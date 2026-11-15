"""A single shared asinh stretch computed across all frames of a sequence,
so blinking between them doesn't flicker from per-frame normalization
differences.

The clip interval is a plain 1-99.5 percentile of all finite pixels across
every frame, not ZScale: ZScale fits the display range tightly around the
sky background's own scatter, which in a crowded Milky Way field (Proxima
Centauri sits at galactic latitude ~-2) stretches pure noise into a frame
full of fake "stars". A percentile clip keeps the faint end anchored at the
actual dark end of the data and lets asinh compress the bright end, so real
sources stand out of a quiet background instead of competing with amplified
noise."""
from __future__ import annotations

import numpy as np
from astropy.visualization import AsinhStretch, ImageNormalize

CLIP_LO_PERCENTILE = 1.0
CLIP_HI_PERCENTILE = 99.5


def shared_normalization(frames: list[np.ndarray]) -> ImageNormalize:
    # A sparsely-covered epoch (few exposures, mostly flagged) can end up
    # entirely NaN -- guard both the per-frame filter and the case where
    # every single frame is empty, rather than crashing np.concatenate on
    # an empty list of arrays.
    parts = [f[np.isfinite(f)].ravel() for f in frames if np.isfinite(f).any()]
    finite_values = np.concatenate(parts) if parts else np.array([0.0, 1.0])
    if finite_values.size == 0:
        finite_values = np.array([0.0, 1.0])
    vmin = float(np.percentile(finite_values, CLIP_LO_PERCENTILE))
    vmax = float(np.percentile(finite_values, CLIP_HI_PERCENTILE))
    if vmax <= vmin:
        vmax = vmin + 1.0
    return ImageNormalize(vmin=vmin, vmax=vmax, stretch=AsinhStretch(a=0.1))


def to_uint8(frame: np.ndarray, norm: ImageNormalize) -> np.ndarray:
    filled = np.where(np.isfinite(frame), frame, norm.vmin)
    scaled = norm(filled)
    scaled = np.clip(np.nan_to_num(scaled, nan=0.0), 0.0, 1.0)
    return (scaled * 255).astype(np.uint8)
