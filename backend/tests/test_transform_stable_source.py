"""Real Transform requests inspect one original across background publication."""
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import threading
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image as PillowImage
import pytest
from sqlmodel import Session

from app.api.endpoints import transform
from app.db.database import get_session
from app.models.engine import Engine
from app.models.image import Image
from app.models.project import Project
from app.services import file_effects, media_operations, media_paths
from tests_support.router_harness import make_session_override


@pytest.fixture
def engine():
    from tests_support.sqlmodel import make_sqlite_engine
    bind=make_sqlite_engine()
    try:
        yield bind
    finally:
        media_operations.stop_workers()
        bind.dispose()


@pytest.mark.parametrize("endpoint",["launch","export"])
@pytest.mark.parametrize("pause",["resolved","opened"])
def test_transform_reads_stable_source_while_worker_moves_resolved_file(engine,session,tmp_path,monkeypatch,endpoint,pause):
    monkeypatch.setattr(media_operations,"start_worker",lambda **kwargs:None)
    project_root=tmp_path/"projects"
    directory=project_root/"race"
    (directory/"input").mkdir(parents=True)
    (directory/"output").mkdir()
    logical=directory/"input"/"source.png"
    scratch=tmp_path/"pending-source.png"
    PillowImage.new("RGB",(16,12),(30,80,140)).save(scratch)
    original=scratch.read_bytes()
    digest=sha256(original).hexdigest()
    project=Project(slug="race",name="Race",config_json={"storage_root_dir":str(project_root),"folders":["input","output"]})
    selected=Engine(name="Local ComfyUI",base_url="http://127.0.0.1:8188",
        input_dir=str(tmp_path/"comfy"/"input"),output_dir=str(tmp_path/"comfy"/"output"))
    image=Image(job_id=-1,path=str(logical),filename=logical.name,file_exists=False,
        extra_metadata={"resync_route":{"project_slug":"race","folder":"input"}})
    session.add_all([project,selected,image]);session.flush()
    file_effects.stage(session,[{"kind":"publish_file","src":str(scratch),"dst":str(logical),
        "sha256":digest,"image_id":image.id,"revision":image.media_revision,"updates_media":True}],
        kind="pending_source",project_id=project.id)
    session.commit()
    entered,release=threading.Event(),threading.Event()
    once=threading.Event()
    if pause=="resolved":
        from app.services.gallery import paths
        resolve=paths._resolve_media_path
        def paused_resolve(path,current):
            actual=resolve(path,current)
            if str(path)==str(logical) and not once.is_set():
                once.set();entered.set();assert release.wait(3)
            return actual
        monkeypatch.setattr(paths,"_resolve_media_path",paused_resolve)
    else:
        open_original=media_paths.open_media_file
        def paused_open(current,path):
            actual,stream=open_original(current,path)
            if str(path)==str(logical) and not once.is_set():
                once.set();entered.set();assert release.wait(3)
            return actual,stream
        monkeypatch.setattr(media_paths,"open_media_file",paused_open)
    app=FastAPI();app.include_router(transform.router,prefix="/transform")
    app.dependency_overrides[get_session]=make_session_override(engine)
    with TestClient(app) as client,ThreadPoolExecutor(max_workers=1) as workers:
        def request():
            if endpoint=="launch":
                return client.get("/transform/launch",params={"image_path":str(logical)})
            return client.post("/transform/export",files={"file":("render.png",original,"image/png")},data={
                "document_json":json.dumps({"sourceImage":{"path":str(logical),"hash":digest},"edit":{}}),
                "source_path":str(logical),"save_mode":"new_copy","target_project_slug":"race", "target_folder":"output"})
        pending=workers.submit(request)
        try:
            assert entered.wait(3)
            deadline=time.monotonic()+2
            while scratch.exists() and time.monotonic()<deadline:
                media_operations.run_pending(bind=engine,recover=True)
            assert not scratch.exists() and logical.read_bytes()==original
        finally:
            release.set()
        response=pending.result(timeout=3)
        assert response.status_code==200,response.text
    if endpoint=="launch":
        info=response.json()["source_image"]
        assert info["path"]==str(logical) and info["hash"]==digest
        assert (info["width"],info["height"])==(16,12)
    else:
        result=response.json()
        assert result["path"]!=str(logical)
        with Session(engine) as reader:
            exported=reader.get(Image,result["id"])
            assert exported.extra_metadata["transform"]["source_sha256"]==digest
    assert logical.read_bytes()==original
