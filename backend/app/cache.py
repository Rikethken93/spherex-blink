"""Disk cache for rendered frames/spectra/light curves, keyed by
(ra, dec, fov, mode, detector, wl_min, wl_max, data release).

`scripts/precache.py` populates this ahead of time for the demo targets and
the result is committed to the repo, so the live demo works even if IRSA is
slow, rate-limited, or unreachable. `/api/*` endpoints read through this
cache first and only fall back to a live IRSA query on a miss.
"""
from __future__ import annotations

import hashlib
import json
import os

from . import config


def _key(kind: str, **params) -> str:
    payload = json.dumps({"kind": kind, "release": config.DATA_RELEASE_TAG, **params}, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()[:24]


def _entry_dir(kind: str, **params) -> str:
    path = os.path.join(config.CACHE_DIR, kind, _key(kind, **params))
    os.makedirs(path, exist_ok=True)
    return path


def frames_cache_dir(ra_deg: float, dec_deg: float, fov_arcmin: float, mode: str, detector: str, wl_min: str, wl_max: str) -> str:
    return _entry_dir(
        "frames",
        ra=round(ra_deg, 5), dec=round(dec_deg, 5), fov=round(fov_arcmin, 2),
        mode=mode, detector=detector, wl_min=wl_min, wl_max=wl_max,
    )


def spectrum_cache_dir(ra_deg: float, dec_deg: float, fov_arcmin: float) -> str:
    return _entry_dir("spectrum", ra=round(ra_deg, 5), dec=round(dec_deg, 5), fov=round(fov_arcmin, 2))


def lightcurve_cache_dir(ra_deg: float, dec_deg: float, fov_arcmin: float) -> str:
    return _entry_dir("lightcurve", ra=round(ra_deg, 5), dec=round(dec_deg, 5), fov=round(fov_arcmin, 2))


def read_json(directory: str, name: str = "meta.json"):
    path = os.path.join(directory, name)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def write_json(directory: str, data, name: str = "meta.json") -> None:
    path = os.path.join(directory, name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)


def write_bytes(directory: str, name: str, content: bytes) -> str:
    path = os.path.join(directory, name)
    with open(path, "wb") as fh:
        fh.write(content)
    return path


def read_bytes(directory: str, name: str) -> bytes | None:
    path = os.path.join(directory, name)
    if not os.path.exists(path):
        return None
    with open(path, "rb") as fh:
        return fh.read()
