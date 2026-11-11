from __future__ import annotations

import os
from io import BytesIO
from pathlib import Path
from typing import Literal, Optional
from urllib.parse import parse_qs, urlparse
from uuid import uuid4
import json
import hashlib

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response
from PIL import Image as PILImage, ImageOps
from pydantic import BaseModel
from sqlmodel import Session, select

from app.core.config import settings
from app.db.database import get_session
from app.models.engine import Engine
from app.services.local_storage_engine import select_storage_engine, owns_local_files
from app.services.drafts_project_normalization import resolve_project_input_subfolder
from app.services.gallery.paths import _resolve_media_path
from app.services.transform_outpainting import (
    normalize_expansion, expansion_frame, automatic_coverage, reproject_coverage, persist_preparation, _atomic_bytes,
)

router = APIRouter()


class TransformMaskApplyResponse(BaseModel):
    filename: str
    path: str
    comfy_filename: str
    width: int
    height: int


class TransformOutpaintPrepareResponse(BaseModel):
    preparation_id: str
    width: int
    height: int
    frame: dict
    paths: dict[str, str]
    inputs: dict[str, str] = {}


def _resolve_engine(engine_id: Optional[int], session: Session) -> Optional[Engine]:
    if engine_id is not None:
        engine = session.get(Engine, engine_id)
        if engine is None or not engine.is_active:
            raise HTTPException(409, "The selected engine is unavailable.")
        return engine
    return select_storage_engine(session)


def _unwrap_media_path(value: str) -> str:
    candidate = str(value or "").strip()
    # Mask used to reconstruct a filesystem path by parsing the gallery image
    # URL in the browser. Accept that gallery URL here as well so the backend
    # owns the final path resolution regardless of how the caller represents it.
    for _ in range(3):
        try:
            parsed = urlparse(candidate)
            nested = parse_qs(parsed.query).get("path", [None])[0]
        except Exception:
            nested = None
        if not nested or nested == candidate:
            break
        candidate = nested
    return candidate


def _resolve_source(path: str, session: Session, engine: Optional[Engine] = None) -> Path:
    source_path = _unwrap_media_path(path)
    resolved = _resolve_media_path(source_path, session)
    if resolved:
        candidate = Path(resolved)
        if candidate.is_file():
            return candidate

    candidate = Path(source_path)
    if candidate.is_file():
        return candidate

    if engine and engine.input_dir:
        input_candidate = Path(engine.input_dir) / source_path.replace("\\", "/")
        if input_candidate.is_file():
            return input_candidate

    raise HTTPException(status_code=404, detail="Source image not found")


def _png_bytes(image: PILImage.Image) -> bytes:
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def _opaque_rgb_and_coverage(source: Path) -> tuple[PILImage.Image, PILImage.Image]:
    try:
        with PILImage.open(source) as opened:
            opened.load()
            oriented = ImageOps.exif_transpose(opened)
            rgba = oriented.convert("RGBA")
            red, green, blue, alpha = rgba.split()
            opaque = PILImage.merge(
                "RGBA",
                (red, green, blue, PILImage.new("L", rgba.size, 255)),
            )
            coverage = ImageOps.invert(alpha)
            return opaque, coverage
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to read source image: {exc}") from exc


def _target_for_apply(
    source: Path,
    *,
    engine: Engine,
    project_slug: Optional[str],
    subfolder: Optional[str],
) -> Path:
    if not engine.input_dir:
        raise HTTPException(status_code=400, detail="No valid ComfyUI input directory found")

    input_root = Path(engine.input_dir)
    try:
        source.resolve().relative_to(input_root.resolve())
        source_is_input = True
    except ValueError:
        source_is_input = False

    if source_is_input:
        target_dir = source.parent
    elif project_slug:
        target_dir = settings.get_project_input_dir_in_comfy(engine.input_dir, project_slug)
        resolved_subfolder = resolve_project_input_subfolder(project_slug, subfolder)
        if resolved_subfolder:
            target_dir = target_dir / resolved_subfolder
    else:
        target_dir = input_root

    target_dir.mkdir(parents=True, exist_ok=True)

    # Applying again to an existing PNG mutates that image object in place.
    # Converting a non-PNG creates the obvious sibling PNG when available.
    if source_is_input and source.suffix.lower() == ".png":
        return source

    candidate = target_dir / f"{source.stem}.png"
    if not candidate.exists():
        return candidate

    base = target_dir / f"{source.stem}_masked.png"
    if not base.exists():
        return base

    counter = 1
    while True:
        candidate = target_dir / f"{source.stem}_masked_{counter}.png"
        if not candidate.exists():
            return candidate
        counter += 1


