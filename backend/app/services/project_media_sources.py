"""Reusable media connections, bounded project attachments and lazy folders.

Source definitions reuse private storage. A filesystem path is a local binding;
project attachments and folder IDs remain portable and never contain that path.

The persisted legacy flag identifies the project's own logical root, not a
filesystem connection. Its hierarchy and media belong to Project; its synthetic
source_id is retained only for compatibility with saved selections. All physical
project writes use project_folder_context.resolve_project_write_directory.
"""
from __future__ import annotations

import copy
import os
import threading
import time
from pathlib import Path
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from fastapi import HTTPException
from sqlmodel import Session, select

from app.models.app_setting import AppSetting
from app.models.directory_configuration import DirectoryDeviceBinding
from app.models.project import Project, canonical_project_slug
from app.models.storage import StorageLocation, ProjectStorageBinding, JobMediaDestination, JobStorageDestination
from app.services.directory_configuration import device_key, _binding_id
from app.services.project_folder_tree import folder_tree, normalize_folder_path, safe_folder_child

DEFAULT_KEY = "media_source_default_id"
_searches = {}
_search_lock = threading.Lock()


def _directory_search(directory, relative=""):
    # A suspended depth-first iterator retains one directory handle per level,
    # rather than every sibling or an entire recursive listing in memory.
    with os.scandir(directory) as entries:
        for entry in entries:
            if entry.name.startswith(".") or not entry.is_dir(follow_symlinks=False):
                continue
            path = "/".join(part for part in (relative, entry.name) if part)
            try:
                normalize_folder_path(path)
            except HTTPException:
                continue
            yield path
            yield from _directory_search(Path(entry.path), path)


def _search_page(session, project, root, row, query, cursor, limit):
    if row.kind == "s3":
        from app.services import object_storage as storage
        prefix = storage.prefix_for(row, root["prefix"])
        with storage.client(row) as client:
            page = client.list_objects_v2(Bucket=row.bucket, Prefix=prefix, MaxKeys=limit,
                **({"ContinuationToken": cursor} if cursor else {}))
        paths = set()
        for entry in page.get("Contents", []):
            relative = entry["Key"][len(prefix):]
            parts = relative.split("/")[:-1]
            for end in range(1, len(parts) + 1):
                path = "/".join(parts[:end])
                if query.casefold() in (root["label"] + "/" + path).casefold():
                    paths.add(path)
        return sorted(paths), page.get("NextContinuationToken")
    identity = (str(session.get_bind().url), project.id, root["id"], query)
    with _search_lock:
        now = time.monotonic()
        for key, state in list(_searches.items()):
            if state[2] < now - 120 or len(_searches) >= 32 and not cursor:
                state[1].close()
                del _searches[key]
        if cursor:
            state = _searches.get(cursor)
            if state is None or state[0] != identity:
                raise HTTPException(409, "The folder search expired. Start the search again.")
        else:
            cursor = str(uuid4())
            state = [identity, _directory_search(_filesystem_root(session, row, root)), now]
            _searches[cursor] = state
        state[2] = now
        matches = []
        # Each continuation also advances a bounded amount when there are no
        # matches. The caller can continue without blocking the whole browser.
        for _ in range(2000):
            try:
                path = next(state[1])
            except StopIteration:
                del _searches[cursor]
                return matches, None
            if query.casefold() in (root["label"] + "/" + path).casefold():
                matches.append(path)
                if len(matches) == limit:
                    break
        return matches, cursor


def selection_token(destination):
    return "media:" + destination["attachment_id"] + ":" + (destination.get("folder_id") or "root")


def parse_selection(value):
    if not isinstance(value, str) or not value.startswith("media:"):
        return None
    try:
        _, attachment_id, folder_id = value.split(":")
        return str(UUID(attachment_id)), str(UUID(folder_id)) if folder_id != "root" else None
    except (ValueError, AttributeError):
        raise HTTPException(422, "The selected media folder is invalid. Choose it again.")


def job_folder(job):
    metadata = job.generation.output_metadata_json if job.generation else {}
    destination = (metadata or {}).get("media_destination")
    if destination:
        return selection_token(destination)
    from sqlalchemy.orm import object_session
    session = object_session(job)
    frozen = session.get(JobMediaDestination, job.id) if session is not None and job.id else None
    return selection_token({"attachment_id": frozen.attachment_id, "folder_id": frozen.folder_id}) if frozen else job.output_dir or "output"


def _config(project):
    return copy.deepcopy(project.config_json or {})


def _save_config(session, project, config):
    project.config_json = config
    session.add(project)


def default_source_id(session):
    setting = session.exec(select(AppSetting).where(AppSetting.key == DEFAULT_KEY)).first()
    return setting.value if setting else None


def set_default(session, source_id):
    if source_id:
        source(session, source_id)
    setting = session.exec(select(AppSetting).where(AppSetting.key == DEFAULT_KEY)).first() or AppSetting(key=DEFAULT_KEY)
    setting.value = source_id
    session.add(setting)


def source(session, source_id):
    row = session.get(StorageLocation, str(source_id))
    if row is None or row.deleted:
        raise HTTPException(410, "This media source was removed. Choose another source.")
    return row


def bound_directory(session, row):
    binding = session.get(DirectoryDeviceBinding, _binding_id(row.id, row.id))
    return Path(binding.path) if binding else None


def bind_directory(session, row, path):
    candidate = Path(path).expanduser()
    if not candidate.is_absolute() or not candidate.is_dir():
        raise HTTPException(400, "Choose an existing absolute directory on this computer.")
    binding = session.get(DirectoryDeviceBinding, _binding_id(row.id, row.id)) or DirectoryDeviceBinding(
        id=_binding_id(row.id, row.id), configuration_id=row.id, directory_id=row.id, device_key=device_key(), path=str(candidate.resolve()))
    binding.path = str(candidate.resolve())
    session.add(binding)


