"""Durable media effects on AgentOperation: plan -> commit -> apply -> settle.

Logical changes and file intents commit together. Effects never run in a write
transaction and are never compensated after acknowledgement. Startup and the
worker replay the same per-image intents in commit order.
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timedelta
from functools import wraps
import errno
import logging
import os
from pathlib import Path
import shutil
import threading
import time
from weakref import WeakValueDictionary
from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlmodel import Session, select
from sqlalchemy import func, text
from sqlalchemy.orm import defer, lazyload

from app.db.writer import (
    commit_profile, component_span, component_trace_enabled, profile_write,
    profile_session_write, post_commit_safe, record_component_duration,
)
from app.models.agent_access import AgentOperation, AgentOperationItem
from app.models.image import Image

log = logging.getLogger(__name__)
_effect_bind = ContextVar("media_effect_bind",default=None)
_effect_cleanup = ContextVar("media_effect_cleanup",default=None)
_effect_item_id = ContextVar("media_effect_item_id",default=None)
_plan_locks = WeakValueDictionary()
_plan_locks_guard = threading.Lock()
_workers_lock = threading.Lock()
_workers = {}
_worker_stops = {}
_worker_wakes = {}
_run_locks = {}
_derived_publications = {}
_logical_publications = {}
_logical_publications_lock = threading.Lock()
from concurrent.futures import ThreadPoolExecutor
_event_dispatch = ThreadPoolExecutor(max_workers=1,thread_name_prefix="media-events")
_PENDING = ("pending", "applying", "needs_attention")


@contextmanager
def planning(*, image_ids=(), paths=(), operation_ids=()):
    """Order only the resources involved; unrelated preparations stay concurrent."""
    keys = {("image", str(value)) for value in image_ids if value is not None}
    keys.update(("path", os.path.normcase(os.path.abspath(str(path)))) for path in paths if path)
    keys.update(("operation",str(value)) for value in operation_ids if value)
    # Keep strong references until release; unused resource locks disappear.
    with _plan_locks_guard:
        locks = []
        for key in sorted(keys):
            lock = _plan_locks.get(key)
            if lock is None:
                lock = threading.RLock()
                _plan_locks[key] = lock
            locks.append(lock)
    with component_span("domain_lock.wait", domain="media.planning", lock_count=len(locks)):
        for lock in locks:
            lock.acquire()
    try:
        yield
    finally:
        for lock in reversed(locks):
            lock.release()


class MediaPlanChanged(HTTPException):
    def __init__(self):
        super().__init__(409,"The media changed while this action was being prepared")


def replan_once(function):
    @wraps(function)
    def execute(*args,**kwargs):
        for attempt in range(2):
            try:
                return function(*args,**kwargs)
            except MediaPlanChanged:
                if attempt:
                    raise
    return execute



def _ref(operation_id):
    try:
        return str(UUID(str(operation_id))) if operation_id else str(uuid4())
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, "operation_id must be a UUID") from exc


def find_operation(session, operation_id, *, token_id=None, request=None):
    token_id = token_id if token_id is not None else session.info.get("media_actor_token_id")
    if not operation_id:
        return None
    op = session.exec(select(AgentOperation).where(AgentOperation.operation_ref == _ref(operation_id))).first()
    if op and op.token_id != token_id:
        raise HTTPException(403, "This operation belongs to another actor")
    if op and request is not None and op.spec_json.get("request") not in (None, request):
        raise HTTPException(409, "Operation ID was already used for a different request")
    return op


def operation_result(session, op):
    items = session.exec(select(AgentOperationItem).where(AgentOperationItem.operation_id == op.id)).all()
    state = "needs_attention" if any(i.status == "needs_attention" for i in items) else "done" if all(i.status in {"applied", "superseded"} for i in items) else "applying"
    return {**op.summary_json, "operation_id": op.operation_ref, "operation_ref": op.operation_ref, "state": state,
        "items": [{"image_id": item.target_id, "cause": item.output_json.get("cause"),
                   "path": item.input_json.get("src"), "status": item.status} for item in items]}


def effect(image, dst=None, *, kind="move", src=None):
    source = str(src or image.path or "")
    sidecar = Path(source).with_suffix(".json") if source else None
    from app.services.media_paths import media_file_fingerprint, resolve_media_file
    physical = source
    if source and (not Path(source).is_file() or src is None and image.file_exists is False):
        from sqlalchemy.orm import object_session
        current = object_session(image)
        if current is not None:
            physical = resolve_media_file(image,current)
    fingerprint = media_file_fingerprint(physical) if physical else None
    return {"image_id": image.id, "revision": image.media_revision,
            "media_uuid": image.continuity_media_uuid,
            "source_fingerprint": fingerprint,
            "src": source, "dst": str(dst) if dst else None, "kind": kind,
            "sidecar_src": str(sidecar) if sidecar else None,
            "sidecar_dst": str(Path(dst).with_suffix(".json")) if dst and sidecar else None,
            "restore_marker_src": source+".restore.json" if source else None}


def committed_media_event(image_id, revision, *, is_deleted=False, project_id=None, folder=None, media_uuid=None):
    """Scalar catalog notification, captured in the transaction that changed it."""
    payload = {"image_ids": [image_id], "revision": revision, "is_deleted": bool(is_deleted),"media_uuid":media_uuid}
    if project_id is not None:
        payload["project_id"] = project_id
    if folder is not None:
        payload["folder"] = folder
    return payload


def stage_logical_events(session, operation, events):
    """Publish these UI notifications once the transaction commits.

    Best effort by design: no durable delivery queue. A missed notification is
    corrected by the next page load or gallery refresh, which read the catalog.
    """
    events = list(events)
    if not events:
        return
    transaction = session.get_nested_transaction() or session.get_transaction()
    session.info.setdefault("media_logical_events", []).append((operation.operation_ref, events, transaction))


def logical_event_catalog(bind, events):
    """Batch the cheap UUID guards without loading Images or opening per notice."""
    ids = {image_id for payload in events for image_id in payload["image_ids"]}
    with Session(bind) as session:
        rows = session.exec(select(Image.id,Image.continuity_media_uuid,Image.media_revision,Image.is_deleted)
            .where(Image.id.in_(ids))).all() if ids else []
    return {row[0]:row for row in rows}


def _current_logical_events(bind, events, current_catalog=None):
    current = logical_event_catalog(bind,events) if current_catalog is None else current_catalog
    result=[]
    for payload in events:
        expected = payload.get("media_uuid")
        if expected is None:
            continue  # An old numeric ID alone cannot identify a current Image.
        for image_id in payload["image_ids"]:
            row=current.get(image_id)
            if row is not None and row[1]!=expected or row is None and not payload.get("is_deleted"):
                continue
            result.append({**payload,"image_ids":[image_id],
                "revision":row[2] if row is not None else payload["revision"],
                "is_deleted":row[3] if row is not None else True})
    return result


@post_commit_safe
def publish_logical_events(bind, operation_ref, events, *, current_catalog=None):
    """Enqueue without waiting on Studio's loop; return only completed delivery state."""
    import asyncio
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        pass
    else:
        _event_dispatch.submit(publish_logical_events,bind,operation_ref,events,current_catalog=current_catalog)
        return False
    from app.services.agent.events import studio_event_bus
    for payload in _current_logical_events(bind,events,current_catalog):
        studio_event_bus.publish_sync({"type": "studio.media.updated",
            "actor": {"type": "system", "id": "media-operations"},
            "entity": {"kind": "media", "ids": payload["image_ids"]},
            "payload": {**payload, "operation_ref": operation_ref}})
    return True


