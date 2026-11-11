"""Canonical modality, preview, and provenance contracts for Agent Access.

This module deliberately keeps unknown engine metadata unknown.  In particular,
an audio file is not described as executable, registered, or reusable until a
runtime provides those operations.
"""

from __future__ import annotations

import json
import mimetypes
import shutil
import subprocess
from pathlib import Path
from typing import Any, Mapping

from app.services.media_codecs import resolve_media_tool

MEDIA_CONTRACT_VERSION = "studio-media/v1"
MEDIA_MODALITIES = ("image", "video", "audio")
AUDIO_EXTENSIONS = {".mp3", ".wav", ".ogg", ".oga", ".flac", ".m4a", ".aac", ".opus", ".wma"}
AUDIO_MIME_TYPES = {
    "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/ogg",
    "audio/flac", "audio/mp4", "audio/aac", "audio/opus", "audio/webm",
}


def media_kind(*values: Any) -> str | None:
    for value in values:
        raw = str(value or "").strip().lower()
        if not raw:
            continue
        mime = raw.split(";", 1)[0]
        if mime.startswith("image/"):
            return "image"
        if mime.startswith("video/"):
            return "video"
        if mime.startswith("audio/"):
            return "audio"
        suffix = Path(raw).suffix.lower()
        if suffix in AUDIO_EXTENSIONS:
            return "audio"
        if suffix in {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v", ".mpg", ".mpeg"}:
            return "video"
        if suffix in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"}:
            return "image"
    return None


def mime_for_path(path: str | Path, fallback: str | None = None) -> str:
    return (mimetypes.guess_type(str(path))[0] or fallback or "application/octet-stream").lower()


def normalize_client_modalities(value: Any) -> dict[str, bool]:
    """Normalize the small capability vocabulary shared by clients."""
    if value is None:
        # No client declaration is a server-side/catalog contract, not a
        # capability denial. Route callers pass an explicit list when they
        # need client blockers.
        return {"image": True, "video": True, "audio": True}
    defaults = {"image": False, "video": False, "audio": False}
    if isinstance(value, Mapping):
        for name in MEDIA_MODALITIES:
            if name in value:
                defaults[name] = bool(value[name])
    elif isinstance(value, (list, tuple, set)):
        defaults.update({name: name in value for name in MEDIA_MODALITIES})
    return defaults


def preview_blockers(kind: str | None, capabilities: Any, *, audio_registered: bool | None = False) -> list[dict[str, str]]:
    normalized = normalize_client_modalities(capabilities)
    blockers: list[dict[str, str]] = []
    if kind in MEDIA_MODALITIES and not normalized.get(kind, False):
        blockers.append({
            "code": f"client_{kind}_unsupported",
            "message": f"The calling client did not advertise {kind} preview capability.",
            "repair": f"Reconnect or refresh the client definition with {kind} capability enabled.",
        })
    return blockers


def ffprobe_metadata(path: str | Path, preferred_kind: str | None = None) -> dict[str, Any]:
    """Return best-effort technical metadata; missing ffprobe stays explicit."""
    executable = resolve_media_tool("ffprobe")
    if not executable or not Path(path).is_file():
        return {"available": False, "duration_ms": None, "sample_rate": None, "channels": None, "frame_rate": None}
    command = [executable, "-v", "error", "-of", "json", "-show_format", "-show_streams", str(path)]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=8, check=False)
        if completed.returncode != 0:
            raise ValueError(completed.stderr[:200])
        payload = json.loads(completed.stdout or "{}")
    except (OSError, ValueError, json.JSONDecodeError, subprocess.TimeoutExpired):
        return {"available": False, "duration_ms": None, "sample_rate": None, "channels": None, "frame_rate": None}
    streams = payload.get("streams") if isinstance(payload, dict) else []
    stream = {}
    if isinstance(streams, list) and streams:
        preferred = str(preferred_kind or "").strip().lower()
        if preferred in {"audio", "video"}:
            stream = next((item for item in streams if isinstance(item, dict) and str(item.get("codec_type") or "").lower() == preferred), {})
        if not stream:
            stream = next((item for item in streams if isinstance(item, dict)), {})
    duration = (payload.get("format") or {}).get("duration") if isinstance(payload, dict) else None
    try:
        duration_ms = round(float(duration) * 1000) if duration is not None else None
    except (TypeError, ValueError):
        duration_ms = None
    frame_rate = stream.get("r_frame_rate") if isinstance(stream, dict) else None
    return {
        "available": True,
        "duration_ms": duration_ms,
        "sample_rate": int(stream["sample_rate"]) if isinstance(stream, dict) and str(stream.get("sample_rate") or "").isdigit() else None,
        "channels": int(stream["channels"]) if isinstance(stream, dict) and str(stream.get("channels") or "").isdigit() else None,
        "frame_rate": frame_rate,
        "frame_count": int(stream["nb_frames"]) if isinstance(stream, dict) and str(stream.get("nb_frames") or "").isdigit() else None,
    }


