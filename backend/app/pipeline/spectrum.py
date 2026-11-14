"""For a clicked sky position: pull the pixel value from every exposure that
covers it, paired with that pixel's wavelength (per-pixel, since SPHEREx's
linear variable filters mean wavelength varies across the detector)."""
from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np

from .. import config
from ..irsa_client import Exposure

logger = logging.getLogger("spherex_blink.spectrum")


@dataclass
class SpectrumPoint:
    wavelength_um: float
    flux: float
    error: float
    detector: int
    mjd: float


def extract_spectrum(exposures: list[Exposure], ra_deg: float, dec_deg: float) -> list[SpectrumPoint]:
    from astropy import units as u
    from astropy.coordinates import SkyCoord

    coord = SkyCoord(ra=ra_deg * u.deg, dec=dec_deg * u.deg)
    points: list[SpectrumPoint] = []

    for exposure in exposures:
        try:
            x, y = exposure.wcs.world_to_pixel(coord)
        except Exception as exc:  # noqa: BLE001
            logger.debug("Skipping exposure %s: %s", exposure.meta.obs_id, exc)
            continue
        xi, yi = round(float(x)), round(float(y))
        h, w = exposure.image.shape
        if not (0 <= xi < w and 0 <= yi < h):
            continue
        if exposure.flags[yi, xi] & config.FLAG_BAD_BITMASK:
            continue
        flux = float(exposure.image[yi, xi])
        var = float(exposure.variance[yi, xi])
        if not np.isfinite(flux) or not np.isfinite(var) or var < 0:
            continue
        wl = exposure.wavelength_at(x, y)
        if wl is None:
            continue
        points.append(
            SpectrumPoint(
                wavelength_um=wl,
                flux=flux,
                error=float(np.sqrt(var)),
                detector=exposure.detector,
                mjd=exposure.mjd,
            )
        )

    points.sort(key=lambda p: p.wavelength_um)
    return points
