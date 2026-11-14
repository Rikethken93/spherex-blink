"""Regression coverage for FLAGS bit masking (config.FLAG_BAD_BITMASK).

A live render came out solid black because the original implementation
treated any nonzero FLAGS value as "bad". The SPHEREx Explanatory
Supplement's Table 16 says bit 21 (SOURCE, "pixel mapped to a known
source") is informational, not a defect -- every other documented bit
means exclude the pixel.
"""
from __future__ import annotations

import numpy as np

from app import config


def test_source_only_flag_is_not_masked():
    flags = np.array([[1 << 21]], dtype=np.int32)  # SOURCE only
    assert (flags & config.FLAG_BAD_BITMASK)[0, 0] == 0


def test_hot_pixel_flag_is_masked():
    flags = np.array([[1 << 10]], dtype=np.int32)  # HOT
    assert (flags & config.FLAG_BAD_BITMASK)[0, 0] != 0


def test_source_combined_with_a_defect_is_still_masked():
    flags = np.array([[(1 << 21) | (1 << 0)]], dtype=np.int32)  # SOURCE + TRANSIENT
    assert (flags & config.FLAG_BAD_BITMASK)[0, 0] != 0


def test_bitmask_is_within_signed_int32_range():
    # The FLAGS extension is a signed int32 array; a mask outside that
    # range overflows the bitwise AND instead of raising a clear error.
    assert 0 <= config.FLAG_BAD_BITMASK <= 2**31 - 1