@post_commit_safe
def _deliver_committed_events(bind,pending):
    catalog=logical_event_catalog(bind,[event for _ref,events,_transaction in pending for event in events])
    for operation_ref,events,_transaction in pending:
        publish_logical_events(bind,operation_ref,events,current_catalog=catalog)


@post_commit_safe
def _publish_after_commit(session):
    if session.in_nested_transaction():
        return  # Releasing a SAVEPOINT is not a committed catalog change.
    pending = session.info.pop("media_logical_events", [])
    if pending:
        bind = session.get_bind()
        _event_dispatch.submit(_deliver_committed_events,bind,pending)
        start_worker(bind=bind)


def _forget_rolled_back_events(session, previous_transaction):
    def retained(entry):
        transaction = entry[2]
        while transaction is not None:
            if transaction is previous_transaction:
                return False
            transaction = transaction.parent
        return True
    pending = [entry for entry in session.info.get("media_logical_events", []) if retained(entry)]
    if pending:
        session.info["media_logical_events"] = pending
    else:
        session.info.pop("media_logical_events", None)


from sqlalchemy import event as _orm_event
from sqlalchemy.orm import Session as _OrmSession
_orm_event.listen(_OrmSession, "after_commit", _publish_after_commit)
_orm_event.listen(_OrmSession, "after_soft_rollback", _forget_rolled_back_events)


def commit_operation(session, kind, plans, mutate, summary, *, operation_id=None, token_id=None, request=None):
    """Plans contain only scalar data. mutate performs DB changes only."""
    token_id = token_id if token_id is not None else session.info.get("media_actor_token_id")
    existing = find_operation(session, operation_id, token_id=token_id)
    if existing:
        if existing.kind != "media." + kind:
            raise HTTPException(409, "Operation ID was already used for a different action")
        return existing
    identifier = _ref(operation_id)
    # Acquire at BEGIN, before rereading revisions. Planning holds no writer.
    from app.db.writer import install_profile_writer
    install_profile_writer(session.get_bind())
    with planning(image_ids=[plan.get("image_id") for plan in plans],
                  paths=[plan.get("dst") for plan in plans],operation_ids=[identifier]), profile_write("media." + kind, "interactive"):
        if not session.new and not session.dirty and not session.deleted:
            session.rollback()
        session.connection().exec_driver_sql("BEGIN IMMEDIATE")
        existing=find_operation(session,identifier,token_id=token_id,request=request)
        if existing:
            session.rollback()
            return existing
        rows = {}
        for plan in plans:
            if plan.get("new_image"):
                row = Image(**plan["new_image"])
                session.add(row)
                session.flush()
                plan["image_id"] = row.id
                plan["revision"] = 0
                plan.setdefault("media_uuid",row.continuity_media_uuid)
            else:
                row = session.get(Image, plan["image_id"], populate_existing=True)
            if row is None or row.media_revision != plan["revision"] or row.continuity_media_uuid!=plan.get("media_uuid"):
                session.rollback()
                raise MediaPlanChanged()
            rows[row.id] = row
        op = AgentOperation(operation_ref=identifier, kind="media." + kind,
            token_id=token_id, owner_scope=session.info.get("media_actor_scope", "local-owner"),
            status="running", idempotency_key="media:" + identifier,
            summary_json=summary, spec_json={"version": 1, "media_effects": True, "request": request})
        session.add(op)
        session.flush()
        for position, plan in enumerate(plans):
            row = rows[plan["image_id"]]
            if kind == "restore":
                # Undo before a trash item is claimed changes only the catalog.
                pending = session.exec(select(AgentOperationItem).where(
                    AgentOperationItem.target_id == row.id, AgentOperationItem.status == "pending")).all()
                for previous in pending:
                    if previous.input_json.get("verb") == "trash":
                        previous.status = "superseded"
                        session.add(previous)
                        plan = {**plan, "src": row.path, "dst": row.path,
                                "sidecar_src": None, "sidecar_dst": None}
            row.media_revision += 1
            mutate(row, plan, session)
            summary.setdefault("revisions", {})[str(row.id)] = row.media_revision
            summary.setdefault("media_uuids", {})[str(row.id)] = row.continuity_media_uuid
            if row not in session.deleted:
                session.add(row)
            session.add(AgentOperationItem(operation_id=op.id, position=position,
                target_id=row.id, input_json={**plan, "verb": kind, "revision": row.media_revision, "operation_ref": identifier}))
        from copy import deepcopy
        op.summary_json = deepcopy(summary)
        from sqlalchemy.orm.attributes import flag_modified
        flag_modified(op, "summary_json")
        stage_logical_events(session, op, [committed_media_event(row.id, row.media_revision,
            is_deleted=row.is_deleted or row in session.deleted,
            project_id=summary.get("project_id"),media_uuid=row.continuity_media_uuid) for row in rows.values()])
        session.add(op)
        commit_profile(session)
    return op


