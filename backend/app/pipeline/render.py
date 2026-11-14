"""PNG rendering for blink / difference / sum / RGB-composite modes.

All frames in a sequence share one normalization (pipeline.stretch) so the
blink animation doesn't flicker, which is the whole point of a blink tool.
"""
from __future__ import annotations

import io
import warnings

import numpy as np
from matplotlib import colormaps
from PIL import Image

from .stretch import shared_normalization, to_uint8


def _png_bytes_gray(uint8_array: np.ndarray, crosshair: bool = True) -> bytes:
    img = Image.fromarray(np.flipud(uint8_array), mode="L").convert("RGB")
    if crosshair:
        img = _draw_crosshair(img)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _draw_crosshair(img: Image.Image) -> Image.Image:
    from PIL import ImageDraw

    draw = ImageDraw.Draw(img)
    w, h = img.size
    cx, cy = w // 2, h // 2
    arm, gap = 6, 3
    color = (255, 90, 90)
    draw.line([(cx - arm - gap, cy), (cx - gap, cy)], fill=color, width=1)
    draw.line([(cx + gap, cy), (cx + arm + gap, cy)], fill=color, width=1)
    draw.line([(cx, cy - arm - gap), (cx, cy - gap)], fill=color, width=1)
    draw.line([(cx, cy + gap), (cx, cy + arm + gap)], fill=color, width=1)
    return img


def render_blink_frames(frames: list[np.ndarray]) -> list[bytes]:
    norm = shared_normalization(frames)
    return [_png_bytes_gray(to_uint8(f, norm)) for f in frames]


def render_difference(frame_first: np.ndarray, frame_last: np.ndarray) -> bytes:
    diff = frame_last - frame_first
    finite = diff[np.isfinite(diff)]
    if finite.size == 0:
        vmax = 1.0
    else:
        vmax = max(float(np.percentile(np.abs(finite), 99)), 1e-6)
    normed = np.clip((diff + vmax) / (2 * vmax), 0, 1)
    normed = np.nan_to_num(normed, nan=0.5)
    colored = (colormaps["coolwarm"](normed)[:, :, :3] * 255).astype(np.uint8)
    img = Image.fromarray(np.flipud(colored), mode="RGB")
    img = _draw_crosshair(img)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def render_sum(frames: list[np.ndarray]) -> bytes:
    stack = np.stack(frames)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", category=RuntimeWarning)
        deep = np.nanmean(stack, axis=0)
    norm = shared_normalization([deep])
    return _png_bytes_gray(to_uint8(deep, norm))


def render_rgb(red: np.ndarray, green: np.ndarray, blue: np.ndarray) -> bytes:
    norm = shared_normalization([red, green, blue])
    r = to_uint8(red, norm)
    g = to_uint8(green, norm)
    b = to_uint8(blue, norm)
    rgb = np.dstack([r, g, b])
    img = Image.fromarray(np.flipud(rgb), mode="RGB")
    img = _draw_crosshair(img)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
