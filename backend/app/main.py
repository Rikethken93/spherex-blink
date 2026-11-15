# AI-assisted: written with Claude Code (Anthropic) under the team's
# direction; concept, requirements, and design decisions are the team's
# own. See DECISIONS.md and README.md ("AI assistance") for details.
from __future__ import annotations

import logging
import os
import time

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from . import config, service
from .coords import parse_dec_deg, parse_ra_deg
from .errors import InvalidRequestError, NoCoverageError
from .net import UpstreamUnavailable
from .resolve import resolve_target_with_fallback
from .targets import ALL_TARGETS, TARGETS_BY_KEY

logging.basicConfig(level=logging.INFO)

app = FastAPI(title="SPHEREx Blink API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

os.makedirs(config.CACHE_DIR, exist_ok=True)


@app.get("/cache/{path:path}")
def serve_cache_file(path: str):
    # Reads config.CACHE_DIR per-request rather than a StaticFiles mount
    # bound to the directory at import time, so changing
    # SPHEREX_BLINK_CACHE_DIR (including via test monkeypatching) is
    # actually honored.
    full_path = os.path.normpath(os.path.join(config.CACHE_DIR, path))
    if not full_path.startswith(os.path.normpath(config.CACHE_DIR)):
        raise HTTPException(status_code=404, detail="Not found")
    if not os.path.isfile(full_path):
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(full_path)


@app.get("/api/health")
def health():
    return {"status": "ok", "data_release": config.DATA_RELEASE_TAG}


@app.get("/api/targets")
def targets():
    return [
        {
            "key": t.key,
            "display_name": t.display_name,
            "category": t.category,
            "required": t.required,
            "note": t.note,
            "ra_deg": t.fallback_ra_deg,
            "dec_deg": t.fallback_dec_deg,
        }
        for t in ALL_TARGETS
    ]


# /api/resolve hits live Gaia DR3 / Sesame on every single call -- unlike
# /api/frames, it has no cache of its own. A live outage (observed directly:
# Gaia's TAP endpoint timing out with no error, each retry taking well over
# a minute to even fail) means every search-by-name for a Gaia-PM target
# pays that multi-minute cost, repeatedly, for every visitor, even though
# the resolved position barely moves on any timescale shorter than days
# (even Barnard's Star, the fastest target here, drifts ~0.0003" in 15
# minutes -- three orders of magnitude below this app's own 0.36" cache
# rounding). A short in-memory TTL cache turns "every visitor pays the
# outage cost" into "the first visitor pays it once"; caching the failure
# too (briefly) stops a sustained outage from re-paying the full multi-
# minute retry budget on every single request. Resets on process restart,
# which is fine -- it exists to smooth over a single machine's uptime, not
# to be a durable store.
_RESOLVE_CACHE: dict[str, tuple[float, dict | Exception]] = {}
_RESOLVE_SUCCESS_TTL_SECONDS = 900.0
_RESOLVE_FAILURE_TTL_SECONDS = 60.0


@app.get("/api/resolve")
def resolve(name: str = Query(..., min_length=1)):
    cache_key = name.strip().lower()
    cached = _RESOLVE_CACHE.get(cache_key)
    if cached is not None:
        cached_at, payload = cached
        ttl = _RESOLVE_FAILURE_TTL_SECONDS if isinstance(payload, Exception) else _RESOLVE_SUCCESS_TTL_SECONDS
        if time.monotonic() - cached_at < ttl:
            if isinstance(payload, Exception):
                raise payload
            return payload

    target = TARGETS_BY_KEY.get(name.lower().replace(" ", "-"))
    try:
        if target is not None:
            result = resolve_target_with_fallback(target)
        else:
            from .resolve import resolve_target_name

            result = resolve_target_name(name)
    except UpstreamUnavailable as exc:
        http_exc = HTTPException(status_code=503, detail=str(exc))
        _RESOLVE_CACHE[cache_key] = (time.monotonic(), http_exc)
        raise http_exc from exc

    body = {
        "ra_deg": result.ra_deg,
        "dec_deg": result.dec_deg,
        "name": result.name,
        "source": result.source,
        "gaia_source_id": result.gaia_source_id,
        "pmra_mas_yr": result.pmra_mas_yr,
        "pmdec_mas_yr": result.pmdec_mas_yr,
        "gaia_ref_epoch": result.gaia_ref_epoch,
        "propagated_to_epoch": result.propagated_to_epoch,
        "warning": result.warning,
    }
    _RESOLVE_CACHE[cache_key] = (time.monotonic(), body)
    return body


@app.get("/api/frames")
def frames(
    ra: str = Query(...),
    dec: str = Query(...),
    fov: float = Query(config.FOV_DEFAULT_ARCMIN, ge=config.FOV_MIN_ARCMIN, le=config.FOV_MAX_ARCMIN),
    mode: str = Query("blink"),
    detector: int | None = Query(None, ge=1, le=6),
    wl_min: float | None = Query(None),
    wl_max: float | None = Query(None),
):
    try:
        ra_deg = parse_ra_deg(ra)
        dec_deg = parse_dec_deg(dec)
        result = service.get_frames(ra_deg, dec_deg, fov, mode, detector, wl_min, wl_max)
    except InvalidRequestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except NoCoverageError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except UpstreamUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    # cache_key_dir is already relative to CACHE_DIR, e.g. "frames/<hash>",
    # and serve_cache_file above serves CACHE_DIR at /cache.
    base = f"/cache/{result['cache_key_dir']}"
    result["frame_urls"] = [f"{base}/{name}" for name in result["frames"]]
    return result


@app.get("/api/spectrum")
def spectrum(
    ra: str = Query(...),
    dec: str = Query(...),
    fov: float = Query(config.FOV_DEFAULT_ARCMIN, ge=config.FOV_MIN_ARCMIN, le=config.FOV_MAX_ARCMIN),
):
    try:
        ra_deg = parse_ra_deg(ra)
        dec_deg = parse_dec_deg(dec)
        points = service.get_spectrum(ra_deg, dec_deg, fov)
    except InvalidRequestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except NoCoverageError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except UpstreamUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"ra_deg": ra_deg, "dec_deg": dec_deg, "points": points}


@app.get("/api/lightcurve")
def lightcurve(
    ra: str = Query(...),
    dec: str = Query(...),
    fov: float = Query(config.FOV_DEFAULT_ARCMIN, ge=config.FOV_MIN_ARCMIN, le=config.FOV_MAX_ARCMIN),
):
    try:
        ra_deg = parse_ra_deg(ra)
        dec_deg = parse_dec_deg(dec)
        points = service.get_lightcurve(ra_deg, dec_deg, fov)
    except InvalidRequestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except NoCoverageError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except UpstreamUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"ra_deg": ra_deg, "dec_deg": dec_deg, "points": points}
