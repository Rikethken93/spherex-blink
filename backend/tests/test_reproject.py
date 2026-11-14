"""Reprojection alignment tests using synthetic data (never real SPHEREx
data): a fake point source placed at a known sky position in exposures with
different native WCS orientations/offsets, verifying stack_epoch recovers it
at the expected pixel in the common output grid -- including a known,
deliberately injected proper-motion shift between two synthetic epochs."""
from __future__ import annotations

import numpy as np
import pytest
from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.wcs import WCS

from app.irsa_client import Exposure, ExposureMeta
from app.pipeline.reproject_stack import make_target_wcs, stack_epoch

RA0, DEC0 = 180.0, 10.0
FOV_ARCMIN = 3.0
PIXEL_SCALE_ARCSEC = 6.2
NPIX = 29  # matches make_target_wcs's own sizing for this fov/scale


def _synthetic_exposure(
    star_ra_deg: float,
    star_dec_deg: float,
    mjd: float,
    *,
    crval_offset_arcsec: tuple[float, float] = (0.0, 0.0),
    rotation_deg: float = 0.0,
    detector: int = 3,
) -> Exposure:
    """A fake single-detector cutout: flat background, one bright pixel at
    the given sky position, no flags, unit variance. The exposure's own WCS
    is deliberately offset/rotated from the eventual common target grid to
    exercise real reprojection, not just an identity copy."""
    npix = NPIX
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    cx = RA0 + crval_offset_arcsec[0] / 3600.0 / np.cos(np.radians(DEC0))
    cy = DEC0 + crval_offset_arcsec[1] / 3600.0
    wcs.wcs.crval = [cx, cy]
    wcs.wcs.crpix = [npix / 2.0 + 0.5, npix / 2.0 + 0.5]
    cdelt = PIXEL_SCALE_ARCSEC / 3600.0
    theta = np.radians(rotation_deg)
    wcs.wcs.cd = np.array(
        [
            [-cdelt * np.cos(theta), cdelt * np.sin(theta)],
            [-cdelt * np.sin(theta), -cdelt * np.cos(theta)],
        ]
    )

    image = np.random.default_rng(42).normal(0.0, 0.01, size=(npix, npix)).astype(np.float32)
    star_x, star_y = wcs.world_to_pixel(SkyCoord(star_ra_deg * u.deg, star_dec_deg * u.deg))
    xi, yi = round(float(star_x)), round(float(star_y))
    assert 0 <= xi < npix and 0 <= yi < npix, "synthetic star must land inside the fake frame"
    image[yi, xi] = 100.0  # bright point source, far above the noise floor

    flags = np.zeros((npix, npix), dtype=np.int32)
    variance = np.full((npix, npix), 1.0, dtype=np.float32)

    meta = ExposureMeta(
        access_url="synthetic://test",
        obs_id=f"synthetic-{mjd}",
        detector=detector,
        em_min_um=1.63,
        em_max_um=2.41,
        t_min_mjd=mjd,
        t_max_mjd=mjd,
        obs_collection="synthetic_test_data",
    )
    return Exposure(meta=meta, image=image, flags=flags, variance=variance, wcs=wcs, spectral_wcs=None, mjd=mjd)


def _peak_pixel(image: np.ndarray) -> tuple[int, int]:
    finite = np.nan_to_num(image, nan=-np.inf)
    yi, xi = np.unravel_index(np.argmax(finite), finite.shape)
    return int(xi), int(yi)


def test_single_offset_rotated_exposure_recovers_star_at_center():
    """A synthetic star placed at the target center, in an exposure whose
    own WCS is offset by 5 pixels and rotated 20 degrees, must still land
    at the common grid's center pixel after reprojection."""
    exposure = _synthetic_exposure(
        RA0, DEC0, mjd=60000.0,
        crval_offset_arcsec=(5 * PIXEL_SCALE_ARCSEC, -3 * PIXEL_SCALE_ARCSEC),
        rotation_deg=20.0,
    )
    stacked = stack_epoch([exposure], RA0, DEC0, FOV_ARCMIN)

    xi, yi = _peak_pixel(stacked.image)
    center = NPIX // 2
    assert abs(xi - center) <= 1
    assert abs(yi - center) <= 1


@pytest.mark.parametrize("shift_pixels", [3, -4])
def test_two_epoch_stack_recovers_known_proper_motion_shift(shift_pixels):
    """Inject a star that has moved by exactly `shift_pixels` SPHEREx
    pixels (6.2" each) between two synthetic epochs, stack each epoch
    independently, and verify the recovered peak-pixel shift between the
    two stacked frames matches -- this is the core "blink" premise."""
    shift_deg = shift_pixels * PIXEL_SCALE_ARCSEC / 3600.0

    exposure_epoch1 = _synthetic_exposure(RA0, DEC0, mjd=60000.0)
    exposure_epoch2 = _synthetic_exposure(RA0 + shift_deg / np.cos(np.radians(DEC0)), DEC0, mjd=60200.0)

    stacked1 = stack_epoch([exposure_epoch1], RA0, DEC0, FOV_ARCMIN)
    stacked2 = stack_epoch([exposure_epoch2], RA0, DEC0, FOV_ARCMIN)

    x1, y1 = _peak_pixel(stacked1.image)
    x2, y2 = _peak_pixel(stacked2.image)

    assert y1 == y2  # no Dec motion injected
    # RA increases to the east, but by the standard RA---TAN convention
    # (negative CDELT1) east is toward *decreasing* pixel x, so a positive
    # RA shift shows up as a negative x-pixel shift.
    assert (x2 - x1) == -shift_pixels


def test_target_wcs_pixel_scale_matches_config():
    wcs, shape = make_target_wcs(RA0, DEC0, FOV_ARCMIN, pixel_scale_arcsec=PIXEL_SCALE_ARCSEC)
    assert shape == (NPIX, NPIX)
    assert np.isclose(abs(wcs.wcs.cdelt[0]) * 3600.0, PIXEL_SCALE_ARCSEC)
