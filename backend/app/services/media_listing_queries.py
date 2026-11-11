from __future__ import annotations

from typing import Sequence

from sqlalchemy import func
from sqlmodel import Session, select

from app.models.image import Image
from app.models.job import Job
from app.models.project import Project
from app.models.prompt import Prompt
from app.models.workflow import WorkflowTemplate
from app.services.model_query_filters import not_deleted_image_filter


def build_active_image_query():
    return select(Image).where(not_deleted_image_filter())


def build_deleted_image_query():
    return select(Image).where(Image.is_deleted == True)  # noqa: E712


def build_image_query():
    return select(Image)


def build_active_image_job_query():
    return (
        select(Image, Job)
        .join(Job, Image.job_id == Job.id, isouter=True)
        .where(not_deleted_image_filter())
    )


def build_gallery_listing_query():
    return (
        select(Image, Job, Prompt, WorkflowTemplate)
        .join(Job, Image.job_id == Job.id, isouter=True)
        .join(Prompt, Job.prompt_id == Prompt.id, isouter=True)
        .join(WorkflowTemplate, Job.workflow_template_id == WorkflowTemplate.id, isouter=True)
        .where(not_deleted_image_filter())
        .order_by(Image.created_at.desc())
    )


def build_library_listing_query():
    return (
        select(Image, Job, Prompt, Project)
        .join(Job, Image.job_id == Job.id, isouter=True)
        .join(Prompt, Job.prompt_id == Prompt.id, isouter=True)
        .join(Project, Job.project_id == Project.id, isouter=True)
        .where(not_deleted_image_filter())
        .order_by(Image.created_at.desc())
    )


def list_images_by_ids(session: Session, image_ids: Sequence[int]) -> list[Image]:
    if not image_ids:
        return []
    return session.exec(build_image_query().where(Image.id.in_(tuple(image_ids)))).all()


def list_active_images_by_ids(session: Session, image_ids: Sequence[int]) -> list[Image]:
    if not image_ids:
        return []
    return session.exec(build_active_image_query().where(Image.id.in_(tuple(image_ids)))).all()


def list_deleted_images_by_ids(session: Session, image_ids: Sequence[int]) -> list[Image]:
    if not image_ids:
        return []
    return session.exec(build_deleted_image_query().where(Image.id.in_(tuple(image_ids)))).all()


def list_active_images_by_lowercase_paths(
    session: Session,
    lowercase_paths: Sequence[str],
) -> list[Image]:
    if not lowercase_paths:
        return []
    return session.exec(
        build_active_image_query()
        .where(Image.path.is_not(None))
        .where(func.lower(Image.path).in_(tuple(lowercase_paths)))
    ).all()


def list_active_collection_images(
    session: Session,
    *,
    collection_id: int | None = None,
    image_ids: Sequence[int] | None = None,
) -> list[Image]:
    query = select(Image).where(not_deleted_image_filter())
    if collection_id is not None:
        query = query.where(Image.collection_id == collection_id)
    if image_ids is not None:
        query = query.where(Image.id.in_(tuple(image_ids)))
    return session.exec(query).all()


def count_active_images_for_job(session: Session, *, job_id: int) -> int:
    return int(
        session.exec(
            select(func.count(Image.id))
            .where(Image.job_id == job_id)
            .where(not_deleted_image_filter())
        ).one()
        or 0
    )


def list_deleted_image_paths_for_scope(session: Session, *, scoped_filter) -> list[str]:
    rows = session.exec(
        select(Image.path)
        .join(Job, Image.job_id == Job.id, isouter=True)
        .where(Image.is_deleted == True)  # noqa: E712
        .where(scoped_filter)
    ).all()
    return [str(path) for path in rows if path]


def load_collection_item_counts(session: Session) -> dict[int, int]:
    rows = session.exec(
        select(Image.collection_id, func.count(Image.id))
        .where(Image.collection_id.is_not(None))
        .where(not_deleted_image_filter())
        .group_by(Image.collection_id)
    ).all()
    return {
        int(collection_id): int(count or 0)
        for collection_id, count in rows
        if collection_id is not None
    }
