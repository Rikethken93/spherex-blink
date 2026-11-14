"""Orchestrates: SIA metadata query -> filter by detector/wavelength ->
fetch cutouts -> group into epochs -> reproject+stack -> render -> cache."""
from __future__ import annotations

import os

from . import cache, config
from .errors import InvalidRequestError, NoCoverageError
from .irsa_client import ExposureMeta, fetch_exposures, query_exposure_metadata
from .pipeline.epochs import epoch_summary, group_into_epochs
from .pipeline.lightcurve import build_light_curve
from .pipeline.render import (
    render_blink_frames,
    render_difference,
    render_rgb,
    render_sum,
)
from .pipeline.reproject_stack import stack_epoch
from .pipeline.spectrum import extract_spectrum

VALID_MODES = {"blink", "difference", "sum", "rgb"}


def validate_request(ra_deg: float, dec_deg: float, fov_arcmin: float, mode: str) -> None:
    if not (0.0 <= ra_deg < 360.0):
        raise InvalidRequestError("ra must be in [0, 360) degrees")
    if not (-90.0 <= dec_deg <= 90.0):
        raise InvalidRequestError("dec must be in [-90, 90] degrees")
    if not (config.FOV_MIN_ARCMIN <= fov_arcmin <= config.FOV_MAX_ARCMIN):
        raise InvalidRequestError(
            f"fov must be between {config.FOV_MIN_ARCMIN} and {config.FOV_MAX_ARCMIN} arcmin"
        )
    if mode not in VALID_MODES:
        raise InvalidRequestError(f"mode must be one of {sorted(VALID_MODES)}")


def _filter_metadata(
    metas: list[ExposureMeta], detector: int | None, wl_min: float | None, wl_max: float | None
) -> list[ExposureMeta]:
    out = metas
    if detector is not None:
        out = [m for m in out if m.detector == detector]
    if wl_min is not None:
        out = [m for m in out if m.em_max_um >= wl_min]
    if wl_max is not None:
        out = [m for m in out if m.em_min_um <= wl_max]
    return out


def get_frames(
    ra_deg: float,
    dec_deg: float,
    fov_arcmin: float,
    mode: str,
    detector: int | None = None,
    wl_min: float | None = None,
    wl_max: float | None = None,
) -> dict:
    validate_request(ra_deg, dec_deg, fov_arcmin, mode)

    cache_dir = cache.frames_cache_dir(
        ra_deg, dec_deg, fov_arcmin, mode, str(detector), str(wl_min), str(wl_max)
    )
    cached = cache.read_json(cache_dir)
    if cached is not None:
        cached["cache_hit"] = True
        return cached

    metas = query_exposure_metadata(ra_deg, dec_deg, fov_arcmin)
    metas = _filter_metadata(metas, detector, wl_min, wl_max)
    if not metas:
        raise NoCoverageError(
            "No SPHEREx coverage yet for this position/filter combination. "
            "SPHEREx is an ongoing all-sky survey -- try a wider field of view, "
            "a different wavelength range, or check back after the next data release."
        )

    exposures = fetch_exposures(metas, ra_deg, dec_deg, fov_arcmin)
    if not exposures:
        raise NoCoverageError(
            "SPHEREx metadata exists for this position but no cutout could be "
            "retrieved from IRSA right now. Please try again shortly."
        )

    epochs = group_into_epochs(exposures, lambda e: e.mjd)
    stacked_epochs = [stack_epoch(epoch, ra_deg, dec_deg, fov_arcmin) for epoch in epochs]

    epoch_meta = []
    for epoch, stacked in zip(epochs, stacked_epochs):
        summary = epoch_summary(epoch, lambda e: e.mjd)
        epoch_meta.append(
            {
                **summary,
                "flag_fraction": stacked.flag_fraction,
                "detectors": stacked.detectors,
                "wavelengths_um": stacked.wavelengths_um,
            }
        )

    frame_names: list[str] = []
    if mode == "blink":
        pngs = render_blink_frames([s.image for s in stacked_epochs])
        for i, png in enumerate(pngs):
            name = f"frame_{i}.png"
            cache.write_bytes(cache_dir, name, png)
            frame_names.append(name)
    elif mode == "sum":
        png = render_sum([s.image for s in stacked_epochs])
        cache.write_bytes(cache_dir, "frame_0.png", png)
        frame_names.append("frame_0.png")
    elif mode == "difference":
        if len(stacked_epochs) < 2:
            raise InvalidRequestError("difference mode needs at least 2 epochs")
        png = render_difference(stacked_epochs[0].image, stacked_epochs[-1].image)
        cache.write_bytes(cache_dir, "frame_0.png", png)
        frame_names.append("frame_0.png")
    elif mode == "rgb":
        bands = sorted({d for s in stacked_epochs for d in s.detectors})
        if len(bands) < 3:
            raise InvalidRequestError("rgb mode needs exposures from at least 3 detectors")
        lo, mid, hi = bands[0], bands[len(bands) // 2], bands[-1]

        def band_image(band):
            frames = [s.image for s in stacked_epochs if band in s.detectors]
            return frames[0] if frames else stacked_epochs[0].image

        png = render_rgb(band_image(hi), band_image(mid), band_image(lo))
        cache.write_bytes(cache_dir, "frame_0.png", png)
        frame_names.append("frame_0.png")

    result = {
        "ra_deg": ra_deg,
        "dec_deg": dec_deg,
        "fov_arcmin": fov_arcmin,
        "mode": mode,
        "detector": detector,
        "wl_min_um": wl_min,
        "wl_max_um": wl_max,
        "frames": frame_names,
        "cache_key_dir": os.path.relpath(cache_dir, config.CACHE_DIR),
        "epochs": epoch_meta,
        "n_exposures_total": len(exposures),
        "cache_hit": False,
    }
    cache.write_json(cache_dir, result)
    return result


def get_spectrum(ra_deg: float, dec_deg: float, fov_arcmin: float = config.FOV_DEFAULT_ARCMIN) -> list[dict]:
    metas = query_exposure_metadata(ra_deg, dec_deg, fov_arcmin)
    if not metas:
        raise NoCoverageError("No SPHEREx coverage yet at this position.")
    exposures = fetch_exposures(metas, ra_deg, dec_deg, fov_arcmin)
    points = extract_spectrum(exposures, ra_deg, dec_deg)
    return [p.__dict__ for p in points]


def get_lightcurve(ra_deg: float, dec_deg: float, fov_arcmin: float = config.FOV_DEFAULT_ARCMIN) -> list[dict]:
    metas = query_exposure_metadata(ra_deg, dec_deg, fov_arcmin)
    if not metas:
        raise NoCoverageError("No SPHEREx coverage yet at this position.")
    exposures = fetch_exposures(metas, ra_deg, dec_deg, fov_arcmin)
    epochs = group_into_epochs(exposures, lambda e: e.mjd)
    stacked_epochs = [stack_epoch(epoch, ra_deg, dec_deg, fov_arcmin) for epoch in epochs]
    points = build_light_curve(stacked_epochs, ra_deg, dec_deg, fov_arcmin)
    return [p.__dict__ for p in points]