@router.get("/mask-source")
def get_transform_mask_source(
    path: str,
    view: Literal["opaque", "coverage"] = Query("opaque"),
    session: Session = Depends(get_session),
):
    engine = _resolve_engine(None, session)
    source = _resolve_source(path, session, engine)

    # JPEG has no alpha channel. Its opaque preview is already the source file,
    # and its initial mask coverage is definitionally empty. Avoid a full
    # decode/re-encode round trip just to reconstruct those two facts.
    if source.suffix.lower() in {".jpg", ".jpeg"}:
        if view == "opaque":
            return FileResponse(
                source,
                media_type="image/jpeg",
                headers={"Cache-Control": "no-store"},
            )
        return Response(
            content=_png_bytes(PILImage.new("L", (1, 1), 0)),
            media_type="image/png",
            headers={"Cache-Control": "no-store"},
        )

    opaque, coverage = _opaque_rgb_and_coverage(source)
    payload = _png_bytes(opaque if view == "opaque" else coverage)
    return Response(
        content=payload,
        media_type="image/png",
        headers={"Cache-Control": "no-store"},
    )


@router.post("/apply-mask", response_model=TransformMaskApplyResponse)
def apply_transform_mask(
    coverage_file: UploadFile = File(...),
    source_path: str = Form(...),
    engine_id: Optional[int] = Form(None),
    project_slug: Optional[str] = Form(None),
    subfolder: Optional[str] = Form(None),
    session: Session = Depends(get_session),
):
    target_engine = _resolve_engine(engine_id, session)
    engine = target_engine if owns_local_files(target_engine) else select_storage_engine(session)
    engine = engine or Engine(name="Studio input storage", input_dir=str(settings.ROOT_DIR / "input"))
    if not engine.input_dir:
        raise HTTPException(status_code=400, detail="No valid ComfyUI input directory found")

    source = _resolve_source(source_path, session, engine)
    target = _target_for_apply(
        source,
        engine=engine,
        project_slug=(project_slug or "").strip() or None,
        subfolder=(subfolder or "").strip() or None,
    )

    # Coverage is produced by MaskCanvasSurface from the exact source-sized
    # raster it edits, so image/mask dimensions are one invariant rather than
    # two independently supplied values that need reconciliation here.
    try:
        coverage_bytes = coverage_file.file.read()
        with PILImage.open(source) as opened:
            opened.load()
            oriented = ImageOps.exif_transpose(opened)
            rgba = oriented.convert("RGBA")
            red, green, blue, _ = rgba.split()
            icc_profile = opened.info.get("icc_profile")

        with PILImage.open(BytesIO(coverage_bytes)) as mask_image:
            mask_image.load()
            coverage = ImageOps.exif_transpose(mask_image).convert("L")

        if coverage.size != rgba.size:
            raise ValueError("Mask dimensions do not match the source image")
        alpha = ImageOps.invert(coverage)
        output = PILImage.merge("RGBA", (red, green, blue, alpha))

        temp = target.with_name(f".{target.name}.{uuid4().hex}.tmp.png")
        save_kwargs = {"format": "PNG"}
        if icc_profile:
            save_kwargs["icc_profile"] = icc_profile
        output.save(temp, **save_kwargs)
        os.replace(temp, target)
    except Exception as exc:
        temp_candidate = locals().get("temp")
        if isinstance(temp_candidate, Path):
            temp_candidate.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"Failed to apply mask: {exc}") from exc
    finally:
        try:
            coverage_file.file.close()
        except Exception:
            pass

    input_root = Path(engine.input_dir)
    comfy_filename = target.resolve().relative_to(input_root.resolve()).as_posix()
    if target_engine is not None and not owns_local_files(target_engine):
        from app.services.media_input_copy import copy_file_to_input
        staged = copy_file_to_input(session, source_path=str(target), project_slug=project_slug or "drafts",
            subfolder=subfolder, engine_id=target_engine.id, allow_unmanaged_source=True)
        comfy_filename = str(staged["filename"])
    return TransformMaskApplyResponse(
        filename=target.name,
        path=str(target),
        comfy_filename=comfy_filename,
        width=output.width,
        height=output.height,
    )


