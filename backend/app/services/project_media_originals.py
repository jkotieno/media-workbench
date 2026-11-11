"""Foreground access to a project placement; never creates a cache replica."""
from __future__ import annotations

from pathlib import Path
from fastapi import HTTPException
from sqlmodel import Session, select

from app.models.image import Image
from app.models.project_storage import LocalMediaPlacement
from app.services.directory_configuration import device_key
from app.services.gallery.image_lookup import active_images_for_paths


def placement_for_image(session: Session, image_id: int):
    return session.exec(select(LocalMediaPlacement).where(
        LocalMediaPlacement.image_id == image_id,
        LocalMediaPlacement.device_key == device_key(),
    )).first()


def image_for_path(session: Session, *paths: str):
    candidates = list(dict.fromkeys(str(path) for path in paths))
    image = next(iter(active_images_for_paths(session, paths=candidates)), None)
    if image:
        return image
    # A caller can still hold the preview placeholder after the destination
    # was claimed. The previous path is an explicit placement alias, not a
    # filename search or another device's path.
    return next((image for image in session.exec(select(Image).join(
        LocalMediaPlacement, LocalMediaPlacement.image_id == Image.id).where(
        LocalMediaPlacement.device_key == device_key(),
        LocalMediaPlacement.previous_path.in_(candidates))).all() if not image.is_deleted), None)


def request_project_original(session: Session, image: Image, *, project_id: int | None = None):
    placement = placement_for_image(session, image.id)
    if placement is None:
        return None
    if project_id is not None and placement.project_id != project_id:
        raise HTTPException(403, "Source file is outside the selected project folders")
    if image.is_deleted:
        raise HTTPException(404, "Image not found.")
    if placement.state == "present" and image.file_exists and Path(image.path).is_file():
        return None
    if placement.state in {"conflict", "unresolved", "changed_locally", "remote_changed", "remote_missing", "skipped"}:
        raise HTTPException(409, detail={
            "code": "project_original_needs_attention",
            "message": "Review this project's file mapping before preparing the original.",
            "placement_id": placement.id, "image_id": image.id,
            "state": placement.state,
        })
    from app.services import project_storage, storage_transfers
    transfer = project_storage.promote_for_image(session, image.id)
    if transfer is None:
        raise HTTPException(409, detail={
            "code": "project_original_needs_attention",
            "message": "Choose an available original in project storage.",
            "placement_id": placement.id, "image_id": image.id,
        })
    storage_transfers.start_worker(bind=session.get_bind())
    return transfer


def pending_detail(image: Image, placement, transfer):
    return {
        "code": "storage_original_downloading",
        "message": "Downloading the original into this project's folder.",
        "image_id": image.id, "placement_id": placement.id,
        "asset_id": placement.asset_id, "transfer_id": transfer.id,
    }
