"""Shared geometry and coverage for Transform and literal Agent Access preparation."""
from __future__ import annotations

from PIL import Image, ImageOps
import hashlib
import json
import os
from io import BytesIO
from pathlib import Path
from uuid import uuid4
from PIL.PngImagePlugin import PngInfo

MAX_DIMENSION = 16384
MAX_PIXELS = 64 * 1024 * 1024


def validate_frame(frame: dict) -> dict:
    keys = ("x", "y", "width", "height")
    if not isinstance(frame, dict) or any(type(frame.get(key)) is not int for key in keys):
        raise ValueError("The frame must use whole pixels.")
    if not (1 <= frame["width"] <= MAX_DIMENSION and 1 <= frame["height"] <= MAX_DIMENSION) or frame["width"] * frame["height"] > MAX_PIXELS:
        raise ValueError("The frame must fit within 16,384 px per side and contain at most 64 megapixels.")
    return {key: frame[key] for key in keys}


def normalize_expansion(value: dict | None) -> dict | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("Invalid expansion frame.")
    base = validate_frame(value.get("base"))
    keys = ("left", "top", "right", "bottom", "transition")
    if any(type(value.get(key)) is not int or value[key] < 0 or value[key] > MAX_DIMENSION for key in keys):
        raise ValueError("Padding and transition must be nonnegative whole pixels.")
    result = {"base": base, **{key: value[key] for key in keys}}
    expansion_frame(result)
    return result


def expansion_frame(expansion: dict) -> dict:
    base = expansion["base"]
    return validate_frame({"x": base["x"] - expansion["left"], "y": base["y"] - expansion["top"],
        "width": base["width"] + expansion["left"] + expansion["right"],
        "height": base["height"] + expansion["top"] + expansion["bottom"]})


def automatic_coverage(expansion: dict, composition: Image.Image) -> Image.Image:
    frame = expansion_frame(expansion)
    if composition.size != (frame["width"], frame["height"]):
        raise ValueError("Composition dimensions do not match the frame.")
    width, height = composition.size
    left, top = expansion["left"], expansion["top"]
    bw, bh = expansion["base"]["width"], expansion["base"]["height"]
    transition = expansion["transition"]
    pixels = bytearray(width * height)
    alpha = composition.convert("RGBA").getchannel("A").tobytes()
    x_distances = [min(x - left + .5 if left else float("inf"), bw - (x - left) - .5 if expansion["right"] else float("inf")) for x in range(width)]
    for y in range(height):
        py = y - top
        dy = min(py + .5 if top else float("inf"), bh - py - .5 if expansion["bottom"] else float("inf"))
        for x in range(width):
            i = y * width + x
            px = x - left
            if px < 0 or py < 0 or px >= bw or py >= bh:
                pixels[i] = 255
            else:
                seam = int(255 * max(0, 1 - min(x_distances[x], dy) / transition) + .5) if transition else 0
                pixels[i] = max(seam, 255 - alpha[i])
    return Image.frombytes("L", composition.size, bytes(pixels))


def prepared_images(composition: Image.Image, coverage: Image.Image, frame: dict) -> dict[str, Image.Image]:
    frame = validate_frame(frame)
    size = (frame["width"], frame["height"])
    if composition.size != size or coverage.size != size:
        raise ValueError("Expanded image and mask dimensions must match the output frame.")
    rgba = composition.convert("RGBA")
    opaque = Image.new("RGB", size, (127, 127, 127))
    opaque.paste(rgba, mask=rgba.getchannel("A"))
    mask = coverage.convert("L")
    encoded = opaque.convert("RGBA")
    encoded.putalpha(ImageOps.invert(mask))
    return {"image": opaque, "mask": mask, "alpha": encoded}


def reproject_coverage(base: Image.Image, frame: dict, previous: Image.Image,
                       previous_frame: dict, previous_base: Image.Image | None = None) -> Image.Image:
    validate_frame(previous_frame)
    if previous.size != (previous_frame["width"], previous_frame["height"]) or (previous_base and previous_base.size != previous.size):
        raise ValueError("Mask dimensions do not match its saved frame.")
    result = base.copy()
    x = max(frame["x"], previous_frame["x"])
    y = max(frame["y"], previous_frame["y"])
    right = min(frame["x"] + frame["width"], previous_frame["x"] + previous_frame["width"])
    bottom = min(frame["y"] + frame["height"], previous_frame["y"] + previous_frame["height"])
    dst, src = result.load(), previous.convert("L").load()
    old_base = previous_base.convert("L").load() if previous_base else None
    for py in range(y, bottom):
        for px in range(x, right):
            a = (px - previous_frame["x"], py - previous_frame["y"])
            b = (px - frame["x"], py - frame["y"])
            if old_base:
                if src[a] != old_base[a]:
                    dst[b] = src[a]
            else:
                dst[b] = max(dst[b], src[a])
    return result


def _atomic_bytes(path: Path, raw: bytes) -> None:
    temp = path.with_name(f".{path.name}.{uuid4().hex}.partial")
    try:
        temp.write_bytes(raw)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def persist_preparation(composition: Image.Image, coverage: Image.Image, expansion: dict,
                        source_path: Path, root: Path) -> dict:
    """Content-addressed files plus a receipt; completed writes survive interrupted preparation."""
    frame = expansion_frame(expansion)
    images = prepared_images(composition, coverage, frame)
    digest = hashlib.sha256(str(source_path).encode() + json.dumps(expansion, sort_keys=True).encode()
        + images["image"].tobytes() + images["mask"].tobytes()).hexdigest()
    folder = root / digest[:24]
    folder.mkdir(parents=True, exist_ok=True)
    metadata = {"operation": "outpaint_prepare", "source_path": str(source_path), "expansion": expansion,
        "frame": frame, "coverage_polarity": "white_generates", "preparation_id": digest}
    info = PngInfo(); info.add_text("sweet_tea_transform", json.dumps(metadata))
    paths = {}
    for role, image in images.items():
        path = folder / f"outpaint_{role}.png"
        if not path.is_file():
            raw = BytesIO(); image.save(raw, format="PNG", pnginfo=info)
            _atomic_bytes(path, raw.getvalue())
        else:
            with Image.open(path) as stored:
                stored.load()
                if stored.size != image.size or stored.mode != image.mode or stored.tobytes() != image.tobytes():
                    raise ValueError("A prepared artifact has changed; prepare again after removing the damaged artifact.")
        paths[role] = str(path)
    receipt = {**metadata, "width": frame["width"], "height": frame["height"], "paths": paths}
    _atomic_bytes(folder / "receipt.json", json.dumps(receipt).encode())
    return receipt