def source_read(session, row):
    directory = bound_directory(session, row) if row.kind == "filesystem" else None
    if row.kind == "filesystem":
        availability = "needs_directory" if directory is None else "available" if directory.is_dir() else "unavailable"
    else:
        from app.services.object_storage import credentials_available
        availability = "available" if row.enabled and credentials_available(row.id) else "credentials_required"
    return {"id": row.id, "name": row.name, "kind": row.kind, "revision": row.definition_revision,
            "default": default_source_id(session) == row.id, "availability": availability,
            "directory": str(directory) if directory else None,
            "capabilities": {"browse": not row.deleted, "write": row.allow_writes, "delete": row.allow_deletes}}


def create_directory_source(session, name, path, allow_writes):
    row = StorageLocation(name=name.strip(), kind="filesystem", bucket="", allow_writes=allow_writes)
    bind_directory(session, row, path)
    session.add(row)
    return row


def _attachments(project):
    return _config(project).get("media_sources", [])


def _attachment(project, identifier):
    row = next((row for row in _attachments(project) if row["id"] == identifier and not row.get("deleted")), None)
    if row is None:
        raise HTTPException(410, "This source is no longer attached to the project.")
    return row


def attach(session, project, source_id, *, label, prefix="", writable=False, default=False, legacy=False, identifier=None):
    row = source(session, source_id)
    if prefix:
        prefix = normalize_folder_path(prefix)
    if writable and not row.allow_writes:
        raise HTTPException(403, "This source does not allow adding media.")
    config = _config(project)
    roots = config.get("media_sources", [])
    attachment = {"id": identifier or str(uuid4()), "source_id": row.id, "label": label.strip() or row.name,
        "prefix": prefix, "writable": writable, "revision": 1, "deleted": False, "legacy": legacy, "folder_tree": []}
    roots.append(attachment)
    config["media_sources"] = roots
    if default:
        config["media_default_attachment_id"] = attachment["id"]
    _save_config(session, project, config)
    return attachment


def _legacy_directory_intent(session, project, *, fresh=False):
    """Read only persisted intent; filesystem inspection belongs to preparation."""
    from app.models.engine import Engine
    from app.services.media_paths import get_project_storage_root_dir
    from app.services.local_storage_engine import owns_local_files
    directory = get_project_storage_root_dir(project)
    if directory or project.continuity_origin == "remote":
        return directory
    engines = session.exec(select(Engine).where(Engine.connection_kind == "local",
        Engine.runtime_kind == "comfyui").order_by(Engine.id)
        .execution_options(populate_existing=fresh)).all()
    local = [engine for engine in engines if owns_local_files(engine)]
    engine = next((engine for engine in local if engine.name == "Local ComfyUI"), local[0] if local else None)
    return engine.input_dir if engine else None


def _prepare_legacy_attachment(session, project):
    """Inspect the selected directory without native writer ownership."""
    directory = _legacy_directory_intent(session, project)
    if not directory:
        return {"directory": directory}
    identifier = str(uuid5(NAMESPACE_URL, "studio-project-media-root:" + device_key() + ":" + str(directory)))
    candidate = Path(directory)
    binding = str(candidate.resolve()) if candidate.is_absolute() and candidate.is_dir() else None
    return {"directory": directory, "id": identifier, "name": candidate.name or "Project media",
            "binding": binding, "binding_id": _binding_id(identifier, identifier), "device_key": device_key()}


def ensure_existing_attachments(session, project):
    if _config(project).get("media_sources_initialized"):
        return
    from app.db.writer import profile_session_write
    project_id, created_at = project.id, project.created_at
    # Preparation can race a deliberate project-directory edit. Reprepare that
    # changed domain intent outside admission; uniqueness failures are never a
    # retry mechanism. Already initialized requests never enter this loop.
    for _ in range(3):
        with session.no_autoflush:
            prepared = _prepare_legacy_attachment(session, project)
        changed = False
        with profile_session_write(session, label="project.initialize_media_roots", lane="interactive"):
            current = session.get(Project, project_id, populate_existing=True)
            if current is None or current.created_at != created_at or current.archived_at:
                raise HTTPException(404, "Project not found.")
            config = _config(current)
            if config.get("media_sources_initialized"):
                return
            if _legacy_directory_intent(session, current, fresh=True) != prepared["directory"]:
                changed = True
            else:
                # BEGIN IMMEDIATE and fresh reads own the complete find/create
                # lifetime. Concurrent initializers see these rows after commit.
                if prepared["directory"]:
                    row = session.get(StorageLocation, prepared["id"], populate_existing=True)
                    if row is None:
                        row = StorageLocation(id=prepared["id"], name=prepared["name"], kind="filesystem",
                                              bucket="", allow_writes=True)
                        session.add(row)
                    if row.kind == "filesystem" and prepared["binding"]:
                        binding = session.get(DirectoryDeviceBinding, prepared["binding_id"])
                        if binding is None:
                            session.add(DirectoryDeviceBinding(id=prepared["binding_id"], configuration_id=row.id,
                                directory_id=row.id, device_key=prepared["device_key"], path=prepared["binding"]))
                    session.flush()  # attach reads the now-durable-in-transaction source.
                    identifier = str(uuid5(UUID(row.id), "project:" + str(project_id)))
                    if not row.deleted and not any(root["id"] == identifier for root in _attachments(current)):
                        attach(session, current, row.id, label="Project directory", prefix=canonical_project_slug(current),
                               writable=bool(row.allow_writes), default=True, legacy=True, identifier=identifier)
                for binding in session.exec(select(ProjectStorageBinding).where(ProjectStorageBinding.project_id == project_id)):
                    row = session.get(StorageLocation, binding.location_id)
                    if row and not row.deleted and not any(root["id"] == binding.id for root in _attachments(current)):
                        attach(session, current, row.id, label=row.name, prefix=binding.prefix,
                               writable=binding.role == "outputs" and row.allow_writes, identifier=binding.id)
                config = _config(current)
                config["media_sources_initialized"] = True
                _save_config(session, current, config)
        if not changed:
            return
    raise HTTPException(409, "The project directory changed while its media roots were prepared. Reload the project.")


