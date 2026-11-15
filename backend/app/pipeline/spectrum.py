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


# Candidate pixel offsets around the requested position, nearest first
# (centre, then the 4-neighbors, diagonals, and the radius-2 ring).
_NEIGHBOR_OFFSETS: list[tuple[int, int]] = sorted(
    ((dx, dy) for dx in range(-2, 3) for dy in range(-2, 3)),
    key=lambda o: o[0] * o[0] + o[1] * o[1],
)


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
        # The exact pixel can be unusable in *every* exposure -- a bright
        # star's saturated core (OVERFLOW/BLOOM flags, e.g. Proxima
        # Centauri) -- which previously produced a 0-point spectrum for
        # the very targets the demo centres on. Fall back to the nearest
        # usable pixel within a small radius: a PSF-wing spectrum is
        # biased in absolute flux but preserves the spectral shape, and
        # is honest about the alternative (no spectrum at all).
        found = None
        for dx, dy in _NEIGHBOR_OFFSETS:
            xj, yj = xi + dx, yi + dy
            if not (0 <= xj < w and 0 <= yj < h):
                continue
            if exposure.flags[yj, xj] & config.FLAG_BAD_BITMASK:
                continue
            f = float(exposure.image[yj, xj])
            v = float(exposure.variance[yj, xj])
            if np.isfinite(f) and np.isfinite(v) and v >= 0:
                found = (xj, yj, f, v)
                break
        if found is None:
            continue
        xi, yi, flux, var = found
        x, y = float(xi), float(yi)
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