def acknowledge(session, op, *, start=True):
    result = operation_result(session, op)
    bind = session.get_bind()
    logical_events = list(op.spec_json.get("logical_events", [])) if op.spec_json.get("logical_events_pending") else []
    operation_ref = op.operation_ref
    # Release the read transaction/connection before starting derived work.
    session.rollback()
    if logical_events:
        publish_logical_events(bind, operation_ref, logical_events)
    if start:
        start_worker(bind=bind)
    return result


def pending_sources(session):
    return {str(i.input_json.get("src")) for i in session.exec(select(AgentOperationItem).join(
        AgentOperation, AgentOperation.id == AgentOperationItem.operation_id).where(
        (AgentOperation.kind.like("media.%") | AgentOperation.kind.like("filesystem.%")), AgentOperationItem.status.in_(_PENDING))).all() if i.input_json.get("src")}


class RecoveryProtectionPending(OSError):
    """Retained for import compatibility; file effects no longer wait on backups."""


def _move_file(src,dst,token):
    """Move without overwriting; replay-safe from what is on disk.

    Same disk: hard-link the destination, then unlink the source. Across
    disks: copy to an owned temp beside the destination, fsync, link it into
    place, then unlink the source. Keep the temp link until catalog settlement
    so readers can verify the copied destination while its new inode is pending.
    A replay that finds the source
    gone and the destination present is done; one that finds the destination
    is our own link or temp finishes the unlink. A different file already at
    the destination is never overwritten.
    """
    src,dst=Path(src),Path(dst)
    if src==dst:return dst.exists()
    temporary=dst.with_name(".st-media-"+str(token)+".tmp")
    def finish_temporary():
        if not temporary.exists():
            return
        cleanup = _effect_cleanup.get()
        if cleanup is None:
            temporary.unlink(missing_ok=True)
        else:
            cleanup.append(str(temporary))
    if not src.exists():
        finish_temporary()
        return dst.exists()
    dst.parent.mkdir(parents=True,exist_ok=True)
    if dst.exists():
        if os.path.samefile(src,dst) or (temporary.exists() and os.path.samefile(temporary,dst)):
            src.unlink();finish_temporary()
            return True
        raise FileExistsError(str(dst))
    try:
        os.link(src,dst)
    except OSError as exc:
        if exc.errno not in (errno.EXDEV,errno.EPERM,errno.ENOTSUP):raise
        with src.open("rb") as incoming,temporary.open("wb") as outgoing:
            shutil.copyfileobj(incoming,outgoing,1024*1024)
            outgoing.flush();os.fsync(outgoing.fileno())
        os.link(temporary,dst)
    src.unlink()
    finish_temporary()
    return True


def _apply(plan, token):
    if plan.get("verb") == "filesystem":
        from app.services.file_effects import apply
        return apply(plan, token)
    if plan["kind"]=="noop":
        return {"exists":False}
    source = Path(plan["src"])
    from app.services.media_paths import _matches_media_fingerprint
    expected = plan.get("source_fingerprint")
    if source.is_file() and expected and not _matches_media_fingerprint(source,expected):
        raise OSError("media_source_identity_changed")
    if plan["kind"] == "unlink":
        source.unlink(missing_ok=True)
        if plan.get("sidecar_src"):
            Path(plan["sidecar_src"]).unlink(missing_ok=True)
        if plan.get("restore_marker_src"):
            Path(plan["restore_marker_src"]).unlink(missing_ok=True)
        return {"exists": False}
    target = Path(plan["dst"])
    # Destinations are chosen unique at plan time, so a missing source with a
    # present destination means this move already happened.
    exists = _move_file(source, target, token)
    if plan.get("sidecar_src") and plan.get("sidecar_dst"):
        _move_file(Path(plan["sidecar_src"]), Path(plan["sidecar_dst"]), token + "-sidecar")
    if plan.get("verb")=="restore" and plan.get("restore_marker_src"):
        Path(plan["restore_marker_src"]).unlink(missing_ok=True)
    return {"exists": exists, "dst": str(target)}


@post_commit_safe
def _derived(plans, bind, *, item_id=None):
    key=(bind,item_id)
    previous=_derived_publications.get(key) if item_id is not None else None
    if previous is not None:
        if not previous.done():
            return False
        _derived_publications.pop(key,None)
        previous.result()  # Already completed: never waits on an event loop.
        return True
    from app.services import project_media_views, project_stats_runtime
    from app.services.gallery.thumbnails import _purge_thumbnail_cache_for_path
    for plan in plans:
        for path in (plan.get("src"), plan.get("dst")):
            if path:
                _purge_thumbnail_cache_for_path(path)
    project_media_views.clear_project_media_view_caches()
    with Session(bind) as session:
        ids = [p["image_id"] for p in plans if p.get("image_id")]
        images = session.exec(select(Image).where(Image.id.in_(ids))).all() if ids else []
        expected_uuids = {p["image_id"]:p.get("media_uuid") for p in plans if p.get("image_id")}
        project_ids = project_stats_runtime.collect_project_ids_for_jobs(session,
            [i.job_id for i in images if i.continuity_media_uuid==expected_uuids.get(i.id)])
        item = session.get(AgentOperationItem,item_id) if item_id is not None else None
        cleanup_paths = list(item.output_json.get("cleanup_paths",[])) if item is not None else []
        cleanup_output = dict(item.output_json) if item is not None else {}
    from app.services.storage_file_effects import prepare_publication_cleanup, settle_publication_cleanup
    cleanup_proofs = prepare_publication_cleanup(plans, cleanup_output)
    # The byte transaction has settled. Its persisted derived intent owns these
    # cross-filesystem verification links until cleanup succeeds after restart.
    for path in cleanup_paths:
        Path(path).unlink(missing_ok=True)
    if item_id is not None and cleanup_proofs:
        settle_publication_cleanup(bind, item_id, cleanup_proofs)
    project_ids = set(project_ids) | {p["project_id"] for p in plans if p.get("project_id")}
    scheduler(bind).schedule(project_ids)
    from app.services.agent.events import studio_event_bus
    by_id = {image.id:image for image in images}
    for plan in plans:
        if not plan.get("image_id"):
            continue
        image = by_id.get(plan["image_id"])
        if plan.get("media_uuid") is None or image is not None and image.continuity_media_uuid!=plan["media_uuid"]:
            continue
        future = studio_event_bus.publish_sync({"type": "studio.media.updated",
            "actor": {"type": "system", "id": "media-operations"},
            "entity": {"kind": "media", "ids": [plan["image_id"]]},
            "payload": {"image_ids": [plan["image_id"]], "revision": image.media_revision if image else plan["revision"],
                        "is_deleted": image.is_deleted if image else True,"media_uuid":plan["media_uuid"], "operation_ref": plan.get("operation_ref")}})
        if future is not None:
            if future.done():
                future.result()
            elif item_id is not None:
                _derived_publications[key]=future
                def wake_after_delivery(_result):
                    wake=_worker_wakes.get(bind)
                    if wake is not None:
                        wake.set()
                future.add_done_callback(wake_after_delivery)
                return False
    return True


