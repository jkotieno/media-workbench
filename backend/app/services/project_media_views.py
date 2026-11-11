"""Project folder/trash media inventory helpers."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime as dt, timezone
import hashlib
import logging
import json
import os
from pathlib import Path
import threading
from typing import Any, Dict, List, Optional
import uuid

from fastapi import HTTPException, Request
from sqlalchemy import and_, func, literal_column, or_
from sqlmodel import SQLModel, Session, select
from sqlalchemy.orm import defer, lazyload, load_only, selectinload

from app.core.runtime_cache import ThreadSafeTimedLRUCache
from app.models.engine import Engine
from app.models.generation import Generation
from app.models.image import Image, image_metadata_for_read
from app.models.job import Job
from app.models.project import Project
from app.services.drafts_project_normalization import (
    DRAFTS_PROJECT_SLUG,
    normalize_drafts_root_media,
)
from app.services.filename_sequence import parse_filename_sequence
from app.services import app_settings, project_folder_context, project_read_views, project_storage_roots
from app.services.media_listing_queries import (
    build_active_image_job_query,
)
from app.services.gallery.image_identity import image_path_identity
from app.services.media_scope_context import (
    build_media_scope_context,
    media_scope_matches,
    resolve_media_scope_for_row,
)
from app.services.media_paths import (
    get_project_folder_paths,
    get_project_storage_root_dir,
    normalize_fs_path,
    local_media_path_key,
)
from app.services.media_project_routing import (
    extract_resync_route,
    logical_folder_from_project_path,
    normalize_route_folder,
)

logger = logging.getLogger(__name__)

MEDIA_EXTENSIONS = project_folder_context.MEDIA_EXTENSIONS
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v", ".mpg", ".mpeg"}
AUDIO_EXTENSIONS = {".aac", ".flac", ".m4a", ".mp3", ".oga", ".ogg", ".opus", ".wav", ".wma"}


class FolderImage(SQLModel):
    cloud_reference: bool = False
    preview_available: bool | None = None
    path: str
    filename: str
    mtime: str
    image_id: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None


class ProjectTrashEntry(SQLModel):
    trash_path: str
    original_path: str
    filename: str
    folder: str
    deleted_at: str
    image_id: Optional[int] = None
    tracked: bool
    remote_original: bool = False


@dataclass
class ProjectFolderImagesView:
    items: List[dict]
    etag_header: str
    not_modified: bool = False


def _get_setting_int(key: str, fallback: int) -> int:
    value = app_settings.get_setting_typed(key, fallback)
    if value is None:
        return fallback
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return fallback


def _get_setting_float(key: str, fallback: float) -> float:
    value = app_settings.get_setting_typed(key, fallback)
    if value is None:
        return fallback
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _get_image_dim_cache_max() -> int:
    return max(0, _get_setting_int("image_dim_cache_max", 2000))


def _get_folder_cache_max() -> int:
    return max(0, _get_setting_int("project_folder_cache_max", 32))


def _get_folder_cache_ttl_s() -> float:
    return max(0.0, _get_setting_float("project_folder_cache_ttl_s", 2.5))


_image_dim_cache = ThreadSafeTimedLRUCache[
    str,
    tuple[float, Optional[int], Optional[int]],
](
    max_entries=_get_image_dim_cache_max,
)

_folder_image_cache = ThreadSafeTimedLRUCache[
    str,
    tuple[str, List[dict]],
](
    max_entries=_get_folder_cache_max,
    freshness_seconds=_get_folder_cache_ttl_s,
)

_folder_cache_epoch = uuid.uuid4().hex
_folder_cache_revision = 0
_folder_cache_revision_lock = threading.Lock()


def clear_project_media_view_caches() -> None:
    global _folder_cache_revision
    with _folder_cache_revision_lock:
        _folder_cache_revision += 1
    _image_dim_cache.clear()
    _folder_image_cache.clear()


def _project_folder_route_filter(*, project_slug: str, folder_name: str):
    """Return the exact JSON route predicate backed by ix_image_resync_route_scope."""
    return and_(
        Image.extra_metadata.is_not(None),
        func.json_valid(Image.extra_metadata),
        func.lower(
            func.json_extract(
                Image.extra_metadata,
                literal_column("'$.resync_route.project_slug'"),
            )
        )
        == project_slug.strip().lower(),
        func.lower(
            func.json_extract(
                Image.extra_metadata,
                literal_column("'$.resync_route.folder'"),
            )
        )
        == folder_name.strip().lower(),
    )


def _chunked(values: list[str], size: int = 400) -> list[list[str]]:
    return [values[offset : offset + size] for offset in range(0, len(values), size)]


def _folder_cache_get(cache_key: str, signature: str) -> Optional[List[dict]]:
    entry = _folder_image_cache.get(cache_key)
    if entry is None:
        return None
    cached_signature, cached_images = entry.value
    if cached_signature != signature:
        _folder_image_cache.pop(cache_key)
        return None
    return cached_images


def _folder_cache_set(cache_key: str, signature: str, images: List[dict]) -> None:
    _folder_image_cache.set(cache_key, (signature, images))


def _get_cached_dimensions(path: str, mtime: float) -> tuple[Optional[int], Optional[int], bool]:
    entry = _image_dim_cache.get(path)
    if entry is not None:
        cached_mtime, width, height = entry.value
        if cached_mtime == mtime:
            return width, height, True
    return None, None, False


def _set_cached_dimensions(path: str, mtime: float, width: Optional[int], height: Optional[int]) -> None:
    _image_dim_cache.set(path, (mtime, width, height))


def project_trash_restore_metadata_path(trash_path) -> Path:
    return Path(f"{trash_path}.restore.json")


def _as_utc_z_iso(value: dt) -> str:
    normalized = value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return normalized.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _normalize_project_trash_deleted_at(value: Any) -> Optional[str]:
    if isinstance(value, dt):
        return _as_utc_z_iso(value)
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = dt.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return _as_utc_z_iso(parsed)


def _project_trash_deleted_at_from_name(filename: str) -> Optional[str]:
    import re

    match = re.match(r"^(?P<stamp>\d{8}_\d{6})_", filename)
    if not match:
        return None
    try:
        return _as_utc_z_iso(dt.strptime(match.group("stamp"), "%Y%m%d_%H%M%S"))
    except ValueError:
        return None


def _project_trash_original_path_from_legacy_name(filename: str, folder_path: Path) -> Optional[str]:
    import re

    match = re.match(r"^\d{8}_\d{6}_file(?:_\d+)?_(?P<name>.+)$", filename)
    if not match:
        return None
    return str(folder_path / match.group("name"))


def _normalize_folder_image_sort_dt(value: Optional[dt]) -> dt:
    if not isinstance(value, dt):
        return dt.fromtimestamp(0, tz=timezone.utc)
    return value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)


def collect_project_trash_entries(
    session: Session,
    *,
    project: Project,
    active_engine: Optional[Engine],
    folder_filter: Optional[str] = None,
    requested_paths: Optional[List[str]] = None,
) -> List[ProjectTrashEntry]:
    """Inventory one project's trash without loading unrelated image rows or media blobs.

    When restoring selected files, resolve only those paths inside this project's
    known trash folders rather than scanning the complete trash inventory.
    """
    folders = (
        project_folder_context.project_config_with_virtual_folder(
            project=project,
            active_engine=active_engine,
        ).get("folders")
        or list(project_read_views.DEFAULT_PROJECT_FOLDERS)
    )
    normalized_folder_filter = (folder_filter or "").strip().lower()
    storage_root_dir = project_storage_roots.normalize_storage_root_path(
        get_project_storage_root_dir(project)
    )
    requested_by_dir: Dict[str, List[str]] = {}
    if requested_paths is not None:
        for requested in requested_paths:
            normalized = normalize_fs_path(requested)
            if normalized:
                requested_by_dir.setdefault(
                    normalize_fs_path(str(Path(normalized).parent)), []
                ).append(Path(requested).name)

    # Collect the *project's existing files first*. Query only their small DB
    # fields; selecting Image would also hydrate every thumbnail and metadata blob.
    candidates: List[tuple[str, str, Path]] = []
    seen_paths: set[str] = set()
    for folder_name in folders:
        if normalized_folder_filter and folder_name.lower() != normalized_folder_filter:
            continue
        folder_paths = get_project_folder_paths(
            engine=active_engine,
            project_slug=project.slug,
            folder_name=folder_name,
            project_storage_root_dir=storage_root_dir,
        )
        for folder_path in folder_paths:
            trash_dir = folder_path / ".trash"
            if trash_dir.is_symlink() or not trash_dir.is_dir():
                continue
            requested_names = (
                requested_by_dir.get(normalize_fs_path(str(trash_dir)), [])
                if requested_paths is not None else None
            )
            if requested_paths is not None and not requested_names:
                continue

            from app.services.project_folder_mutations import recover_project_folder_trash_purges

            recover_project_folder_trash_purges(trash_dir, session=session, logger=logger)
            try:
                if requested_names is not None:
                    files = (
                        str(trash_dir / name)
                        for name in requested_names
                        if name not in {".", ".."}
                        and (trash_dir / name).is_file()
                        and not (trash_dir / name).is_symlink()
                    )
                    for path in files:
                        normalized = normalize_fs_path(path)
                        if normalized and normalized not in seen_paths:
                            if Path(path).suffix.lower() in (IMAGE_EXTENSIONS | VIDEO_EXTENSIONS | AUDIO_EXTENSIONS):
                                seen_paths.add(normalized)
                                candidates.append((path, folder_name, folder_path))
                else:
                    with os.scandir(trash_dir) as contents:
                        for entry in contents:
                            if not entry.is_file() or entry.is_symlink():
                                continue
                            if Path(entry.name).suffix.lower() not in (IMAGE_EXTENSIONS | VIDEO_EXTENSIONS | AUDIO_EXTENSIONS):
                                continue
                            normalized = normalize_fs_path(entry.path)
                            if normalized and normalized not in seen_paths:
                                seen_paths.add(normalized)
                                candidates.append((entry.path, folder_name, folder_path))
            except FileNotFoundError:
                continue

    from app.services.project_catalog_trash import entries as catalog_trash_entries
    catalog_entries = catalog_trash_entries(
        session, project=project, folder=folder_filter, requested_paths=requested_paths,
    )
    if not candidates:
        return sorted(catalog_entries, key=lambda item: item.deleted_at, reverse=True)

    tracked_by_trash_path: Dict[str, tuple[int, str, Any, str]] = {}
    candidate_paths = [path for path, _, _ in candidates]
    for offset in range(0, len(candidate_paths), 400):
        rows = session.exec(
            select(Image.id, Image.trash_path, Image.path, Image.deleted_at, Image.filename)
            .where(Image.is_deleted == True)  # noqa: E712
            .where(Image.trash_path.in_(candidate_paths[offset : offset + 400]))
        ).all()
        for image_id, trash_path, original_path, deleted_at, filename in rows:
            if trash_path and image_id is not None:
                tracked_by_trash_path[normalize_fs_path(trash_path)] = (
                    image_id, original_path or "", deleted_at, filename or ""
                )

    entries: List[ProjectTrashEntry] = []
    for path, folder_name, folder_path in candidates:
        file_path = Path(path)
        tracked_image = tracked_by_trash_path.get(normalize_fs_path(path))
        deleted_at = _project_trash_deleted_at_from_name(file_path.name)
        original_path = ""
        filename = file_path.name
        image_id: Optional[int] = None
        tracked = tracked_image is not None

        if tracked_image is not None:
            image_id, original_path, db_deleted_at, db_filename = tracked_image
            deleted_at = _normalize_project_trash_deleted_at(db_deleted_at) or deleted_at
            filename = db_filename or os.path.basename(original_path) or file_path.name
        else:
            metadata_path = project_trash_restore_metadata_path(path)
            metadata: Dict[str, Any] = {}
            if metadata_path.exists():
                try:
                    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    metadata = {}
            original_path = str(metadata.get("original_path") or "")
            if not original_path:
                original_path = _project_trash_original_path_from_legacy_name(
                    file_path.name, folder_path
                ) or ""
            deleted_at = (
                _normalize_project_trash_deleted_at(metadata.get("deleted_at"))
                or deleted_at
            )
            filename = os.path.basename(original_path) if original_path else file_path.name

        if not deleted_at:
            try:
                deleted_at = _as_utc_z_iso(
                    dt.fromtimestamp(file_path.stat().st_mtime, tz=timezone.utc)
                )
            except FileNotFoundError:
                continue
        entries.append(
            ProjectTrashEntry(
                trash_path=path,
                original_path=original_path,
                filename=filename,
                folder=folder_name,
                deleted_at=deleted_at,
                image_id=image_id,
                tracked=tracked,
            )
        )

    seen_ids = {entry.image_id for entry in entries if entry.image_id is not None}
    entries.extend(entry for entry in catalog_entries if entry.image_id not in seen_ids)
    entries.sort(key=lambda item: item.deleted_at, reverse=True)
    return entries


def list_project_folder_images_view(
    session: Session,
    *,
    project: Project,
    active_engine: Optional[Engine],
    folder_name: str,
    include_dimensions: bool = True,
    dimensions_source: str = "auto",
    request: Optional[Request] = None,
    logger,
) -> ProjectFolderImagesView:
    if (project.slug or "").strip().lower() == DRAFTS_PROJECT_SLUG:
        normalize_drafts_root_media(
            session,
            active_engine=active_engine,
            project_storage_root_dir=get_project_storage_root_dir(project),
            update_db_rows=False,
        )

    folder_context = project_folder_context.resolve_project_folder_context(
        project=project,
        active_engine=active_engine,
        folder_name=folder_name,
    )
    folder_paths = folder_context.folder_paths

    logger.info(f"[ProjectGallery] project={project.slug}, folder={folder_name}")
    logger.info(f"[ProjectGallery] active_engine={active_engine.name if active_engine else 'None'}")
    if active_engine:
        logger.info(f"[ProjectGallery] input_dir='{active_engine.input_dir}', output_dir='{active_engine.output_dir}'")
    logger.info(f"[ProjectGallery] folder_paths={[str(p) for p in folder_paths]}")

    scope_context = build_media_scope_context(session, projects=[project])

    dimensions_source = (dimensions_source or "auto").lower()
    if dimensions_source not in {"auto", "db", "file"}:
        dimensions_source = "auto"

    cache_key_parts = [
        str(project.id),
        folder_name,
        "dims" if include_dimensions else "nodims",
        dimensions_source,
    ]
    signature_parts = [
        f"dims:{int(include_dimensions)}",
        f"source:{dimensions_source}",
        f"epoch:{_folder_cache_epoch}",
        f"revision:{_folder_cache_revision}",
    ]
    for path in folder_paths:
        norm_path = normalize_fs_path(str(path))
        cache_key_parts.append(norm_path)
        try:
            stat = path.stat()
            signature_parts.append(f"{norm_path}:{stat.st_mtime_ns}")
        except Exception:
            signature_parts.append(f"{norm_path}:missing")

    cache_key = "|".join(cache_key_parts)
    signature = "|".join(signature_parts)
    etag = hashlib.sha1(signature.encode("utf-8")).hexdigest()
    etag_header = f"\"{etag}\""

    if request is not None:
        if_none_match = request.headers.get("if-none-match") or ""
        if if_none_match.strip() == etag_header or if_none_match.strip().strip("\"") == etag:
            return ProjectFolderImagesView(items=[], etag_header=etag_header, not_modified=True)

    cached = _folder_cache_get(cache_key, signature)
    if cached is not None:
        return ProjectFolderImagesView(items=cached, etag_header=etag_header)

    # Identity is a snapshot within this read: merging and sorting the same
    # path must not walk its symlink components again. Never retain these keys
    # across reads; aliases and previously missing files may change on disk.
    path_keys: dict[str | None, str] = {}

    def _path_key(value: str | None) -> str:
        if value not in path_keys:
            path_keys[value] = local_media_path_key(value)
        return path_keys[value]

    images: List[dict] = []
    images_by_path: Dict[str, dict] = {}
    entry_records: List[tuple[dict, str, float]] = []
    sort_keys_by_path: Dict[str, tuple[float, int, int]] = {}
    db_sorted_paths: set[str] = set()
    folder_query_lower = folder_name.lower()
    deleted_paths: set[str] = set()

    def _update_sort_key(
        normalized_path: str,
        sort_key: tuple[float, int, int],
        *,
        from_db: bool,
    ) -> None:
        current_sort_key = sort_keys_by_path.get(normalized_path)
        current_from_db = normalized_path in db_sorted_paths

        if from_db:
            if not current_from_db or current_sort_key is None or sort_key > current_sort_key:
                sort_keys_by_path[normalized_path] = sort_key
            db_sorted_paths.add(normalized_path)
            return

        if current_from_db:
            return
        if current_sort_key is None or sort_key > current_sort_key:
            sort_keys_by_path[normalized_path] = sort_key

    def _matches_folder_for_project(*, path_value: str, route_folder: Optional[str]) -> bool:
        logical_folder = route_folder
        if not logical_folder:
            logical_folder = logical_folder_from_project_path(
                image_path=path_value,
                project_id=project.id,
                path_index=scope_context.path_index,
            )
        return bool(logical_folder and logical_folder.lower() == folder_query_lower)

    def _append_record(
        *,
        path_value: str,
        filename: str,
        ext: str,
        stat_mtime: float,
        image_id: Optional[int] = None,
        width: Optional[int] = None,
        height: Optional[int] = None,
        sort_key: Optional[tuple[float, int, int]] = None,
        from_db: bool = False,
    ) -> None:
        normalized_path = _path_key(path_value)
        if not normalized_path or normalized_path in deleted_paths:
            return

        existing_record = images_by_path.get(normalized_path)
        if existing_record:
            if existing_record.get("image_id") is None and image_id is not None:
                existing_record["image_id"] = image_id
                # Keep the DB path paired with its ID so provisional completion
                # and the physical scan converge on the same gallery record.
                existing_record["path"] = path_value
            if existing_record.get("width") is None and width is not None:
                existing_record["width"] = width
            if existing_record.get("height") is None and height is not None:
                existing_record["height"] = height
            if sort_key is not None:
                _update_sort_key(normalized_path, sort_key, from_db=from_db)
            return

        record = {
            "path": path_value,
            "filename": filename,
            "mtime": dt.fromtimestamp(stat_mtime).isoformat(),
            "image_id": image_id,
            "width": width,
            "height": height,
        }
        images.append(record)
        images_by_path[normalized_path] = record
        entry_records.append((record, ext, stat_mtime))
        _update_sort_key(
            normalized_path,
            sort_key or (stat_mtime, 0, 0),
            from_db=from_db,
        )

    physical_entries: list[tuple[str, str, str, float]] = []
    try:
        pil_image = None
        if include_dimensions and dimensions_source in {"auto", "file"}:
            from PIL import Image as pil_image  # type: ignore

        for folder_path in folder_paths:
            for entry in os.scandir(folder_path):
                if entry.is_file():
                    ext = os.path.splitext(entry.name)[1].lower()
                    if ext in IMAGE_EXTENSIONS or ext in VIDEO_EXTENSIONS or ext in AUDIO_EXTENSIONS:
                        stat = entry.stat()
                        physical_entries.append((entry.path, entry.name, ext, stat.st_mtime))
    except Exception as exc:
        logger.warning(
            "Project gallery physical scan failed.",
            extra={
                "project_id": project.id,
                "project_slug": project.slug,
                "folder_name": folder_name,
                "folder_path": str(folder_path),
                "include_dimensions": include_dimensions,
                "dimensions_source": dimensions_source,
                "error": str(exc),
            },
            exc_info=True,
        )
        pil_image = None

    preview_by_image_id: dict[int, bool] = {}

    def _browse_rows(query):
        # Listing needs preview presence and canonical routing metadata, never
        # the thumbnail bytes or generation recipe. Both ORM relationships use
        # select-in loading by default; constrain them before materialization.
        rows = session.exec(query.add_columns(func.length(Image.thumbnail_data) > 0).options(
            defer(Image.thumbnail_data),
            load_only(Job.id, Job.project_id, Job.output_dir),
            lazyload(Job.generation),
            selectinload(Image.generation).load_only(Generation.id, Generation.output_metadata_json),
        )).all()
        for image, _job, has_preview in rows:
            preview_by_image_id[image.id] = bool(has_preview)
        return [(image, job) for image, job, _preview in rows]

    physical_mtimes = {_path_key(path): mtime for path, _name, _ext, mtime in physical_entries}
    physical_paths = [entry[0] for entry in physical_entries]
    physical_db_rows: list[tuple[Image, Optional[Job]]] = []
    for offset in range(0, len(physical_paths), 400):
        path_chunk = physical_paths[offset : offset + 400]
        identity_chunk = [
            identity
            for identity in (image_path_identity(path) for path in path_chunk)
            if identity
        ]
        lookup_filters = [Image.path.in_(tuple(path_chunk))]
        if identity_chunk:
            lookup_filters.insert(0, Image.path_identity.in_(tuple(identity_chunk)))
        candidate_rows = _browse_rows(
            select(Image, Job)
            .join(Job, Image.job_id == Job.id, isouter=True)
            .where(or_(*lookup_filters))
        )
        physical_db_rows.extend(candidate_rows)

    active_physical_identities: set[str] = set()
    deleted_physical_identities: set[str] = set()
    for image_row, _job_row in physical_db_rows:
        identity = _path_key(image_row.path)
        if not identity:
            continue
        if image_row.is_deleted:
            deleted_physical_identities.add(identity)
        else:
            active_physical_identities.add(identity)
    deleted_paths = deleted_physical_identities - active_physical_identities

    for path_value, filename, ext, stat_mtime in physical_entries:
        _append_record(
            path_value=path_value,
            filename=filename,
            ext=ext,
            stat_mtime=stat_mtime,
            sort_key=(stat_mtime, 0, 0),
        )

    routed_db_rows = _browse_rows(
        build_active_image_job_query().where(
            or_(
                _project_folder_route_filter(project_slug=project.slug, folder_name=folder_name),
                Job.project_id == project.id,
            )
        )
    )
    db_rows: list[tuple[Image, Optional[Job]]] = []
    seen_db_ids: set[int] = set()
    for image_row, job_row in [*physical_db_rows, *routed_db_rows]:
        if image_row.is_deleted:
            continue
        row_key = int(image_row.id) if image_row.id is not None else id(image_row)
        if row_key in seen_db_ids:
            continue
        seen_db_ids.add(row_key)
        db_rows.append((image_row, job_row))

    for image_row, job_row in db_rows:
        if not image_row or not image_row.path:
            continue

        resolved_scope = resolve_media_scope_for_row(
            context=scope_context,
            image_path=image_row.path,
            extra_metadata=image_metadata_for_read(image_row),
            job_project_id=job_row.project_id if job_row else None,
            job_output_dir=job_row.output_dir if job_row else None,
        )
        if not media_scope_matches(
            resolved_scope=resolved_scope,
            project_id=project.id,
            folder=folder_name,
        ):
            continue

        ext = os.path.splitext(image_row.filename or image_row.path)[1].lower()
        if ext not in IMAGE_EXTENSIONS and ext not in VIDEO_EXTENSIONS and ext not in AUDIO_EXTENSIONS:
            continue
        # The physical scan already obtained this timestamp. A second stat per
        # catalog row doubles filesystem work on cold or remote folders.
        stat_mtime = physical_mtimes.get(_path_key(image_row.path))
        if stat_mtime is None:
            try:
                stat_mtime = os.path.getmtime(image_row.path)
            except OSError:
                stat_mtime = _normalize_folder_image_sort_dt(image_row.created_at).timestamp()

        _append_record(
            path_value=image_row.path,
            filename=image_row.filename or os.path.basename(image_row.path),
            ext=ext,
            stat_mtime=stat_mtime,
            image_id=int(image_row.id) if image_row.id is not None else None,
            width=image_row.width,
            height=image_row.height,
            sort_key=(
                _normalize_folder_image_sort_dt(image_row.created_at).timestamp(),
                1,
                int(image_row.id or 0),
            ),
            from_db=True,
        )

    for image_row, _ in db_rows:
        record = images_by_path.get(_path_key(image_row.path))
        if record is not None:
            metadata = image_row.extra_metadata or {}
            record["cloud_reference"] = image_row.cloud_reference
            record["preview_available"] = bool(preview_by_image_id.get(image_row.id) or image_row.thumbnail_path or metadata.get("studio_sync", {}).get("preview"))

    if include_dimensions and images:
        path_to_dims: dict[str, tuple[Optional[int], Optional[int]]] = {}
        paths = [record["path"] for record in images]
        chunk_size = 900
        for i in range(0, len(paths), chunk_size):
            chunk = paths[i:i + chunk_size]
            rows = session.exec(
                select(Image.path, Image.width, Image.height).where(Image.path.in_(chunk))
            ).all()
            for row in rows:
                try:
                    img_path, width, height = row
                except Exception:
                    continue
                if img_path:
                    path_to_dims[str(img_path)] = (width, height)

        for record, ext, stat_mtime in entry_records:
            dims = path_to_dims.get(record["path"])
            if dims:
                width, height = dims
                if width is not None and height is not None:
                    record["width"] = width
                    record["height"] = height

            if record["width"] is None and dimensions_source in {"auto", "file"} and pil_image is not None:
                if ext in IMAGE_EXTENSIONS:
                    cached_width, cached_height, cached = _get_cached_dimensions(record["path"], stat_mtime)
                    if cached:
                        record["width"] = cached_width
                        record["height"] = cached_height
                    else:
                        try:
                            with pil_image.open(record["path"]) as opened:
                                record["width"], record["height"] = opened.size
                        except Exception:
                            pass
                        _set_cached_dimensions(record["path"], stat_mtime, record["width"], record["height"])

    filename_prefix = f"{project.slug}-{folder_name}"

    def _folder_image_sort_key(item: dict) -> tuple[float | int, ...]:
        stable_key = sort_keys_by_path.get(
            _path_key(item.get("path")),
            (0.0, 0, 0),
        )
        parsed_sequence = parse_filename_sequence(
            str(item.get("filename") or ""),
            expected_prefix=filename_prefix,
        )
        if parsed_sequence is not None:
            return (1, parsed_sequence.number, *stable_key)
        return (0, 0, *stable_key)

    images.sort(key=_folder_image_sort_key, reverse=True)
    _folder_cache_set(cache_key, signature, images)
    return ProjectFolderImagesView(items=images, etag_header=etag_header)
