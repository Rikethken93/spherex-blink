#!/usr/bin/env python3
"""Build the on-disk cache for the demo targets (5 required + 3 extra),
hitting the real IRSA/Gaia archives, so the committed result lets the app
run its full demo offline.

Usage (from repo root, with the backend venv active):
    python scripts/precache.py [--targets key1,key2,...] [--modes blink,sum,...]

AI-assisted: written with Claude Code (Anthropic) under the team's
direction; concept, requirements, and design decisions are the team's
own. See DECISIONS.md and README.md ("AI assistance") for details.
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from app import config, service
from app.errors import NoCoverageError
from app.net import UpstreamUnavailable
from app.resolve import resolve_target_with_fallback
from app.targets import ALL_TARGETS, TARGETS_BY_KEY

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("precache")

DEFAULT_MODES = ["blink", "sum", "difference"]
DEFAULT_FOV_ARCMIN = 3.0


def precache_target(key: str, modes: list[str], epoch_gap_days: float | None = None) -> bool:
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
    try:
        # One fetch, shared across every mode plus spectrum and light curve
        # -- avoids paying for a separate full IRSA fetch per product.
        result = service.precache_all(
            resolved.ra_deg, resolved.dec_deg, DEFAULT_FOV_ARCMIN, modes, epoch_gap_days=epoch_gap_days
        )
        logger.info(
            "  exposures=%d epochs=%d spectrum=%d points lightcurve=%d points",
            result["n_exposures_total"], result["n_epochs"],
            result["spectrum_points"], result["lightcurve_points"],
        )
        for mode in modes:
            logger.info("  mode=%-10s frames=%s", mode, result.get(f"mode_{mode}"))
    except NoCoverageError as exc:
        logger.warning("  NO COVERAGE: %s", exc)
        ok = False
    except UpstreamUnavailable as exc:
        logger.error("  FAILED: %s", exc)
        ok = False
    except Exception as exc:  # noqa: BLE001
        logger.error("  FAILED (%s): %s", type(exc).__name__, exc)
        ok = False

    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--targets", default=None, help="Comma-separated target keys (default: all)")
    parser.add_argument("--modes", default=",".join(DEFAULT_MODES), help="Comma-separated frame modes")
    parser.add_argument(
        "--epoch-gap-days", type=float, default=None,
        help="Override config.EPOCH_GAP_DAYS for this run (e.g. for a near-ecliptic-pole "
        "target like R Draconis, where dense SPHEREx revisits mean the default 60-day gap "
        "never splits the baseline into more than one epoch)",
    )
    args = parser.parse_args()

    keys = args.targets.split(",") if args.targets else [t.key for t in ALL_TARGETS]
    modes = args.modes.split(",")

    logger.info("Cache dir: %s", config.CACHE_DIR)
    logger.info("Targets: %s", keys)
    logger.info("Modes: %s", modes)
    if args.epoch_gap_days is not None:
        logger.info("Epoch gap override: %s days", args.epoch_gap_days)

    results = {key: precache_target(key, modes, epoch_gap_days=args.epoch_gap_days) for key in keys}

    print("\n=== Precache summary ===")
    for key, ok in results.items():
        print(f"  {'OK  ' if ok else 'FAIL'} {key}")

    return 0 if all(results.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
