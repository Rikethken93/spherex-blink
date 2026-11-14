"""Reproject exposures onto one common grid centred on the target, mask
flagged pixels, and combine with a variance-weighted mean.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from astropy.wcs import WCS
from reproject import reproject_interp

from .. import config
from ..irsa_client import Exposure


def make_target_wcs(
    ra_deg: float, dec_deg: float, fov_arcmin: float, pixel_scale_arcsec: float = config.PIXEL_SCALE_ARCSEC
) -> tuple[WCS, tuple[int, int]]:
    npix = max(8, round((fov_arcmin * 60.0) / pixel_scale_arcsec))
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = [ra_deg, dec_deg]
    wcs.wcs.crpix = [npix / 2.0 + 0.5, npix / 2.0 + 0.5]
    wcs.wcs.cdelt = [-pixel_scale_arcsec / 3600.0, pixel_scale_arcsec / 3600.0]
    wcs.wcs.cunit = ["deg", "deg"]
    return wcs, (npix, npix)


@dataclass
class StackedFrame:
    image: np.ndarray  # NaN where no valid data
    variance: np.ndarray
    flag_fraction: float
    n_exposures: int
    detectors: list[int]
    wavelengths_um: list[float]
    mjd_mean: float
    mjd_min: float
    mjd_max: float


def _reproject_one(exposure: Exposure, target_wcs: WCS, shape: tuple[int, int]):
    masked_image = np.where(exposure.flags != 0, np.nan, exposure.image) if config.FLAG_MASK_NONZERO else exposure.image
    masked_variance = np.where(exposure.flags != 0, np.nan, exposure.variance) if config.FLAG_MASK_NONZERO else exposure.variance

    img_rep, footprint = reproject_interp(
        (masked_image, exposure.wcs), target_wcs, shape_out=shape, order="bilinear"
    )
    var_rep, _ = reproject_interp(
        (masked_variance, exposure.wcs), target_wcs, shape_out=shape, order="bilinear"
    )
    valid = footprint > 0.5
    flagged_fraction = float(np.mean(exposure.flags != 0)) if exposure.flags.size else 0.0
    return img_rep, var_rep, valid, flagged_fraction


def stack_epoch(
    exposures: list[Exposure], ra_deg: float, dec_deg: float, fov_arcmin: float
) -> StackedFrame:
    target_wcs, shape = make_target_wcs(ra_deg, dec_deg, fov_arcmin)

    weighted_sum = np.zeros(shape, dtype=np.float64)
    weight_sum = np.zeros(shape, dtype=np.float64)
    any_valid = np.zeros(shape, dtype=bool)
    flagged_fractions: list[float] = []

    for exposure in exposures:
        img_rep, var_rep, valid, flagged_fraction = _reproject_one(exposure, target_wcs, shape)
        flagged_fractions.append(flagged_fraction)

        usable = valid & np.isfinite(img_rep) & np.isfinite(var_rep) & (var_rep > 0)
        weight = np.where(usable, 1.0 / np.where(var_rep > 0, var_rep, np.inf), 0.0)
        weighted_sum += np.where(usable, img_rep * weight, 0.0)
        weight_sum += weight
        any_valid |= usable

    with np.errstate(invalid="ignore", divide="ignore"):
        combined = np.where(weight_sum > 0, weighted_sum / weight_sum, np.nan)
        combined_variance = np.where(weight_sum > 0, 1.0 / weight_sum, np.nan)

    mjds = [e.mjd for e in exposures]
    return StackedFrame(
        image=combined,
        variance=combined_variance,
        flag_fraction=float(np.mean(flagged_fractions)) if flagged_fractions else 0.0,
        n_exposures=len(exposures),
        detectors=sorted({e.detector for e in exposures}),
        wavelengths_um=sorted({round(e.nominal_wavelength_um, 3) for e in exposures}),
        mjd_mean=float(np.mean(mjds)) if mjds else 0.0,
        mjd_min=float(np.min(mjds)) if mjds else 0.0,
        mjd_max=float(np.max(mjds)) if mjds else 0.0,
    )