_schedulers = {}
def scheduler(bind):
    from app.services.project_stats_runtime import ProjectStatsRefreshScheduler
    if bind not in _schedulers:
        _schedulers[bind] = ProjectStatsRefreshScheduler(db_engine=bind)
    return _schedulers[bind]


def run_pending(*, bind, recover=False, fault=None):
    with _workers_lock:
        lock=_run_locks.setdefault(bind,threading.RLock())
    with lock:
        return _run_pending_owned(bind=bind,recover=recover,fault=fault)


_retention_checked = {}
RETENTION_SWEEP_SECONDS = 60.0
# Literal predicates so SQLite can use the matching partial indexes created by
# add_media_write_discipline; bound parameters would force a full JSON scan of
# every retained operation on each worker turn.
_OPEN_MEDIA_OPERATIONS = text("agentoperation.status != 'completed' AND "
    "(agentoperation.kind LIKE 'media.%' OR agentoperation.kind LIKE 'filesystem.%')")
_LOGICAL_EVENTS_PENDING = text("json_extract(agentoperation.spec_json,'$.logical_events_pending')=1")


def _run_pending_owned(*, bind, recover=False, fault=None):
    """Bounded replay turn. Tests invoke the same worker after crash points."""
    now = datetime.utcnow()
    processed = 0
    sweep = recover or time.monotonic() - _retention_checked.get(bind, -RETENTION_SWEEP_SECONDS) >= RETENTION_SWEEP_SECONDS
    if sweep:
        _retention_checked[bind] = time.monotonic()
    with Session(bind) as session, profile_write("media.retention", "background"):
        expired = [] if not sweep else session.exec(select(AgentOperation).where(
            (AgentOperation.kind.like("media.%") | AgentOperation.kind.like("filesystem.%")),
            AgentOperation.status == "completed", AgentOperation.completed_at < now - timedelta(days=7),
            func.coalesce(func.json_extract(AgentOperation.spec_json, "$.logical_events_pending"), 0) != 1
        ).limit(128)).all()
        for operation in expired:
            for item in session.exec(select(AgentOperationItem).where(AgentOperationItem.operation_id == operation.id)).all():
                session.delete(item)
            session.delete(operation)
        if expired:
            commit_profile(session)
    with Session(bind) as session:
        notifications = [(o.id, o.operation_ref, list(o.spec_json.get("logical_events", []))) for o in session.exec(
            select(AgentOperation).where(_LOGICAL_EVENTS_PENDING)
            .order_by(AgentOperation.id).limit(16)).all()]
        # Offline event delivery must never occupy the bounded file-work page.
        # These are independent queues even though they share the durable owner.
        ops = session.exec(select(AgentOperation).where(_OPEN_MEDIA_OPERATIONS)
            .order_by(AgentOperation.id).limit(64)).all()
        op_ids = [o.id for o in ops if o.spec_json.get("media_effects") or o.spec_json.get("filesystem_effects")]
    # Notification delivery precedes every filesystem turn, including slow effects.
    notification_deadline = time.monotonic() + .01
    catalog = logical_event_catalog(bind, [event for _, _, events in notifications for event in events])
    for position, (op_id, operation_ref, events) in enumerate(notifications):
        if position and time.monotonic() >= notification_deadline:
            break
        if publish_logical_events(bind, operation_ref, events, current_catalog=catalog):
            with Session(bind) as session, profile_session_write(session, label="media.logical_event", lane="background"):
                op = session.get(AgentOperation, op_id)
                if op is not None:
                    op.spec_json = {**op.spec_json, "logical_events_pending": False}
                    session.add(op)
    # Failed event delivery retains its own intent. Its read/preparation time
    # must never consume the independent file queue's opportunity to progress.
    deadline = time.monotonic() + .05
    for op_id in op_ids:
        with Session(bind, expire_on_commit=False) as session:
            items = session.exec(select(AgentOperationItem).where(AgentOperationItem.operation_id == op_id)
                .where(AgentOperationItem.status.in_(_PENDING) | (func.json_extract(AgentOperationItem.output_json,"$.derived_pending")==1))
                .where(func.coalesce(func.json_extract(AgentOperationItem.output_json,"$.recovery_network_inert"),0)!=1)
                .order_by(AgentOperationItem.position).limit(16)).all()
            item_ids = [i.id for i in items if i.status in _PENDING or i.output_json.get("derived_pending")]
        for item_id in item_ids:
            with Session(bind, expire_on_commit=False) as session:
                item = session.get(AgentOperationItem, item_id)
                if item is None:
                    continue
                original_plan = dict(item.input_json)
                original_output = dict(item.output_json)
                status = item.status
                retry_at = float(item.output_json.get("retry_at", 0))
            if (original_plan.get("recovery_local_only") and original_plan.get("kind") in {"s3_mkdir","s3_rmdir"}
                    and status in _PENDING):
                with Session(bind) as session,profile_session_write(session,label="media.restored_remote_attention",lane="background"):
                    item=session.get(AgentOperationItem,item_id)
                    if item and item.input_json==original_plan:
                        item.status="needs_attention"
                        item.output_json={**item.output_json,"recovery_network_inert":True,
                                          "cause":"restored_remote_requires_review"}
                        op=session.get(AgentOperation,item.operation_id);op.status="needs_attention"
                        session.add_all([item,op])
                continue
            if status in {"applied","superseded"}:
                if processed and (processed >= 16 or time.monotonic() >= deadline):
                    return True
                processed += 1
                if _derived([original_plan], bind, item_id=item_id):
                    with Session(bind) as session:
                        item = session.get(AgentOperationItem, item_id)
                        item.output_json = {**item.output_json, "derived_pending": False}
                        session.add(item)
                        commit_profile(session, label="media.derived")
                continue
            if status not in _PENDING or not recover and (retry_at > time.time() or status == "applying"):
                continue
            # Preparation on a busy CPU must not prevent every unit of work.
            # Make progress once, then yield at the ordinary turn boundary.
            if processed and (processed >= 16 or time.monotonic() >= deadline):
                return True
            processed += 1
            # Filesystem planning precedes the short claim transaction. A
            # compare-and-set below prevents Undo from being overwritten by a
            # worker that read its old pending item before Undo committed.
            plan = dict(original_plan)
            old_dst = None
            src = Path(plan["src"]) if plan.get("src") else None
            dst = Path(plan["dst"]) if plan.get("dst") else None
            if (plan["verb"] != "filesystem" or plan.get("kind")=="publish_file" and plan.get("updates_media") and not plan.get("expected_dst_sha256")) and dst and src != dst and src.exists() and dst.exists():
                temporary = dst.with_name(".st-media-" + str(item_id) + ".tmp")
                replay_copy = temporary.exists() and os.path.samefile(temporary, dst)
                if not os.path.samefile(src, dst) and not replay_copy:
                    old_dst = str(dst)
                    dst = dst.with_name(dst.stem + "-" + str(item_id) + dst.suffix)
                    while dst.exists():
                        dst = dst.with_name(dst.stem + "-copy" + dst.suffix)
                    plan["logical_dst"] = plan.get("logical_dst", old_dst)
                    plan["dst"] = str(dst)
                    if plan.get("sidecar_dst"):
                        plan["sidecar_dst"] = str(dst.with_suffix(".json"))
            with Session(bind, expire_on_commit=False) as session, profile_write("media.claim"):
                session.connection().exec_driver_sql("BEGIN IMMEDIATE")
                item = session.get(AgentOperationItem, item_id)
                if item is None or item.status != status or item.input_json != original_plan:
                    session.rollback()
                    continue
                from sqlalchemy import or_,and_,literal
                resources=[]
                if item.target_id is not None:
                    resources.append(AgentOperationItem.target_id==item.target_id)
                previous_kind=func.json_extract(AgentOperationItem.input_json,"$.kind")
                for path in (plan.get("src"),plan.get("dst")):
                    if not path:
                        continue
                    for key in ("src","dst"):
                        previous_path=func.json_extract(AgentOperationItem.input_json,"$."+key)
                        resources.append(previous_path==path)
                        resources.append(and_(previous_kind=="move_dir",
                            func.substr(literal(path),1,func.length(previous_path)+1)==previous_path.concat(os.sep)))
                        if plan.get("kind")=="move_dir":
                            resources.append(previous_path.startswith(path+os.sep,autoescape=True))
                resource=or_(*resources) if resources else False
                predecessor = session.exec(select(AgentOperationItem.id).where(
                    resource, AgentOperationItem.id < item.id,
                    AgentOperationItem.status.in_(_PENDING))).first()
                if predecessor is not None:
                    session.rollback()
                    continue
                current_uuid = session.exec(select(Image.continuity_media_uuid).where(Image.id==item.target_id)).first() if item.target_id is not None else None
                catalog_matches = current_uuid is not None and current_uuid==plan.get("media_uuid")
                plan["catalog_identity_current"] = catalog_matches
                if old_dst is not None:
                    following = session.exec(select(AgentOperationItem).where(AgentOperationItem.target_id == item.target_id,
                        AgentOperationItem.id > item.id, AgentOperationItem.status.in_(_PENDING))).all()
                    for future in following:
                        next_plan = dict(future.input_json)
                        if next_plan.get("src") == old_dst and next_plan.get("media_uuid")==plan.get("media_uuid"):
                            next_plan["src"] = plan["dst"]
                            if next_plan.get("sidecar_src"):
                                next_plan["sidecar_src"] = plan["sidecar_dst"]
                            future.input_json = next_plan
                            session.add(future)
                item.input_json, item.status = plan, "applying"
                queued_at = item.created_at
                session.add(item)
                commit_profile(session)
            if component_trace_enabled():
                record_component_duration("effect.item_age_at_apply", (datetime.utcnow()-queued_at).total_seconds()*1000,
                    item_id=item_id, kind=plan.get("kind"), includes_retries=True)
            if fault:
                fault("after_commit", plan)
            try:
                token = _effect_bind.set(bind)
                cleanup_token = _effect_cleanup.set([])
                item_token = _effect_item_id.set(item_id)
                try:
                    with component_span("effect.apply", kind=plan.get("kind")):
                        output = _apply(plan, str(item_id))
                    if _effect_cleanup.get():
                        output["cleanup_paths"] = list(dict.fromkeys(_effect_cleanup.get()))
                    if output.get("exists") and output.get("dst"):
                        from app.services.media_paths import media_file_fingerprint
                        output.setdefault("media_fingerprint", media_file_fingerprint(output["dst"]))
                finally:
                    _effect_cleanup.reset(cleanup_token)
                    _effect_item_id.reset(item_token)
                    _effect_bind.reset(token)
                if fault:
                    fault("before_settle", plan)
            except OSError as exc:
                with Session(bind) as session, profile_write("media.retry"):
                    item = session.get(AgentOperationItem, item_id)
                    output = dict(item.output_json)
                    first = float(output.get("first_failure", time.time()))
                    count = int(output.get("attempts", 0)) + 1
                    output.update(first_failure=first, attempts=count,
                                  retry_at=time.time()+min(60, 2**min(count, 6)), cause=type(exc).__name__)
                    item.output_json = output
                    item.status = "needs_attention" if time.time()-first >= 600 else "pending"
                    session.add(item)
                    commit_profile(session)
                continue
            with Session(bind) as session, profile_session_write(session,label="media.settle",lane="background"):
                if plan.get("storage_placement_id") or plan.get("recovery_local_only"):
                    session.info["project_storage_local_only"]=True
                if plan.get("recovery_local_only"):
                    session.info["recovery_local_only"]=True
                item = session.get(AgentOperationItem, item_id)
                image = session.get(Image, item.target_id, options=(lazyload(Image.generation), defer(Image.thumbnail_data))) if item.target_id is not None else None
                logical_dst = plan.get("logical_dst", plan.get("dst"))
                identity_matches = image and plan.get("media_uuid") is not None and image.continuity_media_uuid==plan["media_uuid"]
                matches_current = identity_matches and (
                    image.media_revision == plan["revision"] or
                    plan["verb"] == "trash" and image.is_deleted and image.trash_path == logical_dst or
                    plan["verb"] in {"restore", "move", "rename"} and not image.is_deleted and image.path == logical_dst or
                    plan["verb"]=="filesystem" and plan.get("updates_media") and not image.is_deleted and image.path==logical_dst)
                if plan.get("storage_effect"):
                    from app.services.storage_file_effects import settle
                    settle(session,plan,output)
                if image and matches_current and not plan.get("storage_effect") and not output.get("superseded") and (plan["verb"]!="filesystem" or plan.get("updates_media")):
                    if plan["verb"] == "purge":
                        session.delete(image)
                    else:
                        if plan["verb"] == "trash":
                            image.trash_path = output.get("dst") if output["exists"] else None
                        elif output.get("dst"):
                            image.path = output["dst"]
                            image.filename = Path(image.path).name
                            from app.services.gallery.image_identity import assign_image_path_identity
                            assign_image_path_identity(image)
                        image.file_exists = output["exists"] and plan["verb"] != "trash"
                        session.add(image)
                if (image and matches_current and not image.is_deleted and image.file_exists
                        and plan.get("updates_media") and plan.get("output_job_id") is not None
                        and not plan.get("recovery_local_only") and not output.get("superseded")):
                    from app.services.project_object_storage import enqueue_outputs
                    enqueue_outputs(session,plan["output_job_id"],[image])
                if plan.get("storage_placement_id") and identity_matches:
                    from app.models.project_storage import LocalMediaPlacement
                    placement=session.get(LocalMediaPlacement,plan["storage_placement_id"])
                    if placement and placement.claim_token == plan.get("storage_claim_token"):
                        placement.state,placement.error_code=("present",None) if image and not image.is_deleted else ("skipped","media_deleted")
                        placement.claim_token,placement.claim_expires_at=None,None
                        placement.fingerprint_json=output.get("fingerprint",{})
                        if output.get("dst") and placement.destination != output["dst"]:
                            placement.destination=output["dst"]
                            from app.services.project_storage_placements import canonical_destination
                            placement.canonical_destination=canonical_destination(output["dst"])
                            placement.relative_path=str(Path(placement.relative_path).with_name(Path(output["dst"]).name))
                        placement.details_json={**(placement.details_json or {}),"published":True,"publication_method":"hardlink_no_replace"}
                        if image and matches_current:
                            image.cloud_reference=False
                            session.add(image)
                        session.add(placement)
                if plan.get("storage_transfer_id") and not plan.get("storage_effect"):
                    from app.services.storage_file_effects import settle_transfer
                    settle_transfer(session,plan,output)
                if item.target_id is not None and output.get("media_fingerprint") and not output.get("superseded"):
                    following = session.exec(select(AgentOperationItem).where(
                        AgentOperationItem.target_id==item.target_id, AgentOperationItem.id>item.id,
                        AgentOperationItem.status.in_(_PENDING))).all()
                    for future in following:
                        if future.input_json.get("src")==output.get("dst") and future.input_json.get("media_uuid")==plan.get("media_uuid"):
                            future.input_json={**future.input_json,"source_fingerprint":output["media_fingerprint"]}
                            session.add(future)
                item.status = "superseded" if output.get("superseded") else "applied"
                # Cross-filesystem links remain owned until cleanup after this
                # commit. Ordinary cache/UI work remains best effort.
                cleanup_pending = bool(output.get("cleanup_paths"))
                item.output_json = {**output, "derived_pending": cleanup_pending}
                session.add(item)
                session.flush()
                op = session.get(AgentOperation, item.operation_id)
                if op is not None and not session.exec(select(AgentOperationItem.id).where(
                        AgentOperationItem.operation_id == op.id,
                        (AgentOperationItem.status.in_(_PENDING) |
                         (func.json_extract(AgentOperationItem.output_json,"$.derived_pending")==1))).limit(1)).first():
                    op.status, op.completed_at = "completed", now
                    session.add(op)
            if not cleanup_pending:
                _derived([plan], bind)
        with Session(bind) as session, profile_write("media.complete"):
            op = session.get(AgentOperation, op_id)
            if op is None or op.status == "completed":
                continue
            remaining = session.exec(select(AgentOperationItem).where(AgentOperationItem.operation_id == op_id,
                (AgentOperationItem.status.in_(_PENDING) | (func.json_extract(AgentOperationItem.output_json, "$.derived_pending") == 1)))).all()
            if not remaining:
                op.status, op.completed_at = "completed", now
                session.add(op)
                commit_profile(session)


