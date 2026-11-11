from app.services.media_contracts import (
    MEDIA_CONTRACT_VERSION,
    build_media_contract,
    normalize_client_modalities,
    preview_blockers,
)


def test_audio_contract_distinguishes_unregistered_metadata_from_reusable_file():
    contract = build_media_contract(
        media_id=7,
        filename="take.wav",
        path=None,
        media_type="audio/wav",
        client_capabilities=["image", "audio"],
    )
    assert contract["contract_version"] == MEDIA_CONTRACT_VERSION
    assert contract["modality"] == "audio"
    assert contract["operations"]["audio_import"] is True
    assert contract["operations"]["audio_output_registration"] is False
    assert contract["operations"]["audio_preview_playback"] is False
    assert contract["operations"]["reuse"] is False
    assert not any(item["code"] == "audio_runtime_registration_unavailable" for item in contract["capability_blockers"])


def test_client_modality_blocker_prevents_unadvertised_native_media():
    assert normalize_client_modalities(["image"]) == {"image": True, "video": False, "audio": False}
    blockers = preview_blockers("video", ["image"])
    assert blockers[0]["code"] == "client_video_unsupported"
    assert "refresh" in blockers[0]["repair"].lower()


def test_image_contract_advertises_native_image_operations_and_provenance_shape():
    contract = build_media_contract(
        media_id=9,
        filename="source.png",
        path=None,
        media_type="image/png",
        width=640,
        height=480,
        extra_metadata={"media_contract": {"source_media_id": 3}},
    )
    assert contract["operations"]["mask"] is True
    assert contract["operations"]["crop"] is True
    assert contract["operations"]["comparison"] is True
    assert contract["provenance"]["source_media_id"] == 3


def test_agent_media_kind_recognizes_filename_and_format_extensions():
    from app.api.endpoints.agent_core import _media_kind_from_path_value

    assert _media_kind_from_path_value("clip.mp4") == "video"
    assert _media_kind_from_path_value("mp4") == "video"
    assert _media_kind_from_path_value("voice.wav") == "audio"
    assert _media_kind_from_path_value("flac") == "audio"
    assert _media_kind_from_path_value("still.png") == "image"
