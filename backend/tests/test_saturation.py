"""Saturated-core classification and rendering (all synthetic data): a
bright-star core whose pixels carry OVERFLOW/BLOOM flags in every exposure
must come out of stack_epoch classified `saturated` (not silently NaN ->
rendered black), and render_blink_frames must paint it white with a red
outline and other fully-masked pixels dark grey."""
from __future__ import annotations

import io

import numpy as np
from astropy.wcs import WCS
from PIL import Image

from app import config
from app.irsa_client import Exposure, ExposureMeta
from app.pipeline.render import MASKED_GREY, SATURATED_OUTLINE, render_blink_frames
from app.pipeline.reproject_stack import stack_epoch

RA0, DEC0 = 180.0, 10.0
NPIX = 29


def _exposure(flags_center: int, flags_corner: int = 0) -> Exposure:
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = [RA0, DEC0]
    wcs.wcs.crpix = [NPIX / 2.0 + 0.5, NPIX / 2.0 + 0.5]
    cdelt = 6.2 / 3600.0
    wcs.wcs.cdelt = [-cdelt, cdelt]

    image = np.full((NPIX, NPIX), 1.0, dtype=np.float32)
    flags = np.zeros((NPIX, NPIX), dtype=np.int32)
    flags[13:16, 13:16] = flags_center  # 3x3 "core" at the centre
    flags[2:5, 2:5] = flags_corner
    variance = np.full((NPIX, NPIX), 1.0, dtype=np.float32)
    meta = ExposureMeta(
        access_url="synthetic://sat", obs_id="sat", detector=3,
        em_min_um=1.63, em_max_um=2.41, t_min_mjd=60000.0, t_max_mjd=60000.0,
        obs_collection="synthetic_test_data",
    )
    return Exposure(meta=meta, image=image, flags=flags, variance=variance,
                    wcs=wcs, spectral_wcs=None, mjd=60000.0)


OVERFLOW = 1 << 1
HOT = 1 << 10  # a non-saturation bad bit


def test_saturated_core_is_classified_and_other_masked_pixels_are_not():
    exposures = [_exposure(OVERFLOW, flags_corner=HOT) for _ in range(3)]
    stacked = stack_epoch(exposures, RA0, DEC0, 3.0)
    assert stacked.saturated[14, 14], "core must be classified saturated"
    assert not stacked.masked[14, 14]
    assert stacked.masked[3, 3], "hot-pixel region is masked, not saturated"
    assert not stacked.saturated[3, 3]
    assert np.isnan(stacked.image[14, 14])
    # bits used in this test really are in the app's masks
    assert OVERFLOW & config.FLAG_SATURATION_BITMASK
    assert HOT & config.FLAG_BAD_BITMASK and not (HOT & config.FLAG_SATURATION_BITMASK)


def test_render_paints_saturated_white_red_outline_and_masked_grey():
    exposures = [_exposure(OVERFLOW, flags_corner=HOT)]
    stacked = stack_epoch(exposures, RA0, DEC0, 3.0)
    pngs = render_blink_frames([stacked.image], [stacked.saturated], [stacked.masked])
    arr = np.array(Image.open(io.BytesIO(pngs[0])).convert("RGB"))
    red = (arr == np.array(SATURATED_OUTLINE)).all(axis=2).sum()
    grey = (arr == np.array(MASKED_GREY)).all(axis=2).sum()
    white = (arr == 255).all(axis=2).sum()
    assert red > 0, "saturated core must have a red outline"
    assert white > 0, "saturated core interior must be white"
    assert grey > 0, "masked pixels must be dark grey"
