"""A fully saturated target core must yield an honest null light curve --
flux None in valid JSON -- never a crash and never invented photometry.
Also covers the clicked-position aperture: photometry at an offset pixel
of the same stacked field measures that pixel, not the frame centre."""
from __future__ import annotations

import json

import numpy as np

from app.pipeline.lightcurve import aperture_photometry, build_light_curve
from app.pipeline.reproject_stack import StackedFrame, make_target_wcs
from app.service import _json_safe_point

RA0, DEC0 = 180.0, 10.0
FOV = 3.0


def _frame(fill: float, saturated_core: bool) -> StackedFrame:
    _wcs, shape = make_target_wcs(RA0, DEC0, FOV)
    image = np.full(shape, fill)
    variance = np.full(shape, 1.0)
    saturated = np.zeros(shape, dtype=bool)
    if saturated_core:
        ny, nx = shape
        cy, cx = ny // 2, nx // 2
        image[cy - 3 : cy + 4, cx - 3 : cx + 4] = np.nan
        variance[cy - 3 : cy + 4, cx - 3 : cx + 4] = np.nan
        saturated[cy - 3 : cy + 4, cx - 3 : cx + 4] = True
    return StackedFrame(
        image=image, variance=variance, saturated=saturated,
        masked=np.zeros(shape, dtype=bool), flag_fraction=0.1, n_exposures=5,
        detectors=[3], wavelengths_um=[2.0], mjd_mean=60000.0,
        mjd_min=59999.0, mjd_max=60001.0,
    )


def test_saturated_core_returns_null_flux_in_valid_json():
    frames = [_frame(1.0, saturated_core=True), _frame(2.0, saturated_core=True)]
    points = [_json_safe_point(p.__dict__) for p in build_light_curve(frames, RA0, DEC0, FOV)]
    assert len(points) == 2
    for p in points:
        assert p["flux"] is None
        assert p["error"] is None
    # json.dumps must not emit a bare NaN token (invalid JSON)
    text = json.dumps(points)
    assert "NaN" not in text
    assert json.loads(text)[0]["flux"] is None


def test_offset_aperture_measures_the_clicked_pixel_not_the_centre():
    frame = _frame(1.0, saturated_core=True)
    # off-centre pixel carries a distinct value
    frame.image[5, 5] = 42.0
    flux_centre, _ = aperture_photometry(frame, RA0, DEC0, FOV)
    assert np.isnan(flux_centre), "saturated centre must be NaN"
    flux_off, err_off = aperture_photometry(frame, RA0, DEC0, FOV, center_px=(5.0, 5.0))
    assert np.isfinite(flux_off) and np.isfinite(err_off)
    assert flux_off > 1.0  # pulled up by the bright clicked pixel


def test_aperture_outside_the_frame_returns_nan_not_crash():
    frame = _frame(1.0, saturated_core=False)
    flux, error = aperture_photometry(frame, RA0, DEC0, FOV, center_px=(-50.0, -50.0))
    assert np.isnan(flux) and np.isnan(error)
