from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

from app.core.config import settings
from app.models.engine import Engine
from app.services.local_storage_engine import owns_local_files
from app.models.project import Project
from app.services.internal_pipe_storage import path_is_internal_pipe_storage

PROJECT_STORAGE_ROOT_KEY = "storage_root_dir"


def normalize_fs_path(path: str) -> str:
    cleaned = (path or "").strip().strip('"').strip("'")
    if not cleaned:
        return ""
    try:
        return os.path.normcase(os.path.normpath(cleaned))
    except Exception:
        return cleaned


def local_media_path_key(path: str | None) -> str:
    """Compare local aliases by their existing physical file, without rewriting paths.

    Missing/cloud paths retain their lexical identity. This is a read-side key,
    not a replacement for the persisted portable media identity.
    """
    normalized = normalize_fs_path(path or "")
    if not normalized:
        return ""
    try:
        if os.path.exists(normalized):
            return normalize_fs_path(os.path.realpath(normalized))
    except OSError:
        pass
    return normalized


def _unique_existing_dirs(paths: Iterable[Path]) -> list[Path]:
    seen: set[str] = set()
    unique: list[Path] = []
    for path in paths:
        try:
            if not path or not path.exists() or not path.is_dir():
                continue
        except Exception:
            continue
        key = local_media_path_key(str(path))
        if not key or key in seen:
            continue
        seen.add(key)
        unique.append(path)
    return unique


def _local_folder_aliases(folder_name: str) -> list[str]:
    normalized = (folder_name or "").strip().lower()
    if not normalized:
        return []
    if normalized == "input":
        return ["input", "inputs"]
    if normalized == "output":
        return ["output", "outputs"]
    if normalized == "mask":
        return ["mask", "masks"]
    if normalized == "masks":
        return ["masks"]
    return [folder_name]


def _is_project_root_folder(*, folder_name: str, project_slug: str) -> bool:
    normalized_folder = (folder_name or "").strip().lower()
    normalized_slug = (project_slug or "").strip().lower()
    if normalized_folder in {"input", "output", "masks"}:
        return False
    return bool(normalized_folder and normalized_slug and normalized_folder == normalized_slug)


def get_project_storage_root_dir(project: Optional[Project]) -> Optional[str]:
    if not project:
        return None
    config = project.config_json if isinstance(project.config_json, dict) else {}
    raw_value = config.get(PROJECT_STORAGE_ROOT_KEY)
    if not isinstance(raw_value, str):
        return None
    cleaned = raw_value.strip().strip('"').strip("'")
    if not cleaned:
        return None
    return cleaned


def resolve_project_storage_root(*, project_slug: str, project_storage_root_dir: Optional[str]) -> Optional[Path]:
    raw_root = (project_storage_root_dir or "").strip().strip('"').strip("'")
    if not raw_root:
        return None
    root_path = Path(raw_root).expanduser()
    if not root_path.is_absolute():
        return None
    return root_path / project_slug


def get_project_folder_paths(
    *,
    engine: Optional[Engine],
    project_slug: str,
    folder_name: str,
    project_storage_root_dir: Optional[str] = None,
) -> list[Path]:
    engine = engine if owns_local_files(engine) else None
    candidates: list[Path] = []
    is_project_root_folder = _is_project_root_folder(folder_name=folder_name, project_slug=project_slug)
    custom_root = resolve_project_storage_root(
        project_slug=project_slug,
        project_storage_root_dir=project_storage_root_dir,
    )
    if custom_root:
        candidates.append(custom_root if is_project_root_folder else custom_root / folder_name)
    if engine and engine.input_dir:
        project_input_root = Path(engine.input_dir) / project_slug
        candidates.append(project_input_root if is_project_root_folder else project_input_root / folder_name)
    if engine and engine.output_dir:
        project_output_root = settings.get_project_dir_in_comfy(engine.output_dir, project_slug)
        if not path_is_internal_pipe_storage(project_output_root):
            candidates.append(project_output_root if is_project_root_folder else project_output_root / folder_name)

    local_root = settings.get_project_dir(project_slug)
    if is_project_root_folder:
        candidates.append(local_root)
    else:
        for alias in _local_folder_aliases(folder_name):
            candidates.append(local_root / alias)

    return _unique_existing_dirs(candidates)