def build_media_contract(*, media_id: int | None, filename: str | None, path: str | None,
                         media_type: str | None = None, width: int | None = None,
                         height: int | None = None, extra_metadata: Any = None,
                         client_capabilities: Any = None) -> dict[str, Any]:
    meta = extra_metadata if isinstance(extra_metadata, dict) else {}
    technical = meta.get("media_contract") if isinstance(meta.get("media_contract"), dict) else {}
    kind = media_kind(media_type, filename, path) or "image"
    probe = technical.get("technical") if isinstance(technical.get("technical"), dict) else {}
    if kind in {"audio", "video"} and path and not probe:
        probe = ffprobe_metadata(path, preferred_kind=kind)
    audio_registered = (
        technical.get("audio_output_registered")
        or (technical.get("audio", {}).get("output_registered") if isinstance(technical.get("audio"), dict) else False)
        or (technical.get("operations", {}).get("audio_output_registration") if isinstance(technical.get("operations"), dict) else False)
    )
    ffmpeg_available = resolve_media_tool("ffmpeg") is not None
    contract = {
        "contract_version": MEDIA_CONTRACT_VERSION,
        "media_id": media_id,
        "modality": kind,
        "mime_type": (media_type or mime_for_path(filename or path or "", fallback=None)),
        "dimensions": {"width": width, "height": height} if kind == "image" else None,
        "technical": {
            "duration_ms": probe.get("duration_ms"),
            "sample_rate": probe.get("sample_rate") if kind == "audio" else None,
            "channels": probe.get("channels") if kind == "audio" else None,
            "frame_rate": probe.get("frame_rate") if kind == "video" else None,
            "frame_count": probe.get("frame_count") if kind == "video" else None,
            "probe_available": bool(probe.get("available")),
            "ffmpeg_available": ffmpeg_available,
        },
        "operations": {
            "native_view": kind in {"image", "video", "audio"},
            "mask": kind == "image",
            "crop": kind == "image",
            "comparison": kind == "image",
            "frame_inspection": kind == "video" and ffmpeg_available,
            "segment_inspection": kind in {"video", "audio"} and ffmpeg_available,
            "audio_import": kind == "audio",
            "audio_output_registration": audio_registered is True,
            "audio_preview_playback": kind == "audio" and bool(path),
            "export": kind != "audio" or bool(path),
            "reuse": kind != "audio" or bool(path),
        },
        "temporal_lineage": technical.get("temporal_lineage") if kind == "video" else None,
        "provenance": {
            "source_media_id": technical.get("source_media_id"),
            "source_revision": technical.get("source_revision"),
            "operation_id": technical.get("operation_id"),
        },
        "client_capabilities": normalize_client_modalities(client_capabilities),
        "capability_blockers": preview_blockers(kind, client_capabilities, audio_registered=audio_registered),
    }
    return contract