def roots(session, project):
    ensure_existing_attachments(session, project)
    result = []
    for root in _attachments(project):
        if root.get("deleted"):
            continue
        row = session.get(StorageLocation, root["source_id"])
        info = ({"availability": "available", "capabilities": {"browse": True, "write": True, "delete": True}}
            if root.get("legacy") else source_read(session, row) if row and not row.deleted
            else {"availability": "removed", "capabilities": {"browse": False, "write": False}})
        directory_label = (Path(root["prefix"]).name if root["prefix"] else
            Path(info.get("directory") or "").name or (row.bucket if row and row.kind == "s3" else root["label"]))
        result.append({"id": root["id"], "directory_label": directory_label, "source_id": root["source_id"], "label": root["label"], "prefix": root["prefix"],
            "revision": root["revision"],
            "legacy": root.get("legacy", False), "default": (_config(project).get("media_default_attachment_id") == root["id"]),
            "availability": info["availability"], "writable": bool(root["writable"] and info["capabilities"]["write"]),
            "capabilities": {**info["capabilities"], "write": bool(root["writable"] and info["capabilities"]["write"])}})
    return result


def _tree(project, root):
    root = next((row for row in _attachments(project) if row["id"] == root["id"]), root)
    config = _config(project)
    if root.get("legacy"):
        from app.services.project_folder_context import list_configured_project_folders
        return folder_tree(canonical_project_slug(project), list_configured_project_folders(project), config.get("folder_tree"))
    return root.get("folder_tree", [])


def canonical_folder_id(root,identifier):
    if not identifier or identifier=="root":return None
    aliases=root.get("folder_aliases",{});seen=set();retired=set(root.get("deleted_folder_ids",[]))
    while identifier in aliases:
        if identifier in seen or identifier in retired or len(seen)>=64:
            raise HTTPException(410,"This folder reference is no longer available.")
        seen.add(identifier);identifier=aliases[identifier]
    if identifier in retired:raise HTTPException(410,"This folder reference is no longer available.")
    return identifier


def folder_path(project, root, folder_id):
    if not folder_id or folder_id == "root":
        return ""
    folder_id=canonical_folder_id(root,folder_id)
    row = next((row for row in _tree(project, root) if row["id"] == folder_id), None)
    if row is None:
        raise HTTPException(410, "The selected folder is no longer attached to this project.")
    return row["path"]


def _remember_folders(session, project, root, paths):
    tree = _tree(project, root)
    known = {row["path"] for row in tree}
    added = [path for path in paths if path not in known]
    if not added:
        return tree
    retired = set(root.get("deleted_folder_ids", [])) | set(_config(project).get("deleted_folder_ids", []))
    from app.services.project_folder_tree import complete_folder_paths
    existing={row["path"]:row for row in tree}
    previous=[];ids={}
    for path in complete_folder_paths([*[row["path"] for row in tree],*added]):
        parent,_,name=path.rpartition("/")
        identifier=existing.get(path,{}).get("id")
        try:identifier=str(UUID(identifier)) if identifier else None
        except (ValueError,TypeError,AttributeError):identifier=None
        identifier=identifier or str(uuid5(UUID(ids.get(parent,root["id"])),"folder:"+name))
        if identifier in retired:identifier=str(uuid4())
        ids[path]=identifier;previous.append({"id":identifier,"path":path})
    tree = folder_tree(root["id"], [row["path"] for row in previous], previous)
    config = _config(project)
    if root.get("legacy"):
        config["folders"] = [row["path"] for row in tree]
        config["folder_tree"] = tree
    else:
        for row in config["media_sources"]:
            if row["id"] == root["id"]:
                row["folder_tree"] = tree
                row["revision"] += 1
    _save_config(session, project, config)
    return tree


def _filesystem_root(session, row, root):
    directory = bound_directory(session, row)
    if directory is None or not directory.is_dir():
        raise HTTPException(409, "This source needs an available directory on this computer.")
    return safe_folder_child(directory, root["prefix"]) if root["prefix"] else directory


def browse(session,project,attachment_id,*,folder_id=None,path=None,cursor=None,limit=100,search=""):
    with session.no_autoflush:
        return _browse(session,project,attachment_id,folder_id=folder_id,path=path,cursor=cursor,limit=limit,search=search)