def get_project_roots(
    *,
    engine: Optional[Engine],
    project_slug: str,
    project_storage_root_dir: Optional[str] = None,
    include_unavailable: bool = False,
) -> list[Path]:
    engine = engine if owns_local_files(engine) else None
    candidates: list[Path] = []
    custom_root = resolve_project_storage_root(
        project_slug=project_slug,
        project_storage_root_dir=project_storage_root_dir,
    )
    if custom_root:
        candidates.append(custom_root)
    if engine and engine.input_dir:
        candidates.append(Path(engine.input_dir) / project_slug)
    if engine and engine.output_dir:
        project_output_root = settings.get_project_dir_in_comfy(engine.output_dir, project_slug)
        if not path_is_internal_pipe_storage(project_output_root):
            candidates.append(project_output_root)

    local_root = settings.get_project_dir(project_slug)
    candidates.append(local_root)

    # Catalog ownership must survive an unplugged drive or a profile restore.
    # Filesystem scans retain their existing available-directory behavior.
    if include_unavailable:
        return list(dict.fromkeys(candidates))
    return _unique_existing_dirs(candidates)


def infer_project_slug_from_path(
    path: Path,
    engines: Iterable[Engine],
    projects: Optional[Iterable[Project]] = None,
) -> Optional[str]:
    resolved = path
    try:
        resolved = path.resolve()
    except Exception:
        pass

    def _project_slug_from_relative(relative: Path) -> Optional[str]:
        parts = [part for part in relative.parts if part]
        if not parts:
            return None
        if len(parts) >= 2:
            return parts[0]
        try:
            if resolved.is_dir():
                return parts[0]
        except Exception:
            pass
        return None

    for engine in engines:
        if engine.input_dir:
            try:
                rel = resolved.relative_to(Path(engine.input_dir))
                slug = _project_slug_from_relative(rel)
                if slug:
                    return slug
            except ValueError:
                pass

        if engine.output_dir:
            try:
                sweet_tea_dir = settings.get_sweet_tea_dir_from_engine_path(engine.output_dir)
                rel = resolved.relative_to(sweet_tea_dir)
                slug = _project_slug_from_relative(rel)
                if slug and not path_is_internal_pipe_storage(sweet_tea_dir / slug):
                    return slug
            except ValueError:
                pass

    try:
        rel = resolved.relative_to(settings.projects_dir)
        slug = _project_slug_from_relative(rel)
        if slug:
            return slug
    except ValueError:
        pass

    if projects:
        for project in projects:
            if not project or not project.slug:
                continue
            custom_root = resolve_project_storage_root(
                project_slug=project.slug,
                project_storage_root_dir=get_project_storage_root_dir(project),
            )
            if not custom_root:
                continue
            try:
                resolved.relative_to(custom_root)
                return project.slug
            except ValueError:
                continue

    return None


@dataclass
class ProjectPathIndex:
    roots: list[tuple[str, int, str]]

    def match_project_id(self, path: str) -> Optional[int]:
        normalized = normalize_fs_path(path)
        if not normalized:
            return None
        for root, project_id, _slug in self.roots:
            if normalized == root or normalized.startswith(root + os.sep):
                return project_id
        return None

    def match_project_slug(self, path: str) -> Optional[str]:
        normalized = normalize_fs_path(path)
        if not normalized:
            return None
        for root, _project_id, slug in self.roots:
            if normalized == root or normalized.startswith(root + os.sep):
                return slug
        return None