@post_commit_safe
def start_worker(*, bind=None):
    if bind is None:
        from app.db.engine import engine
        bind = engine
    with _workers_lock:
        worker = _workers.get(bind)
        if worker and worker.is_alive():
            _worker_wakes[bind].set()
            return
        stop = threading.Event()
        wake = threading.Event()
        _worker_stops[bind] = stop
        _worker_wakes[bind] = wake
        def work():
            from app.core.profile_runtime_guard import acquire_profile_background_mutation_lease, restart_required_payload
            from app.services.media_legacy_recovery import LegacyPurgeRecovery
            recovery = LegacyPurgeRecovery(bind, logger=log)
            first = True
            try:
                while not stop.is_set():
                    try:
                        with acquire_profile_background_mutation_lease():
                            discovering = recovery.step() if not recovery.done else False
                            more = run_pending(bind=bind, recover=first)
                        first = False
                        if more or discovering:
                            continue
                    except Exception:
                        if restart_required_payload() is not None:
                            return
                        log.exception("Media operations worker will resume on next wake")
                    wake.wait(1)
                    wake.clear()
            finally:
                recovery.close()
        worker = threading.Thread(target=work, daemon=True, name="media-operations")
        _workers[bind] = worker
        worker.start()


def stop_workers(timeout=5):
    with _workers_lock:
        pairs = [(worker, _worker_stops[bind]) for bind,worker in _workers.items()]
        for worker,stop in pairs:
            stop.set()
        for wake in _worker_wakes.values():
            wake.set()
    for worker,stop in pairs:
        if worker is not threading.current_thread():
            worker.join(timeout)
    for current in list(_schedulers.values()):
        current.stop(timeout)
    _schedulers.clear()
    with _workers_lock:
        for bind,worker in list(_workers.items()):
            if not worker.is_alive():
                _workers.pop(bind,None)
                _worker_stops.pop(bind,None)
                _worker_wakes.pop(bind,None)
                _run_locks.pop(bind,None)
                for key in [key for key in _derived_publications if key[0] is bind]:
                    _derived_publications.pop(key).cancel()
                with _logical_publications_lock:
                    for key in [key for key in _logical_publications if key[0] is bind]:
                        for future in _logical_publications.pop(key):
                            future.cancel()
    return all(not worker.is_alive() for worker,stop in pairs)



