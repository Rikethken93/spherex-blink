"""Thin wrapper around IRSA's SIA2 service and cutout endpoint for SPHEREx.

Confirmed live against the real archive (see config.py docstring and
DECISIONS.md): `Irsa.query_sia` with our collection list returns metadata
rows including `access_url`, `energy_bandpassname` ("SPHEREx-D<n>"),
`t_min`/`t_max` (MJD), `em_min`/`em_max` (meters). Appending
`?center=<ra>,<dec>d&size=<deg>` to `access_url` returns a cropped 7-HDU FITS
(PRIMARY, IMAGE, FLAGS, VARIANCE, ZODI, EPSF, WCS-WAVE) -- a real server-side
cutout, never the full exposure.
"""
from __future__ import annotations

import io
import logging
import re
from dataclasses import dataclass

import numpy as np
import requests
from astropy.io import fits
from astropy.wcs import WCS

from . import config
from .net import UpstreamUnavailable, with_backoff

logger = logging.getLogger("spherex_blink.irsa")

_DETECTOR_RE = re.compile(r"SPHEREx-D(\d)", re.IGNORECASE)

M_TO_UM = 1.0e6


@dataclass
class ExposureMeta:
    access_url: str
    obs_id: str
    detector: int
    em_min_um: float
    em_max_um: float
    t_min_mjd: float
    t_max_mjd: float
    obs_collection: str


@dataclass
class Exposure:
    meta: ExposureMeta
    image: np.ndarray
    flags: np.ndarray
    variance: np.ndarray
    wcs: WCS
    spectral_wcs: WCS | None
    mjd: float

    @property
    def detector(self) -> int:
        return self.meta.detector

    @property
    def nominal_wavelength_um(self) -> float:
        return (self.meta.em_min_um + self.meta.em_max_um) / 2.0

    def wavelength_at(self, x: float, y: float) -> float | None:
        if self.spectral_wcs is None:
            return self.nominal_wavelength_um
        try:
            world = self.spectral_wcs.pixel_to_world(x, y)
            wl = world[0] if isinstance(world, (list, tuple)) else world
            return float(wl.to("um").value)
        except Exception:  # noqa: BLE001
            return self.nominal_wavelength_um


def _parse_detector(bandpass_name: str) -> int:
    m = _DETECTOR_RE.search(bandpass_name or "")
    return int(m.group(1)) if m else 0


def query_exposure_metadata(
    ra_deg: float, dec_deg: float, fov_arcmin: float
) -> list[ExposureMeta]:
    """Query IRSA SIA2 for every SPHEREx exposure covering this position.
    No pixel data is downloaded here -- that happens lazily per exposure."""
    from astropy import units as u
    from astropy.coordinates import SkyCoord
    from astroquery.ipac.irsa import Irsa

    coord = SkyCoord(ra=ra_deg * u.deg, dec=dec_deg * u.deg)
    radius = (fov_arcmin / 2.0) * u.arcmin

    def _call():
        return Irsa.query_sia(pos=(coord, radius), collection=config.SIA_COLLECTIONS)

    table = with_backoff(_call, what="IRSA SIA2 query_sia")

    rows: list[ExposureMeta] = []
    for row in table:
        try:
            rows.append(
                ExposureMeta(
                    access_url=str(row["access_url"]),
                    obs_id=str(row["obs_id"]),
                    detector=_parse_detector(str(row["energy_bandpassname"])),
                    em_min_um=float(row["em_min"]) * M_TO_UM,
                    em_max_um=float(row["em_max"]) * M_TO_UM,
                    t_min_mjd=float(row["t_min"]),
                    t_max_mjd=float(row["t_max"]),
                    obs_collection=str(row["obs_collection"]),
                )
            )
        except (TypeError, ValueError, KeyError) as exc:
            logger.warning("Skipping malformed SIA row: %s", exc)
    return rows


def fetch_cutout(meta: ExposureMeta, ra_deg: float, dec_deg: float, fov_arcmin: float) -> Exposure:
    """Download the server-side cutout FITS for one exposure and parse its
    IMAGE/FLAGS/VARIANCE extensions, spatial WCS and spectral ("W") WCS."""
    size_deg = fov_arcmin / 60.0
    url = config.CUTOUT_URL_TEMPLATE.format(
        access_url=meta.access_url, ra_deg=ra_deg, dec_deg=dec_deg, size_deg=size_deg
    )

    def _call() -> bytes:
        resp = requests.get(url, timeout=config.HTTP_TIMEOUT_SECONDS)
        resp.raise_for_status()
        return resp.content

    content = with_backoff(_call, what=f"cutout fetch {meta.obs_id}")

    with fits.open(io.BytesIO(content)) as hdul:
        image_hdu = hdul[config.FITS_EXTENSIONS["image"]]
        flags_hdu = hdul[config.FITS_EXTENSIONS["flags"]]
        variance_hdu = hdul[config.FITS_EXTENSIONS["variance"]]

        image = np.array(image_hdu.data, dtype=np.float32)
        flags = np.array(flags_hdu.data, dtype=np.int32)
        variance = np.array(variance_hdu.data, dtype=np.float32)
        header = image_hdu.header
        mjd = float(header.get("MJD-OBS", meta.t_min_mjd))

        wcs = WCS(header)
        spectral_wcs = None
        try:
            spectral_wcs = WCS(header, fobj=hdul, key="W")
            spectral_wcs.sip = None
        except Exception as exc:  # noqa: BLE001
            logger.warning("No usable spectral WCS for %s: %s", meta.obs_id, exc)

    return Exposure(
        meta=meta,
        image=image,
        flags=flags,
        variance=variance,
        wcs=wcs,
        spectral_wcs=spectral_wcs,
        mjd=mjd,
    )


def fetch_exposures(
    metas: list[ExposureMeta], ra_deg: float, dec_deg: float, fov_arcmin: float
) -> list[Exposure]:
    exposures: list[Exposure] = []
    for meta in metas:
        try:
            exposures.append(fetch_cutout(meta, ra_deg, dec_deg, fov_arcmin))
        except UpstreamUnavailable as exc:
            logger.warning("Dropping exposure %s: %s", meta.obs_id, exc)
    return exposures
