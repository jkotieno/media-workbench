"""Shared browse/listing orchestration for gallery and library media views."""

from __future__ import annotations

from datetime import datetime
from difflib import SequenceMatcher
import os
from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session

from app.services.gallery.search import (
    _build_search_block as build_gallery_search_block,
    _score_search_match as score_gallery_search_match,
)
from app.services.media_browse_candidates import (
    MediaBrowseCandidate,
    load_gallery_browse_candidates,
    load_library_browse_candidates,
)
from app.services.media_scope_context import (
    MediaScopeContext,
    build_media_scope_context,
    media_scope_matches,
    resolve_media_scope_for_row,
)
from app.models.image import image_metadata_for_read
from app.services.media_result_projection import project_media_row
from app.services.media_paths import original_availability_for_images


def _normalize_folder_filter(folder: Optional[str]) -> Optional[str]:
    if not isinstance(folder, str):
        return None
    cleaned = folder.strip()
    if not cleaned:
        return None
    return cleaned


def _tokenize_query(query: str) -> list[str]:
    return [tok for tok in query.lower().replace(",", " ").split() if tok]


def _field_relevance(query: str, tokens: list[str], text: str) -> float:
    if not text:
        return 0.0
    lower = text.lower()
    token_hits = sum(1 for token in tokens if token in lower)
    coverage = token_hits / len(tokens) if tokens else 0.0
    phrase = 1.0 if query and query in lower else 0.0
    fuzzy = SequenceMatcher(None, query, lower).ratio() if query else 0.0
    return (0.58 * coverage) + (0.28 * phrase) + (0.14 * fuzzy)


def _recency_score(created_at: datetime) -> float:
    age_days = max((datetime.utcnow() - created_at).total_seconds() / 86400.0, 0.0)
    return pow(2.718281828459045, -age_days / 45.0)


def _score_library_search_match(
    query: str,
    *,
    active_positive: Optional[str],
    active_negative: Optional[str],
    caption: Optional[str],
    tags: list[str],
    prompt_history: list[dict[str, Any]],
    prompt_name: Optional[str],
    project_name: Optional[str],
    filename: Optional[str],
    created_at: datetime,
) -> float:
    query_lower = (query or "").strip().lower()
    if not query_lower:
        return _recency_score(created_at)

    tokens = _tokenize_query(query_lower)
    if not tokens:
        return _recency_score(created_at)

    history_text = " ".join(
        f"{entry.get('positive_text') or ''} {entry.get('negative_text') or ''}"
        for entry in prompt_history
        if isinstance(entry, dict)
    )
    tag_text = " ".join(tags or [])

    relevance = (
        0.40 * _field_relevance(query_lower, tokens, active_positive or "")
        + 0.08 * _field_relevance(query_lower, tokens, active_negative or "")
        + 0.28 * _field_relevance(query_lower, tokens, caption or "")
        + 0.12 * _field_relevance(query_lower, tokens, tag_text)
        + 0.06 * _field_relevance(query_lower, tokens, history_text)
        + 0.03 * _field_relevance(query_lower, tokens, prompt_name or "")
        + 0.02 * _field_relevance(query_lower, tokens, project_name or "")
        + 0.01 * _field_relevance(query_lower, tokens, filename or "")
    )
    recency = _recency_score(created_at)
    return (0.86 * relevance) + (0.14 * recency)