@replan_once
def trash(image_ids, session, *, operation_id=None, token_id=None, untracked_paths=None, request_spec=None, summary_extra=None):
    from app.services.bridge.transfers import mark_lifecycle
    request = request_spec or {"verb":"trash","image_ids":sorted(set(image_ids)),"paths":sorted(untracked_paths or [])}
    with session.no_autoflush:
        existing = find_operation(session, operation_id, token_id=token_id, request=request)
        if existing:
            return acknowledge(session, existing)
        rows = [session.get(Image, i) for i in dict.fromkeys(image_ids)]
        found = [i for i in rows if i is not None]
        identifier = _ref(operation_id)
        plans = []
        for image in found:
            if image.is_deleted:
                continue
            source = Path(image.path)
            dst = source.parent / ".trash" / (identifier + "-" + str(image.id) + "-" + source.name)
            plans.append(effect(image,dst) if not image.cloud_reference else
                {"image_id":image.id,"revision":image.media_revision,"media_uuid":image.continuity_media_uuid,"kind":"noop","src":image.path,"dst":None})
        for path in untracked_paths or []:
            source=Path(path)
            image=Image(job_id=-1,path=str(source),filename=source.name,format=source.suffix.lstrip("."),file_exists=True)
            dst=source.parent/".trash"/(identifier+"-"+source.name)
            plan=effect(image,dst)
            plan["new_image"]=image.model_dump(exclude={"id","created_at"})
            plans.append(plan)
        summary = {"deleted": len(found), "deleted_ids": [i.id for i in found],
                   "not_found": [i for i in image_ids if i not in {r.id for r in found}], "file_errors": [], "files_deleted": len(plans),"trash_paths":[],**(summary_extra or {})}
        summary["deleted"]=len(found)+len(untracked_paths or [])
        def mutate(row, plan, current):
            row.is_deleted = True
            row.deleted_at = row.deleted_at or datetime.utcnow()
            row.trash_path = plan["dst"]
            if row.id not in summary["deleted_ids"]:
                summary["deleted_ids"].append(row.id)
            from app.services.project_catalog_trash import trash_handle
            summary["trash_paths"].append(plan["dst"] or trash_handle(row.continuity_media_uuid,row.filename))
            row.file_exists = False
            mark_lifecycle(row, "trash")
        op = commit_operation(session, "trash", plans, mutate, summary, operation_id=identifier, token_id=token_id, request=request)
        return acknowledge(session, op)


