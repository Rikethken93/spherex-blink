"""Orchestrates: SIA metadata query -> filter by detector/wavelength ->
fetch cutouts -> group into epochs -> reproject+stack -> render -> cache."""
from __future__ import annotations

import math
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


def _json_safe_point(point: dict) -> dict:
    """A sparse aperture (few/no valid pixels in that epoch) makes
    aperture_photometry return NaN for flux/error. Python's json.dumps
    happily writes a literal `NaN` token by default, which is not valid
    JSON per the ECMA-404 grammar -- JavaScript's native JSON.parse throws
    a SyntaxError on it, breaking the light-curve chart outright for that
    response. Replace non-finite floats with None (-> JSON null) instead."""
    return {k: (None if isinstance(v, float) and not math.isfinite(v) else v) for k, v in point.items()}


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


def _fetch_and_stack(
    ra_deg: float,
    dec_deg: float,
    fov_arcmin: float,
    detector: int | None = None,
    wl_min: float | None = None,
    wl_max: float | None = None,
):
    """Query + fetch + epoch-group + reproject-stack once. Shared by
    get_frames/get_spectrum/get_lightcurve (each still caches its own
    final product independently, for the live API) and by
    scripts/precache.py (which calls this directly to fetch a target's
    exposures exactly once and derive all three cached products from it,
    rather than paying for three independent full fetches per target)."""
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
    return exposures, epochs, stacked_epochs


def _epoch_metadata(epochs, stacked_epochs) -> list[dict]:
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
    return epoch_meta


def _render_mode(
    mode: str,
    stacked_epochs,
    cache_dir: str,
    exposures=None,
    ra_deg: float | None = None,
    dec_deg: float | None = None,
    fov_arcmin: float | None = None,
) -> list[str]:
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
        # Each stacked epoch's .image already blends every detector
        # present in that epoch into one combined frame (stack_epoch has
        # no notion of "band"), so picking an "epoch that happens to
        # contain band X" and reusing its .image would just return the
        # same all-bands-blended image for every channel -- not a real
        # 3-wavelength-range composite. RGB needs its own three
        # single-band deep stacks, built directly from the raw exposures.
        if exposures is None or ra_deg is None or dec_deg is None or fov_arcmin is None:
            raise InvalidRequestError("rgb mode requires the raw exposures")
        bands = sorted({e.detector for e in exposures})
        if len(bands) < 3:
            raise InvalidRequestError("rgb mode needs exposures from at least 3 detectors")
        lo, mid, hi = bands[0], bands[len(bands) // 2], bands[-1]

        def band_stack(band: int):
            band_exposures = [e for e in exposures if e.detector == band]
            return stack_epoch(band_exposures, ra_deg, dec_deg, fov_arcmin).image

        png = render_rgb(band_stack(hi), band_stack(mid), band_stack(lo))
        cache.write_bytes(cache_dir, "frame_0.png", png)
        frame_names.append("frame_0.png")
    return frame_names


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

    exposures, epochs, stacked_epochs = _fetch_and_stack(ra_deg, dec_deg, fov_arcmin, detector, wl_min, wl_max)
    epoch_meta = _epoch_metadata(epochs, stacked_epochs)
    frame_names = _render_mode(mode, stacked_epochs, cache_dir, exposures, ra_deg, dec_deg, fov_arcmin)

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
    cache_dir = cache.spectrum_cache_dir(ra_deg, dec_deg, fov_arcmin)
    cached = cache.read_json(cache_dir)
    if cached is not None:
        return cached

    exposures, _epochs, _stacked = _fetch_and_stack(ra_deg, dec_deg, fov_arcmin)
    points = [p.__dict__ for p in extract_spectrum(exposures, ra_deg, dec_deg)]
    cache.write_json(cache_dir, points)
    return points


def get_lightcurve(ra_deg: float, dec_deg: float, fov_arcmin: float = config.FOV_DEFAULT_ARCMIN) -> list[dict]:
    cache_dir = cache.lightcurve_cache_dir(ra_deg, dec_deg, fov_arcmin)
    cached = cache.read_json(cache_dir)
    if cached is not None:
        return cached

    _exposures, _epochs, stacked_epochs = _fetch_and_stack(ra_deg, dec_deg, fov_arcmin)
    points = [_json_safe_point(p.__dict__) for p in build_light_curve(stacked_epochs, ra_deg, dec_deg, fov_arcmin)]
    cache.write_json(cache_dir, points)
    return points


def precache_all(ra_deg: float, dec_deg: float, fov_arcmin: float, modes: list[str]) -> dict:
    """Used only by scripts/precache.py: fetch a target's exposures exactly
    once and populate the frames (every requested mode), spectrum, and
    light-curve caches from that single fetch -- each of get_frames,
    get_spectrum and get_lightcurve independently re-fetches on a cold
    cache (correct for an arbitrary live query), which would cost three
    full IRSA fetches per target here for no benefit, since all three are
    about to be cached for the exact same position anyway."""
    exposures, epochs, stacked_epochs = _fetch_and_stack(ra_deg, dec_deg, fov_arcmin)
    epoch_meta = _epoch_metadata(epochs, stacked_epochs)

    results: dict[str, object] = {"n_exposures_total": len(exposures), "n_epochs": len(epochs)}

    for mode in modes:
        cache_dir = cache.frames_cache_dir(ra_deg, dec_deg, fov_arcmin, mode, "None", "None", "None")
        try:
            frame_names = _render_mode(mode, stacked_epochs, cache_dir, exposures, ra_deg, dec_deg, fov_arcmin)
        except InvalidRequestError as exc:
            results[f"mode_{mode}"] = f"skipped: {exc}"
            continue
        frames_result = {
            "ra_deg": ra_deg, "dec_deg": dec_deg, "fov_arcmin": fov_arcmin, "mode": mode,
            "detector": None, "wl_min_um": None, "wl_max_um": None,
            "frames": frame_names, "cache_key_dir": os.path.relpath(cache_dir, config.CACHE_DIR),
            "epochs": epoch_meta, "n_exposures_total": len(exposures), "cache_hit": False,
        }
        cache.write_json(cache_dir, frames_result)
        results[f"mode_{mode}"] = len(frame_names)

    spectrum_dir = cache.spectrum_cache_dir(ra_deg, dec_deg, fov_arcmin)
    spectrum_points = [p.__dict__ for p in extract_spectrum(exposures, ra_deg, dec_deg)]
    cache.write_json(spectrum_dir, spectrum_points)
    results["spectrum_points"] = len(spectrum_points)

    lightcurve_dir = cache.lightcurve_cache_dir(ra_deg, dec_deg, fov_arcmin)
    lightcurve_points = [_json_safe_point(p.__dict__) for p in build_light_curve(stacked_epochs, ra_deg, dec_deg, fov_arcmin)]
    cache.write_json(lightcurve_dir, lightcurve_points)
    results["lightcurve_points"] = len(lightcurve_points)

    return results
