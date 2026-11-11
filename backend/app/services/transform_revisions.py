"""Immutable edit recipes and optimistic saves; source media is never rewritten here."""
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from uuid import uuid4
from filelock import FileLock
from fastapi import HTTPException
from sqlmodel import select

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()

def atomic(path, value):
    import os
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid4().hex + ".tmp")
    try:
        with temporary.open("wb") as stream:
            stream.write(canonical(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)

def history_dir(path):
    return path.with_name(path.stem + ".revisions")

def pending_document(session, path):
    """The committed recipe is readable before its JSON publication finishes."""
    from app.models.agent_access import AgentOperationItem
    with session.no_autoflush:
        pending=session.exec(select(AgentOperationItem).where(
            AgentOperationItem.input_json["kind"].as_string()=="write_json",
            AgentOperationItem.input_json["dst"].as_string()==str(path),
            AgentOperationItem.status.in_(["pending","applying","needs_attention"]))
            .order_by(AgentOperationItem.id.desc()).limit(1)).first()
    return deepcopy(pending.input_json["content"]) if pending else None


@contextmanager
def admission(path, expected, draft, session=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    with FileLock(str(path) + ".lock", timeout=10):
        current = json.loads(path.read_text()) if path.exists() else {}
        if session is not None:
            pending=pending_document(session,path)
            if pending is not None:
                current=pending
        actual = int(current.get("recipeRevision", 0))
        if expected != actual:
            conflict = uuid4().hex
            atomic(history_dir(path) / ("conflict-" + conflict + ".json"), {
                "draft": draft, "base_revision": expected, "current_revision": actual,
                "saved_at": datetime.now(timezone.utc).isoformat(),
            })
            raise HTTPException(409, {"code": "transform_recipe_conflict", "conflict_id": conflict,
                "message": "This edit changed in another window. Your draft was preserved; reopen Transform to review the current version."})
        # Preserve the pre-upgrade document before assets are changed.
        if current:
            atomic(history_dir(path) / (str(actual) + "-" + hashlib.sha256(canonical(current)).hexdigest() + ".json"), current)
        yield actual

def portable(document):
    """Machine paths become content identities; blobs remain separate replicas."""
    value = deepcopy(document)
    assets = {}
    def walk(item):
        if isinstance(item, list):
            return [walk(v) for v in item]
        if not isinstance(item, dict):
            return item
        result = {}
        for key, val in item.items():
            if key in {"dataUrl", "path"}:
                continue
            if key in {"assetPath", "draftPath", "coverageAssetPath", "baseCoverageAssetPath"}:
                if isinstance(val, str) and Path(val).is_file():
                    path = Path(val)
                    with path.open("rb") as stream:
                        digest = hashlib.file_digest(stream, "sha256").hexdigest()
                    assets[digest] = {"path": str(path), "size": path.stat().st_size, "sha256": digest}
                    result[key] = "asset:" + digest
                elif val is None:
                    result[key] = None
            else:
                result[key] = walk(val)
        return result
    return walk(value), assets

def commit(session, path, document, revision, source_path):
    from app.services.file_effects import json_effect,stage
    from app.db.writer import profile_session_write
    from app.services.media_operations import start_worker
    document["recipeRevision"]=revision+1
    document["rendererVersion"]="studio-transform-v1"
    import os
    from app.services.media_paths import open_media_file
    from app.services.gallery.image_lookup import active_images_for_paths
    with session.no_autoflush:
        _physical, stream = open_media_file(session, str(source_path))
        with stream:
            source_size = os.fstat(stream.fileno()).st_size
    document["sourceIdentity"]={"sha256":document["sourceImage"]["hash"],"size":source_size}
    document["recipeHash"]=hashlib.sha256(canonical({key:value for key,value in document.items() if key!="recipeHash"})).hexdigest()
    effects=[json_effect(history_dir(path)/(str(revision+1)+"-"+document["recipeHash"]+".json"),document),json_effect(path,document)]
    previous=pending_document(session,path)
    if previous is not None:
        effects[-1]["expected_dst_sha256"]=hashlib.sha256(canonical(previous)).hexdigest()
    recipe,assets=portable(document)
    with profile_session_write(session,label="transform.revision",lane="interactive"):
        image=next(iter(active_images_for_paths(session,paths=(str(source_path),),populate_existing=True)),None)
        if image:
            current=(image.extra_metadata or {}).get("transform_recipe",{})
            if int(current.get("recipeRevision",0))>revision:
                raise HTTPException(409,"This edit changed in another window. Reopen Transform to review it.")
            image.extra_metadata={**(image.extra_metadata or {}),"transform_recipe":recipe,"transform_recipe_assets":assets}
            session.add(image)
        stage(session,effects,kind="transform_revision")
    start_worker(bind=session.get_bind())
    return document


def hydrate(session, source_path, document_path, source_sha256):
    """Restore a portable recipe only after its exact original is local."""
    from app.models.storage import StorageAsset, StorageLocation
    from app.services import object_storage
    from app.services.gallery.image_lookup import active_images_for_paths
    image = next(iter(active_images_for_paths(session,paths=(str(source_path),))),None)
    recipe = (image.extra_metadata or {}).get("transform_recipe") if image else None
    if not isinstance(recipe, dict) or not recipe.get("edit"):
        return None
    if recipe.get("sourceIdentity", {}).get("sha256") != source_sha256:
        raise HTTPException(409, "The recovered edit belongs to a different original.")
    document = deepcopy(recipe)
    references = set()
    def collect(value):
        if isinstance(value, str) and value.startswith("asset:"):
            digest = value[6:]
            if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
                raise HTTPException(409, "The recovered edit has an invalid layer reference.")
            references.add(digest)
        elif isinstance(value, dict):
            for key, item in value.items():
                if key in {"assetPath", "draftPath", "coverageAssetPath", "baseCoverageAssetPath"} and item is not None:
                    if not isinstance(item, str) or not item.startswith("asset:"):
                        raise HTTPException(409, "A recovered layer must use a portable content reference.")
                if key == "path":
                    raise HTTPException(409, "This recovered edit contains a machine-local path.")
                collect(item)
        elif isinstance(value, list):
            for item in value: collect(item)
    collect(document)
    if len(references) > 128:
        raise HTTPException(409, "This edit has too many recovery assets to restore at once.")
    paths = {}
    replicas = session.exec(select(StorageAsset).where(StorageAsset.image_id == image.id, StorageAsset.state == "available")).all()
    total = 0
    for digest in sorted(references):
        target = document_path.with_name(document_path.stem + ".assets") / "recovered" / (digest + ".png")
        valid = False
        if target.is_file():
            with target.open("rb") as stream:
                valid = hashlib.file_digest(stream, "sha256").hexdigest() == digest
        for replica in ([] if valid else replicas):
            owner = session.get(StorageLocation, replica.location_id)
            if not owner or not owner.enabled:
                continue
            try:
                with object_storage.client(owner) as connection:
                    key = replica.object_key + ".metadata/assets/" + digest + ".png"
                    object_storage.check_key(owner, key)
                    response = connection.get_object(Bucket=owner.bucket, Key=key)
                    try:
                        data = response["Body"].read(128 * 1024 * 1024 + 1)
                    finally:
                        response["Body"].close()
                    total += len(data)
                    if len(data) > 128 * 1024 * 1024 or total > 256 * 1024 * 1024:
                        raise HTTPException(409, "The recovered layers exceed the restore limit.")
                    if hashlib.sha256(data).hexdigest() != digest:
                        raise HTTPException(409, "A recovered layer failed its integrity check.")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    temporary = target.with_suffix(".tmp")
                    temporary.write_bytes(data)
                    temporary.replace(target)
                    valid = True
                    break
            except HTTPException:
                raise
            except Exception:
                continue
        if not valid:
            raise HTTPException(409, "Reconnect the storage location containing this edit's layers, then reopen Transform.")
        paths["asset:" + digest] = str(target)
    def replace(value):
        if isinstance(value, str): return paths.get(value, value)
        if isinstance(value, dict): return {key: replace(item) for key, item in value.items()}
        if isinstance(value, list): return [replace(item) for item in value]
        return value
    document = replace(document)
    document["sourceImage"]["path"] = str(source_path)
    atomic(document_path, document)
    return document
