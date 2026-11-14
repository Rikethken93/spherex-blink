#!/usr/bin/env python3
"""Build the on-disk cache for the demo targets (5 required + 3 extra),
hitting the real IRSA/Gaia archives, so the committed result lets the app
run its full demo offline.

Usage (from repo root, with the backend venv active):
    python scripts/precache.py [--targets key1,key2,...] [--modes blink,sum,...]
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from app import config, service  # noqa: E402
from app.errors import NoCoverageError  # noqa: E402
from app.net import UpstreamUnavailable  # noqa: E402
from app.resolve import resolve_target_with_fallback  # noqa: E402
from app.targets import ALL_TARGETS, TARGETS_BY_KEY  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("precache")

DEFAULT_MODES = ["blink", "sum", "difference"]
DEFAULT_FOV_ARCMIN = 3.0


def precache_target(key: str, modes: list[str]) -> bool:
    target = TARGETS_BY_KEY[key]
    logger.info("=== %s (%s) ===", key, target.display_name["en"])

    try:
        resolved = resolve_target_with_fallback(target)
    except UpstreamUnavailable as exc:
        logger.error("Could not resolve %s: %s", key, exc)
        return False

    logger.info(
        "Resolved %s -> ra=%.5f dec=%.5f (source=%s, pmra=%s, pmdec=%s)",
        key, resolved.ra_deg, resolved.dec_deg, resolved.source,
        resolved.pmra_mas_yr, resolved.pmdec_mas_yr,
    )
    if resolved.warning:
        logger.warning("%s: %s", key, resolved.warning)

    ok = True
    for mode in modes:
        try:
            result = service.get_frames(resolved.ra_deg, resolved.dec_deg, DEFAULT_FOV_ARCMIN, mode)
            logger.info(
                "  mode=%-10s epochs=%d exposures=%d frames=%d",
                mode, len(result["epochs"]), result["n_exposures_total"], len(result["frames"]),
            )
        except NoCoverageError as exc:
            logger.warning("  mode=%-10s NO COVERAGE: %s", mode, exc)
            ok = False
        except UpstreamUnavailable as exc:
            logger.error("  mode=%-10s FAILED: %s", mode, exc)
            ok = False
        except Exception as exc:  # noqa: BLE001
            logger.error("  mode=%-10s FAILED (%s): %s", mode, type(exc).__name__, exc)
            ok = False

    try:
        spectrum = service.get_spectrum(resolved.ra_deg, resolved.dec_deg, DEFAULT_FOV_ARCMIN)
        logger.info("  spectrum: %d points", len(spectrum))
    except (NoCoverageError, UpstreamUnavailable) as exc:
        logger.warning("  spectrum FAILED: %s", exc)
        ok = False

    try:
        lightcurve = service.get_lightcurve(resolved.ra_deg, resolved.dec_deg, DEFAULT_FOV_ARCMIN)
        logger.info("  lightcurve: %d points", len(lightcurve))
    except (NoCoverageError, UpstreamUnavailable) as exc:
        logger.warning("  lightcurve FAILED: %s", exc)
        ok = False

    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--targets", default=None, help="Comma-separated target keys (default: all)")
    parser.add_argument("--modes", default=",".join(DEFAULT_MODES), help="Comma-separated frame modes")
    args = parser.parse_args()

    keys = args.targets.split(",") if args.targets else [t.key for t in ALL_TARGETS]
    modes = args.modes.split(",")

    logger.info("Cache dir: %s", config.CACHE_DIR)
    logger.info("Targets: %s", keys)
    logger.info("Modes: %s", modes)

    results = {key: precache_target(key, modes) for key in keys}

    print("\n=== Precache summary ===")
    for key, ok in results.items():
        print(f"  {'OK  ' if ok else 'FAIL'} {key}")

    return 0 if all(results.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
