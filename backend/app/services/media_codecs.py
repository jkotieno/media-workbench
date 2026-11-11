"""Bounded media codec helpers used by native agent previews.

Codec tools are optional runtime capabilities. Callers must treat unavailable or
failed extraction as a truthful handoff condition rather than as inspected media.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional

from app.core.config import settings

AUDIO_EXCERPT_MAX_DURATION_MS = 15_000
AUDIO_EXCERPT_MAX_BYTES = 2 * 1024 * 1024


def resolve_media_tool(name: str) -> Optional[str]:
    normalized = str(name or "").strip().lower()
    if normalized not in {"ffmpeg", "ffprobe"}:
        return None
    configured_name = "FFMPEG_PATH" if normalized == "ffmpeg" else "FFPROBE_PATH"
    configured = getattr(settings, configured_name, None)
    if isinstance(configured, str) and configured.strip():
        candidate = configured.strip().strip('"')
        if Path(candidate).is_file():
            return candidate

    from_path = shutil.which(normalized)
    if from_path:
        return from_path

    executable = f"{normalized}.exe" if os.name == "nt" else normalized
    candidates: list[Path] = []
    if os.name == "nt":
        candidates.append(Path(sys.prefix) / "Library" / "bin" / executable)
    else:
        candidates.append(Path(sys.prefix) / "bin" / executable)

    # A configured sibling tool is often installed beside the requested one.
    sibling_setting = getattr(settings, "FFMPEG_PATH" if normalized == "ffprobe" else "FFPROBE_PATH", None)
    if isinstance(sibling_setting, str) and sibling_setting.strip():
        sibling = Path(sibling_setting.strip().strip('"'))
        candidates.append(sibling.with_name(executable))

    located = next((str(path) for path in candidates if path.is_file()), None)
    if located:
        return located
    if normalized == "ffmpeg":
        # The pinned wheel carries a platform-specific decoder; no first-use
        # download or separately installed system package is needed.
        import imageio_ffmpeg
        try:
            return imageio_ffmpeg.get_ffmpeg_exe()
        except RuntimeError:
            return None
    return None


def extract_audio_excerpt(
    path: str | Path,
    *,
    start_ms: int = 0,
    end_ms: int | None = None,
    max_duration_ms: int = AUDIO_EXCERPT_MAX_DURATION_MS,
) -> tuple[bytes | None, dict[str, Any]]:
    source = Path(path)
    ffmpeg = resolve_media_tool("ffmpeg")
    start = max(0, int(start_ms or 0))
    requested_duration = None if end_ms is None else max(0, int(end_ms) - start)
    duration = min(int(max_duration_ms), requested_duration if requested_duration is not None else int(max_duration_ms))
    if duration <= 0:
        return None, {"available": False, "code": "audio_excerpt_range_empty", "start_ms": start, "end_ms": end_ms}
    if not source.is_file():
        return None, {"available": False, "code": "audio_source_missing", "start_ms": start, "end_ms": end_ms}
    if not ffmpeg:
        return None, {"available": False, "code": "ffmpeg_unavailable", "start_ms": start, "end_ms": end_ms}

    command = [
        ffmpeg,
        "-hide_banner", "-nostdin", "-loglevel", "error",
        "-ss", f"{start / 1000.0:.3f}",
        "-i", str(source),
        "-t", f"{duration / 1000.0:.3f}",
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
        "-f", "wav", "pipe:1",
    ]
    try:
        completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        return None, {"available": False, "code": "audio_excerpt_failed", "start_ms": start, "end_ms": start + duration}
    if completed.returncode != 0 or not completed.stdout or len(completed.stdout) > AUDIO_EXCERPT_MAX_BYTES:
        return None, {
            "available": False,
            "code": "audio_excerpt_failed" if completed.returncode else "audio_excerpt_too_large",
            "start_ms": start,
            "end_ms": start + duration,
        }
    return completed.stdout, {
        "available": True,
        "media_type": "audio/wav",
        "start_ms": start,
        "end_ms": start + duration,
        "duration_ms": duration,
        "truncated": requested_duration is None or requested_duration > duration,
    }