def _browse(session, project, attachment_id, *, folder_id=None, path=None, cursor=None, limit=100, search=""):
    root = _attachment(project, attachment_id)
    row = None if root.get("legacy") else source(session, root["source_id"])
    relative = folder_path(project, root, folder_id) if folder_id else (path or "")
    if relative:
        relative = normalize_folder_path(relative)
    if root.get("legacy") and relative and not any(item["path"] == relative for item in _tree(project, root)):
        raise HTTPException(404, "Folder not found in this project")
    tree = _remember_folders(session, project, root, [relative] if relative else [])
    by_path = {item["path"]: item for item in tree}
    ancestors = [by_path["/".join(relative.split("/")[:i])] for i in range(1, len(relative.split("/")) + 1)] if relative else []
    context = {"path": relative, "source": root["label"], "writable": root["writable"] and (row is None or row.allow_writes),
               "folder_id": by_path[relative]["id"] if relative else None, "ancestors": ancestors,
               "attachment_revision": _attachment(project, attachment_id)["revision"]}
    if root.get("legacy"):
        # This attachment represents the existing logical project, whose input,
        # output and restored media can live in different physical directories.
        # Its portable folder tree remains browsable without a device binding.
        if cursor and (not cursor.isdigit() or len(cursor) > 9):
            raise HTTPException(422, "The directory cursor is invalid.")
        query = search.strip().casefold()
        matches = [item for item in tree if (
            query in item["path"].casefold() if query
            else item["path"].rpartition("/")[0] == relative
        )]
        matches.sort(key=lambda item: (item["path"].casefold(), item["id"]))
        offset = int(cursor or 0)
        end = offset + limit
        return {**context, "items": matches[offset:end],
                "next_cursor": str(end) if end < len(matches) else None}
    if search:
        paths, next_cursor = _search_page(session, project, root, row, search, cursor, limit)
        if row.kind=="s3":
            from app.services.project_s3_folder_moves import hidden_destination
            from app.services.object_storage import prefix_for
            paths=[path for path in paths if not hidden_destination(session,row.id,prefix_for(row,"/".join(part for part in (root["prefix"],path) if part)))]
        tree = _remember_folders(session, project, root, paths)
        by_path = {item["path"]: item for item in tree}
        return {**context, "attachment_revision": _attachment(project, attachment_id)["revision"],
                "items": [by_path[path] for path in paths], "next_cursor": next_cursor}
    if row.kind == "filesystem":
        base = _filesystem_root(session, row, root)
        directory = safe_folder_child(base, relative) if relative else base
        if not directory.is_dir():
            raise HTTPException(409, "The selected directory is unavailable.")
        names = sorted((child.name for child in directory.iterdir() if child.is_dir() and not child.name.startswith(".")), key=str.casefold)
        if cursor and (not cursor.isdigit() or len(cursor) > 9):
            raise HTTPException(422, "The directory cursor is invalid.")
        offset = int(cursor or 0)
        selected = names[offset:offset+limit]
        next_cursor = str(offset+limit) if offset+limit < len(names) else None
    else:
        from app.services import object_storage as storage
        if not row.enabled:
            raise HTTPException(409, "Reconnect this media source before browsing.")
        prefix = "/".join(part.strip("/") for part in (root["prefix"], relative) if part)
        full_prefix = storage.prefix_for(row, prefix)
        with storage.client(row) as client:
            page = client.list_objects_v2(Bucket=row.bucket, Prefix=full_prefix, Delimiter="/", MaxKeys=limit,
                                         **({"ContinuationToken": cursor} if cursor else {}))
        from app.services.project_s3_folder_moves import hidden_destination
        selected = [entry["Prefix"][len(full_prefix):].strip("/") for entry in page.get("CommonPrefixes", []) if not hidden_destination(session,row.id,entry["Prefix"])]
        next_cursor = page.get("NextContinuationToken")
    children = ["/".join(part for part in (relative, name) if part) for name in selected]
    tree = _remember_folders(session, project, root, children)
    by_path = {item["path"]: item for item in tree}
    return {**context, "attachment_revision": _attachment(project, attachment_id)["revision"], "items": [by_path[child] for child in children], "next_cursor": next_cursor}


def assert_writable_project(project):
    if (project.config_json or {}).get("team_handoff"):
        raise HTTPException(409, "This is a read-only backup of a team project. Open the shared project to make changes.")


def create_folder(session, project, attachment_id, parent_id, name):
    with session.no_autoflush:
        return _create_folder(session,project,attachment_id,parent_id,name)


def _create_folder(session,project,attachment_id,parent_id,name):
    from app.services.file_effects import stage
    assert_writable_project(project)
    root=_attachment(project,attachment_id)
    path="/".join(part for part in (folder_path(project,root,parent_id),normalize_folder_path(name)) if part)
    if any(item["path"].casefold()==path.casefold() for item in _tree(project,root)):
        raise HTTPException(409,"Folder already exists")
    if not root["writable"]:
        raise HTTPException(403,"This media source is read only.")
    if root.get("legacy"):
        from app.services.project_folder_context import resolve_project_write_directory
        from app.services.local_storage_engine import select_storage_engine
        directory=resolve_project_write_directory(project=project,engine=select_storage_engine(session),folder_name=path)
        effect={"kind":"mkdir","dst":str(directory)}
    else:
        row=source(session,root["source_id"])
        if not row.allow_writes:
            raise HTTPException(403,"This media source is read only.")
        if row.kind=="filesystem":
            effect={"kind":"mkdir","dst":str(safe_folder_child(_filesystem_root(session,row,root),path))}
        else:
            from app.services import object_storage as storage
            prefix="/".join(part for part in (root["prefix"],path) if part)
            effect={"kind":"s3_mkdir","location_id":row.id,"key":storage.prefix_for(row,prefix)}
    item=next(item for item in _remember_folders(session,project,root,[path]) if item["path"]==path)
    stage(session,[effect],kind="folder_add",project_id=project.id)
    return item


def resolve_destination(session, project, attachment_id, folder_id):
    assert_writable_project(project)
    root = _attachment(project, attachment_id)
    folder_id=canonical_folder_id(root,folder_id)
    if root.get("legacy"):
        if not root["writable"]:
            raise HTTPException(403, "This project is read only.")
        from app.services.project_folder_context import resolve_project_write_directory
        from app.services.local_storage_engine import select_storage_engine
        relative = folder_path(project, root, folder_id)
        directory = resolve_project_write_directory(project=project, engine=select_storage_engine(session), folder_name=relative)
        directory.mkdir(parents=True, exist_ok=True)
        return {"source_id": root["source_id"], "attachment_id": root["id"], "folder_id": folder_id,
                "relative_path": relative, "filesystem_path": str(directory.resolve())}
    row = source(session, root["source_id"])
    if not root["writable"] or not row.allow_writes:
        raise HTTPException(403, "The selected folder is read only. Choose a writable destination.")
    relative = folder_path(project, root, folder_id)
    if row.kind == "filesystem":
        base = _filesystem_root(session, row, root)
        directory = safe_folder_child(base, relative) if relative else base
        if not directory.is_dir():
            from app.models.agent_access import AgentOperationItem
            pending=session.exec(select(AgentOperationItem).where(
                AgentOperationItem.status.in_(["pending","applying","needs_attention"]),
                AgentOperationItem.input_json["kind"].as_string().in_(["move_dir","mkdir"]))).all()
            if not any(str(directory)==item.input_json.get("dst") or str(directory).startswith(str(item.input_json.get("dst"))+os.sep) for item in pending):
                raise HTTPException(409, "The selected output directory is unavailable or not writable.")
        elif not os.access(directory, os.W_OK):
            raise HTTPException(409, "The selected output directory is unavailable or not writable.")
        return {"source_id": row.id, "attachment_id": root["id"], "folder_id": folder_id if folder_id != "root" else None,
                "relative_path": relative, "filesystem_path": str(directory.resolve())}
    from app.services import object_storage as storage
    if not row.enabled or not storage.credentials_available(row.id):
        raise HTTPException(409, "Reconnect the selected output source before generating.")
    return {"source_id": row.id, "attachment_id": root["id"], "folder_id": folder_id if folder_id != "root" else None,
            "relative_path": relative, "filesystem_path": None,
            "remote_prefix": "/".join(part for part in (root["prefix"], relative) if part)}


