"""Exported image bytes must stay recognizable to ComfyUI and Civitai."""

import io
import json
from pathlib import Path

import pytest
from PIL import Image as PILImage, PngImagePlugin

from app.api.endpoints.transform import (
    _extract_transform_metadata_from_image,
    _save_exported_image,
    PORTABLE_METADATA_KEY,
)
from app.services.gallery.metadata import _decode_xp_comment
from app.services.image_metadata_parser import parse_image_metadata_from_path
from app.services.job_processing.media_pipeline import process_single_image
from app.services.model_provenance import (
    build_automatic1111_parameters,
    encode_exif_user_comment,
)
from tests_support.output_publication import create_output_provenance, settle_output

def _graph(*, steps: int | None = 24) -> dict:
    nodes = {
        "1": {"class_type": "CLIPTextEncode", "inputs": {"text": "portrait 東京"}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "blurry"}},
    }
    if steps is not None:
        nodes["3"] = {"class_type": "KSampler", "inputs": {
            "positive": ["1", 0], "negative": ["2", 0], "seed": 42,
            "steps": steps, "cfg": 7, "sampler_name": "euler",
        }}
    return nodes


def _png_bytes(chunks: dict[str, str] | None = None) -> bytes:
    png = PngImagePlugin.PngInfo()
    for key, value in (chunks or {}).items():
        png.add_text(key, value)
    buffer = io.BytesIO()
    PILImage.new("RGB", (12, 10), "navy").save(buffer, format="PNG", pnginfo=png)
    return buffer.getvalue()


def _user_comment(exif) -> str | None:
    # piexif correctly stores this tag in the nested EXIF IFD; PIL can also
    # expose top-level comments on Transform-created images.
    value = exif.get(0x9286) or exif.get_ifd(0x8769).get(0x9286)
    return _decode_xp_comment(value)


def _export(source: Path, output: Path) -> None:
    # Real source file and real encoded pixels; no FastAPI/DB needed.
    _save_exported_image(
        source_path=source,
        export_bytes=_png_bytes(),
        output_path=output,
        document={"edit": {}},
        transform_payload={"source_image_path": str(source), "mode": "edit"},
    )


def _provenance(graph: dict, *, additional: str = "") -> dict:
    return {
        "schema": "sweet_tea_provenance",
        "schema_version": 2,
        "positive_prompt": "portrait 東京",
        "negative_prompt": "blurry",
        "params": {"steps": 24, "seed": 42},
        "source_execution": {
            "graph_json": graph,
            "execution_graph": graph,
        },
        "capture_note": additional,
    }


@pytest.mark.parametrize("extension", ["jpg", "webp"])
def test_comfy_png_export_retains_civitai_readable_exif_and_roundtrips_workflow(
    tmp_path, extension,
):
    graph = _graph()
    workflow = {"nodes": [{"id": 1, "type": "CLIPTextEncode", "widgets_values": ["portrait 東京"]}]}
    parameters = build_automatic1111_parameters(
        positive_prompt="portrait 東京", negative_prompt="blurry",
        params={"steps": 24, "seed": 42}, graph=graph, resources=[],
    )
    provenance = _provenance(graph)
    source = tmp_path / "source.png"
    source.write_bytes(_png_bytes({
        "prompt": json.dumps(graph),
        "workflow": json.dumps(workflow),
        "parameters": parameters,
        "sweet_tea_provenance": json.dumps(provenance, ensure_ascii=False),
    }))
    encoded = tmp_path / f"export.{extension}"
    _export(source, encoded)

    with PILImage.open(encoded) as image:
        exif = image.getexif()
        assert _decode_xp_comment(exif[0x9286]) == parameters
        assert json.loads(_decode_xp_comment(exif[0x9C9C])) == provenance
        description = json.loads(exif[0x010E])
        assert description["sweet_tea_transform"]["mode"] == "edit"
        assert description[PORTABLE_METADATA_KEY]["workflow"] == json.dumps(workflow)

    assert _extract_transform_metadata_from_image(encoded)["source_image_path"] == str(source)
    assert parse_image_metadata_from_path(str(encoded)).workflow_graph == graph
    roundtrip = tmp_path / f"roundtrip-{extension}.png"
    _export(encoded, roundtrip)
    with PILImage.open(roundtrip) as image:
        assert json.loads(image.info["prompt"]) == graph
        assert json.loads(image.info["workflow"]) == workflow
        assert image.info["parameters"] == parameters
        assert json.loads(image.info["sweet_tea_provenance"]) == provenance
    assert parse_image_metadata_from_path(str(roundtrip)).prompt == "portrait 東京"


def test_comfy_png_without_infotext_creates_real_a1111_parameters_for_jpeg(tmp_path):
    source = tmp_path / "raw-comfy.png"
    source.write_bytes(_png_bytes({"prompt": json.dumps(_graph())}))
    output = tmp_path / "raw-comfy-export.jpg"
    _export(source, output)
    with PILImage.open(output) as image:
        comment = _decode_xp_comment(image.getexif()[0x9286])
        assert "portrait 東京" in comment
        assert "Steps: 24" in comment
        assert "Seed: 42" in comment


