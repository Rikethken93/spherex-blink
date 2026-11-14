from __future__ import annotations

import logging
import os

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

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
app.mount("/cache", StaticFiles(directory=config.CACHE_DIR), name="cache")


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


@app.get("/api/resolve")
def resolve(name: str = Query(..., min_length=1)):
    target = TARGETS_BY_KEY.get(name.lower().replace(" ", "-"))
    try:
        if target is not None:
            result = resolve_target_with_fallback(target)
        else:
            from .resolve import resolve_target_name

            result = resolve_target_name(name)
    except UpstreamUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return {
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

    base = f"/cache/frames/{result['cache_key_dir']}"
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