def freeze_destination(session, job, destination):
    session.flush()
    session.add(JobMediaDestination(job_id=job.id, **{key:value for key,value in destination.items() if key != "remote_prefix"}))
    if "remote_prefix" in destination:
        session.add(JobStorageDestination(job_id=job.id, location_id=destination["source_id"], prefix=destination["remote_prefix"]))
    from app.services.generation_ownership import ensure_job_generation
    ensure_job_generation(session, job)
    if job.generation:
        job.generation.output_metadata_json = {**(job.generation.output_metadata_json or {}), "media_destination": {
            key: destination[key] for key in ("source_id", "attachment_id", "folder_id", "relative_path")}}
        session.add(job.generation)


def _adopt_preview_original(session, project, asset, relative, located):
    """Give an existing preview-only record its linked cloud original.

    A record synced from another device keeps its media identity, recipe and
    project route; it gains this object as a location. Correspondence needs
    the same project-relative path and the exact recorded original size and
    SHA-256. The SHA-256 is recorded on the asset so retrieval verifies the
    actual bytes. Ambiguous or contradicted matches keep separate identities.

    `relative` is the key within the link; `located` is the key within the
    storage location. A link made at a parent or child of the project's root
    still corresponds when the recorded path ends the located key at a folder
    boundary. An exact link-relative match always takes precedence.
    """
    import re
    from sqlalchemy import func
    from app.models.image import Image
    from app.models.storage import StorageAsset
    from app.services.project_storage_plan import _legacy_relative
    if asset.kind != "media" or not relative:
        return None
    exact, aligned = [], []
    for image in session.exec(select(Image).where(Image.is_deleted == False, Image.cloud_reference == True,
            Image.filename == relative.rpartition("/")[2], func.json_valid(Image.extra_metadata),
            func.json_extract(Image.extra_metadata, "$.resync_route.project_slug") == project.slug,
            func.json_extract(Image.extra_metadata, "$.studio_sync.availability") == "preview_only").execution_options(yield_per=100)):
        sync = image.extra_metadata.get("studio_sync") or {}
        original = dict(sync.get("original") or {})
        revision = sync.get("content_revision")
        if isinstance(revision, dict) and revision.get("kind") == "edit":
            original.update(sha256=revision.get("sha256"), size=revision.get("size", original.get("size")))
        expected = str(original.get("sha256") or "")
        locators = {original.get("relative_path"),
                    _legacy_relative(project, (image.extra_metadata.get("resync_route") or {}).get("folder"), image.filename)}
        locators.discard(None)
        if (original.get("size") != asset.size
                or not re.fullmatch(r"[0-9a-f]{64}", expected) or asset.sha256 not in (None, expected)):
            continue
        if relative in locators:
            target = exact
        elif any(located == locator or located.endswith("/" + locator) for locator in locators):
            target = aligned
        else:
            continue
        if session.exec(select(StorageAsset.id).where(StorageAsset.image_id == image.id,
                StorageAsset.location_id == asset.location_id, StorageAsset.id != asset.id).limit(1)).first():
            continue  # Another object at this source already supplies this record.
        # Two matches already establish ambiguity; keep memory bounded while
        # continuing to look for higher-priority exact matches.
        if len(target) < 2:
            target.append((image, expected))
    matches = exact or aligned
    if len(matches) != 1:
        return None
    image, expected = matches[0]
    asset.image_id, asset.sha256 = image.id, expected
    session.add(asset)
    return image


def list_media(session,project,attachment_id,folder_id=None,*,cursor=None,limit=100,recursive=False):
    from sqlmodel import Session
    from app.db.writer import commit_profile
    with Session(session.get_bind()) as owned:
        owned_project=owned.get(Project,project.id)
        with owned.no_autoflush:
            result=_list_media(owned,owned_project,attachment_id,folder_id,cursor=cursor,limit=limit,recursive=recursive)
        commit_profile(owned,label="media.discover",lane="background")
    if project not in session.dirty:
        session.expire(project)
    return result


