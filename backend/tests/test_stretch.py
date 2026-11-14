"""Regression coverage for pipeline.stretch.shared_normalization: a live
precache run against Barnard's Star hit a sparse observing epoch where
every pixel of every frame was NaN (masked out / no coverage), which
crashed np.concatenate on an empty list of arrays."""
from __future__ import annotations

import numpy as np

from app.pipeline.stretch import shared_normalization, to_uint8


def test_normal_frames_produce_sane_limits():
    frames = [np.full((5, 5), 1.0), np.full((5, 5), 2.0), np.full((5, 5), 3.0)]
    norm = shared_normalization(frames)
    assert norm.vmin < norm.vmax


def test_all_nan_single_frame_does_not_crash():
    frames = [np.full((5, 5), np.nan), np.full((5, 5), 1.0)]
    norm = shared_normalization(frames)
    assert norm.vmin < norm.vmax


def test_all_frames_entirely_nan_does_not_crash():
    frames = [np.full((5, 5), np.nan), np.full((5, 5), np.nan)]
    norm = shared_normalization(frames)
    assert norm.vmax > norm.vmin


def test_to_uint8_handles_all_nan_frame():
    frames = [np.full((5, 5), np.nan)]
    norm = shared_normalization(frames)
    out = to_uint8(frames[0], norm)
    assert out.shape == (5, 5)
    assert out.dtype == np.uint8
