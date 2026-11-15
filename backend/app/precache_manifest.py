# AI-assisted: written with Claude Code (Anthropic) under the team's
# direction; concept, requirements, and design decisions are the team's
# own. See DECISIONS.md and README.md ("AI assistance") for details.
"""Small on-disk record of exactly what scripts/precache.py has baked in
for each target -- the *exact* resolved ra/dec used (which can differ
slightly from a target's static fallback position, and drifts over time
for a live Gaia-PM lookup), which FOV(s) are complete, and which modes
are complete at each FOV.

Read by /api/targets so the frontend's gallery can pick a FOV/mode
combination it *knows* is cached and go straight there, rather than
discovering a gap by trying a live fetch -- see the "never fall through
to a live fetch for a gallery target" rule in DECISIONS.md.
"""
from __future__ import annotations

import json
import os

from . import config

MANIFEST_PATH = os.path.join(config.CACHE_DIR, "precache_manifest.json")


def read() -> dict:
    if not os.path.exists(MANIFEST_PATH):
        return {}
    with open(MANIFEST_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def fov_key(fov_arcmin: float) -> str:
    # Normalizes e.g. 6.0 -> "6", 3.5 -> "3.5" into a stable, predictable key.
    return f"{fov_arcmin:g}"


def record(
    target_key: str,
    fov_arcmin: float,
    ra_deg: float,
    dec_deg: float,
    modes: list[str],
    pmra_mas_yr: float | None,
    pmdec_mas_yr: float | None,
) -> None:
    """Merges into the existing manifest (read-modify-write) rather than
    overwriting it, so precaching one FOV/mode subset never erases a
    previously recorded, still-valid one for the same target."""
    if not modes:
        return
    data = read()
    target_entry = data.setdefault(target_key, {})
    key = fov_key(fov_arcmin)
    existing_modes = set(target_entry.get(key, {}).get("modes", []))
    target_entry[key] = {
        "ra_deg": ra_deg,
        "dec_deg": dec_deg,
        "modes": sorted(existing_modes | set(modes)),
        "pmra_mas_yr": pmra_mas_yr,
        "pmdec_mas_yr": pmdec_mas_yr,
    }
    os.makedirs(config.CACHE_DIR, exist_ok=True)
    tmp_path = f"{MANIFEST_PATH}.tmp{os.getpid()}"
    with open(tmp_path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, sort_keys=True)
    os.replace(tmp_path, MANIFEST_PATH)  # atomic -- never leaves a half-written manifest
