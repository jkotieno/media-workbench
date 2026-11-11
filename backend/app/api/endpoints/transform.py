from __future__ import annotations

import base64
import copy
import hashlib
import json
import math
import os
import re
import shutil
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any, Literal, Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from PIL import Image as PILImage, ImageOps
from PIL import PngImagePlugin
from sqlmodel import SQLModel, Session, select

from app.core.config import settings
from app.db.database import get_session
from app.models.engine import Engine
from app.models.image import Image, image_metadata_for_read
from app.models.project import Project
from app.services import project_folder_context, project_media_views
from app.services.transform_outpainting import normalize_expansion, expansion_frame, validate_frame
from app.services.gallery.image_identity import image_path_identity, upsert_active_image_for_path
from app.services.gallery.metadata import _decode_xp_comment
from app.services.gallery.paths import _resolve_media_path
from app.services.job_processing.media_pipeline import create_thumbnail
from app.services.image_metadata_parser import parse_image_metadata_from_path
from app.services import model_provenance
from app.services.workflow_fingerprint import looks_like_api_graph
from app.services.media_paths import (
    get_project_roots,
    get_project_storage_root_dir,
    infer_project_slug_from_path,
    resolve_project_storage_root,
)

router = APIRouter()

SUPPORTED_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
EXIF_USER_COMMENT_TAG = 0x9286
EXIF_XP_COMMENT_TAG = 0x9C9C
EXIF_ORIENTATION_TAG = 0x0112
EXIF_IMAGE_DESCRIPTION_TAG = 0x010E
EXIF_MODEL_TAG = 0x0110
TRANSFORM_METADATA_KEY = "sweet_tea_transform"
TRANSFORM_SOURCE_USER_COMMENT_KEY = "sweet_tea_source_user_comment"
TRANSFORM_SOURCE_XP_COMMENT_KEY = "sweet_tea_source_xp_comment"
PORTABLE_METADATA_KEY = "sweet_tea_portable_metadata"
# The JPEG APP1 marker holds two bytes of length plus the six-byte EXIF identifier.
MAX_JPEG_EXIF_TIFF_BYTES = 65527
TRANSFORM_SCHEMA_VERSION = 5
TRANSFORM_SAVE_MODE_DEFAULT = "new_copy"
SUPPORTED_FONT_EXTENSIONS = {".otf", ".ttf", ".woff", ".woff2"}
MAX_TRANSFORM_FONT_BYTES = 10 * 1024 * 1024
TRANSFORM_FONT_MANIFEST_FILENAME = "manifest.json"
TransformSaveMode = Literal["new_copy", "overwrite_current"]


class TransformProjectContext(SQLModel):
    id: Optional[int] = None
    slug: Optional[str] = None
    folder: Optional[str] = None
    available_folders: list[str] = []


class TransformSourceImage(SQLModel):
    path: str
    format: Literal["png", "jpg", "jpeg", "webp"]
    width: int
    height: int
    hash: Optional[str] = None


class TransformLaunchResponse(SQLModel):
    action_label: Literal["transform"]
    source_image: TransformSourceImage
    project: TransformProjectContext
    document: Optional[dict[str, Any]] = None
    resolved_source_path: str
    launch_image_path: str


class TransformDocumentRequest(SQLModel):
    document: dict[str, Any]


class TransformDocumentResponse(SQLModel):
    document: dict[str, Any]
    saved_at: str


class TransformExportResponse(SQLModel):
    operation_ref: str | None = None
    state: str | None = None
    source_recipe_revision: Optional[int] = None
    id: Optional[int] = None
    path: str
    filename: str
    project_slug: Optional[str] = None
    folder: Optional[str] = None
    saved_at: str
    mtime: Optional[str] = None
    save_mode: TransformSaveMode
    document_id: Optional[str] = None


class TransformFontInfo(SQLModel):
    id: str
    name: str
    filename: str
    size_bytes: int
    created_at: str


class TransformFontsResponse(SQLModel):
    fonts: list[TransformFontInfo]
    max_bytes: int
    allowed_extensions: list[str]


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_transform_save_mode(value: Optional[str]) -> TransformSaveMode:
    if value is None or value == "" or value == TRANSFORM_SAVE_MODE_DEFAULT:
        return "new_copy"
    if value == "overwrite_current":
        return "overwrite_current"
    raise HTTPException(status_code=400, detail="Invalid transform save mode")


def _same_path(left: Path, right: Path) -> bool:
    try:
        return left.resolve() == right.resolve()
    except Exception:
        return os.path.abspath(str(left)) == os.path.abspath(str(right))


def _normalize_source_image_rotation(value: Any) -> float:
    try:
        raw = float(value)
    except (TypeError, ValueError):
        raw = 0.0
    if not math.isfinite(raw) or raw == 0:
        return 0.0
    normalized = ((raw % 360.0) + 360.0) % 360.0
    if normalized > 180.0:
        normalized -= 360.0
    return round(normalized, 2)


def _normalize_source_image_transform(value: Any) -> dict[str, Any]:
    payload = value if isinstance(value, dict) else {}
    return {
        "rotationDegrees": _normalize_source_image_rotation(payload.get("rotationDegrees")),
        "flipHorizontal": bool(payload.get("flipHorizontal")),
        "flipVertical": bool(payload.get("flipVertical")),
    }


def _transform_fonts_dir() -> Path:
    path = settings.meta_dir / "transform-fonts"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _transform_font_manifest_path() -> Path:
    return _transform_fonts_dir() / TRANSFORM_FONT_MANIFEST_FILENAME


def _coerce_font_record(record: Any) -> Optional[dict[str, Any]]:
    if not isinstance(record, dict):
        return None
    font_id = str(record.get("id") or "").strip()
    name = str(record.get("name") or "").strip()
    filename = Path(str(record.get("filename") or "")).name
    created_at = str(record.get("created_at") or "").strip()
    try:
        size_bytes = int(record.get("size_bytes") or 0)
    except (TypeError, ValueError):
        size_bytes = 0
    if not font_id or not name or not filename:
        return None
    if Path(filename).suffix.lower() not in SUPPORTED_FONT_EXTENSIONS:
        return None
    if not (_transform_fonts_dir() / filename).exists():
        return None
    return {
        "id": font_id,
        "name": name,
        "filename": filename,
        "size_bytes": size_bytes,
        "created_at": created_at or _utc_now_iso(),
    }


def _read_transform_font_records() -> list[dict[str, Any]]:
    manifest_path = _transform_font_manifest_path()
    if not manifest_path.exists():
        return []
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        return []
    records = payload.get("fonts") if isinstance(payload, dict) else payload
    if not isinstance(records, list):
        return []
    return [
        record
        for record in (_coerce_font_record(item) for item in records)
        if record is not None
    ]


def _write_transform_font_records(records: list[dict[str, Any]]) -> None:
    manifest_path = _transform_font_manifest_path()
    payload = {"fonts": sorted(records, key=lambda item: item["name"].lower())}
    temp_path = manifest_path.with_suffix(".tmp")
    temp_path.write_text(json.dumps(payload, ensure_ascii=True, indent=2), encoding="utf-8")
    os.replace(temp_path, manifest_path)


def _transform_font_response(record: dict[str, Any]) -> TransformFontInfo:
    return TransformFontInfo(
        id=str(record["id"]),
        name=str(record["name"]),
        filename=str(record["filename"]),
        size_bytes=int(record.get("size_bytes") or 0),
        created_at=str(record.get("created_at") or _utc_now_iso()),
    )


def _normalize_font_name(filename: str) -> str:
    stem = Path(filename).stem
    normalized = re.sub(r"[_-]+", " ", stem)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized or "Imported font"


def _dedupe_font_name(base_name: str, existing_names: set[str]) -> str:
    candidate = base_name
    suffix = 2
    while candidate in existing_names:
        candidate = f"{base_name} {suffix}"
        suffix += 1
    return candidate


def _build_font_id(display_name: str, font_bytes: bytes) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", display_name.lower()).strip("-") or "font"
    digest = hashlib.sha256(font_bytes).hexdigest()[:12]
    return f"{slug}-{digest}"


