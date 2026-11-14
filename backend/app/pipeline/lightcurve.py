"""Brightness inside a small aperture at the target position, one point per
observing epoch -- for monitoring variables like RW Aurigae and R Draconis."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .reproject_stack import StackedFrame, make_target_wcs


@dataclass
class LightCurvePoint:
    mjd: float
    mjd_min: float
    mjd_max: float
    flux: float
    error: float
    n_exposures: int
    flag_fraction: float


def aperture_photometry(
    stacked: StackedFrame, ra_deg: float, dec_deg: float, fov_arcmin: float, aperture_radius_px: float = 2.0
) -> tuple[float, float]:
    _target_wcs, shape = make_target_wcs(ra_deg, dec_deg, fov_arcmin)
    ny, nx = shape
    yy, xx = np.mgrid[0:ny, 0:nx]
    cx, cy = (nx - 1) / 2.0, (ny - 1) / 2.0
    mask = (xx - cx) ** 2 + (yy - cy) ** 2 <= aperture_radius_px**2

    pix = stacked.image[mask]
    var = stacked.variance[mask]
    valid = np.isfinite(pix) & np.isfinite(var) & (var >= 0)
    if not np.any(valid):
        return float("nan"), float("nan")

    weights = np.where(var[valid] > 0, 1.0 / var[valid], 0.0)
    if np.sum(weights) == 0:
        flux = float(np.mean(pix[valid]))
        error = float(np.std(pix[valid])) if np.sum(valid) > 1 else float("nan")
    else:
        flux = float(np.sum(pix[valid] * weights) / np.sum(weights))
        error = float(np.sqrt(1.0 / np.sum(weights)))
    return flux, error


def build_light_curve(
    stacked_epochs: list[StackedFrame], ra_deg: float, dec_deg: float, fov_arcmin: float
) -> list[LightCurvePoint]:
    points: list[LightCurvePoint] = []
    for stacked in stacked_epochs:
        flux, error = aperture_photometry(stacked, ra_deg, dec_deg, fov_arcmin)
        points.append(
            LightCurvePoint(
                mjd=stacked.mjd_mean,
                mjd_min=stacked.mjd_min,
                mjd_max=stacked.mjd_max,
                flux=flux,
                error=error,
                n_exposures=stacked.n_exposures,
                flag_fraction=stacked.flag_fraction,
            )
        )
    points.sort(key=lambda p: p.mjd)
    return points