@replan_once
def restore(image_ids, session, *, operation_id=None, token_id=None, untracked=None, request_spec=None):
    from app.services.bridge.transfers import mark_lifecycle
    request = request_spec or {"verb":"restore","image_ids":sorted(set(image_ids)),"untracked":untracked or []}
    with session.no_autoflush:
        existing = find_operation(session, operation_id, token_id=token_id, request=request)
        if existing:
            return acknowledge(session, existing)
        rows = [session.get(Image, i) for i in dict.fromkeys(image_ids)]
        plans, conflicts = [], []
        for row in rows:
            if row is None:
                continue
            if not row.is_deleted:
                continue
            from app.services.gallery.image_identity import image_path_identity
            from app.services.gallery.image_lookup import active_images_for_paths
            other = next((image for image in active_images_for_paths(session,
                identities=(image_path_identity(row.path),)) if image.id != row.id), None)
            if other:
                conflicts.append(row.id)
                continue
            if row.trash_path and not Path(row.trash_path).exists():
                from app.services.project_folder_mutations import recover_project_folder_trash_purges
                recover_project_folder_trash_purges(Path(row.trash_path).parent,session=session,logger=log)
            plans.append(effect(row,row.path,src=row.trash_path or row.path) if not row.cloud_reference else
                {"image_id":row.id,"revision":row.media_revision,"media_uuid":row.continuity_media_uuid,"kind":"noop","src":row.path,"dst":None})
        for entry in untracked or []:
            source,target=Path(entry["src"]),Path(entry["dst"])
            row=Image(job_id=-1,path=str(target),filename=target.name,format=target.suffix.lstrip("."),
                is_deleted=True,trash_path=str(source),file_exists=False)
            plan=effect(row,target,src=source)
            plan["new_image"]=row.model_dump(exclude={"id","created_at"})
            plans.append(plan)
        def mutate(row, plan, current):
            row.is_deleted, row.deleted_at, row.trash_path = False, None, None
            row.file_exists = False
            mark_lifecycle(row, "restore")
        summary = {"restored": len(plans), "not_found": [i for i,r in zip(dict.fromkeys(image_ids),rows) if r is None],
                   "conflicts": conflicts, "file_errors": []}
        op = commit_operation(session, "restore", plans, mutate, summary, operation_id=operation_id, token_id=token_id, request=request)
        return acknowledge(session, op)


@replan_once
def rename(image_id, new_name, session, *, operation_id=None, token_id=None, request_spec=None):
    from app.services.gallery.mutation_contracts import normalize_media_rename_filename, _casefold_name_conflict
    from app.services.gallery.image_identity import assign_image_path_identity
    request = request_spec or {"verb": "rename", "image_id": image_id, "new_name": new_name}
    with session.no_autoflush:
        existing = find_operation(session, operation_id, token_id=token_id, request=request)
        if existing:
            return acknowledge(session, existing)
        image = session.get(Image, image_id)
        if image is None or image.is_deleted:
            raise HTTPException(404, "Media not found")
        old = Path(image.path)
        name = normalize_media_rename_filename(image.filename, new_name)
        target = old.with_name(name)
        if target != old and _casefold_name_conflict(old.parent, name, source=old):
            raise HTTPException(409, "A file with that name already exists")
        plan = effect(image, target)
        def mutate(row, plan, current):
            row.path, row.filename, row.thumbnail_path = plan["dst"], name, None
            row.file_exists = False
            assign_image_path_identity(row)
        summary = {"image_id": image_id, "filename": name, "old_path": str(old), "new_path": str(target), "changed": target != old}
        op = commit_operation(session, "rename", [plan], mutate, summary, operation_id=operation_id, token_id=token_id, request=request)
        return acknowledge(session, op)