def _list_media(session, project, attachment_id, folder_id=None, *, cursor=None, limit=100, recursive=False):
    """Read only the chosen folder. Remote originals are indexed, never eagerly downloaded."""
    from datetime import datetime
    from app.models.image import Image
    from app.services.project_folder_context import MEDIA_EXTENSIONS
    root = _attachment(project, attachment_id)
    folder_id=canonical_folder_id(root,folder_id)
    if root.get("legacy"):
        from app.services.project_source_gallery import source_gallery_page
        page = source_gallery_page(session, project.id, (attachment_id, folder_id), cursor=cursor, limit=limit)
        items = []
        for entry in page["items"]:
            image = entry["image"]
            items.append({"path": image["path"], "filename": image["filename"], "mtime": image["created_at"],
                          "image_id": image["id"], "cloud_reference": image.get("cloud_reference", False),
                          "preview_available": image.get("preview_available", False),
                          "width": image.get("width"), "height": image.get("height")})
        return {"items": items, "next_cursor": page["next_cursor"], "writable": root["writable"]}
    row = source(session, root["source_id"])
    relative = folder_path(project, root, folder_id)
    items = []
    if row.kind == "filesystem":
        base = _filesystem_root(session, row, root)
        directory = safe_folder_child(base, relative) if relative else base
        if not directory.is_dir():
            raise HTTPException(409, "The selected directory is unavailable.")
        import base64, json
        scope = attachment_id + ":" + (folder_id or "root")
        after = None
        offset = 0
        try:
            if cursor and cursor.startswith("names:"):
                decoded=json.loads(base64.urlsafe_b64decode(cursor[6:]).decode())
                if decoded["scope"]!=scope or not isinstance(decoded["last"],list) or len(decoded["last"])!=2 or not all(isinstance(value,str) for value in decoded["last"]):
                    raise ValueError()
                after=tuple(decoded["last"])
            elif cursor:
                if not cursor.isdigit() or len(cursor)>9:raise ValueError()
                offset=int(cursor)
        except (ValueError,KeyError,TypeError):
            raise HTTPException(422, "The media cursor is invalid.") from None
        # Names are stable page boundaries when generation adds earlier files.
        paths = sorted((child for child in directory.iterdir() if child.is_file() and child.suffix.lower() in MEDIA_EXTENSIONS), key=lambda child: (child.name.casefold(),child.name))
        if after is not None:
            paths=[child for child in paths if (child.name.casefold(),child.name)>after]
        selected = paths[offset:offset + limit]
        images = {image.path: image for image in session.exec(select(Image).where(Image.path.in_([str(path) for path in selected])))} if selected else {}
        for path in selected:
            image = images.get(str(path))
            if image and image.is_deleted:
                continue
            if image is None:
                from app.services.project_storage import destination_claimed
                if destination_claimed(session, str(path)):
                    continue
                from app.services.gallery.image_identity import image_path_identity
                image = Image(job_id=-1,path=str(path),path_identity=image_path_identity(str(path)),filename=path.name,
                    format=path.suffix.lstrip("."),file_exists=True,extra_metadata={"resync_route":{
                        "project_slug":project.slug,"folder":selection_token({"attachment_id":attachment_id,"folder_id":folder_id})}})
                session.add(image)
                session.flush()
            items.append({"path": str(path), "filename": path.name, "mtime": datetime.fromtimestamp(path.stat().st_mtime).isoformat(),
                "image_id": image.id if image else None, "width": image.width if image else None, "height": image.height if image else None})
        next_cursor = "names:"+base64.urlsafe_b64encode(json.dumps({"scope":scope,"last":[selected[-1].name.casefold(),selected[-1].name]}).encode()).decode() if selected and offset+limit<len(paths) else None
    else:
        from app.services import object_storage as storage
        # Verified remote output replicas may live beneath a content-addressed
        # key. Their logical destination still is the submitted folder, not
        # that transport subdirectory. Page those catalog identities first.
        from sqlalchemy import func
        token = selection_token({"attachment_id": attachment_id, "folder_id": folder_id})
        tokens=[token]
        for alias in root.get("folder_aliases",{}):
            try:
                if canonical_folder_id(root,alias)==folder_id:
                    tokens.append(selection_token({"attachment_id":attachment_id,"folder_id":alias}))
            except HTTPException:
                continue
        if recursive:
            cursor = cursor.removeprefix("objects:") if cursor else None
        elif cursor is None or cursor.startswith("catalog:"):
            raw_offset = cursor.removeprefix("catalog:") if cursor else "0"
            if not raw_offset.isdigit() or len(raw_offset) > 9:
                raise HTTPException(422, "The media cursor is invalid.")
            offset = int(raw_offset)
            routed = session.exec(select(Image).where(Image.is_deleted == False,
                func.json_valid(Image.extra_metadata),
                func.json_extract(Image.extra_metadata, "$.resync_route.project_slug") == project.slug,
                func.json_extract(Image.extra_metadata, "$.resync_route.folder").in_(tokens)).order_by(Image.id.desc()).offset(offset).limit(limit + 1)).all()
            if routed:
                return {"items": [{"path": image.path, "filename": image.filename, "mtime": image.created_at.isoformat(),
                    "image_id": image.id, "cloud_reference": image.cloud_reference, "preview_available": bool(image.thumbnail_data or image.thumbnail_path),
                    "width": image.width, "height": image.height} for image in routed[:limit]],
                    "next_cursor": "catalog:" + str(offset + limit) if len(routed) > limit else "objects:",
                    "writable": bool(root["writable"] and row.allow_writes)}
            cursor = None
        elif cursor.startswith("objects:"):
            cursor = cursor.removeprefix("objects:") or None
        else:
            raise HTTPException(422, "The media cursor is invalid.")
        full_prefix = storage.prefix_for(row, "/".join(part for part in (root["prefix"], relative) if part))
        mirror_prefixes = [storage.prefix_for(row, mapping.get("prefix", ""))
            for attachment in _attachments(project) if not attachment.get("deleted")
            for mapping in attachment.get("replicas", [])
            if not mapping.get("deleted") and mapping.get("mode") == "mirror" and mapping.get("location_id") == row.id]
        with storage.client(row) as connection:
            page = connection.list_objects_v2(Bucket=row.bucket, Prefix=full_prefix, MaxKeys=limit,
                **({} if recursive else {"Delimiter": "/"}),
                **({"ContinuationToken": cursor} if cursor else {}))
            continuation = page.get("NextContinuationToken")
            if page.get("IsTruncated") and (not continuation or continuation == cursor):
                raise storage.StorageError("invalid_storage_response")
            prefetched = {}
            frozen = (root["source_id"], root.get("prefix", ""), row.definition_revision,
                row.prefix, row.bucket, row.endpoint_url, row.region)
            if recursive:
                for entry in page.get("Contents", []):
                    storage.check_key(row, entry["Key"])
                    if not entry["Key"].startswith(full_prefix):
                        raise storage.StorageError("object_outside_location")
                    if (Path(entry["Key"]).suffix.lower() in MEDIA_EXTENSIONS and entry["Size"]
                            and "/.metadata/" not in "/" + entry["Key"]):
                        prefetched[entry["Key"]] = storage.head_object(connection, row, entry["Key"])
            conflicts = []
            from contextlib import nullcontext
            from app.db.writer import profile_session_write
            for entry in page.get("Contents", []):
                with (profile_session_write(session, label="storage.discover_object", lane="background")
                        if recursive else nullcontext()):
                    if Path(entry["Key"]).suffix.lower() not in MEDIA_EXTENSIONS or not entry["Size"]:
                        continue
                    key = entry["Key"]
                    item_token, conflict = token, None
                    if recursive:
                        session.refresh(project)
                        root = _attachment(project, attachment_id)
                        session.refresh(row)
                        actual = (root["source_id"], root.get("prefix", ""), row.definition_revision,
                            row.prefix, row.bucket, row.endpoint_url, row.region)
                        if root.get("deleted") or actual != frozen:
                            raise storage.StorageError("scope_changed")
                        parent = key[len(full_prefix):].rpartition("/")[0]
                        if parent:
                            try:
                                normalized = normalize_folder_path(parent)
                                if normalized != parent:
                                    raise HTTPException(409, "This cloud folder needs an explicit local name mapping.")
                                tree = _remember_folders(session, project, root, [normalized])
                                folder = next(item for item in tree if item["path"] == parent)
                                item_token = selection_token({"attachment_id": attachment_id, "folder_id": folder["id"]})
                            except HTTPException:
                                # S3 names need not be legal local folder names. Keep
                                # their bytes/identities and expose the path conflict.
                                conflict = {"relative_path": key[len(full_prefix):], "code": "folder_name_conflict"}
                                conflicts.append(conflict)
                    import re
                    held = any(key.startswith(prefix) for prefix in mirror_prefixes)
                    held = held or bool(re.search(r"(?:^|/)studio/[0-9a-fA-F-]{36}/[0-9a-f]{64}[^/]*$", key))
                    if "/.metadata/" in "/" + key or key.startswith(".metadata/"):
                        continue
                    if held:
                        from app.models.storage import StorageAsset
                        asset = session.exec(select(StorageAsset).where(StorageAsset.location_id == row.id,
                            StorageAsset.object_key == key).order_by(StorageAsset.image_id.is_(None), StorageAsset.indexed_at.desc())).first()
                        image = session.get(Image, asset.image_id) if asset and asset.image_id else None
                        if (image is None and asset and asset.state == "available"
                                and asset.etag == str(entry.get("ETag", "")) and asset.size == entry["Size"]):
                            # Managed keys stay fenced from new discovery. A verified
                            # observation may only reconnect an existing live preview;
                            # the shared owner resolver cannot mint a gallery row.
                            image = storage._verified_observation_owner(session, asset)
                        if image is None or image.is_deleted:
                            continue
                    else:
                        asset = storage.index_object(session, row, key, prefetched[key] if recursive else storage.head_object(connection, row, key))
                        if asset.image_id is None:
                            _adopt_preview_original(session, project, asset,
                                key[len(storage.prefix_for(row, root["prefix"])):], key[len(storage.prefix_for(row)):])
                    if asset.state == "deleted":
                        continue
                    try:
                        if not held:
                            image = storage.project_media(session, asset)
                    except storage.StorageError as exc:
                        if exc.code == "media_deleted":
                            continue
                        raise
                    route = (image.extra_metadata or {}).get("resync_route", {})
                    if route.get("project_slug") == project.slug and route.get("folder") in tokens:
                        continue
                    if (not route and image.job_id == -1
                            and image.path == str(storage.cache_path(asset))):
                        # Unassigned provider imports need the same durable project
                        # membership as local imports. Preserve existing owners and
                        # creative context when a source is shared or reattached.
                        image.extra_metadata = {**(image.extra_metadata or {}), "resync_route": {
                            "project_slug": project.slug, "folder": item_token}}
                        if conflict:
                            image.extra_metadata = {**image.extra_metadata, "source_folder_conflict": conflict}
                        session.add(image)
                    items.append({"path": image.path, "filename": asset.filename, "mtime": entry["LastModified"].isoformat(),
                        "image_id": image.id, "cloud_reference": image.cloud_reference, "preview_available": bool(image.thumbnail_data),
                        "width": image.width, "height": image.height})
        continuation = page.get("NextContinuationToken")
        next_cursor = "objects:" + continuation if continuation else None
    return {"items": items, "next_cursor": next_cursor, "writable": bool(root["writable"] and row.allow_writes),
            **({"conflicts": conflicts} if recursive else {})}


