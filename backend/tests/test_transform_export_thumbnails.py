import json
from pathlib import Path
from io import BytesIO

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image as PILImage

from app.api.endpoints import gallery, transform
from app.db.database import get_session
from app.models.engine import Engine
from app.models.project import Project
from tests_support.router_harness import make_session_override


def test_repeated_overwrite_serves_new_pixels_by_id_and_path(engine, session, tmp_path):
    engine_root = tmp_path / "ComfyUI"
    root = engine_root / "input" / "vitamins"
    folder = root / "input"
    folder.mkdir(parents=True)
    source = folder / "vitamins-input-0421.jpg"
    PILImage.new("RGB", (720, 1280), (20, 40, 180)).save(source)
    session.add(Project(
        slug="vitamins", name="vitamins",
        config_json={"folders": ["input"], "storage_root_dir": str(root)},
    ))
    session.add(Engine(
        name="fixture", base_url="http://127.0.0.1:8188",
        input_dir=str(engine_root / "input"), output_dir=str(engine_root / "output"),
    ))
    session.commit()
    app = FastAPI()
    app.include_router(transform.router, prefix="/api/v1/transform")
    app.include_router(gallery.router, prefix="/api/v1/gallery")
    app.dependency_overrides[get_session] = make_session_override(engine)
    client = TestClient(app)
    launch = client.get("/api/v1/transform/launch", params={"image_path": str(source)})
    assert launch.status_code == 200, launch.text
    assert launch.json()["project"]["folder"] == "input"
    previous_version = None
    for color in [(200, 30, 40), (20, 180, 40)]:
        payload = BytesIO()
        PILImage.new("RGB", (720, 1280), color).save(payload, format="JPEG")
        response = client.post(
            "/api/v1/transform/export",
            files={"file": ("render.jpg", payload.getvalue(), "image/jpeg")},
            data={
                "document_json": json.dumps(launch.json().get("document") or {}),
                "source_path": str(source), "launch_image_path": str(source),
                "save_mode": "overwrite_current",
            },
        )
        assert response.status_code == 200, response.text
        result = response.json()
        from app.models.image import Image
        session.expire_all()
        assert session.get(Image, result["id"]).job_id == -1
        assert result["path"] == str(source)
        assert result["folder"] == "input"
        assert result["mtime"] != previous_version
        previous_version = result["mtime"]
        # Exercise both the inline DB thumbnail and the filesystem thumbnail cache.
        # The first iteration warms each before the same file is overwritten again.
        for url in [
            f"/api/v1/gallery/image/{result['id']}/thumbnail",
            "/api/v1/gallery/image/path/thumbnail",
        ]:
            thumbnail = client.get(
                url, params={"path": str(source), "max_px": 256, "v": result["mtime"]},
            )
            assert thumbnail.status_code == 200, thumbnail.text
            pixel = PILImage.open(BytesIO(thumbnail.content)).convert("RGB").getpixel((0, 0))
            assert max(abs(actual - expected) for actual, expected in zip(pixel, color)) < 12


def test_edit_history_conflict_reopen_and_export_revision(engine, session, tmp_path):
    from copy import deepcopy
    root = tmp_path / "projects" / "history"
    folder = root / "input"
    folder.mkdir(parents=True)
    source = folder / "source.png"
    PILImage.new("RGB", (16, 16), (30, 80, 140)).save(source)
    original = source.read_bytes()
    from app.models.image import Image
    selected_source = Image(job_id=0, path=str(source), filename=source.name, file_exists=True)
    session.add(selected_source)
    session.add(Project(slug="history", name="History",
        config_json={"folders": ["input"], "storage_root_dir": str(root)}))
    session.add(Engine(name="fixture", base_url="http://127.0.0.1:8188",
        input_dir=str(tmp_path / "input"), output_dir=str(tmp_path / "output")))
    session.commit()
    app = FastAPI()
    app.include_router(transform.router, prefix="/transform")
    app.dependency_overrides[get_session] = make_session_override(engine)
    client = TestClient(app)
    launch = client.get("/transform/launch", params={"image_path": str(source)})
    assert launch.status_code == 200, launch.text
    draft = launch.json()["document"] or {"sourceImage": launch.json()["source_image"], "edit": {}}
    first = client.post("/transform/documents", json={"document": draft})
    assert first.status_code == 200, first.text
    assert first.json()["document"]["recipeRevision"] == 1
    conflict = client.post("/transform/documents", json={"document": draft})
    assert conflict.status_code == 409, conflict.text
    assert conflict.json()["detail"]["code"] == "transform_recipe_conflict"
    history = client.get("/transform/revisions", params={"image_path": str(source)})
    conflict_id = next(item["id"] for item in history.json()["items"] if item["conflict"])
    reopened = client.get("/transform/revisions/" + conflict_id, params={"image_path": str(source)})
    assert reopened.status_code == 200, reopened.text
    assert reopened.json()["document"]["recipeRevision"] == 1
    saved = client.post("/transform/documents", json={"document": reopened.json()["document"]})
    assert saved.status_code == 200, saved.text
    current = saved.json()["document"]
    assert current["recipeRevision"] == 2
    def export(document):
        return client.post("/transform/export", files={"file": ("render.png", original, "image/png")},
            data={"document_json": json.dumps(document), "source_path": str(source), "save_mode": "new_copy"})
    assert export(draft).status_code == 409
    wrong_source = deepcopy(current)
    wrong_source["sourceImage"]["hash"] = "0" * 64
    assert export(wrong_source).status_code == 409
    result = export(current)
    assert result.status_code == 200, result.text
    assert result.json()["source_recipe_revision"] == 3
    assert result.json()["path"] != str(source)
    assert source.read_bytes() == original
    session.expire_all()
    edited = session.get(Image, result.json()["id"])
    assert edited.job_id == -1  # A legacy zero placeholder is not propagated.
    operation = edited.extra_metadata["transform"]
    import hashlib
    assert operation["source_media_uuid"] == selected_source.continuity_media_uuid
    assert operation["source_sha256"] == hashlib.sha256(original).hexdigest()
    from app.services.media_paths import resolve_media_file
    pending_path=resolve_media_file(edited,session)
    assert pending_path is not None
    assert operation["output_sha256"] == hashlib.sha256(Path(pending_path).read_bytes()).hexdigest()
    from tests_support.media_operations import wait_for_media_operations
    wait_for_media_operations(session.get_bind())
    assert operation["output_sha256"] == hashlib.sha256(Path(edited.path).read_bytes()).hexdigest()
    from app.services.ancestry import read_ancestry
    from app.models.ancestry import AncestryRead
    page = read_ancestry(session, AncestryRead(root_image_id=edited.id))
    assert next(node for node in page.nodes if node.kind == "step").label == "Transform"
    assert any(node.media_uuid == selected_source.continuity_media_uuid for node in page.nodes)
