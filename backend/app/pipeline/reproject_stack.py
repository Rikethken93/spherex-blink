"""Reproject exposures onto one common grid centred on the target, mask
flagged pixels, and combine with a variance-weighted mean.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from astropy.wcs import WCS
from reproject import reproject_adaptive, reproject_interp

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
    # Pixels covered by at least one exposure but with zero usable
    # (unflagged) samples, split by why: `saturated` = the flagged samples
    # were predominantly OVERFLOW/NONLINEAR/BLOOM (a blown-out bright-star
    # core -- rendered white with a red outline, see render.py);
    # `masked` = any other reason (rendered dark grey, not fake-black sky).
    saturated: np.ndarray
    masked: np.ndarray
    flag_fraction: float
    n_exposures: int
    detectors: list[int]
    wavelengths_um: list[float]
    mjd_mean: float
    mjd_min: float
    mjd_max: float


def _reproject_one(exposure: Exposure, target_wcs: WCS, shape: tuple[int, int]):
    bad = (exposure.flags & config.FLAG_BAD_BITMASK) != 0
    sat = (exposure.flags & config.FLAG_SATURATION_BITMASK) != 0
    masked_image = np.where(bad, np.nan, exposure.image)
    masked_variance = np.where(bad, np.nan, exposure.variance)

    # reproject_adaptive (DeForest anti-aliased resampling), not plain
    # bilinear interpolation: the output grid is at SPHEREx's native
    # ~6.2"/px scale (make_target_wcs), and each input exposure's grid is
    # rotated/dithered relative to it, so bilinear sampling both softens
    # the PSF and aliases it slightly differently per exposure -- which a
    # variance-weighted stack then smears. Adaptive resampling keeps the
    # per-exposure contribution consistent. conserve_flux=False because
    # these are surface-brightness (MJy/sr) images.
    img_rep, footprint = reproject_adaptive(
        (masked_image, exposure.wcs), target_wcs, shape_out=shape, conserve_flux=False
    )
    var_rep, _ = reproject_adaptive(
        (masked_variance, exposure.wcs), target_wcs, shape_out=shape, conserve_flux=False
    )
    # The boolean saturation mask must not be smoothed -- nearest-neighbor.
    # Its footprint also serves as the *geometric* coverage of this
    # exposure: reproject_adaptive's own footprint goes to zero wherever
    # the (NaN-masked) input had no usable value, which is exactly the
    # saturated-core region we need to classify -- so it can't be used to
    # answer "did this exposure's detector cover this sky pixel at all?".
    sat_rep, cover_fp = reproject_interp(
        (sat.astype(np.float32), exposure.wcs), target_wcs, shape_out=shape, order="nearest-neighbor"
    )
    valid = footprint > 0.5
    covered = cover_fp > 0.5
    flagged_fraction = float(np.mean(bad)) if exposure.flags.size else 0.0
    return img_rep, var_rep, valid, covered, sat_rep > 0.5, flagged_fraction


def stack_epoch(
    exposures: list[Exposure], ra_deg: float, dec_deg: float, fov_arcmin: float
) -> StackedFrame:
    target_wcs, shape = make_target_wcs(ra_deg, dec_deg, fov_arcmin)

    weighted_sum = np.zeros(shape, dtype=np.float64)
    weight_sum = np.zeros(shape, dtype=np.float64)
    covered_count = np.zeros(shape, dtype=np.int32)
    saturated_count = np.zeros(shape, dtype=np.int32)
    flagged_fractions: list[float] = []

    for exposure in exposures:
        img_rep, var_rep, valid, covered, sat, flagged_fraction = _reproject_one(exposure, target_wcs, shape)
        flagged_fractions.append(flagged_fraction)

        usable = valid & np.isfinite(img_rep) & np.isfinite(var_rep) & (var_rep > 0)
        weight = np.where(usable, 1.0 / np.where(var_rep > 0, var_rep, np.inf), 0.0)
        weighted_sum += np.where(usable, img_rep * weight, 0.0)
        weight_sum += weight
        covered_count += covered.astype(np.int32)
        saturated_count += (covered & sat).astype(np.int32)

    with np.errstate(invalid="ignore", divide="ignore"):
        combined = np.where(weight_sum > 0, weighted_sum / weight_sum, np.nan)
        combined_variance = np.where(weight_sum > 0, 1.0 / weight_sum, np.nan)

    # Pixels with coverage but no usable sample: classify as a saturated
    # core if at least 30% of the covering exposures flagged them as
    # saturated (a real blown core is flagged in essentially every
    # exposure; a stray cosmic-ray/outlier mask is not).
    empty = (weight_sum == 0) & (covered_count > 0)
    with np.errstate(invalid="ignore", divide="ignore"):
        sat_frac = np.where(covered_count > 0, saturated_count / np.maximum(covered_count, 1), 0.0)
    saturated = empty & (sat_frac >= 0.3)
    masked = empty & ~saturated

    mjds = [e.mjd for e in exposures]
    return StackedFrame(
        image=combined,
        variance=combined_variance,
        saturated=saturated,
        masked=masked,
        flag_fraction=float(np.mean(flagged_fractions)) if flagged_fractions else 0.0,
        n_exposures=len(exposures),
        detectors=sorted({e.detector for e in exposures}),
        wavelengths_um=sorted({round(e.nominal_wavelength_um, 3) for e in exposures}),
        mjd_mean=float(np.mean(mjds)) if mjds else 0.0,
        mjd_min=float(np.min(mjds)) if mjds else 0.0,
        mjd_max=float(np.max(mjds)) if mjds else 0.0,
    )