def folder_context(session, project, value, *, write=False, delete=False):
    from app.services.project_folder_context import ProjectFolderContext
    if write or delete:
        assert_writable_project(project)
    selected = parse_selection(value)
    if not selected:
        return None
    root = _attachment(project, selected[0])
    if root.get("legacy"):
        if (write or delete) and not root["writable"]:
            raise HTTPException(403, "This project is read only.")
        from app.services.project_folder_context import resolve_project_folder_context
        from app.services.local_storage_engine import select_storage_engine
        relative = folder_path(project, root, selected[1])
        if not relative:
            from app.services.media_paths import get_project_roots, get_project_storage_root_dir, normalize_fs_path
            paths = get_project_roots(engine=select_storage_engine(session), project_slug=project.slug,
                                      project_storage_root_dir=get_project_storage_root_dir(project))
            return ProjectFolderContext(config=_config(project), folders=[value],
                storage_root_dir=get_project_storage_root_dir(project), folder_paths=paths,
                normalized_folder_roots=[normalize_fs_path(str(path.resolve())) for path in paths])
        return resolve_project_folder_context(project=project, active_engine=select_storage_engine(session),
                                              folder_name=relative or project.slug)
    row = source(session, root["source_id"])
    if (write or delete) and (not root["writable"] or not row.allow_writes or delete and not row.allow_deletes):
        raise HTTPException(403, "This source does not allow changing its original media.")
    relative = folder_path(project, root, selected[1])
    paths = []
    if row.kind == "filesystem":
        base = _filesystem_root(session, row, root)
        paths = [safe_folder_child(base, relative) if relative else base]
    elif write or delete:
        raise HTTPException(409, "Use storage copy or explicit remote deletion for this source. Originals are preserved until the operation is verified.")
    return ProjectFolderContext(config=_config(project), folders=[value], storage_root_dir=None,
        folder_paths=paths, normalized_folder_roots=[str(path.resolve()) for path in paths])