def test_generated_jpeg_to_png_recovers_nested_exif_and_studio_provenance(tmp_path,session):
    graph = _graph()
    provenance = create_output_provenance(session,_provenance(graph))
    record = json.dumps(provenance)
    parameters = "portrait 東京\nNegative prompt: blurry\nSteps: 24, Seed: 42"
    saved = process_single_image(
        {"image_bytes": _png_bytes()}, 0, str(tmp_path), "generated.png",
        record, record.encode("utf-16-le") + b"\0\0",
        None, None, generated_image_format="jpeg",
        comfy_prompt_json=json.dumps(graph),
        user_comment_bytes=encode_exif_user_comment(parameters),
        automatic1111_parameters=parameters,
        bind=session.get_bind(),
    )
    settle_output(session.get_bind())
    assert saved is not None
    png = tmp_path / "generated-transform.png"
    _export(Path(saved[0]), png)
    with PILImage.open(png) as image:
        assert image.info["parameters"] == parameters
        assert json.loads(image.info["prompt"]) == graph
        assert json.loads(image.info["sweet_tea_provenance"]) == provenance
    assert parse_image_metadata_from_path(str(png)).workflow_graph == graph


def test_old_transform_jpeg_envelope_is_upgraded_without_losing_prompt(tmp_path):
    infotext = "original scene\nNegative prompt: artifacts\nSteps: 12, Seed: 8"
    old = {"sweet_tea_transform": {"source_image_path": "legacy"},
           "sweet_tea_source_user_comment": infotext}
    source = tmp_path / "old-transform.jpg"
    exif = PILImage.Exif()
    exif[0x9286] = json.dumps(old)
    PILImage.new("RGB", (12, 10)).save(source, exif=exif)
    output = tmp_path / "fixed-transform.jpg"
    _export(source, output)

    with PILImage.open(output) as image:
        assert _decode_xp_comment(image.getexif()[0x9286]) == infotext
    assert _extract_transform_metadata_from_image(output)["source_image_path"] == str(source)


def test_large_comfy_graph_remains_portable_with_jpeg_sidecar(tmp_path):
    graph = _graph()
    graph["20"] = {"class_type": "CustomGraphNode", "inputs": {"large_context": "x" * 85_000}}
    params = "portrait 東京\nSteps: 24, Seed: 42"
    source = tmp_path / "large.png"
    source.write_bytes(_png_bytes({
        "prompt": json.dumps(graph),
        "parameters": params,
        "sweet_tea_provenance": json.dumps(_provenance(graph, additional="x" * 8_000)),
    }))
    jpeg = tmp_path / "large-export.jpg"
    _export(source, jpeg)

    sidecar = json.loads(jpeg.with_suffix(".json").read_text(encoding="utf-8"))
    assert sidecar[PORTABLE_METADATA_KEY]["prompt"] == json.dumps(graph)
    with PILImage.open(jpeg) as image:
        assert "Steps: 24" in _decode_xp_comment(image.getexif()[0x9286])
        assert _extract_transform_metadata_from_image(jpeg)["mode"] == "edit"

    roundtrip = tmp_path / "large-return.png"
    _export(jpeg, roundtrip)
    with PILImage.open(roundtrip) as image:
        assert json.loads(image.info["prompt"]) == graph


def test_samplerless_generated_jpeg_exposes_comfy_graph_without_faking_steps(tmp_path,session):
    graph = _graph(steps=None)
    graph["1"]["inputs"]["api_key"] = "private-test-key"
    provenance = create_output_provenance(session,_provenance(graph))
    provenance["params"] = {}
    record = json.dumps(provenance)
    image = process_single_image(
        {"image_bytes": _png_bytes()}, 0, str(tmp_path), "samplerless.png",
        record, record.encode("utf-16-le") + b"\0\0",
        None, None, generated_image_format="jpeg",
        comfy_prompt_json=json.dumps(graph),
        user_comment_bytes=encode_exif_user_comment("portrait 東京"),
        automatic1111_parameters="portrait 東京",
        bind=session.get_bind(),
    )
    settle_output(session.get_bind())
    assert image is not None
    with PILImage.open(image[0]) as saved:
        exif = saved.getexif()
        assert exif[0x0110].startswith("prompt:")
        shared_graph = json.loads(exif[0x0110][len("prompt:"):])
        assert shared_graph["1"]["inputs"]["text"] == "portrait 東京"
        assert "api_key" not in shared_graph["1"]["inputs"]
        assert "Steps:" not in _user_comment(exif)


def test_generated_jpeg_keeps_readable_user_comment_when_provenance_exceeds_app1(tmp_path,session):
    provenance = create_output_provenance(session,_provenance(_graph(), additional="x" * 100_000))
    record = json.dumps(provenance)
    params = "portrait 東京\nSteps: 24, Sampler: Euler, Seed: 42"
    result = process_single_image(
        {"image_bytes": _png_bytes()}, 0, str(tmp_path), "overflow.png",
        record, record.encode("utf-16-le") + b"\0\0", None, None,
        generated_image_format="jpeg",
        user_comment_bytes=encode_exif_user_comment(params),
        automatic1111_parameters=params,
        bind=session.get_bind(),
    )
    settle_output(session.get_bind())
    assert result is not None
    image_path = Path(result[0])
    assert json.loads(image_path.with_suffix(".json").read_text()) == provenance
    with PILImage.open(image_path) as saved:
        exif = saved.getexif()
        assert _user_comment(exif) == params
        assert 0x9C9C not in exif
