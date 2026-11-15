"""PNG rendering for blink / difference / sum / RGB-composite modes.

All frames in a sequence share one normalization (pipeline.stretch) so the
blink animation doesn't flicker, which is the whole point of a blink tool.

Pixels with coverage but no usable data are rendered honestly rather than
disguised as sky: a saturated bright-star core (OVERFLOW/NONLINEAR/BLOOM
flags in essentially every exposure -- see config.FLAG_SATURATION_BITMASK)
is drawn white with a thin red outline, and any other fully-masked pixel is
drawn dark grey. Previously both were filled with the stretch's vmin and
came out pure black -- a black hole sitting on top of the brightest star in
the field, which reads as corrupted data.
"""
from __future__ import annotations

import io
import warnings

import numpy as np
from matplotlib import colormaps
from PIL import Image

from .stretch import shared_normalization, to_uint8

# SPHEREx's real pixel scale is ~6.2"/pixel, so at the app's supported field
# of view (1'-15') a cutout is a genuine 10-145px native image -- rendering
# at that size and leaving scaling to the browser meant a *fixed-size*
# crosshair (a handful of pixels) could end up covering more than half of a
# small frame, reading as a distorted red blob rather than a small marker.
# Upsampling here, before drawing anything, fixes both problems from one
# root cause: the crosshair is drawn proportionally correct at any FOV, and
# the image reaches a sane on-screen size without the browser inventing
# detail that isn't in the data (nearest-neighbor block-repeat, matching the
# "pixelated" CSS rendering already used client-side -- crisp real pixels,
# not a fake smooth blur).
MIN_DISPLAY_PX = 400

MASKED_GREY = (54, 54, 58)
SATURATED_WHITE = (255, 255, 255)
SATURATED_OUTLINE = (231, 72, 72)


def _upsample_nearest(arr: np.ndarray, min_size: int = MIN_DISPLAY_PX) -> np.ndarray:
    h, w = arr.shape[:2]
    scale = max(1, -(-min_size // max(h, w)))  # ceil(min_size / max(h, w))
    if scale == 1:
        return arr
    return np.repeat(np.repeat(arr, scale, axis=0), scale, axis=1)


def _mask_boundary(mask: np.ndarray) -> np.ndarray:
    """Pixels of `mask` with at least one 4-neighbor outside it -- a thin
    (1 display px) outline, computed on the already-upsampled mask."""
    if not mask.any():
        return mask
    interior = mask.copy()
    interior[1:, :] &= mask[:-1, :]
    interior[:-1, :] &= mask[1:, :]
    interior[:, 1:] &= mask[:, :-1]
    interior[:, :-1] &= mask[:, 1:]
    return mask & ~interior


def _compose_rgb(
    rgb: np.ndarray,
    saturated: np.ndarray | None,
    masked: np.ndarray | None,
) -> Image.Image:
    """Apply mask styling to an HxWx3 uint8 array (native orientation,
    row 0 = south), then flip north-up, upsample, and outline saturated
    cores. Returns a PIL image ready for the crosshair."""
    if masked is not None and masked.any():
        rgb[masked] = MASKED_GREY
    if saturated is not None and saturated.any():
        rgb[saturated] = SATURATED_WHITE

    rgb = _upsample_nearest(np.flipud(rgb))
    if saturated is not None and saturated.any():
        sat_up = _upsample_nearest(np.flipud(saturated))
        rgb[_mask_boundary(sat_up)] = SATURATED_OUTLINE
    return Image.fromarray(np.ascontiguousarray(rgb), mode="RGB")


def _png_bytes_gray(
    uint8_array: np.ndarray,
    saturated: np.ndarray | None = None,
    masked: np.ndarray | None = None,
    crosshair: bool = True,
) -> bytes:
    rgb = np.dstack([uint8_array] * 3)
    img = _compose_rgb(rgb, saturated, masked)
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
    arm, gap = 18, 7
    color = (255, 90, 90)
    draw.line([(cx - arm - gap, cy), (cx - gap, cy)], fill=color, width=1)
    draw.line([(cx + gap, cy), (cx + arm + gap, cy)], fill=color, width=1)
    draw.line([(cx, cy - arm - gap), (cx, cy - gap)], fill=color, width=1)
    draw.line([(cx, cy + gap), (cx, cy + arm + gap)], fill=color, width=1)
    return img


def render_blink_frames(
    frames: list[np.ndarray],
    saturated: list[np.ndarray] | None = None,
    masked: list[np.ndarray] | None = None,
) -> list[bytes]:
    norm = shared_normalization(frames)
    out: list[bytes] = []
    for i, f in enumerate(frames):
        sat = saturated[i] if saturated is not None else None
        msk = masked[i] if masked is not None else None
        out.append(_png_bytes_gray(to_uint8(f, norm), sat, msk))
    return out


def render_difference(
    frame_first: np.ndarray,
    frame_last: np.ndarray,
    saturated: np.ndarray | None = None,
) -> bytes:
    diff = frame_last - frame_first
    finite = diff[np.isfinite(diff)]
    if finite.size == 0:
        vmax = 1.0
    else:
        vmax = max(float(np.percentile(np.abs(finite), 99)), 1e-6)
    normed = np.clip((diff + vmax) / (2 * vmax), 0, 1)
    normed = np.nan_to_num(normed, nan=0.5)
    colored = (colormaps["coolwarm"](normed)[:, :, :3] * 255).astype(np.uint8)
    # In a difference map "white" would read as a strong positive change, so
    # a saturated core keeps the neutral midpoint fill and gets only the red
    # outline to say "no reliable difference measurable here".
    img = _compose_rgb(colored, saturated, None)
    img = _draw_crosshair(img)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def render_sum(
    frames: list[np.ndarray],
    saturated: list[np.ndarray] | None = None,
    masked: list[np.ndarray] | None = None,
) -> bytes:
    stack = np.stack(frames)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", category=RuntimeWarning)
        deep = np.nanmean(stack, axis=0)
    norm = shared_normalization([deep])
    # In the deep stack a pixel only stays empty if it was empty in every
    # epoch; call it saturated if any epoch classified it so.
    empty = ~np.isfinite(deep)
    sat_deep = (empty & np.any(np.stack(saturated), axis=0)) if saturated else None
    msk_deep = None
    if saturated is not None or masked is not None:
        msk_deep = empty & ~sat_deep if sat_deep is not None else empty
    return _png_bytes_gray(to_uint8(deep, norm), sat_deep, msk_deep)


def render_rgb(
    red: np.ndarray,
    green: np.ndarray,
    blue: np.ndarray,
    saturated: np.ndarray | None = None,
    masked: np.ndarray | None = None,
) -> bytes:
    norm = shared_normalization([red, green, blue])
    r = to_uint8(red, norm)
    g = to_uint8(green, norm)
    b = to_uint8(blue, norm)
    rgb = np.dstack([r, g, b])
    img = _compose_rgb(rgb, saturated, masked)
    img = _draw_crosshair(img)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
