"""Shared project folder context and virtual-root helpers."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from fastapi import HTTPException

from app.core.config import settings
from app.models.engine import Engine
from app.models.project import Project
from app.services.drafts_project_normalization import (
    DRAFTS_PROJECT_FOLDERS,
    DRAFTS_PROJECT_SLUG,
)
from app.services.internal_pipe_storage import project_root_is_internal_pipe_storage
from app.services import project_storage_roots
from app.services.media_paths import (
    get_project_folder_paths,
    get_project_roots,
    get_project_storage_root_dir,
    normalize_fs_path,
)

DEFAULT_PROJECT_FOLDERS = ["input", "output", "masks"]
MEDIA_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
    ".bmp",
    ".tif",
    ".tiff",
    ".mp4",
    ".webm",
    ".mov",
    ".mkv",
    ".avi",
    ".m4v",
    ".mpg",
    ".mpeg",
    ".aac",
    ".flac",
    ".m4a",
    ".mp3",
    ".oga",
    ".ogg",
    ".opus",
    ".wav",
    ".wma",
}


@dataclass(frozen=True)
class ProjectFolderContext:
    config: dict
    folders: list[str]
    storage_root_dir: Optional[str]
    folder_paths: list[Path]
    normalized_folder_roots: list[str]


def _normalize_slug_token(value: str) -> str:
    cleaned = (value or "").strip().lower()
    if not cleaned:
        return ""
    import re

    cleaned = re.sub(r"[^\w\s-]", "", cleaned)
    cleaned = re.sub(r"[\s_-]+", "-", cleaned).strip("-")
    return cleaned


def list_configured_project_folders(
    project: Project,
    *,
    default_folders: Optional[list[str]] = None,
) -> list[str]:
    defaults = default_folders or DEFAULT_PROJECT_FOLDERS
    config = project.config_json.copy() if isinstance(project.config_json, dict) else {}
    folders = [
        str(folder)
        for folder in (config.get("folders") or defaults)
        if str(folder) and str(folder) != "__legacy_root__"
    ]
    folders = folders or list(defaults)
    if (project.slug or "").strip().lower() == DRAFTS_PROJECT_SLUG:
        merged: list[str] = []
        seen: set[str] = set()
        for folder in [*DRAFTS_PROJECT_FOLDERS, *folders]:
            key = str(folder).strip().lower()
            if not key or key in seen:
                continue
            seen.add(key)
            merged.append(str(folder))
        return merged
    return folders


def collect_project_root_media_presence(
    projects: list[Project],
    *,
    active_engine: Optional[Engine],
) -> dict[int, bool]:
    root_to_has_media: dict[str, bool] = {}
    project_roots: dict[int, list[str]] = {}

    for project in projects:
        if project.id is None or not project.slug:
            continue
        storage_root_dir = project_storage_roots.normalize_storage_root_path(
            get_project_storage_root_dir(project)
        )
        roots: list[str] = []
        seen_roots: set[str] = set()

        for root in get_project_roots(
            engine=active_engine,
            project_slug=project.slug,
            project_storage_root_dir=storage_root_dir,
        ):
            normalized_root = normalize_fs_path(str(root))
            if not normalized_root or normalized_root in seen_roots:
                continue
            seen_roots.add(normalized_root)
            roots.append(normalized_root)

        if storage_root_dir:
            storage_root_path = Path(storage_root_dir)
            for candidate in [storage_root_path / project.slug, storage_root_path]:
                normalized_candidate = normalize_fs_path(str(candidate))
                if not normalized_candidate or normalized_candidate in seen_roots:
                    continue
                if candidate == storage_root_path and _normalize_slug_token(storage_root_path.name) != _normalize_slug_token(project.slug):
                    continue
                seen_roots.add(normalized_candidate)
                roots.append(normalized_candidate)

        project_roots[int(project.id)] = roots

    for normalized_root in {
        normalized_root
        for roots in project_roots.values()
        for normalized_root in roots
    }:
        root_path = Path(normalized_root)
        has_media = False
        try:
            if root_path.exists() and root_path.is_dir():
                for entry in root_path.iterdir():
                    if entry.is_file() and entry.suffix.lower() in MEDIA_EXTENSIONS:
                        has_media = True
                        break
        except Exception:
            has_media = False
        root_to_has_media[normalized_root] = has_media

    return {
        project_id: any(root_to_has_media.get(normalized_root, False) for normalized_root in roots)
        for project_id, roots in project_roots.items()
    }


def project_config_with_virtual_folder(
    *,
    project: Project,
    active_engine: Optional[Engine],
    has_project_root_media: Optional[bool] = None,
) -> dict:
    config = project.config_json.copy() if isinstance(project.config_json, dict) else {}
    default_folders = (
        DRAFTS_PROJECT_FOLDERS
        if (project.slug or "").strip().lower() == DRAFTS_PROJECT_SLUG
        else DEFAULT_PROJECT_FOLDERS
    )
    folders = list_configured_project_folders(
        project,
        default_folders=list(default_folders),
    )

    storage_root_dir = project_storage_roots.normalize_storage_root_path(
        get_project_storage_root_dir(project)
    )
    if storage_root_dir:
        config["storage_root_dir"] = storage_root_dir
    else:
        config.pop("storage_root_dir", None)

    root_media_present = (
        has_project_root_media
        if has_project_root_media is not None
        else collect_project_root_media_presence([project], active_engine=active_engine).get(int(project.id or 0), False)
    )
    if (
        root_media_present
        and project.slug
        and project.slug != "drafts"
        and not any(str(existing).lower() == project.slug.lower() for existing in folders)
    ):
        folders.append(project.slug)

    from app.services.project_folder_tree import complete_folder_paths, folder_tree
    from app.models.project import canonical_project_slug
    folders = complete_folder_paths(folders)
    config["folders"] = folders
    config["folder_tree"] = folder_tree(canonical_project_slug(project), folders, config.get("folder_tree"))
    return config


def resolve_project_root_dir(
    *,
    project: Project,
    active_engine: Optional[Engine],
) -> str:
    storage_root_dir = project_storage_roots.normalize_storage_root_path(
        get_project_storage_root_dir(project)
    )
    if storage_root_dir and not project_root_is_internal_pipe_storage(
        project_slug=project.slug,
        storage_root_dir=storage_root_dir,
    ):
        return str(Path(storage_root_dir) / project.slug)

    active_input = (
        project_storage_roots.normalize_storage_root_path(active_engine.input_dir)
        if active_engine
        else None
    )
    if active_input:
        return str(Path(active_input) / project.slug)

    return str(settings.get_project_dir(project.slug))


def resolve_project_folder_context(
    *,
    project: Project,
    active_engine: Optional[Engine],
    folder_name: str,
) -> ProjectFolderContext:
    config = project_config_with_virtual_folder(
        project=project,
        active_engine=active_engine,
    )
    folders = config.get("folders") or list(DEFAULT_PROJECT_FOLDERS)
    if folder_name not in folders:
        raise HTTPException(status_code=404, detail=f"Folder '{folder_name}' not found in project")

    storage_root_dir = project_storage_roots.normalize_storage_root_path(
        get_project_storage_root_dir(project)
    )
    folder_paths = get_project_folder_paths(
        engine=active_engine,
        project_slug=project.slug,
        folder_name=folder_name,
        project_storage_root_dir=storage_root_dir,
    )
    normalized_folder_roots = [
        normalize_fs_path(os.path.abspath(str(path)))
        for path in folder_paths
        if normalize_fs_path(os.path.abspath(str(path)))
    ]

    return ProjectFolderContext(
        config=config,
        folders=folders,
        storage_root_dir=storage_root_dir,
        folder_paths=folder_paths,
        normalized_folder_roots=normalized_folder_roots,
    )


def path_is_within_folder_context(
    abs_path: str,
    *,
    context: ProjectFolderContext,
) -> bool:
    normalized = normalize_fs_path(abs_path)
    for root in context.normalized_folder_roots:
        if not root:
            continue
        if normalized == root or normalized.startswith(root + os.sep):
            return True
    return False


def resolve_project_write_directory(*, project: Project, engine: Optional[Engine], folder_name: str) -> Path:
    """Resolve a project-owned destination independently of source attachments.

    The project hierarchy owns membership. This device's project/engine storage
    configuration owns placement. No reusable-source binding participates.
    """
    from app.services.local_storage_engine import owns_local_files
    from app.services.project_folder_tree import normalize_folder_path, safe_folder_child
    engine = engine if owns_local_files(engine) else None
    folder_name = normalize_folder_path(folder_name) if folder_name else ""
    storage_root = get_project_storage_root_dir(project)
    if storage_root:
        base = Path(storage_root) / project.slug
    elif engine and engine.input_dir:
        base = Path(engine.input_dir) / project.slug
    elif engine and engine.output_dir:
        output = Path(engine.output_dir)
        base = (output.parent if output.name in ("output", "input") else output) / "input" / project.slug
    else:
        base = settings.get_project_dir(project.slug)
    base = base.expanduser().resolve(strict=False)
    return safe_folder_child(base, folder_name).resolve(strict=False) if folder_name else base