def _build_library_prompt_stages(raw_history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    prompt_history: list[dict[str, Any]] = []
    for idx, entry in enumerate(raw_history):
        if not isinstance(entry, dict):
            continue
        prompt_history.append(
            {
                "stage": entry.get("stage", idx),
                "positive_text": entry.get("positive_text"),
                "negative_text": entry.get("negative_text"),
                "source": entry.get("source"),
                "timestamp": entry.get("timestamp"),
            }
        )
    return prompt_history


def _build_library_history_search_text(prompt_history: list[dict[str, Any]]) -> str:
    return " ".join(
        f"{entry.get('positive_text') or ''} {entry.get('negative_text') or ''}"
        for entry in prompt_history
        if isinstance(entry, dict)
    )


def build_gallery_browse_context(session: Session) -> MediaScopeContext:
    return build_media_scope_context(session)


def search_library_media_rows(
    session: Session,
    *,
    search: Optional[str],
    workflow_id: Optional[int],
    offset: int,
    limit: int,
) -> tuple[list[dict[str, Any]], bool]:
    clean_search = (search or "").strip()
    candidates, has_more = load_library_browse_candidates(
        session,
        search=clean_search,
        workflow_id=workflow_id,
        offset=offset,
        limit=limit,
    )

    original_availability = original_availability_for_images([candidate.image for candidate in candidates], session)
    scored_results: list[tuple[float, dict[str, Any]]] = []
    query_tokens = _tokenize_query(clean_search) if clean_search else []
    for candidate in candidates:
        image = candidate.image
        job = candidate.job
        prompt = candidate.prompt
        project = candidate.project
        projection = project_media_row(
            image,
            job=job,
            prompt=prompt,
            session=session,
            original_availability=original_availability,
            include_params=True,
            include_thumbnails=False,
        )
        prompt_history = _build_library_prompt_stages(projection.prompt_history)
        item = {
            "image_id": image.id,
            "job_id": job.id if job else None,
            "workflow_template_id": job.workflow_template_id if job else None,
            "project_id": project.id if project else None,
            "project_name": project.name if project else None,
            "created_at": image.created_at,
            "preview_path": projection.preview_path,
            "active_positive": projection.prompt_text,
            "active_negative": projection.negative_prompt,
            "job_params": projection.job_params,
            "prompt_history": prompt_history,
            "tags": projection.prompt_tags,
            "caption": projection.caption,
            "prompt_id": prompt.id if prompt else None,
            "prompt_name": prompt.name if prompt else None,
        }

        if clean_search:
            history_text = _build_library_history_search_text(prompt_history)
            haystack = " ".join(
                filter(
                    None,
                    [
                        projection.prompt_text or "",
                        projection.negative_prompt or "",
                        projection.caption or "",
                        " ".join(projection.prompt_tags),
                        history_text,
                        image.filename or "",
                        item["prompt_name"] or "",
                        item["project_name"] or "",
                    ],
                )
            ).lower()
            if not any(token in haystack for token in query_tokens):
                continue

        score = _score_library_search_match(
            clean_search,
            active_positive=projection.prompt_text,
            active_negative=projection.negative_prompt,
            caption=projection.caption,
            tags=projection.prompt_tags,
            prompt_history=prompt_history,
            prompt_name=item["prompt_name"],
            project_name=item["project_name"],
            filename=image.filename,
            created_at=image.created_at,
        )
        scored_results.append((score, item))

    scored_results.sort(key=lambda row: (row[0], row[1]["created_at"]), reverse=True)
    if clean_search:
        has_more = len(scored_results) > (offset + limit)

    paged = scored_results[offset: offset + limit]
    return [item for _, item in paged], has_more


def list_gallery_rows(
    session: Session,
    *,
    logger,
    log_context: dict[str, Any],
    skip: int,
    limit: Optional[int],
    search: Optional[str],
    include_thumbnails: bool,
    include_params: bool,
    kept_only: bool,
    collection_id: Optional[int],
    project_id: Optional[int],
    folder: Optional[str],
    unassigned_only: bool,
    image_ids: Optional[list[int]] = None,
    candidates_override: Optional[list[MediaBrowseCandidate]] = None,
    browse_context_override: Optional[MediaScopeContext] = None,
) -> list[dict[str, Any]]:
    normalized_folder = _normalize_folder_filter(folder)
    requires_post_filter_paging = bool(
        search or normalized_folder or project_id is not None or unassigned_only
    )
    browse_context = browse_context_override or build_gallery_browse_context(session)
    normalized_folder = browse_context.folder_aliases.get(normalized_folder,normalized_folder)

    if candidates_override is None:
        try:
            candidates = load_gallery_browse_candidates(
                session,
                skip=skip,
                limit=limit,
                search=search,
                include_thumbnails=include_thumbnails,
                kept_only=kept_only,
                collection_id=collection_id,
                project_id=project_id,
                unassigned_only=unassigned_only,
                requires_post_filter_paging=requires_post_filter_paging,
                folder_scoped=normalized_folder is not None,
                folder=normalized_folder,
                scope_context=browse_context,
                image_ids=image_ids,
            )
        except SQLAlchemyError as exc:
            logger.exception("Failed to fetch gallery results", extra=log_context)
            raise HTTPException(status_code=500, detail="Unable to fetch gallery items") from exc
    else:
        candidates = candidates_override

    original_availability = original_availability_for_images([candidate.image for candidate in candidates], session)
    scored_items: list[tuple[float, dict[str, Any]]] = []
    for candidate in candidates:
        img = candidate.image
        job = candidate.job
        prompt = candidate.prompt
        workflow = candidate.workflow
        # File availability is a projection, never membership in the profile.

        projection = project_media_row(
            img,
            job=job,
            prompt=prompt,
            session=session,
            original_availability=original_availability,
            include_params=include_params,
            include_thumbnails=include_thumbnails,
            on_params_error=lambda: logger.exception(
                "Invalid stored job params",
                extra={**log_context, "image_id": img.id, "job_id": job.id if job else None},
            ),
            on_metadata_error=lambda: logger.exception(
                "Invalid extra metadata JSON",
                extra={**log_context, "image_id": img.id},
            ),
            on_tags_error=lambda: logger.exception(
                "Invalid prompt tags JSON",
                extra={**log_context, "prompt_id": prompt.id if prompt else None},
            ),
            on_mtime_error=lambda exc: logger.warning(
                "Unable to read gallery image mtime",
                extra={
                    **log_context,
                    "image_id": img.id,
                    "path": img.path,
                    "error_type": exc.__class__.__name__,
                },
                exc_info=(type(exc), exc, exc.__traceback__),
            ),
        )

        search_block = build_gallery_search_block(
            prompt_text=projection.prompt_text,
            negative_prompt=projection.negative_prompt,
            caption=projection.caption,
            tags=projection.prompt_tags,
            history=projection.prompt_history,
        )

        if search:
            score = score_gallery_search_match(search, search_block)
            if score < 0.35:
                continue
        else:
            score = 1.0

        resolved_scope = resolve_media_scope_for_row(
            context=browse_context,
            image_path=img.path,
            extra_metadata=image_metadata_for_read(img),
            job_project_id=job.project_id if job else None,
            job_output_dir=job.output_dir if job else None,
        )
        if not media_scope_matches(
            resolved_scope=resolved_scope,
            project_id=project_id,
            folder=normalized_folder,
            unassigned_only=unassigned_only,
        ):
            continue

        scored_items.append(
            (
                score,
                {
                    "image": projection.image_payload,
                    "job_params": projection.job_params,
                    "prompt": projection.prompt_text,
                    "negative_prompt": projection.negative_prompt,
                    "prompt_history": projection.prompt_history if include_params else [],
                    "workflow_template_id": job.workflow_template_id if job else None,
                    "workflow_name": workflow.name if workflow else None,
                    "width": projection.width,
                    "height": projection.height,
                    "created_at": img.created_at,
                    "caption": projection.caption,
                    "prompt_tags": projection.prompt_tags,
                    "prompt_name": prompt.name if prompt else None,
                    "engine_id": job.engine_id if job else None,
                    "collection_id": img.collection_id,
                    "project_id": resolved_scope.project_id,
                },
            )
        )

    if search:
        scored_items.sort(key=lambda row: (row[0], row[1]["created_at"]), reverse=True)
        items = [item for _, item in scored_items]
        if limit is not None:
            return items[skip: skip + limit]
        return items[skip:]

    items = [item for _, item in scored_items]
    if requires_post_filter_paging:
        if limit is not None:
            return items[skip: skip + limit]
        return items[skip:]
    if limit is not None:
        return items[:limit]
    return items



def list_global_gallery_page(
    session: Session,
    *,
    logger,
    log_context: dict[str, Any],
    skip: int,
    limit: int,
    include_thumbnails: bool,
    include_params: bool,
) -> dict[str, Any]:
    """Fill pages from existing media; ignore broken DB rows without ending the feed.

    A page is keyed by raw DB offset, not returned image count. The healthy
    path still performs a single bounded query, and damaged ranges scan
    incrementally until a page is full or the database is exhausted.
    """
    scope_context = build_gallery_browse_context(session)
    next_skip = skip
    items: list[dict[str, Any]] = []
    exhausted = False

    # Page reads must never flush identity repairs while scanning a damaged DB.
    with session.no_autoflush:
        while len(items) < limit:
            requested = limit - len(items)
            scan_meta: dict[str, int] = {}
            try:
                candidates = load_gallery_browse_candidates(
                    session,
                    skip=next_skip,
                    limit=requested,
                    search=None,
                    include_thumbnails=include_thumbnails,
                    kept_only=False,
                    collection_id=None,
                    project_id=None,
                    unassigned_only=False,
                    requires_post_filter_paging=False,
                    scope_context=scope_context,
                    raw_scan_meta=scan_meta,
                )
            except SQLAlchemyError as exc:
                logger.exception("Failed to fetch global gallery page", extra=log_context)
                raise HTTPException(status_code=500, detail="Unable to fetch gallery items") from exc

            scanned = scan_meta.get("scanned", 0)
            if not scanned:
                exhausted = True
                break

            items.extend(list_gallery_rows(
                session,
                logger=logger,
                log_context=log_context,
                skip=0,
                limit=None,
                search=None,
                include_thumbnails=include_thumbnails,
                include_params=include_params,
                kept_only=False,
                collection_id=None,
                project_id=None,
                folder=None,
                unassigned_only=False,
                candidates_override=candidates,
                browse_context_override=scope_context,
            ))
            next_skip += scanned
            if scanned < requested:
                exhausted = True
                break

    return {"items": items, "next_skip": next_skip, "has_more": not exhausted}
