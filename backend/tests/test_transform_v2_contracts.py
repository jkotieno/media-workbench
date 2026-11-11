from io import BytesIO
import hashlib
from pathlib import Path

from PIL import Image as PILImage

from app.api.endpoints.transform import (
    TransformProjectContext,
    TransformSourceImage,
    _next_export_path,
    _normalize_document,
    _persist_image_layer_assets,
    _persist_mask_draft_asset,
    _save_exported_image,
    _transform_document_requires_alpha,
)


def test_imported_image_layer_is_normalized_to_project_local_png(
    tmp_path: Path,
) -> None:
    source = PILImage.new("RGB", (3, 2), (12, 34, 56))
    payload = BytesIO()
    source.save(payload, format="WEBP")
    document_path = tmp_path / "source.transform.json"
    document = {
        "edit": {
            "imageLayers": [
                {
                    "id": "reference/unsafe",
                    "dataUrl": None,
                    "assetPath": None,
                },
            ],
        },
    }

    _persist_image_layer_assets(
        document,
        document_path,
        {"reference/unsafe": payload.getvalue()},
    )

    image_layer = document["edit"]["imageLayers"][0]
    asset_path = Path(image_layer["assetPath"])
    assert asset_path == (
        tmp_path
        / "source.transform.assets"
        / "image"
        / ("reference_unsafe-" + hashlib.sha256(payload.getvalue()).hexdigest() + ".png")
    )
    assert image_layer["dataUrl"] is None
    with PILImage.open(asset_path) as persisted:
        assert persisted.mode == "RGBA"
        assert persisted.size == (3, 2)


def test_mask_draft_persistence_round_trips_soft_grayscale_bytes(tmp_path: Path) -> None:
    values = [0, 17, 127, 254]
    image = PILImage.new("RGBA", (4, 1))
    image.putdata([(value, value, value, 255) for value in values])
    payload = BytesIO()
    image.save(payload, format="PNG")
    document_path = tmp_path / "source.transform.json"
    document = {"mask": {"hasDraft": False, "draftPath": None}}

    _persist_mask_draft_asset(
        document,
        document_path,
        payload.getvalue(),
        False,
    )

    coverage_path = Path(document["mask"]["coverageAssetPath"])
    assert coverage_path == (
        tmp_path
        / "source.transform.assets"
        / "mask"
        / ("coverage-" + hashlib.sha256(payload.getvalue()).hexdigest() + ".png")
    )
    with PILImage.open(coverage_path) as persisted:
        assert persisted.mode == "L"
        assert list(persisted.get_flattened_data()) == values
    assert document["mask"]["draftPath"] == str(coverage_path)
    assert document["mask"]["hasDraft"] is True


def test_schema_3_mask_state_normalizes_to_schema_5_without_losing_polarity() -> None:
    source = TransformSourceImage(
        path="/tmp/source.webp",
        format="webp",
        width=1024,
        height=768,
        hash="source-hash",
    )
    project = TransformProjectContext(
        id=7,
        slug="demo",
        folder="storyboards",
        available_folders=["storyboards", "masks"],
    )

    normalized = _normalize_document(
        {
            "schemaVersion": 3,
            "lastUsedMode": "mask",
            "edit": {
                "lastUsedTool": "select",
                "textObjects": [],
                "paintLayers": [],
                "layers": [],
                "paintSettings": {"activeColor": "#123456"},
            },
            "mask": {
                "hasDraft": True,
                "draftPath": "/tmp/source.transform.assets/mask/draft.png",
                "invertOutput": True,
                "overlayColor": "#ff00aa",
                "viewMode": "mask",
                "brush": {"hardness": 0.2},
            },
        },
        source,
        project,
    )

    assert normalized["schemaVersion"] == 5
    assert normalized["edit"]["paintSettings"]["activeColor"] == "#123456"
    assert normalized["edit"]["paintSettings"]["brushFlow"] == 1
    assert normalized["edit"]["retouchSettings"]["pixelate"]["blockSizePx"] == 16
    assert normalized["mask"] == {
        "coverageFrame": {"x": 0, "y": 0, "width": 1024, "height": 768},
        "hasDraft": True,
        "coverageAssetPath": "/tmp/source.transform.assets/mask/draft.png",
        "draftPath": "/tmp/source.transform.assets/mask/draft.png",
        "overlayColor": "#ff00aa",
        "overlayOpacity": 0.55,
        "viewMode": "mask",
        "paintedPixels": "black",
        "lastTool": "add",
        "brush": {
            "sizePx": 64,
            "hardness": 0.2,
            "strength": 1,
            "featherPx": 0,
            "smoothing": 0.3,
        },
        "fillTolerance": 32,
        "proposedFilename": None,
    }


def test_export_filename_is_sanitized_collision_safe_and_can_force_png(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.jpg"
    source.touch()

    first = _next_export_path(
        source,
        tmp_path,
        requested_filename=r"..\outside\portrait.webp",
    )
    assert first == tmp_path / "portrait.webp"
    first.touch()
    assert _next_export_path(
        source,
        tmp_path,
        requested_filename="portrait.webp",
    ) == tmp_path / "portrait_0001.webp"
    assert _next_export_path(
        source,
        tmp_path,
        requested_filename="portrait.jpg",
        force_png=True,
    ) == tmp_path / "portrait.png"


def test_visible_source_erasure_is_the_only_alpha_force_signal() -> None:
    document = {
        "edit": {
            "paintLayers": [
                {"id": "paint", "role": "paint"},
                {"id": "eraser", "role": "source_eraser"},
            ],
            "layers": [
                {
                    "id": "layer-eraser",
                    "kind": "paint_layer",
                    "refId": "eraser",
                    "visible": True,
                },
            ],
        },
    }
    assert _transform_document_requires_alpha(document) is True
    document["edit"]["layers"][0]["visible"] = False
    assert _transform_document_requires_alpha(document) is False


def test_png_export_preserves_compositor_preview_pixels_and_source(
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "source.png"
    source_pixels = [
        (8, 16, 24, 255),
        (32, 40, 48, 255),
        (56, 64, 72, 255),
        (80, 88, 96, 255),
    ]
    source = PILImage.new("RGBA", (2, 2))
    source.putdata(source_pixels)
    source.save(source_path, format="PNG")

    preview_pixels = [
        (255, 0, 0, 255),
        (0, 255, 0, 191),
        (0, 0, 255, 127),
        (255, 255, 255, 0),
    ]
    preview = PILImage.new("RGBA", (2, 2))
    preview.putdata(preview_pixels)
    preview_payload = BytesIO()
    preview.save(preview_payload, format="PNG")

    output_path = tmp_path / "finished.png"
    size = _save_exported_image(
        source_path=source_path,
        export_bytes=preview_payload.getvalue(),
        output_path=output_path,
        document={"edit": {"crop": {"enabled": False}}},
        transform_payload={"document_id": "preview-export-contract"},
    )

    assert size == (2, 2)
    with PILImage.open(output_path) as exported:
        assert list(exported.convert("RGBA").get_flattened_data()) == preview_pixels
    with PILImage.open(source_path) as unchanged_source:
        assert list(unchanged_source.convert("RGBA").get_flattened_data()) == source_pixels