def _font_media_type(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    if ext == ".woff2":
        return "font/woff2"
    if ext == ".woff":
        return "font/woff"
    if ext == ".otf":
        return "font/otf"
    return "font/ttf"


def _resolve_project_for_slug(project_slug: Optional[str], session: Session) -> Optional[Project]:
    if not project_slug:
        return None
    return session.exec(select(Project).where(Project.slug == project_slug)).first()


def _resolve_image_row(path: str, session: Session) -> Optional[Image]:
    if not path:
        return None
    identity = image_path_identity(path)
    from app.services.gallery.image_lookup import active_images_for_paths
    rows = active_images_for_paths(session, paths=(path,), identities=(identity,))
    return max(rows, key=lambda row: (row.created_at or datetime.min, row.id or 0), default=None)


def _usable_media_path(path: Path, session: Session | None):
    if session is not None:
        row=_resolve_image_row(str(path),session)
        if row is not None:
            from app.services.media_paths import open_media_file, resolve_media_file
            if row.cloud_reference:
                try:
                    actual, stream = open_media_file(session, str(path))
                    stream.close()
                    return Path(actual)
                except FileNotFoundError:
                    return None
            usable=resolve_media_file(row,session)
            return Path(usable) if usable else None
    return path if path.is_file() else None


def _read_image_info(path: Path, session: Session | None = None) -> TransformSourceImage:
    ext = path.suffix.lower()
    if ext not in SUPPORTED_IMAGE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="transform only supports PNG, JPG, JPEG, and WEBP images.")
    try:
        if session is not None:
            from app.services.media_paths import open_media_file
            _physical, stream = open_media_file(session,str(path))
        else:
            stream = path.open("rb")
        with stream:
            import stat
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise HTTPException(status_code=404, detail="Source image not found")
            digest = hashlib.file_digest(stream,"sha256").hexdigest()
            stream.seek(0)
            with PILImage.open(stream) as image:
                width, height = ImageOps.exif_transpose(image).size
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Source image not found") from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to inspect source image: {exc}") from exc
    return TransformSourceImage(
        path=str(path),
        format=ext.lstrip("."),  # type: ignore[arg-type]
        width=width,
        height=height,
        hash=digest,
    )


def _extract_transform_metadata_from_image(path: Path) -> dict[str, Any]:
    try:
        with PILImage.open(path) as image:
            info = image.info or {}
            raw = info.get(TRANSFORM_METADATA_KEY)
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8", errors="ignore")
            if isinstance(raw, str) and raw.strip():
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    return parsed

            exif = None
            try:
                exif = image.getexif()
            except Exception:
                exif = None
            if not exif:
                return {}

            for tag in (EXIF_IMAGE_DESCRIPTION_TAG, EXIF_USER_COMMENT_TAG, EXIF_XP_COMMENT_TAG):
                comment = exif.get(tag)
                decoded = _decode_xp_comment(comment)
                if not decoded:
                    continue
                try:
                    parsed = json.loads(decoded)
                except Exception:
                    continue
                if isinstance(parsed, dict):
                    if TRANSFORM_METADATA_KEY in parsed and isinstance(parsed[TRANSFORM_METADATA_KEY], dict):
                        return parsed[TRANSFORM_METADATA_KEY]
                    return parsed
    except Exception:
        return {}
    return {}


def _resolve_transform_lineage(path: Path, session: Session) -> dict[str, Any]:
    image_row = _resolve_image_row(str(path), session)
    if image_row:
        metadata = image_metadata_for_read(image_row) or {}
        transform_payload = metadata.get("transform")
        if isinstance(transform_payload, dict):
            return transform_payload
    return _extract_transform_metadata_from_image(_usable_media_path(path,session) or path)


def _resolve_source_image_path(launch_path: Path, session: Session) -> Path:
    transform_payload = _resolve_transform_lineage(launch_path, session)
    candidate = transform_payload.get("source_image_path") if isinstance(transform_payload, dict) else None
    if isinstance(candidate, str) and candidate.strip():
        source_path = Path(candidate)
        if _usable_media_path(source_path,session) is not None:
            return source_path
    return launch_path


def _row_extra_metadata(row: Optional[Image]) -> dict[str, Any]:
    metadata = image_metadata_for_read(row) if row else None
    return copy.deepcopy(metadata) if isinstance(metadata, dict) else {}


def _merge_missing_metadata(target: dict[str, Any], source: dict[str, Any]) -> None:
    for key, value in source.items():
        if key not in target:
            target[key] = copy.deepcopy(value)