def build_project_path_index(
    *,
    engines: Iterable[Engine],
    projects: Iterable[Project],
) -> ProjectPathIndex:
    roots: list[tuple[str, int, str]] = []
    seen: set[str] = set()
    engine_list: list[Optional[Engine]] = list(engines)
    if not engine_list:
        engine_list = [None]

    for project in projects:
        if not project.slug or project.id is None:
            continue
        slug = project.slug
        storage_root_dir = get_project_storage_root_dir(project)

        for engine in engine_list:
            for root in get_project_roots(
                engine=engine,
                project_slug=slug,
                project_storage_root_dir=storage_root_dir,
                include_unavailable=True,
            ):
                root_key = normalize_fs_path(str(root))
                if not root_key or root_key in seen:
                    continue
                seen.add(root_key)
                roots.append((root_key, int(project.id), slug))

    roots.sort(key=lambda item: len(item[0]), reverse=True)
    return ProjectPathIndex(roots=roots)


def image_for_media_path(session, path):
    """Resolve logical names and durable in-flight aliases to the catalog identity.

    Current names take precedence over retained aliases, so a reused filename is
    never stolen by an earlier operation. Only scalar intent fields are loaded.
    """
    from sqlmodel import select
    from sqlalchemy import func, or_
    from app.models.image import Image
    from app.models.agent_access import AgentOperationItem
    from app.services.gallery.image_lookup import active_images_for_paths
    if not path:
        return None
    variants = {str(path), str(path).replace("\\", "/"), normalize_fs_path(str(path))}
    with session.no_autoflush:
        image = max(active_images_for_paths(session, paths=variants, identities=variants),
                    key=lambda row: row.id or 0, default=None)
        if image is not None:
            return image
        src = func.json_extract(AgentOperationItem.input_json, "$.src")
        dst = func.json_extract(AgentOperationItem.input_json, "$.dst")
        logical = func.json_extract(AgentOperationItem.input_json, "$.logical_dst")
        kind = func.json_extract(AgentOperationItem.input_json, "$.kind")
        columns = (AgentOperationItem.target_id, src, dst, logical, kind)
        # Pending aliases have no retention ceiling. Applied aliases are bounded
        # to recent history; they cover an open request racing physical settle.
        pending = session.exec(select(*columns).where(AgentOperationItem.status.in_(
            ("pending", "applying", "needs_attention")),
            or_(src.in_(variants), dst.in_(variants), logical.in_(variants), kind == "move_dir"))
            .order_by(AgentOperationItem.id.desc())).all()
        recent = session.exec(select(*columns).where(AgentOperationItem.status == "applied")
            .order_by(AgentOperationItem.id.desc()).limit(256)).all()
        aliases = [*pending, *recent]
        candidates = list(variants)
        seen = set()
        while candidates:
            candidate = candidates.pop(0)
            normalized = normalize_fs_path(candidate)
            if normalized in seen:
                continue
            seen.add(normalized)
            current = next(iter(active_images_for_paths(session, paths=(candidate,), identities=(normalized,))), None)
            if current is not None:
                return current
            for target_id, source, destination, logical_dst, effect_kind in aliases:
                names = [name for name in (source, destination, logical_dst) if name]
                if target_id and any(normalize_fs_path(name) == normalized for name in names):
                    row = session.get(Image, target_id, populate_existing=True)
                    if row is not None and not row.is_deleted:
                        return row
                if effect_kind == "move_dir" and source and destination:
                    try:
                        relative = Path(candidate).relative_to(source)
                    except ValueError:
                        continue
                    candidates.append(str(Path(destination) / relative))
    return None


