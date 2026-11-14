"""A single shared asinh/zscale stretch computed across all frames of a
sequence, so blinking between them doesn't flicker from per-frame
normalization differences."""
from __future__ import annotations

import numpy as np
from astropy.visualization import AsinhStretch, ImageNormalize, ZScaleInterval


def shared_normalization(frames: list[np.ndarray]) -> ImageNormalize:
    # A sparsely-covered epoch (few exposures, mostly flagged) can end up
    # entirely NaN -- guard both the per-frame filter and the case where
    # every single frame is empty, rather than crashing np.concatenate on
    # an empty list of arrays.
    parts = [f[np.isfinite(f)].ravel() for f in frames if np.isfinite(f).any()]
    finite_values = np.concatenate(parts) if parts else np.array([0.0, 1.0])
    if finite_values.size == 0:
        finite_values = np.array([0.0, 1.0])
    interval = ZScaleInterval()
    vmin, vmax = interval.get_limits(finite_values)
    if vmax <= vmin:
        vmax = vmin + 1.0
    return ImageNormalize(vmin=vmin, vmax=vmax, stretch=AsinhStretch(a=0.1))


def to_uint8(frame: np.ndarray, norm: ImageNormalize) -> np.ndarray:
    filled = np.where(np.isfinite(frame), frame, norm.vmin)
    scaled = norm(filled)
    scaled = np.clip(np.nan_to_num(scaled, nan=0.0), 0.0, 1.0)
    return (scaled * 255).astype(np.uint8)