def _transform_history_from_metadata(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    history: list[dict[str, Any]] = []
    raw_history = metadata.get("transform_history")
    if isinstance(raw_history, list):
        for entry in raw_history:
            if isinstance(entry, dict):
                history.append(copy.deepcopy(entry))
    elif isinstance(metadata.get("transform"), dict):
        history.append(copy.deepcopy(metadata["transform"]))
    return history


def _resolve_optional_launch_path(value: Optional[str], fallback: Path, session: Session) -> Path:
    if not isinstance(value, str) or not value.strip():
        return fallback
    candidate=Path(value)
    if _resolve_image_row(value,session) is not None and _usable_media_path(candidate,session) is not None:
        return candidate
    resolved = _resolve_media_path(value, session)
    if resolved:
        return Path(resolved)
    candidate = Path(value)
    return candidate if candidate.exists() else fallback


def _resolve_overwrite_launch_path(value: Optional[str], fallback: Path, session: Session) -> Path:
    if not isinstance(value, str) or not value.strip():
        return fallback
    candidate=Path(value)
    if _resolve_image_row(value,session) is not None and _usable_media_path(candidate,session) is not None:
        return candidate
    resolved = _resolve_media_path(value, session)
    if resolved:
        return Path(resolved)
    candidate = Path(value)
    if candidate.exists():
        return candidate
    raise HTTPException(status_code=404, detail="Current transform image not found for overwrite")


def _build_export_extra_metadata(
    *,
    source_image_row: Optional[Image],
    launch_image_row: Optional[Image],
    transform_payload: dict[str, Any],
) -> dict[str, Any]:
    source_metadata = _row_extra_metadata(source_image_row)
    launch_metadata = _row_extra_metadata(launch_image_row)
    extra_metadata = copy.deepcopy(launch_metadata or source_metadata)
    _merge_missing_metadata(extra_metadata, source_metadata)

    history = _transform_history_from_metadata(extra_metadata)
    history.append(copy.deepcopy(transform_payload))
    extra_metadata["transform"] = copy.deepcopy(transform_payload)
    extra_metadata["transform_history"] = history
    return extra_metadata


def _infer_project_slug(path: Path, session: Session) -> Optional[str]:
    engines = session.exec(select(Engine)).all()
    projects = session.exec(select(Project)).all()
    return infer_project_slug_from_path(path, engines, projects=projects)


def _infer_folder(
    path: Path,
    project: Optional[Project],
    engines: Optional[list[Engine]] = None,
) -> Optional[str]:
    if not project:
        return None
    storage_root_dir = get_project_storage_root_dir(project)
    engine_candidates: list[Optional[Engine]] = list(engines or [])
    if not engine_candidates:
        engine_candidates = [None]

    project_roots: list[Path] = []
    seen_roots: set[str] = set()
    for engine in engine_candidates:
        for root in get_project_roots(
            engine=engine,
            project_slug=project.slug,
            project_storage_root_dir=storage_root_dir,
        ):
            root_key = str(root.resolve())
            if root_key in seen_roots:
                continue
            seen_roots.add(root_key)
            project_roots.append(root)

    for project_root in project_roots:
        try:
            relative = path.resolve().relative_to(project_root.resolve())
        except Exception:
            continue
        parts = [part for part in relative.parts if part]
        if len(parts) <= 1:
            return None
        return parts[0]
    return None


def _project_storage_root(project: Project) -> Path:
    custom_root = resolve_project_storage_root(
        project_slug=project.slug,
        project_storage_root_dir=get_project_storage_root_dir(project),
    )
    return custom_root or settings.get_project_dir(project.slug)


def _file_mtime_iso(path: Path) -> Optional[str]:
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()
    except OSError:
        return None


def _document_dir_for_project(project_slug: Optional[str], source_path: Path) -> Path:
    if project_slug:
        return settings.get_project_dir(project_slug) / "transform"
    return source_path.parent / ".sweet-tea-transform"


def _document_path_for_source(source_path: Path, project_slug: Optional[str]) -> Path:
    digest = hashlib.sha256(str(source_path).encode("utf-8")).hexdigest()[:10]
    stem = source_path.stem or "image"
    return _document_dir_for_project(project_slug, source_path) / f"{stem}_{digest}.transform.json"


def _paint_asset_dir_for_document(document_path: Path) -> Path:
    return document_path.with_name(f"{document_path.stem}.assets") / "paint"


def _image_asset_dir_for_document(document_path: Path) -> Path:
    return document_path.with_name(f"{document_path.stem}.assets") / "image"


def _mask_asset_dir_for_document(document_path: Path) -> Path:
    return document_path.with_name(f"{document_path.stem}.assets") / "mask"


def _sanitize_asset_id(value: str) -> str:
    sanitized = re.sub(r"[^A-Za-z0-9_.-]+", "_", value).strip("._")
    return sanitized or uuid4().hex


def _load_document(source_path: Path, project_slug: Optional[str], session: Session | None = None) -> Optional[dict[str, Any]]:
    document_path = _document_path_for_source(source_path, project_slug)
    if session is not None:
        from app.services.transform_revisions import pending_document
        pending=pending_document(session,document_path)
        if pending is not None:
            return pending
    if not document_path.exists():
        return None
    try:
        payload = json.loads(document_path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else None
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to read transform document: {exc}") from exc


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(json.dumps(payload, ensure_ascii=True, indent=2), encoding="utf-8")
    os.replace(temp_path, path)


def _clear_document_assets(document_path: Path) -> None:
    from app.services.transform_revisions import history_dir
    if history_dir(document_path).exists():
        return  # Saved revisions still own these immutable layer files.
    asset_root = document_path.with_name(f"{document_path.stem}.assets")
    if asset_root.exists():
        shutil.rmtree(asset_root, ignore_errors=True)


def _decode_image_data_url(value: str) -> Optional[bytes]:
    match = re.match(r"^data:image/[A-Za-z0-9.+-]+;base64,(?P<data>.+)$", value, re.DOTALL)
    if not match:
        return None
    try:
        return base64.b64decode(match.group("data"), validate=True)
    except Exception:
        return None


def _write_paint_asset(asset_dir: Path, layer_id: str, payload: bytes) -> Path:
    asset_dir.mkdir(parents=True, exist_ok=True)
    asset_path = asset_dir / f"{_sanitize_asset_id(layer_id)[:64]}-{hashlib.sha256(payload).hexdigest()}.png"
    try:
        with PILImage.open(BytesIO(payload)) as image:
            image.convert("RGBA").save(asset_path, format="PNG")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid paint layer asset for {layer_id}") from exc
    return asset_path


def _write_image_asset(asset_dir: Path, layer_id: str, payload: bytes) -> Path:
    asset_dir.mkdir(parents=True, exist_ok=True)
    asset_path = asset_dir / f"{_sanitize_asset_id(layer_id)[:64]}-{hashlib.sha256(payload).hexdigest()}.png"
    try:
        with PILImage.open(BytesIO(payload)) as image:
            image.convert("RGBA").save(asset_path, format="PNG")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid imported image asset for {layer_id}") from exc
    return asset_path


def _persist_paint_layer_assets(
    document: dict[str, Any],
    document_path: Path,
    uploaded_assets: dict[str, bytes],
) -> None:
    edit = document.get("edit") if isinstance(document.get("edit"), dict) else {}
    paint_layers = edit.get("paintLayers") if isinstance(edit.get("paintLayers"), list) else []
    if not paint_layers:
        return

    asset_dir = _paint_asset_dir_for_document(document_path)
    active_asset_names: set[str] = set()
    for layer in paint_layers:
        if not isinstance(layer, dict):
            continue
        layer_id = str(layer.get("id") or "")
        if not layer_id:
            continue
        payload = uploaded_assets.get(layer_id)
        if payload is None and isinstance(layer.get("dataUrl"), str):
            payload = _decode_image_data_url(layer["dataUrl"])
        if payload:
            asset_path = _write_paint_asset(asset_dir, layer_id, payload)
            layer["assetPath"] = str(asset_path)
            layer["dataUrl"] = None
        elif isinstance(layer.get("assetPath"), str) and layer["assetPath"]:
            asset_path = Path(layer["assetPath"])
        else:
            asset_path = asset_dir / f"{_sanitize_asset_id(layer_id)}.png"
        active_asset_names.add(asset_path.name)

    # Referenced by immutable recipe revisions; cleanup is an explicit history operation.


def _persist_image_layer_assets(
    document: dict[str, Any],
    document_path: Path,
    uploaded_assets: dict[str, bytes],
) -> None:
    edit = document.get("edit") if isinstance(document.get("edit"), dict) else {}
    image_layers = edit.get("imageLayers") if isinstance(edit.get("imageLayers"), list) else []
    asset_dir = _image_asset_dir_for_document(document_path)
    active_asset_names: set[str] = set()
    for layer in image_layers:
        if not isinstance(layer, dict):
            continue
        layer_id = str(layer.get("id") or "")
        if not layer_id:
            continue
        payload = uploaded_assets.get(layer_id)
        if payload is None and isinstance(layer.get("dataUrl"), str):
            payload = _decode_image_data_url(layer["dataUrl"])
        if payload:
            asset_path = _write_image_asset(asset_dir, layer_id, payload)
            layer["assetPath"] = str(asset_path)
            layer["dataUrl"] = None
        elif isinstance(layer.get("assetPath"), str) and layer["assetPath"]:
            asset_path = Path(layer["assetPath"])
        else:
            asset_path = asset_dir / f"{_sanitize_asset_id(layer_id)}.png"
        active_asset_names.add(asset_path.name)

    # Referenced by immutable recipe revisions; cleanup is an explicit history operation.


def _persist_mask_draft_asset(
    document: dict[str, Any],
    document_path: Path,
    draft_payload: Optional[bytes],
    clear_draft: bool,
    base_payload: Optional[bytes] = None,
) -> None:
    mask = document.get("mask") if isinstance(document.get("mask"), dict) else {}
    asset_dir = _mask_asset_dir_for_document(document_path)
    draft_path = asset_dir / "draft.png"

    if clear_draft:
        mask["hasDraft"] = False
        mask["coverageAssetPath"] = None
        mask["draftPath"] = None
        mask["baseCoverageAssetPath"] = None
        document["mask"] = mask
        return

    if draft_payload:
        draft_path = asset_dir / f"coverage-{hashlib.sha256(draft_payload).hexdigest()}.png"
        asset_dir.mkdir(parents=True, exist_ok=True)
        try:
            with PILImage.open(BytesIO(draft_payload)) as image:
                # Schema 4 stores mask coverage, not visualization. Keep this
                # single-channel so feathered values round-trip byte-for-byte.
                if image.mode == "RGBA":
                    alpha = image.getchannel("A")
                    grayscale = image.convert("L")
                    if alpha.getextrema() != (255, 255):
                        grayscale = alpha
                else:
                    grayscale = image.convert("L")
                if document.get("edit", {}).get("expansion"):
                    frame = validate_frame(mask.get("coverageFrame"))
                    if grayscale.size != (frame["width"], frame["height"]):
                        raise ValueError("Mask dimensions do not match its saved frame")
                    draft_path = asset_dir / f"coverage-{hashlib.sha256(draft_payload).hexdigest()[:24]}.png"
                grayscale.save(draft_path, format="PNG")
                if base_payload:
                    with PILImage.open(BytesIO(base_payload)) as base:
                        base.load()
                        if base.size != grayscale.size:
                            raise ValueError("Automatic mask dimensions do not match coverage")
                        base_path = asset_dir / f"base-{hashlib.sha256(base_payload).hexdigest()[:24]}.png"
                        base.convert("L").save(base_path, format="PNG")
                        mask["baseCoverageAssetPath"] = str(base_path)
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Invalid mask draft asset") from exc
        mask["hasDraft"] = True
        mask["coverageAssetPath"] = str(draft_path)
        mask["draftPath"] = str(draft_path)
    elif (
        isinstance(mask.get("coverageAssetPath"), str)
        and mask["coverageAssetPath"]
    ):
        mask["hasDraft"] = True
        mask["draftPath"] = mask["coverageAssetPath"]
    elif isinstance(mask.get("draftPath"), str) and mask["draftPath"]:
        mask["hasDraft"] = True
        mask["coverageAssetPath"] = mask["draftPath"]
    else:
        mask["hasDraft"] = False
        mask["coverageAssetPath"] = None
        mask["draftPath"] = None

    document["mask"] = mask


def _normalize_document(document: dict[str, Any], source_image: TransformSourceImage, project: TransformProjectContext) -> dict[str, Any]:
    normalized = copy.deepcopy(document)
    normalized["id"] = str(normalized.get("id") or uuid4())
    normalized["schemaVersion"] = TRANSFORM_SCHEMA_VERSION
    normalized["sourceImage"] = {
        "path": source_image.path,
        "format": source_image.format,
        "width": source_image.width,
        "height": source_image.height,
        "hash": source_image.hash,
    }
    normalized["project"] = {
        "id": project.id,
        "slug": project.slug,
        "folder": project.folder,
    }
    normalized["createdAt"] = str(normalized.get("createdAt") or _utc_now_iso())
    normalized["updatedAt"] = _utc_now_iso()
    legacy_text = normalized.get("text") if isinstance(normalized.get("text"), dict) else {}
    edit = normalized.get("edit") if isinstance(normalized.get("edit"), dict) else {}
    text_objects = edit.get("textObjects") if isinstance(edit.get("textObjects"), list) else legacy_text.get("objects")
    text_layers = edit.get("layers") if isinstance(edit.get("layers"), list) else legacy_text.get("layers")
    if not isinstance(text_objects, list):
        text_objects = []
    if not isinstance(text_layers, list):
        text_layers = []
    normalized["lastUsedMode"] = "mask" if normalized.get("lastUsedMode") == "mask" else "edit"
    crop = edit.get("crop") if isinstance(edit.get("crop"), dict) else {}
    try:
        expansion = normalize_expansion(edit.get("expansion"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    source_image_transform = _normalize_source_image_transform(edit.get("sourceImageTransform"))
    paint_settings = _default_transform_paint_settings()
    if isinstance(edit.get("paintSettings"), dict):
        paint_settings.update(edit["paintSettings"])
    retouch_settings = _default_transform_retouch_settings()
    raw_retouch = edit.get("retouchSettings")
    if isinstance(raw_retouch, dict):
        for key in ("smudge", "pixelate", "fill"):
            if isinstance(raw_retouch.get(key), dict):
                retouch_settings[key].update(raw_retouch[key])

    normalized["edit"] = {
        "lastUsedTool": edit.get("lastUsedTool") if isinstance(edit.get("lastUsedTool"), str) else "select",
        "textObjects": text_objects,
        "paintLayers": edit.get("paintLayers") if isinstance(edit.get("paintLayers"), list) else [],
        "imageLayers": edit.get("imageLayers") if isinstance(edit.get("imageLayers"), list) else [],
        "adjustments": {
            **{
                "brightness": 1,
                "contrast": 1,
                "saturation": 1,
                "hueDegrees": 0,
            },
            **(edit.get("adjustments") if isinstance(edit.get("adjustments"), dict) else {}),
        },
        "paintSettings": paint_settings,
        "retouchSettings": retouch_settings,
        "layers": text_layers,
        "crop": {
            "enabled": bool(crop.get("enabled")),
            "x": crop.get("x", 0),
            "y": crop.get("y", 0),
            "width": crop.get("width", source_image.width),
            "height": crop.get("height", source_image.height),
            "aspectRatio": crop.get("aspectRatio", "free"),
        },
        "sourceImageTransform": source_image_transform,
        "expansion": expansion,
    }
    normalized["text"] = {
        "objects": text_objects,
        "layers": [layer for layer in text_layers if isinstance(layer, dict) and layer.get("kind", "text_object") == "text_object"],
    }
    raw_mask = normalized.get("mask") if isinstance(normalized.get("mask"), dict) else {}
    mask = _default_transform_mask_state()
    mask.update(raw_mask)
    raw_mask_brush = raw_mask.get("brush") if isinstance(raw_mask.get("brush"), dict) else {}
    mask["brush"] = {**_default_transform_mask_state()["brush"], **raw_mask_brush}
    legacy_draft_path = raw_mask.get("draftPath") if isinstance(raw_mask.get("draftPath"), str) else None
    coverage_asset_path = (
        raw_mask.get("coverageAssetPath")
        if isinstance(raw_mask.get("coverageAssetPath"), str)
        else legacy_draft_path
    )
    try:
        mask["coverageFrame"] = validate_frame(raw_mask["coverageFrame"]) if raw_mask.get("coverageFrame") else {"x": 0, "y": 0, "width": source_image.width, "height": source_image.height}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    mask["coverageAssetPath"] = coverage_asset_path
    mask["draftPath"] = coverage_asset_path
    mask["hasDraft"] = bool(raw_mask.get("hasDraft") or coverage_asset_path)
    if raw_mask.get("paintedPixels") not in {"white", "black"}:
        mask["paintedPixels"] = "black" if raw_mask.get("invertOutput") else "white"
    mask.pop("invertOutput", None)
    normalized["mask"] = mask
    return normalized


def _default_transform_paint_settings() -> dict[str, Any]:
    return {
        "activeColor": "#ef4444",
        "recentColors": ["#ef4444", "#000000", "#ffffff"],
        "pencilThicknessPx": 4,
        "brushThicknessPx": 24,
        "eraserThicknessPx": 32,
        "eraserTarget": "paint",
        "brushOpacity": 1,
        "brushHardness": 1,
        "brushFlow": 1,
        "brushSpacing": 0.18,
        "brushSmoothing": 0.35,
        "pencilSmoothing": 0,
        "eraserHardness": 1,
        "eraserOpacity": 1,
        "fillOpacity": 1,
        "eyedropperSampleMerged": True,
        "pressureSize": False,
        "pressureOpacity": False,
    }


def _default_transform_retouch_settings() -> dict[str, Any]:
    return {
        "smudge": {
            "sizePx": 48,
            "hardness": 0.65,
            "strength": 0.48,
            "sampleMerged": True,
            "pressureStrength": False,
        },
        "pixelate": {
            "brushSizePx": 96,
            "blockSizePx": 16,
            "footprint": "round",
            "sampleMerged": True,
            "featherPx": 0,
            "interactionMode": "brush",
        },
        "fill": {
            "tolerance": 32,
            "contiguous": True,
            "sampleMerged": True,
        },
    }


def _default_transform_mask_state() -> dict[str, Any]:
    return {
        "hasDraft": False,
        "coverageAssetPath": None,
        "draftPath": None,
        "overlayColor": "#16b8d4",
        "overlayOpacity": 0.55,
        "viewMode": "overlay",
        "paintedPixels": "white",
        "lastTool": "add",
        "brush": {
            "sizePx": 64,
            "hardness": 0.75,
            "strength": 1,
            "featherPx": 0,
            "smoothing": 0.3,
        },
        "fillTolerance": 32,
        "proposedFilename": None,
    }


def _default_transform_crop(source_image: TransformSourceImage) -> dict[str, Any]:
    return {
        "enabled": False,
        "x": 0,
        "y": 0,
        "width": source_image.width,
        "height": source_image.height,
        "aspectRatio": "free",
    }


def _create_clean_transform_document(
    *,
    source_image: TransformSourceImage,
    project: TransformProjectContext,
) -> dict[str, Any]:
    return _normalize_document(
        {
            "lastUsedMode": "edit",
            "edit": {
                "lastUsedTool": "select",
                "textObjects": [],
                "paintLayers": [],
                "imageLayers": [],
                "adjustments": {
                    "brightness": 1,
                    "contrast": 1,
                    "saturation": 1,
                    "hueDegrees": 0,
                },
                "paintSettings": _default_transform_paint_settings(),
                "layers": [],
                "crop": _default_transform_crop(source_image),
                "sourceImageTransform": _normalize_source_image_transform(None),
            },
            "text": {
                "objects": [],
                "layers": [],
            },
            "mask": _default_transform_mask_state(),
        },
        source_image,
        project,
    )


def _resolve_project_context(source_path: Path, session: Session) -> TransformProjectContext:
    project_slug = _infer_project_slug(source_path, session)
    project = _resolve_project_for_slug(project_slug, session)
    engines = session.exec(select(Engine)).all()
    available_folders: list[str] = []
    if project:
        raw_folders = project_folder_context.project_config_with_virtual_folder(
            project=project,
            active_engine=None,
        ).get("folders")
        if isinstance(raw_folders, list):
            available_folders = [
                str(folder).strip()
                for folder in raw_folders
                if isinstance(folder, str) and str(folder).strip()
            ]
    return TransformProjectContext(
        id=project.id if project and project.id is not None else None,
        slug=project.slug if project else project_slug,
        folder=_infer_folder(source_path, project, engines),
        available_folders=available_folders,
    )


def _base_export_stem(path: Path) -> str:
    return path.stem or "image"


def _next_export_path(
    naming_source_path: Path,
    target_dir: Path,
    requested_filename: Optional[str] = None,
    force_png: bool = False,
) -> Path:
    stem = _base_export_stem(naming_source_path)
    suffix = naming_source_path.suffix.lower() or ".png"
    if requested_filename:
        safe_requested = Path(requested_filename.replace("\\", "/")).name.strip()
        requested_path = Path(safe_requested)
        if requested_path.stem:
            stem = requested_path.stem
        if requested_path.suffix.lower() in SUPPORTED_IMAGE_EXTENSIONS:
            suffix = requested_path.suffix.lower()
    if force_png:
        suffix = ".png"
    first_candidate = target_dir / f"{stem}{suffix}"
    if requested_filename and not first_candidate.exists():
        return first_candidate
    counter = 1
    while True:
        candidate = target_dir / (
            f"{stem}_{counter:04d}{suffix}"
            if requested_filename
            else f"{stem}_transform_{counter:04d}{suffix}"
        )
        if not candidate.exists():
            return candidate
        counter += 1


def _stable_effect_export_path(
    naming_source_path: Path,
    target_dir: Path,
    *,
    side_effect_key: str,
    requested_filename: Optional[str] = None,
    force_png: bool = False,
) -> Path:
    stem = _base_export_stem(naming_source_path)
    suffix = naming_source_path.suffix.lower() or ".png"
    if requested_filename:
        safe_requested = Path(requested_filename.replace("\\", "/")).name.strip()
        requested_path = Path(safe_requested)
        if requested_path.stem:
            stem = requested_path.stem
        if requested_path.suffix.lower() in SUPPORTED_IMAGE_EXTENSIONS:
            suffix = requested_path.suffix.lower()
    if force_png:
        suffix = ".png"
    digest = hashlib.sha256(side_effect_key.encode("utf-8")).hexdigest()[:20]
    return target_dir / f"{stem}__sts_{digest}{suffix}"


def _transform_document_requires_alpha(document: dict[str, Any]) -> bool:
    edit = document.get("edit") if isinstance(document.get("edit"), dict) else {}
    paint_layers = edit.get("paintLayers") if isinstance(edit.get("paintLayers"), list) else []
    layer_entries = edit.get("layers") if isinstance(edit.get("layers"), list) else []
    source_eraser_ids = {
        str(layer.get("id"))
        for layer in paint_layers
        if isinstance(layer, dict) and layer.get("role") == "source_eraser"
    }
    return any(
        isinstance(layer, dict)
        and layer.get("visible") is not False
        and str(layer.get("refId")) in source_eraser_ids
        for layer in layer_entries
    )


def _json_object(value: Any) -> dict[str, Any]:
    if not isinstance(value, (str, bytes)):
        return {}
    try:
        result = json.loads(value)
    except (ValueError, UnicodeError):
        return {}
    return result if isinstance(result, dict) else {}


def _portable_source_metadata(source_image: PILImage.Image) -> dict[str, str]:
    """Recover native ComfyUI/A1111 fields before converting an image's format."""
    info = source_image.info or {}
    portable = {
        key: info[key]
        for key in ("prompt", "workflow", "parameters", "sweet_tea_provenance")
        if isinstance(info.get(key), str) and info[key]
    }
    exif = source_image.getexif()
    description = _json_object(exif.get(EXIF_IMAGE_DESCRIPTION_TAG))
    embedded = description.get(PORTABLE_METADATA_KEY)
    if isinstance(embedded, dict):
        for key, value in embedded.items():
            if key in {"prompt", "workflow", "parameters", "sweet_tea_provenance"} and isinstance(value, str):
                portable.setdefault(key, value)

    user_comment = _decode_xp_comment(exif.get(EXIF_USER_COMMENT_TAG))
    if not user_comment:
        try:
            user_comment = _decode_xp_comment(exif.get_ifd(0x8769).get(EXIF_USER_COMMENT_TAG))
        except (ValueError, KeyError, TypeError):
            pass
    xp_comment = _decode_xp_comment(exif.get(EXIF_XP_COMMENT_TAG))
    legacy = _json_object(user_comment)
    if isinstance(legacy.get(TRANSFORM_SOURCE_USER_COMMENT_KEY), str):
        user_comment = legacy[TRANSFORM_SOURCE_USER_COMMENT_KEY]
    if isinstance(legacy.get(TRANSFORM_SOURCE_XP_COMMENT_KEY), str):
        xp_comment = legacy[TRANSFORM_SOURCE_XP_COMMENT_KEY]
    if user_comment and ("Steps: " in user_comment or "Negative prompt:" in user_comment):
        portable.setdefault("parameters", user_comment)
    for key in ("Parameters", "Comment", "Description"):
        value = info.get(key)
        if isinstance(value, str) and "Steps: " in value:
            portable.setdefault("parameters", value)

    provenance = _json_object(xp_comment)
    if provenance.get("schema") == "sweet_tea_provenance":
        portable.setdefault("sweet_tea_provenance", xp_comment)

    # Larger graphs may travel in a companion sidecar when JPEG APP1 cannot fit them.
    path = getattr(source_image, "filename", None)
    if isinstance(path, str) and path:
        sidecar_path = Path(path).with_suffix(".json")
        try:
            sidecar = (
                _json_object(sidecar_path.read_text(encoding="utf-8"))
                if sidecar_path.stat().st_size <= 8 * 1024 * 1024 else {}
            )
        except (OSError, UnicodeError):
            sidecar = {}
        sidecar_portable = sidecar.get(PORTABLE_METADATA_KEY)
        if isinstance(sidecar_portable, dict):
            for key, value in sidecar_portable.items():
                if key in {"prompt", "workflow", "parameters", "sweet_tea_provenance"} and isinstance(value, str):
                    portable.setdefault(key, value)
        if sidecar.get("schema") == "sweet_tea_provenance":
            portable.setdefault("sweet_tea_provenance", json.dumps(sidecar, ensure_ascii=False))

    provenance = _json_object(portable.get("sweet_tea_provenance"))
    execution = provenance.get("source_execution")
    execution = execution if isinstance(execution, dict) else {}
    executed_graph = execution.get("execution_graph")
    saved_graph = execution.get("graph_json")
    if not isinstance(executed_graph, dict) or not looks_like_api_graph(executed_graph):
        executed_graph = saved_graph if looks_like_api_graph(saved_graph) else None
    if executed_graph:
        portable.setdefault("prompt", json.dumps(executed_graph, ensure_ascii=False))
    if isinstance(saved_graph, dict):
        portable.setdefault("workflow", json.dumps(saved_graph, ensure_ascii=False))

    # Derive A1111 infotext from actual recorded parameters/graphs when it was
    # not embedded (common for raw ComfyUI PNGs). Never invent a step count.
    if "Steps: " not in portable.get("parameters", "") and isinstance(path, str) and path:
        parsed = parse_image_metadata_from_path(path)
        params = {
            **(execution.get("parameters") if isinstance(execution.get("parameters"), dict) else {}),
            **(provenance.get("params") if isinstance(provenance.get("params"), dict) else {}),
            **parsed.parameters,
        }
        raw_resources = provenance.get("resources")
        resources = parsed.resources or (raw_resources if isinstance(raw_resources, list) else [])
        generated = model_provenance.build_automatic1111_parameters(
            positive_prompt=parsed.prompt or parsed.comment_prompt or str(provenance.get("positive_prompt") or ""),
            negative_prompt=parsed.negative_prompt or parsed.comment_negative_prompt or str(provenance.get("negative_prompt") or ""),
            params=params,
            graph=executed_graph or parsed.workflow_graph or {},
            resources=resources,
        )
        if generated.strip() and ("Steps: " in generated or not portable.get("parameters")):
            portable["parameters"] = generated
    return portable


def _apply_png_metadata(
    source_image: PILImage.Image,
    exported_image: PILImage.Image,
    transform_payload: dict[str, Any],
    output_path: Path,
    portable: dict[str, str],
) -> None:
    # PNG text chunks are the standard interchange format for ComfyUI graphs
    # and Civitai/A1111 generation parameters. Preserve source text as well.
    text_chunks = {
        key: value for key, value in (source_image.info or {}).items()
        if key != TRANSFORM_METADATA_KEY and isinstance(value, str)
    }
    text_chunks.update(portable)
    text_chunks[TRANSFORM_METADATA_KEY] = json.dumps(transform_payload, ensure_ascii=True)
    png_info = PngImagePlugin.PngInfo()
    for key, value in text_chunks.items():
        png_info.add_text(key, value)
    exported_image.save(output_path, format="PNG", pnginfo=png_info)


def _build_exif_with_transform(
    source_image: PILImage.Image,
    transform_payload: dict[str, Any],
    portable: dict[str, str],
    *,
    jpeg: bool,
) -> tuple[bytes, Optional[dict[str, Any]]]:
    exif = source_image.getexif()
    # The pixels were already transposed by the rendering path.
    exif.pop(EXIF_ORIENTATION_TAG, None)

    parameters = portable.get("parameters")
    if parameters:
        exif[EXIF_USER_COMMENT_TAG] = model_provenance.encode_exif_user_comment(parameters)
    elif TRANSFORM_METADATA_KEY in _json_object(_decode_xp_comment(exif.get(EXIF_USER_COMMENT_TAG))):
        # A legacy Transform envelope isn't an EXIF generation comment.
        exif.pop(EXIF_USER_COMMENT_TAG, None)

    provenance = portable.get("sweet_tea_provenance")
    if provenance:
        exif[EXIF_XP_COMMENT_TAG] = provenance.encode("utf-16-le") + b"\x00\x00"

    previous_description = exif.get(EXIF_IMAGE_DESCRIPTION_TAG)
    description = _json_object(previous_description)
    envelope: dict[str, Any] = {TRANSFORM_METADATA_KEY: transform_payload}
    if previous_description and not description.get(TRANSFORM_METADATA_KEY):
        envelope["sweet_tea_source_description"] = (
            previous_description.decode("utf-8", errors="replace")
            if isinstance(previous_description, bytes) else str(previous_description)
        )
    graphs = {key: portable[key] for key in ("prompt", "workflow") if portable.get(key)}
    if graphs:
        envelope[PORTABLE_METADATA_KEY] = graphs
    exif[EXIF_IMAGE_DESCRIPTION_TAG] = json.dumps(envelope, ensure_ascii=True)

    # Civitai recognizes a ComfyUI "prompt:" graph in EXIF Model when the image
    # has no A1111 Steps field. This also covers legitimate samplerless graphs.
    if "Steps: " not in (parameters or ""):
        prompt = _json_object(portable.get("prompt"))
        if looks_like_api_graph(prompt):
            from app.services.tea_package import sanitize_workflow_for_shareable

            public_graph = sanitize_workflow_for_shareable(prompt)
            candidate = "prompt:" + json.dumps(public_graph, ensure_ascii=True)
            if len(candidate.encode("ascii")) <= 32_000:
                exif[EXIF_MODEL_TAG] = candidate

    sidecar: Optional[dict[str, Any]] = None
    if jpeg and len(exif.tobytes()) > MAX_JPEG_EXIF_TIFF_BYTES:
        # Preserve large graphs in a local sidecar rather than making JPEG saving
        # fail or stuffing invalid oversized EXIF into the image.
        sidecar = _json_object(provenance)
        sidecar[PORTABLE_METADATA_KEY] = portable
        sidecar[TRANSFORM_METADATA_KEY] = transform_payload
        envelope.pop(PORTABLE_METADATA_KEY, None)
        exif[EXIF_IMAGE_DESCRIPTION_TAG] = json.dumps(envelope, ensure_ascii=True)
        if len(exif.tobytes()) > MAX_JPEG_EXIF_TIFF_BYTES:
            exif.pop(EXIF_MODEL_TAG, None)
        if len(exif.tobytes()) > MAX_JPEG_EXIF_TIFF_BYTES:
            exif.pop(EXIF_XP_COMMENT_TAG, None)
        if len(exif.tobytes()) > MAX_JPEG_EXIF_TIFF_BYTES:
            exif.pop(EXIF_USER_COMMENT_TAG, None)
        if len(exif.tobytes()) > MAX_JPEG_EXIF_TIFF_BYTES:
            raise HTTPException(status_code=400, detail="Source EXIF exceeds JPEG metadata capacity")
    return exif.tobytes(), sidecar


def _save_exported_image(
    *,
    source_path: Path,
    export_bytes: bytes,
    output_path: Path,
    document: dict[str, Any],
    transform_payload: dict[str, Any],
    render_geometry: Optional[dict[str, Any]] = None,
) -> tuple[int, int]:
    with PILImage.open(source_path) as source_image:
        source_image.load()
        portable = _portable_source_metadata(source_image)
        with PILImage.open(BytesIO(export_bytes)) as exported_image:
            exported_image = ImageOps.exif_transpose(exported_image)
            exported_image.load()
            edit_payload = document.get("edit") if isinstance(document.get("edit"), dict) else {}
            crop_payload = edit_payload.get("crop") if isinstance(edit_payload.get("crop"), dict) else {}
            render_offset_x = 0.0
            render_offset_y = 0.0
            if isinstance(render_geometry, dict):
                try:
                    render_offset_x = float(render_geometry.get("offsetX") or 0.0)
                    render_offset_y = float(render_geometry.get("offsetY") or 0.0)
                except (TypeError, ValueError):
                    raise HTTPException(status_code=400, detail="Invalid transform render geometry")
            if edit_payload.get("expansion"):
                frame = expansion_frame(normalize_expansion(edit_payload["expansion"]))
                if exported_image.size != (frame["width"], frame["height"]):
                    raise HTTPException(status_code=400, detail="Export dimensions do not match the expanded frame")
            if crop_payload.get("enabled") and not edit_payload.get("expansion"):
                try:
                    crop_x = max(0, min(int(round(float(crop_payload.get("x", 0)) + render_offset_x)), exported_image.width - 1))
                    crop_y = max(0, min(int(round(float(crop_payload.get("y", 0)) + render_offset_y)), exported_image.height - 1))
                    crop_width = max(1, min(int(round(float(crop_payload.get("width", exported_image.width)))), exported_image.width - crop_x))
                    crop_height = max(1, min(int(round(float(crop_payload.get("height", exported_image.height)))), exported_image.height - crop_y))
                except (TypeError, ValueError):
                    raise HTTPException(status_code=400, detail="Invalid transform crop bounds")
                exported_image = exported_image.crop((crop_x, crop_y, crop_x + crop_width, crop_y + crop_height))
            width, height = exported_image.size
            ext = output_path.suffix.lower()
            save_kwargs: dict[str, Any] = {}
            if ext == ".png":
                _apply_png_metadata(source_image, exported_image, transform_payload, output_path, portable)
                return width, height

            if ext in {".jpg", ".jpeg"}:
                if exported_image.mode in {"RGBA", "LA"} or (
                    exported_image.mode == "P" and "transparency" in exported_image.info
                ):
                    flattened = PILImage.new("RGB", exported_image.size, (255, 255, 255))
                    flattened.paste(exported_image.convert("RGBA"), mask=exported_image.convert("RGBA").getchannel("A"))
                    exported_image = flattened
                elif exported_image.mode not in {"RGB", "L"}:
                    exported_image = exported_image.convert("RGB")
                save_kwargs["quality"] = 95
                save_kwargs["optimize"] = True
                save_kwargs["exif"], sidecar = _build_exif_with_transform(source_image, transform_payload, portable, jpeg=True)
                icc_profile = source_image.info.get("icc_profile")
                if icc_profile:
                    save_kwargs["icc_profile"] = icc_profile
                exported_image.save(output_path, format="JPEG", **save_kwargs)
                if sidecar is not None:
                    _write_json(output_path.with_suffix(".json"), sidecar)
                return width, height

            if ext == ".webp":
                if exported_image.mode not in {"RGB", "RGBA", "L"}:
                    exported_image = exported_image.convert("RGBA")
                save_kwargs["quality"] = 95
                save_kwargs["method"] = 6
                save_kwargs["exif"], _ = _build_exif_with_transform(source_image, transform_payload, portable, jpeg=False)
                icc_profile = source_image.info.get("icc_profile")
                if icc_profile:
                    save_kwargs["icc_profile"] = icc_profile
                exported_image.save(output_path, format="WEBP", **save_kwargs)
                return width, height

    raise HTTPException(status_code=400, detail="Unsupported export format")


@router.get("/fonts", response_model=TransformFontsResponse)
def list_transform_fonts():
    records = _read_transform_font_records()
    return TransformFontsResponse(
        fonts=[_transform_font_response(record) for record in records],
        max_bytes=MAX_TRANSFORM_FONT_BYTES,
        allowed_extensions=sorted(SUPPORTED_FONT_EXTENSIONS),
    )


@router.post("/fonts", response_model=TransformFontInfo)
async def import_transform_font(file: UploadFile = File(...)):
    source_filename = Path(file.filename or "").name
    ext = Path(source_filename).suffix.lower()
    if ext not in SUPPORTED_FONT_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Choose a .ttf, .otf, .woff, or .woff2 font file.")

    font_bytes = await file.read(MAX_TRANSFORM_FONT_BYTES + 1)
    if not font_bytes:
        raise HTTPException(status_code=400, detail="Font file is empty.")
    if len(font_bytes) > MAX_TRANSFORM_FONT_BYTES:
        raise HTTPException(status_code=413, detail="Font file is too large.")

    records = _read_transform_font_records()
    existing_names = {str(record["name"]) for record in records}
    display_name = _dedupe_font_name(_normalize_font_name(source_filename), existing_names)
    font_id = _build_font_id(display_name, font_bytes)
    stored_filename = f"{font_id}{ext}"
    storage_path = _transform_fonts_dir() / stored_filename
    storage_path.write_bytes(font_bytes)

    record = {
        "id": font_id,
        "name": display_name,
        "filename": stored_filename,
        "size_bytes": len(font_bytes),
        "created_at": _utc_now_iso(),
    }
    next_records = [item for item in records if item["id"] != font_id]
    next_records.append(record)
    _write_transform_font_records(next_records)
    return _transform_font_response(record)


@router.get("/fonts/{font_id}/file")
def get_transform_font_file(font_id: str):
    records = _read_transform_font_records()
    record = next((item for item in records if item["id"] == font_id), None)
    if record is None:
        raise HTTPException(status_code=404, detail="Transform font not found")
    filename = Path(str(record["filename"])).name
    font_path = _transform_fonts_dir() / filename
    if not font_path.exists() or not font_path.is_file():
        raise HTTPException(status_code=404, detail="Transform font file not found")
    return FileResponse(
        font_path,
        media_type=_font_media_type(filename),
        filename=filename,
    )


@router.delete("/fonts/{font_id}", status_code=204)
def delete_transform_font(font_id: str):
    records = _read_transform_font_records()
    record = next((item for item in records if item["id"] == font_id), None)
    if record is None:
        raise HTTPException(status_code=404, detail="Transform font not found")
    filename = Path(str(record["filename"])).name
    font_path = _transform_fonts_dir() / filename
    if font_path.exists():
        font_path.unlink()
    _write_transform_font_records([item for item in records if item["id"] != font_id])
    return None


@router.get("/launch", response_model=TransformLaunchResponse)
def get_transform_launch(
    image_path: str,
    session: Session = Depends(get_session),
):
    launch_path = Path(image_path)
    if _resolve_image_row(image_path,session) is None and not launch_path.exists():
        resolved_path = _resolve_media_path(image_path, session)
        if resolved_path:
            launch_path = Path(resolved_path)
    if _usable_media_path(launch_path,session) is None:
        raise HTTPException(status_code=404, detail="Image not found")
    source_path = _resolve_source_image_path(launch_path, session)
    source_image = _read_image_info(source_path,session)
    project = _resolve_project_context(source_path, session)
    document = _load_document(source_path, project.slug, session)
    if document is None:
        from app.services.transform_revisions import hydrate
        document = hydrate(session, source_path, _document_path_for_source(source_path, project.slug), source_image.hash)
    return TransformLaunchResponse(
        action_label="transform",
        source_image=source_image,
        project=project,
        document=document,
        resolved_source_path=str(source_path),
        launch_image_path=str(launch_path),
    )


@router.post("/documents", response_model=TransformDocumentResponse)
async def upsert_transform_document(
    request: Request,
    session: Session = Depends(get_session),
):
    content_type = request.headers.get("content-type", "")
    uploaded_assets: dict[str, bytes] = {}
    uploaded_image_assets: dict[str, bytes] = {}
    mask_draft_payload: Optional[bytes] = None
    mask_base_payload: Optional[bytes] = None
    clear_mask_draft = False
    if content_type.startswith("multipart/form-data"):
        form = await request.form()
        raw_document = form.get("document_json")
        if not isinstance(raw_document, str):
            raise HTTPException(status_code=400, detail="transform document multipart payload is missing document_json")
        try:
            document = json.loads(raw_document)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail=f"Invalid transform document JSON: {exc}") from exc
        layer_ids = [value for value in form.getlist("paint_layer_id") if isinstance(value, str)]
        layer_files = form.getlist("paint_layer_file")
        if len(layer_ids) != len(layer_files):
            raise HTTPException(status_code=400, detail="paint layer asset manifest does not match uploaded files")
        for layer_id, layer_file in zip(layer_ids, layer_files):
            if not hasattr(layer_file, "read"):
                raise HTTPException(status_code=400, detail=f"paint layer asset for {layer_id} is not a file")
            uploaded_assets[layer_id] = await layer_file.read()
        image_layer_ids = [value for value in form.getlist("image_layer_id") if isinstance(value, str)]
        image_layer_files = form.getlist("image_layer_file")
        if len(image_layer_ids) != len(image_layer_files):
            raise HTTPException(status_code=400, detail="image layer asset manifest does not match uploaded files")
        for layer_id, layer_file in zip(image_layer_ids, image_layer_files):
            if not hasattr(layer_file, "read"):
                raise HTTPException(status_code=400, detail=f"image layer asset for {layer_id} is not a file")
            uploaded_image_assets[layer_id] = await layer_file.read()
        mask_draft_file = form.get("mask_draft_file")
        if mask_draft_file is not None:
            if not hasattr(mask_draft_file, "read"):
                raise HTTPException(status_code=400, detail="mask draft asset is not a file")
            mask_draft_payload = await mask_draft_file.read()
        mask_base_file = form.get("mask_base_file")
        if mask_base_file is not None:
            if not hasattr(mask_base_file, "read"):
                raise HTTPException(status_code=400, detail="Invalid automatic mask asset")
            mask_base_payload = await mask_base_file.read()
        clear_mask_draft = str(form.get("mask_draft_clear") or "").lower() == "true"
    else:
        payload = await request.json()
        if not isinstance(payload, dict) or not isinstance(payload.get("document"), dict):
            raise HTTPException(status_code=400, detail="transform document payload must include document")
        document = payload["document"]

    # Parse the request asynchronously, then own the Session and all native
    # image/file work on one worker thread. No live transaction crosses threads.
    from starlette.concurrency import run_in_threadpool
    return await run_in_threadpool(_save_transform_document, session.get_bind(),
        dict(session.info), document, uploaded_assets, uploaded_image_assets,
        mask_draft_payload, mask_base_payload, clear_mask_draft,
        request.headers.get("X-Studio-Recipe-Revision"))


def _save_transform_document(bind, session_info, document, uploaded_assets,
        uploaded_image_assets, mask_draft_payload, mask_base_payload,
        clear_mask_draft, recipe_revision):
    with Session(bind) as session:
        session.info.update(session_info)
        return _save_transform_document_owned(session, document, uploaded_assets,
            uploaded_image_assets, mask_draft_payload, mask_base_payload,
            clear_mask_draft, recipe_revision)


def _save_transform_document_owned(session, document, uploaded_assets,
        uploaded_image_assets, mask_draft_payload, mask_base_payload,
        clear_mask_draft, recipe_revision):
    source_image_payload = document.get("sourceImage")
    if not isinstance(source_image_payload, dict):
        raise HTTPException(status_code=400, detail="transform document is missing sourceImage")
    source_path_value = source_image_payload.get("path")
    if not isinstance(source_path_value, str) or not source_path_value.strip():
        raise HTTPException(status_code=400, detail="transform document sourceImage.path is required")

    source_path = Path(source_path_value)
    source_image = _read_image_info(source_path,session)
    if source_image_payload.get("hash") and source_image_payload["hash"] != source_image.hash:
        raise HTTPException(409, "The original changed. Reopen Transform before applying this edit.")
    project = _resolve_project_context(source_path, session)
    document_path = _document_path_for_source(source_path, project.slug)
    from app.services import transform_revisions
    try:
        expected = int(recipe_revision if recipe_revision is not None else document.get("recipeRevision", 0))
        if expected < 0:
            raise ValueError()
    except (ValueError, TypeError):
        raise HTTPException(400, "Invalid edit revision.") from None
    try:
        with transform_revisions.admission(document_path, expected, document, session=session) as revision:
            normalized = _normalize_document(document, source_image, project)
            _persist_paint_layer_assets(normalized, document_path, uploaded_assets)
            _persist_image_layer_assets(normalized, document_path, uploaded_image_assets)
            _persist_mask_draft_asset(normalized, document_path, mask_draft_payload, clear_mask_draft, mask_base_payload)
            transform_revisions.commit(session, document_path, normalized, revision, source_path)
    except HTTPException as conflict:
        if conflict.status_code == 409 and isinstance(conflict.detail, dict) and conflict.detail.get("conflict_id"):
            # Uploaded paint/mask bytes belong to the preserved draft too.
            draft = _normalize_document(document, source_image, project)
            _persist_paint_layer_assets(draft, document_path, uploaded_assets)
            _persist_image_layer_assets(draft, document_path, uploaded_image_assets)
            _persist_mask_draft_asset(draft, document_path, mask_draft_payload, clear_mask_draft, mask_base_payload)
            conflict_path = transform_revisions.history_dir(document_path) / ("conflict-" + conflict.detail["conflict_id"] + ".json")
            record = json.loads(conflict_path.read_text())
            record["draft"] = draft
            transform_revisions.atomic(conflict_path, record)
        raise
    return TransformDocumentResponse(document=normalized, saved_at=normalized["updatedAt"])


@router.post("/export", response_model=TransformExportResponse)
def export_transform_document(
    file: UploadFile = File(...),
    document_json: str = Form(...),
    source_path: str = Form(...),
    render_geometry_json: Optional[str] = Form(None),
    save_mode: Optional[str] = Form(None),
    launch_image_path: Optional[str] = Form(None),
    target_project_slug: Optional[str] = Form(None),
    target_folder: Optional[str] = Form(None),
    requested_filename: Optional[str] = Form(None),
    agent_side_effect_key: Optional[str] = None,
    session: Session = Depends(get_session),
):
    source = Path(source_path)
    normalized_save_mode = _normalize_transform_save_mode(save_mode)
    launch_source = (
        _resolve_overwrite_launch_path(launch_image_path, source, session)
        if normalized_save_mode == "overwrite_current"
        else _resolve_optional_launch_path(launch_image_path, source, session)
    )
    source_image = _read_image_info(source,session)
    try:
        raw_document = json.loads(document_json)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid transform document JSON: {exc}") from exc
    if not isinstance(raw_document, dict):
        raise HTTPException(status_code=400, detail="transform document payload must be a JSON object")
    render_geometry: Optional[dict[str, Any]] = None
    if render_geometry_json:
        try:
            decoded_geometry = json.loads(render_geometry_json)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail=f"Invalid render geometry JSON: {exc}") from exc
        if not isinstance(decoded_geometry, dict):
            raise HTTPException(status_code=400, detail="transform render geometry must be a JSON object")
        render_geometry = decoded_geometry

    project_context = _resolve_project_context(source, session)
    overwrite_current = normalized_save_mode == "overwrite_current"
    if overwrite_current:
        if _usable_media_path(launch_source,session) is None:
            raise HTTPException(status_code=404, detail="Current transform image not found for overwrite")
        if not _same_path(_resolve_source_image_path(launch_source, session), source):
            raise HTTPException(status_code=400, detail="Overwrite target does not belong to the current transform source")
        output_path = launch_source
        output_project_context = _resolve_project_context(output_path, session)
        output_project_slug = output_project_context.slug
        folder_value = output_project_context.folder
        output_path.parent.mkdir(parents=True, exist_ok=True)
    else:
        if not target_project_slug:
            target_project_slug = project_context.slug
        target_project = _resolve_project_for_slug(target_project_slug, session)
        folder_value = target_folder.strip() if isinstance(target_folder, str) and target_folder.strip() else project_context.folder
        if target_project:
            target_root = _project_storage_root(target_project)
        else:
            target_root = source.parent
        target_dir = target_root / folder_value if folder_value else target_root
        target_dir.mkdir(parents=True, exist_ok=True)
        naming_source = launch_source if launch_source.exists() else source
        force_png = _transform_document_requires_alpha(raw_document)
        if agent_side_effect_key:
            output_path = _stable_effect_export_path(
                naming_source,
                target_dir,
                side_effect_key=agent_side_effect_key,
                requested_filename=requested_filename,
                force_png=force_png,
            )
        else:
            output_path = _next_export_path(
                naming_source,
                target_dir,
                requested_filename=requested_filename,
                force_png=force_png,
            )
        output_project_context = TransformProjectContext(
            id=target_project.id if target_project and target_project.id is not None else project_context.id,
            slug=target_project.slug if target_project else project_context.slug,
            folder=folder_value,
            available_folders=project_context.available_folders,
        )
        output_project_slug = target_project_slug
    export_bytes = file.file.read()

    normalized_document = _normalize_document(raw_document, source_image, TransformProjectContext(
        id=project_context.id,
        slug=project_context.slug,
        folder=folder_value,
        available_folders=project_context.available_folders,
    ))

    source_document_path = _document_path_for_source(source, project_context.slug)
    if not overwrite_current:
        from app.services import transform_revisions
        source_identity = raw_document.get("sourceImage", {})
        if not isinstance(source_identity, dict) or (source_identity.get("hash") and source_identity["hash"] != source_image.hash):
            raise HTTPException(409, "The original changed. Reopen Transform before exporting this edit.")
        expected = raw_document.get("recipeRevision", 0)
        if type(expected) is not int or expected < 0:
            raise HTTPException(400, "Invalid edit revision.")
        with transform_revisions.admission(source_document_path, expected, normalized_document, session=session) as revision:
            _persist_paint_layer_assets(normalized_document, source_document_path, {})
            _persist_image_layer_assets(normalized_document, source_document_path, {})
            transform_revisions.commit(session, source_document_path, normalized_document, revision, source)

    metadata_source_path = launch_source if overwrite_current else source
    export_timestamp = _utc_now_iso()
    source_image_row = _resolve_image_row(source_image.path, session)
    launch_image_row = _resolve_image_row(str(launch_source), session)
    transform_payload = {
        "source_media_uuid": source_image_row.continuity_media_uuid if source_image_row else None,
        "source_sha256": source_image.hash,
        "source_image_path": str(output_path) if overwrite_current else source_image.path,
        "source_image_hash": None if overwrite_current else source_image.hash,
        "launch_image_path": str(output_path) if overwrite_current else str(launch_source),
        "parent_transform_path": None if overwrite_current else (str(launch_source) if launch_source != source else None),
        "document_id": normalized_document.get("id"),
        "mode": normalized_document.get("lastUsedMode") or "edit",
        "object_counts": {
            "text": len(((normalized_document.get("edit") or {}).get("textObjects") or [])),
            "paint": len(((normalized_document.get("edit") or {}).get("paintLayers") or [])),
            "image": len(((normalized_document.get("edit") or {}).get("imageLayers") or [])),
            "layers": len(((normalized_document.get("edit") or {}).get("layers") or [])),
        },
        "adjustments": ((normalized_document.get("edit") or {}).get("adjustments") or {}),
        "crop": ((normalized_document.get("edit") or {}).get("crop") or {}),
        "source_image_transform": ((normalized_document.get("edit") or {}).get("sourceImageTransform") or {}),
        "save_mode": normalized_save_mode,
        "export_timestamp": export_timestamp,
    }
    from uuid import uuid4
    from app.services.file_effects import publication_effect,json_effect,stage
    from app.db.writer import commit_profile
    staged_output=output_path.with_name(".st-export-"+str(uuid4())+output_path.suffix)
    width, height = _save_exported_image(
        source_path=_usable_media_path(metadata_source_path,session) or metadata_source_path,
        export_bytes=export_bytes,
        output_path=staged_output,
        document=normalized_document,
        transform_payload=transform_payload,
        render_geometry=render_geometry,
    )
    saved_image = _read_image_info(staged_output)
    saved_image.path = str(output_path)
    # Already measured by the export path; keep this DB-only to avoid a
    # self-referential file hash in embedded metadata.
    transform_payload["output_sha256"] = saved_image.hash
    if overwrite_current:
        transform_payload["source_image_hash"] = saved_image.hash

    extra_metadata = _build_export_extra_metadata(
        source_image_row=source_image_row,
        launch_image_row=launch_image_row,
        transform_payload=transform_payload,
    )
    if output_project_slug or folder_value:
        extra_metadata["resync_route"] = {
            "project_slug": output_project_slug,
            "folder": folder_value,
        }
    if agent_side_effect_key:
        extra_metadata["agent_side_effect_key"] = agent_side_effect_key

    thumbnail_data, _, _ = create_thumbnail(str(staged_output))
    effects=[publication_effect(staged_output,output_path,replace=overwrite_current)]
    if staged_output.with_suffix(".json").is_file():
        effects.append(publication_effect(staged_output.with_suffix(".json"),output_path.with_suffix(".json"),replace=overwrite_current))
    # Imported/standalone edits have no Job. Preserve real ownership, including
    # an actual Job zero, without propagating old placeholder zero references.
    from app.models.job import Job
    parent = source_image_row if source_image_row is not None else launch_image_row
    export_job_id = (
        parent.job_id if parent is not None and parent.job_id not in (None, -1)
        and session.get(Job, parent.job_id) is not None else -1
    )
    if overwrite_current:
        clean_document = _create_clean_transform_document(
            source_image=saved_image,
            project=output_project_context,
        )
        clean_document_path = _document_path_for_source(output_path, output_project_context.slug)
        effects.append(json_effect(clean_document_path,clean_document))

    upsert_result = upsert_active_image_for_path(
        session,
        job_id=export_job_id,
        path=str(output_path),
        filename=output_path.name,
        format=saved_image.format,
        width=width,
        height=height,
        file_exists=False,
        thumbnail_data=thumbnail_data,
        extra_metadata=extra_metadata,
        is_kept=False,
    )

    effects[0]["updates_media"]=True
    image=upsert_result.image
    image.media_revision+=1
    session.add(image)
    for effect in effects:
        effect.update(image_id=image.id,revision=image.media_revision)
    operation=stage(session,effects,kind="canvas_export",project_id=output_project_context.id)
    commit_profile(session,label="transform.export",lane="interactive")
    from app.services.media_operations import acknowledge
    result=acknowledge(session,operation)
    project_media_views.clear_project_media_view_caches()

    return TransformExportResponse(
        operation_ref=operation.operation_ref,state=result["state"],
        source_recipe_revision=normalized_document.get("recipeRevision") if not overwrite_current else None,
        id=upsert_result.image.id,
        path=str(output_path),
        filename=output_path.name,
        project_slug=output_project_slug,
        folder=folder_value,
        saved_at=export_timestamp,
        mtime=export_timestamp,
        save_mode=normalized_save_mode,
        document_id=str(normalized_document.get("id")) if normalized_document.get("id") else None,
    )


@router.get("/revisions")
def transform_revision_history(image_path: str, session: Session = Depends(get_session)):
    from app.services.transform_revisions import history_dir
    source = Path(image_path)
    _read_image_info(source,session)
    project = _resolve_project_context(source, session)
    directory = history_dir(_document_path_for_source(source, project.slug))
    rows = sorted(directory.glob("*.json"), key=lambda path: path.stat().st_mtime, reverse=True)[:100]
    return {"items": [{"id": path.stem, "conflict": path.name.startswith("conflict-"),
                      "saved_at": _file_mtime_iso(path)} for path in rows]}

@router.get("/revisions/{revision_id}", response_model=TransformDocumentResponse)
def read_transform_revision(revision_id: str, image_path: str, session: Session = Depends(get_session)):
    from app.services import transform_revisions
    if not re.fullmatch(r"(?:[0-9]+-[0-9a-f]{64}|conflict-[0-9a-f]{32})", revision_id):
        raise HTTPException(404, "Edit revision not found.")
    source = Path(image_path)
    info = _read_image_info(source,session)
    project = _resolve_project_context(source, session)
    document_path = _document_path_for_source(source, project.slug)
    path = transform_revisions.history_dir(document_path) / (revision_id + ".json")
    pending=transform_revisions.pending_document(session,path)
    if pending is None and (not path.is_file() or path.stat().st_size > 1024 * 1024):
        raise HTTPException(404, "Edit revision not found.")
    saved=pending
    if saved is None:
        saved=json.loads(path.read_text())
    document = saved.get("draft", saved)
    if document.get("sourceImage", {}).get("hash") != info.hash:
        raise HTTPException(409, "This edit revision belongs to a different original.")
    current = _load_document(source,project.slug,session) or {}
    document = _normalize_document(document, info, project)
    document["recipeRevision"] = current.get("recipeRevision", 0)
    return TransformDocumentResponse(document=document, saved_at=document["updatedAt"])