def _open_cached_media_original(session, image):
    """Open a mapped verified original for reads without changing its logical path."""
    from sqlmodel import select
    from app.models.storage import StorageAsset
    from app.services import storage_cache
    if image.is_deleted:
        raise FileNotFoundError(image.path)
    metadata = image.extra_metadata if isinstance(image.extra_metadata, dict) else {}
    sync = metadata.get("studio_sync")
    expected = sync.get("original") if isinstance(sync, dict) else None
    copies = session.exec(select(StorageAsset).where(
        StorageAsset.image_id == image.id, StorageAsset.state == "available",
        StorageAsset.verified_at != None, StorageAsset.sha256 != None,
    ).order_by(StorageAsset.verified_at.desc()).limit(16)).all()
    for asset in copies:
        if isinstance(expected, dict) and (
            expected.get("sha256") and expected["sha256"] != asset.sha256 or
            expected.get("size") is not None and expected["size"] != asset.size
        ):
            continue
        with storage_cache.asset_guard(asset.id):
            actual = storage_cache.available_path(asset)
            if actual is None:
                continue
            try:
                return str(actual), actual.open("rb")
            except FileNotFoundError:
                continue
    raise FileNotFoundError(image.path)


def open_media_file(session, path):
    """Open bytes before returning to ASGI; chase a physical rename only on ENOENT."""
    from app.services.gallery.paths import _resolve_media_path
    image = image_for_media_path(session, path)
    if image is not None and image.cloud_reference and resolve_media_file(image, session) is None:
        return _open_cached_media_original(session, image)
    last = None
    for _ in range(4):
        actual = _resolve_media_path(path, session)
        if not actual:
            break
        try:
            return actual, open(actual, "rb")
        except FileNotFoundError as exc:
            last = exc
            # The effect may have settled since the catalog lookup. Refresh only
            # this identity; no writer or filesystem lock is acquired by a read.
            session.expire_all()
    raise FileNotFoundError(path) from last


def media_file_fingerprint(path):
    """Cheap local file identity, prepared without hashing or writer admission."""
    try:
        stat = Path(path).stat()
        if not stat.st_ino:
            return None
        return {"device": stat.st_dev, "inode": stat.st_ino,
            "size": stat.st_size, "mtime_ns": stat.st_mtime_ns}
    except (OSError, TypeError, ValueError):
        return None


def owned_publication_path(output,destination):
    """An exact ledger-owned private inode proves publication until settlement."""
    for key in ("publication_proof","copy_receipt"):
        proof=output.get(key) or {}
        if not proof.get("ready") or proof.get("destination")!=str(destination) or not proof.get("path"):
            continue
        path=Path(proof["path"])
        try:
            stat=path.stat()
            if (not path.is_symlink() and path.parent==Path(destination).parent
                    and (stat.st_dev,stat.st_ino)==(proof.get("device"),proof.get("inode"))
                    and os.path.samefile(path,destination)):
                return path
        except OSError:
            continue
    return None


def _matches_media_fingerprint(path, fingerprint):
    return bool(fingerprint) and media_file_fingerprint(path) == fingerprint