def _purge_metadata(row, plan, session):
    """Retain remote replicas; Empty Trash removes local catalog metadata."""
    from app.models.storage import StorageAsset, StorageTransfer
    from app.models.project_storage import LocalMediaPlacement
    for placement in session.exec(select(LocalMediaPlacement).where(LocalMediaPlacement.image_id==row.id)).all():
        # Retain historical ownership without binding it to a reused Image PK.
        placement.image_id=None
        placement.media_uuid=placement.media_uuid or row.continuity_media_uuid
        placement.state,placement.error_code="skipped","media_deleted"
        session.add(placement)
    for asset in session.exec(select(StorageAsset).where(StorageAsset.image_id == row.id)).all():
        asset.image_id = None
        if asset.local_path in {row.path, row.trash_path}:
            asset.local_path = None
        session.add(asset)
    for transfer in session.exec(select(StorageTransfer).where(StorageTransfer.image_id == row.id)).all():
        transfer.image_id = None
        if transfer.state not in {"completed","cancelled","failed"}:
            transfer.cancel_requested=True
        session.add(transfer)
    from sqlalchemy import inspect, text
    if inspect(session.get_bind()).has_table("gallery_fts"):
        session.execute(text("DELETE FROM gallery_fts WHERE rowid=:id"), {"id": row.id})
    from app.models.image import PurgedOutput
    from app.services.output_identity_fences import registration_fence_keys, tombstone_identity
    from app.models.job import Job
    created_at = session.exec(select(Job.created_at).where(Job.id==row.job_id)).first() if row.job_id>=0 else None
    keys = registration_fence_keys(output_key=row.output_key, path=row.path,
        media_uuid=row.continuity_media_uuid, metadata=row.extra_metadata,job_instance=created_at)
    if row.path_identity and row.path_identity != row.path:
        keys = (*keys, *registration_fence_keys(path=row.path_identity,job_instance=created_at))
    for key in set(keys):
        identity = tombstone_identity(row.job_id,key)
        if session.get(PurgedOutput,identity) is None:
            session.add(PurgedOutput(identity=identity,job_id=row.job_id,output_key=key))
    session.delete(row)


@replan_once
def purge(image_ids, session, *, operation_id=None, token_id=None):
    request = {"verb": "purge", "image_ids": sorted(set(image_ids))}
    with session.no_autoflush:
        existing = find_operation(session, operation_id, token_id=token_id, request=request)
        if existing:
            return acknowledge(session, existing)
        rows = [session.get(Image, i) for i in dict.fromkeys(image_ids)]
        if any(r is not None and not r.is_deleted for r in rows):
            raise HTTPException(409, "Only items in Trash can be purged")
        plans = [effect(r, src=r.trash_path or r.path, kind="unlink") for r in rows if r]
        op = commit_operation(session, "purge", plans, _purge_metadata,
            {"purged": len(plans)}, operation_id=operation_id, token_id=token_id, request=request)
        return acknowledge(session, op)


@replan_once
def path_action(path, session, *, kind="trash", new_name=None, operation_id=None, token_id=None):
    """Untracked local files gain a catalog row and Undo in the same commit."""
    from app.services.gallery.paths import _resolve_media_path
    from app.services.gallery.image_identity import image_path_identity, assign_image_path_identity
    from app.services.gallery.mutation_contracts import normalize_media_rename_filename, _casefold_name_conflict
    request = {"verb": kind, "path": str(path), "new_name": new_name}
    with session.no_autoflush:
        existing = find_operation(session, operation_id, token_id=token_id, request=request)
        if existing:
            return acknowledge(session, existing)
        actual = _resolve_media_path(path, session)
        if not actual or not Path(actual).is_file():
            raise HTTPException(404, "Media not found")
        source = Path(actual)
        from app.services.gallery.image_lookup import active_images_for_paths
        row = next(iter(active_images_for_paths(session, paths=(str(source),))), None)
        if row:
            result = trash([row.id], session, operation_id=operation_id, token_id=token_id,request_spec=request) if kind == "trash" else rename(row.id, new_name, session, operation_id=operation_id, token_id=token_id,request_spec=request)
            if kind == "trash":
                result.update(deleted=bool(result["deleted"]),db_updated=True,path=str(path))
            return result
        identifier = _ref(operation_id)
        target = source.parent / ".trash" / (identifier + "-" + source.name) if kind == "trash" else source.with_name(normalize_media_rename_filename(source.name, new_name))
        if kind == "rename" and target != source and _casefold_name_conflict(source.parent, target.name, source=source):
            raise HTTPException(409, "A file with that name already exists")
        row = Image(job_id=-1, path=str(source), filename=source.name, format=source.suffix.lstrip("."), file_exists=True)
        plan = effect(row, target)
        plan["new_image"] = row.model_dump(exclude={"id", "generation", "created_at"})
        summary = {"deleted": True, "path": str(source), "db_updated": True, "deleted_ids": [],
            "image_id": None, "filename": target.name, "old_path": str(source), "new_path": str(target), "changed": source != target}
        def mutate(image, item, current):
            summary["image_id"] = image.id
            if kind == "trash":
                image.is_deleted, image.deleted_at, image.trash_path, image.file_exists = True, datetime.utcnow(), item["dst"], False
                summary["deleted_ids"].append(image.id)
            else:
                image.path, image.filename = item["dst"], target.name
                image.file_exists = False
            assign_image_path_identity(image)
        op = commit_operation(session, kind, [plan], mutate, summary, operation_id=identifier, token_id=token_id, request=request)
        return acknowledge(session, op)


def backlog(*,bind=None):
    if bind is None:
        from app.db.engine import engine
        bind=engine
    with Session(bind) as session:
        rows=session.exec(select(AgentOperationItem.status,func.count(AgentOperationItem.id)).join(
            AgentOperation,AgentOperation.id==AgentOperationItem.operation_id).where(
                (AgentOperation.kind.like("media.%")|AgentOperation.kind.like("filesystem.%")),
                AgentOperationItem.status.in_(_PENDING)).group_by(AgentOperationItem.status)).all()
    return dict(rows)