def contains_media(session, project, path, asset=None):
    from app.services import object_storage as storage
    for root in _attachments(project):
        if root.get("deleted"):
            continue
        if root.get("legacy"):
            from app.services.media_paths import get_project_roots, get_project_storage_root_dir
            from app.services.local_storage_engine import select_storage_engine
            bases = get_project_roots(engine=select_storage_engine(session), project_slug=project.slug,
                                      project_storage_root_dir=get_project_storage_root_dir(project))
            if any(Path(path).resolve().is_relative_to(base.resolve()) for base in bases):
                return True
            continue
        row = session.get(StorageLocation, root["source_id"])
        if row is None or row.deleted:
            continue
        if row.kind == "s3" and asset is not None:
            if asset.location_id == row.id and asset.object_key.startswith(storage.prefix_for(row, root["prefix"])):
                return True
        elif row.kind == "filesystem":
            try:
                Path(path).resolve().relative_to(_filesystem_root(session, row, root).resolve())
                return True
            except (ValueError, HTTPException):
                continue
    return False


def register_import(session, project, selected, path, *, prepared_size=None, prepared_destination=None):
    """Retain project/source identity and use the existing verified-copy worker."""
    from app.models.image import Image
    from app.models.storage import StorageTransfer
    from app.services.gallery.image_identity import image_path_identity
    destination = prepared_destination if prepared_destination is not None else resolve_destination(session, project, *selected)
    token = selection_token(destination)
    from app.services.gallery.image_lookup import active_images_for_paths
    image = next(iter(active_images_for_paths(session, paths=(str(path),))), None)
    if image is None:
        image = Image(job_id=-1, path=str(path), path_identity=image_path_identity(str(path)), filename=path.name,
                      format=path.suffix.lstrip("."), file_exists=True)
    image.extra_metadata = {**(image.extra_metadata or {}), "media_destination": {
        key: destination[key] for key in ("source_id", "attachment_id", "folder_id")},
        "resync_route": {"project_slug": project.slug, "folder": token}}
    size=prepared_size if prepared_size is not None else path.stat().st_size
    image.extra_metadata={**image.extra_metadata,"file_size":size}
    session.add(image);session.flush()
    transfer_id = None
    if "remote_prefix" in destination:
        transfer_id = str(uuid5(UUID(destination["source_id"]), "import:" + image.continuity_media_uuid))
        transfer = session.get(StorageTransfer, transfer_id)
        if transfer is None:
            transfer = StorageTransfer(id=transfer_id, location_id=destination["source_id"], image_id=image.id,
                operation="upload", source_path=str(path), output_prefix=destination["remote_prefix"], bytes_total=size)
            session.add(transfer)
    return image, transfer_id


def remove_empty_folder(session, project, attachment_id, folder_id, expected_revision):
    with session.no_autoflush:
        return _remove_empty_folder(session,project,attachment_id,folder_id,expected_revision)


def _remove_empty_folder(session,project,attachment_id,folder_id,expected_revision):
    from app.services.file_effects import stage
    assert_writable_project(project)
    root=_attachment(project,attachment_id)
    if root["revision"]!=expected_revision:
        raise HTTPException(409,"The folder layout changed. Reload before deleting it.")
    row=None if root.get("legacy") else source(session,root["source_id"])
    if not root["writable"] or row is not None and not row.allow_writes:
        raise HTTPException(403,"This media source is read only.")
    path=folder_path(project,root,folder_id)
    if not path or root.get("legacy") and path in {"input","output","masks"}:
        raise HTTPException(409,"Keep the project root and its required media folders.")
    tree=_tree(project,root)
    if any(item["path"].startswith(path+"/") for item in tree):
        raise HTTPException(409,"This folder has subfolders. Only empty folders can be deleted.")
    parent=next((item for item in tree if item["path"]==path),{}).get("parent_id")
    effects=[]
    if root.get("legacy"):
        from app.services.project_source_gallery import source_gallery_page
        from app.services.media_paths import get_project_folder_paths,get_project_storage_root_dir
        from app.services.local_storage_engine import select_storage_engine
        if source_gallery_page(session,project.id,(attachment_id,folder_id),limit=1)["items"]:
            raise HTTPException(409,"This folder contains media. All media and subfolders are kept.")
        directories=get_project_folder_paths(engine=select_storage_engine(session),project_slug=project.slug,
            folder_name=path,project_storage_root_dir=get_project_storage_root_dir(project))
    elif row.kind=="filesystem":
        base=_filesystem_root(session,row,root)
        current=base
        for part in path.split("/"):
            current/=part
            if current.is_symlink():
                raise HTTPException(409,"A directory link is kept. Choose a real empty folder.")
        directories=[safe_folder_child(base,path)]
    else:
        directories=[]
        from app.services import object_storage as storage
        prefix=storage.prefix_for(row,"/".join(part for part in (root["prefix"],path) if part))
        with storage.client(row) as client:
            page=client.list_objects_v2(Bucket=row.bucket,Prefix=prefix,MaxKeys=2)
            objects=page.get("Contents",[])
            if page.get("IsTruncated") or any(item["Key"]!=prefix or item["Size"]!=0 for item in objects):
                raise HTTPException(409,"This folder contains media or subfolders. Nothing was deleted.")
            marker=client.head_object(Bucket=row.bucket,Key=prefix) if objects else None
        if marker:
            effects.append({"kind":"s3_rmdir","location_id":row.id,"key":prefix,
                "etag":marker["ETag"],"version_id":marker.get("VersionId")})
    for directory in directories:
        if not directory.is_dir():
            raise HTTPException(410,"This directory is no longer available.")
        if directory.is_symlink() or any(directory.iterdir()):
            raise HTTPException(409,"Only an empty writable directory can be deleted. All media and subfolders are kept.")
        effects.append({"kind":"rmdir","src":str(directory)})
    config=_config(project)
    retained=[item for item in tree if item["id"]!=folder_id]
    if root.get("legacy"):
        config["folders"],config["folder_tree"]=[item["path"] for item in retained],retained
        config.setdefault("deleted_folder_ids",[]).append(folder_id)
    for attachment in config["media_sources"]:
        if attachment["id"]==attachment_id:
            if not root.get("legacy"):
                attachment["folder_tree"]=retained
            attachment.setdefault("deleted_folder_ids",[]).append(folder_id)
            attachment["revision"]+=1
    _save_config(session,project,config)
    stage(session,effects,kind="folder_delete",project_id=project.id)
    return parent,lambda:None