@router.post("/prepare-outpaint", response_model=TransformOutpaintPrepareResponse)
def prepare_transform_outpaint(
    composition_file: UploadFile = File(...),
    document_json: str = Form(...),
    source_path: str = Form(...),
    coverage_file: Optional[UploadFile] = File(None),
    engine_id: Optional[int] = Form(None),
    project_slug: Optional[str] = Form(None),
    subfolder: Optional[str] = Form(None),
    stage_inputs: bool = Form(False),
    session: Session = Depends(get_session),
):
    from app.api.endpoints.transform import _document_path_for_source
    from app.api.endpoints.files import upload_file
    from app.core.comfy_client import ComfyClient
    try:
        engine = _resolve_engine(engine_id, session)
        if engine_id is not None and (engine is None or engine.id != engine_id):
            raise ValueError("The selected engine is no longer available.")
        source = _resolve_source(source_path, session, engine)
        document = json.loads(document_json)
        expansion = normalize_expansion(document.get("edit", {}).get("expansion"))
        if not expansion:
            raise ValueError("Choose an expansion frame first.")
        frame = expansion_frame(expansion)
        with PILImage.open(composition_file.file) as opened:
            # Validate before decoding/allocating.
            if opened.size != (frame["width"], frame["height"]):
                raise ValueError("Composition dimensions do not match the output frame.")
            opened.load(); composition = opened.convert("RGBA")
        if coverage_file is not None:
            with PILImage.open(coverage_file.file) as opened:
                if opened.size != composition.size:
                    raise ValueError("Expanded image and mask dimensions must match.")
                opened.load(); coverage = opened.convert("L")
        else:
            coverage = automatic_coverage(expansion, composition)
            mask = document.get("mask") or {}
            draft = mask.get("coverageAssetPath") or mask.get("draftPath")
            if draft:
                previous_source = _resolve_source(draft, session, engine)
                with PILImage.open(previous_source) as old:
                    old.load(); previous = old.convert("L")
                previous_frame = mask.get("coverageFrame") or {"x": 0, "y": 0,
                    "width": document["sourceImage"]["width"], "height": document["sourceImage"]["height"]}
                previous_base = None
                if mask.get("baseCoverageAssetPath"):
                    with PILImage.open(_resolve_source(mask["baseCoverageAssetPath"], session, engine)) as old_base:
                        old_base.load(); previous_base = old_base.convert("L")
                coverage = reproject_coverage(coverage, frame, previous, previous_frame, previous_base)
        document_path = _document_path_for_source(source, project_slug or document.get("project", {}).get("slug"))
        root = document_path.with_name(f"{document_path.stem}.assets") / "outpaint"
        receipt = persist_preparation(composition, coverage, expansion, source, root)
        inputs = {}
        if stage_inputs:
            if not engine or (not engine.input_dir and engine.connection_kind not in {"bridge", "direct", "provider"}):
                raise ValueError("Select an engine before using this in a Pipe.")
            # The existing upload owner provides stable local copies. All engines
            # also receive a real upload; a local disk path is never a remote reference.
            stage_key = hashlib.sha256(f"{engine.id}:{engine.base_url}:{engine.input_dir}:{project_slug}:{subfolder}".encode()).hexdigest()[:20]
            stage_receipt = root / receipt["preparation_id"][:24] / f"stage-{stage_key}.json"
            staged = json.loads(stage_receipt.read_text()) if stage_receipt.is_file() else {}
            from app.services.engine_execution.client import execution_client
            client = execution_client(engine)
            for role, path in receipt["paths"].items():
                if role not in staged:
                    with Path(path).open("rb") as raw:
                        local = upload_file(file=UploadFile(filename=f"outpaint_{role}.png", file=raw),
                            engine_id=engine.id, project_slug=project_slug, subfolder=subfolder,
                            agent_side_effect_key=f"outpaint:{receipt['preparation_id']}:{role}:{stage_key}", session=session)
                    name = Path(local["path"]).name
                    relative_folder = str(Path(local["filename"]).parent).replace("\\", "/")
                    staged[role] = local["filename"] if engine.connection_kind in {"bridge", "direct", "provider"} else client.upload_input_image(
                        Path(local["path"]), name=name, subfolder="" if relative_folder == "." else relative_folder)
                    _atomic_bytes(stage_receipt, json.dumps(staged).encode())
            inputs = staged
        return TransformOutpaintPrepareResponse(**{key: receipt[key] for key in ("preparation_id", "width", "height", "frame", "paths")}, inputs=inputs)
    except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        composition_file.file.close()
        if coverage_file is not None:
            coverage_file.file.close()