def resolve_media_file(image, session=None, *, _pending=None, _folders=None):
    """Read through a committed move until its file effect has settled."""
    if image.file_exists and image.path and Path(image.path).is_file():
        if session is None:
            return image.path
        if _folders is None:
            from sqlmodel import select
            from app.models.agent_access import AgentOperationItem
            _folders=session.exec(select(AgentOperationItem).where(
                AgentOperationItem.input_json["kind"].as_string()=="move_dir",
                AgentOperationItem.status.in_(("pending","applying","needs_attention")))
                .order_by(AgentOperationItem.id.desc())).all()
        # Folder logical commits can intentionally retain file_exists=True.
        # Resolve their predecessor before accepting an externally-created name.
        resolved=_folder_predecessor_file(Path(image.path),_folders,set(),set())
        return resolved or image.path
    from sqlmodel import Session, select
    from app.models.agent_access import AgentOperation, AgentOperationItem
    from app.db.engine import engine
    if session is None:
        with Session(engine) as current:
            return resolve_media_file(image, current)
    items = _pending if _pending is not None else session.exec(select(AgentOperationItem).join(AgentOperation,
        AgentOperation.id == AgentOperationItem.operation_id).where(
        (AgentOperation.kind.like("media.%") | AgentOperation.kind.like("filesystem.%")), AgentOperationItem.target_id == image.id,
        AgentOperationItem.status.in_(("pending", "applying", "needs_attention")))
        .order_by(AgentOperationItem.id.desc())).all()
    untrusted = set()
    for item in items:
        plan=item.input_json
        if plan.get("media_uuid") is None or plan["media_uuid"]!=image.continuity_media_uuid:
            continue  # A numeric ID can be reused before an older purge settles.
        if plan.get("kind") == "storage_cache_evict":
            continue  # A retiring disposable copy never supplies a pending original.
        if plan.get("verb")=="filesystem" and not plan.get("updates_media") and not plan.get("storage_effect"):
            continue  # A sidecar or recipe is never the original's bytes.
        source = plan.get("src")
        fingerprint = plan.get("source_fingerprint")
        if source and Path(source).is_file():
            if not fingerprint or _matches_media_fingerprint(source, fingerprint):
                return source
            untrusted.add(normalize_fs_path(source))
        destination=plan.get("dst")
        if destination:
            # Existence alone cannot distinguish a published original from an
            # external collision after its source disappeared. A cheap prepared
            # inode identity proves same-filesystem moves; other destinations
            # become readable only after settlement establishes ownership.
            if Path(destination).is_file():
                if _matches_media_fingerprint(destination, fingerprint):
                    return destination
                if owned_publication_path(item.output_json,destination) is not None:
                    return destination
                temporary = Path(destination).with_name(".st-media-"+str(item.id)+".tmp")
                try:
                    if (item.status=="applying" or item.output_json.get("attempts")) and temporary.is_file() and os.path.samefile(temporary,destination):
                        return destination
                except OSError:
                    pass
            untrusted.add(normalize_fs_path(destination))
    folders = _folders if _folders is not None else session.exec(select(AgentOperationItem).join(AgentOperation,
        AgentOperation.id == AgentOperationItem.operation_id).where(
        AgentOperation.kind.like("filesystem.%"),
        AgentOperationItem.input_json["kind"].as_string()=="move_dir",
        AgentOperationItem.status.in_(("pending","applying","needs_attention")))
        .order_by(AgentOperationItem.id.desc())).all()
    return _folder_predecessor_file(Path(image.path),folders,untrusted,set()) if image.path else None


def _folder_predecessor_file(candidate,folders,untrusted,visited):
    stack=[(candidate,False)]
    while stack:
        current,expanded=stack.pop();key=str(current)
        if expanded:
            if normalize_fs_path(key) not in untrusted and current.is_file():return key
            continue
        if key in visited:continue
        visited.add(key);stack.append((current,True))
        for item in reversed(folders):
            plan=item.input_json
            try:
                relative=current.relative_to(plan["dst"])
            except ValueError:
                continue
            stack.append((Path(plan["src"])/relative,False))
    return None


def original_availability_for_images(images, session):
    """One pending-intent read per browse page; no new connections per DTO."""
    from collections import defaultdict
    from sqlmodel import select
    from app.models.agent_access import AgentOperationItem
    images = list(images)
    availability = {image.id: bool(not image.cloud_reference and image.file_exists is not False
        and image.path and Path(image.path).is_file())
        for image in images}
    missing = [image for image in images if not image.cloud_reference and not availability[image.id]]
    if not missing:
        return availability
    by_image = defaultdict(list)
    with session.no_autoflush:
        items = session.exec(select(AgentOperationItem).where(
            AgentOperationItem.target_id.in_([image.id for image in missing]),
            AgentOperationItem.status.in_(("pending", "applying", "needs_attention")))
            .order_by(AgentOperationItem.id.desc())).all()
        folders = session.exec(select(AgentOperationItem).where(
            AgentOperationItem.input_json["kind"].as_string() == "move_dir",
            AgentOperationItem.status.in_(("pending", "applying", "needs_attention")))
            .order_by(AgentOperationItem.id.desc())).all()
    for item in items:
        if item.input_json.get("kind") != "storage_cache_evict":
            by_image[item.target_id].append(item)
    for image in missing:
        availability[image.id] = bool(resolve_media_file(image, session,
            _pending=by_image[image.id], _folders=folders))
    return availability
