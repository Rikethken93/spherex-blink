"""Name -> sky position, with Gaia DR3 proper motion propagated to the
SPHEREx observing epoch.

These targets move fast enough (1-3 SPHEREx pixels/year at ~6.2"/pixel) that
using a catalog's static J2000 (or Hipparcos-epoch, or discovery-epoch WISE)
position directly would miss the star in a 3' cutout within a decade or two.
So: resolve a name to an approximate position (Sesame), find the matching
Gaia DR3 source near that position, then linearly propagate RA/Dec using
Gaia's pmra/pmdec from its own reference epoch to the requested epoch.

We use a simple linear tangent-plane propagation rather than
`SkyCoord.apply_space_motion`, because the latter needs a reliable distance
(parallax) and radial velocity to do the full 3D space-motion integral, and
several of our targets (faint brown dwarfs) have noisy or missing Gaia
parallax/RV. Over the few-decade baselines involved here the linear
approximation and the full space-motion integral agree to much better than
one SPHEREx pixel, so the simpler, more robust path was chosen (see
DECISIONS.md).
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass

import astropy.units as u
from astropy.coordinates import SkyCoord
from astropy.time import Time

from . import config
from .net import UpstreamUnavailable, with_backoff

logger = logging.getLogger("spherex_blink.resolve")


@dataclass
class ResolvedPosition:
    ra_deg: float
    dec_deg: float
    name: str | None
    source: str  # "gaia_dr3_pm", "sesame_static", "literal_coords", "fallback"
    gaia_source_id: int | None = None
    pmra_mas_yr: float | None = None
    pmdec_mas_yr: float | None = None
    gaia_ref_epoch: float | None = None
    propagated_to_epoch: float | None = None
    warning: str | None = None


def sesame_resolve(name: str) -> SkyCoord:
    def _call() -> SkyCoord:
        return SkyCoord.from_name(name)

    return with_backoff(_call, what=f"Sesame resolve '{name}'")


def gaia_pm_lookup(approx: SkyCoord) -> dict | None:
    """Find the Gaia DR3 counterpart of `approx` and return its astrometry,
    or None if nothing plausible is found.

    Queries one wide radius (config.GAIA_MATCH_RADIUS_DEG), then picks
    between "nearest" and "brightest overall" using both distance and
    magnitude -- neither alone works, as two live findings against real
    targets showed:

    (1) RW Aurigae sits in a crowded young-cluster field. The correct match
    is modest (G=12.2, 1.6" away), but the single brightest star anywhere
    in a 432"-radius circle is an unrelated foreground star (G=9.4, 389"
    away) -- brightest-overall alone is wrong here.

    (2) Barnard's Star is the opposite problem: Sesame resolves to
    Simbad's J2000-equinox position, while Gaia DR3 astrometry is reported
    at ref_epoch 2016.0 -- 16 years that, at 10.3"/yr, is a genuine 166"
    separation. Every candidate within 15" is a faint (G=19-20) unrelated
    field star; the real star (G=8.2) only shows up once the radius is
    wide enough to clear that epoch gap -- nearest-distance alone is wrong
    here.

    So: take the brightest candidate within NEAR_ARCSEC (an ordinary,
    non-high-PM target). Separately take the brightest candidate anywhere
    in the full radius. If the latter is dramatically brighter
    (BRIGHTNESS_MARGIN_MAG) than the former, trust brightness over
    proximity -- that gap is exactly the signature of "the name's resolved
    position and the object's Gaia-epoch position are far apart because
    the object moves fast", which is this whole tool's premise. Otherwise
    trust the nearby match, since a few magnitudes isn't enough to
    overrule proximity for an ordinary star in a crowded field.
    """
    from astroquery.gaia import Gaia

    near_deg = 15.0 / 3600.0

    query = f"""
    SELECT TOP 30 source_id, ra, dec, pmra, pmdec, parallax, ref_epoch,
           phot_g_mean_mag,
           DISTANCE(POINT('ICRS', ra, dec),
                    POINT('ICRS', {approx.ra.deg}, {approx.dec.deg})) AS dist_deg
    FROM {config.GAIA_TABLE}
    WHERE 1 = CONTAINS(
        POINT('ICRS', ra, dec),
        CIRCLE('ICRS', {approx.ra.deg}, {approx.dec.deg}, {config.GAIA_MATCH_RADIUS_DEG})
    )
    AND phot_g_mean_mag IS NOT NULL
    ORDER BY phot_g_mean_mag ASC
    """

    def _call():
        job = Gaia.launch_job(query)
        return job.get_results()

    # Gaia's TAP client exposes no request timeout (unlike IRSA's, which
    # defaults to 60s -- see config.py): an unreachable Gaia endpoint fails
    # each attempt via a bare connection-level timeout -- observed live to
    # take anywhere from ~2 to ~5 minutes per single attempt (astroquery's
    # TAP+ client appears to make more than one internal round-trip before
    # surfacing one failure), not the sub-minute figure a plain OS TCP
    # timeout would suggest. A retry here is not "a second chance at a
    # flaky connection" -- during a real outage it is "wait several more
    # minutes for the identical failure again". A single attempt, falling
    # straight through to resolve_target_with_fallback's static-position
    # fallback, bounds the worst case to one outage-length wait instead of
    # compounding it; the /api/resolve cache above is what actually
    # protects every request after that first one.
    table = with_backoff(_call, max_retries=1, what="Gaia DR3 cone search")
    if len(table) == 0:
        return None

    best_overall = table[0]  # already brightest-first
    near_rows = [row for row in table if float(row["dist_deg"]) <= near_deg]
    best_near = near_rows[0] if near_rows else None  # still brightest-first

    if best_near is not None:
        gap = float(best_near["phot_g_mean_mag"]) - float(best_overall["phot_g_mean_mag"])
        row = best_overall if gap >= config.GAIA_BRIGHTNESS_MARGIN_MAG else best_near
    else:
        row = best_overall

    return {
        "source_id": int(row["source_id"]),
        "ra": float(row["ra"]),
        "dec": float(row["dec"]),
        "pmra": float(row["pmra"]) if row["pmra"] is not None else None,
        "pmdec": float(row["pmdec"]) if row["pmdec"] is not None else None,
        "ref_epoch": float(row["ref_epoch"]),
    }


def propagate_linear(
    ra_deg: float,
    dec_deg: float,
    pmra_mas_yr: float,
    pmdec_mas_yr: float,
    ref_epoch_decimalyear: float,
    target_epoch_decimalyear: float,
) -> tuple[float, float]:
    """Linear tangent-plane proper-motion propagation. pmra is pmra*cos(dec)
    (the Gaia convention)."""
    dt_yr = target_epoch_decimalyear - ref_epoch_decimalyear
    dec_rad = dec_deg * 3.141592653589793 / 180.0
    dec_new = dec_deg + (pmdec_mas_yr * dt_yr) / 3_600_000.0
    cos_dec = max(abs(math.cos(dec_rad)), 1e-6)
    ra_new = ra_deg + (pmra_mas_yr * dt_yr) / 3_600_000.0 / cos_dec
    return ra_new % 360.0, dec_new


def resolve_target_name(
    name: str, target_epoch_decimalyear: float | None = None
) -> ResolvedPosition:
    if target_epoch_decimalyear is None:
        target_epoch_decimalyear = Time.now().decimalyear

    try:
        approx = sesame_resolve(name)
    except UpstreamUnavailable as exc:
        raise UpstreamUnavailable(f"Could not resolve name '{name}': {exc}") from exc

    try:
        gaia = gaia_pm_lookup(approx)
    except UpstreamUnavailable:
        gaia = None

    if gaia is None or gaia["pmra"] is None or gaia["pmdec"] is None:
        return ResolvedPosition(
            ra_deg=approx.ra.deg,
            dec_deg=approx.dec.deg,
            name=name,
            source="sesame_static",
            warning=(
                "No Gaia DR3 proper motion found for this target; using the "
                "static resolved position. High proper-motion targets may be "
                "missed in a small field of view."
            ),
        )

    ra_now, dec_now = propagate_linear(
        gaia["ra"],
        gaia["dec"],
        gaia["pmra"],
        gaia["pmdec"],
        gaia["ref_epoch"],
        target_epoch_decimalyear,
    )
    return ResolvedPosition(
        ra_deg=ra_now,
        dec_deg=dec_now,
        name=name,
        source="gaia_dr3_pm",
        gaia_source_id=gaia["source_id"],
        pmra_mas_yr=gaia["pmra"],
        pmdec_mas_yr=gaia["pmdec"],
        gaia_ref_epoch=gaia["ref_epoch"],
        propagated_to_epoch=target_epoch_decimalyear,
    )


def resolve_target_with_fallback(target, target_epoch_decimalyear: float | None = None) -> ResolvedPosition:
    """Resolve a `targets.Target`.

    If the target carries a literature `known_pm*` (the brown dwarfs, which
    are too faint/red for a Gaia DR3 astrometric solution -- Gaia is an
    optical mission), propagate directly from its literal fallback position
    using that published proper motion and skip Gaia entirely. Otherwise,
    try each Sesame alias and look up Gaia DR3 proper motion, falling back
    to the literal fallback coordinates if every name lookup fails.
    """
    if target_epoch_decimalyear is None:
        target_epoch_decimalyear = Time.now().decimalyear

    if target.known_pmra_mas_yr is not None and target.known_pmdec_mas_yr is not None:
        ra_now, dec_now = propagate_linear(
            target.fallback_ra_deg,
            target.fallback_dec_deg,
            target.known_pmra_mas_yr,
            target.known_pmdec_mas_yr,
            target.fallback_epoch_decimalyear,
            target_epoch_decimalyear,
        )
        return ResolvedPosition(
            ra_deg=ra_now,
            dec_deg=dec_now,
            name=target.key,
            source="literature_pm",
            pmra_mas_yr=target.known_pmra_mas_yr,
            pmdec_mas_yr=target.known_pmdec_mas_yr,
            gaia_ref_epoch=target.fallback_epoch_decimalyear,
            propagated_to_epoch=target_epoch_decimalyear,
            warning=f"Not in Gaia DR3 (too faint/red); using published proper motion: {target.known_pm_source}",
        )

    last_warning = None
    for alias in target.resolve_names:
        try:
            result = resolve_target_name(alias, target_epoch_decimalyear)
            return result
        except UpstreamUnavailable as exc:
            last_warning = str(exc)
            logger.warning("Alias '%s' failed: %s", alias, exc)
            continue

    approx = SkyCoord(
        ra=target.fallback_ra_deg * u.deg, dec=target.fallback_dec_deg * u.deg
    )
    try:
        gaia = gaia_pm_lookup(approx)
    except UpstreamUnavailable:
        gaia = None

    if gaia and gaia["pmra"] is not None and gaia["pmdec"] is not None:
        ra_now, dec_now = propagate_linear(
            gaia["ra"], gaia["dec"], gaia["pmra"], gaia["pmdec"],
            gaia["ref_epoch"], target_epoch_decimalyear,
        )
        return ResolvedPosition(
            ra_deg=ra_now, dec_deg=dec_now, name=target.key, source="gaia_dr3_pm",
            gaia_source_id=gaia["source_id"], pmra_mas_yr=gaia["pmra"],
            pmdec_mas_yr=gaia["pmdec"], gaia_ref_epoch=gaia["ref_epoch"],
            propagated_to_epoch=target_epoch_decimalyear,
            warning=f"All name lookups failed ({last_warning}); used literal fallback coordinates.",
        )

    return ResolvedPosition(
        ra_deg=target.fallback_ra_deg,
        dec_deg=target.fallback_dec_deg,
        name=target.key,
        source="fallback",
        warning=f"All name/Gaia lookups failed ({last_warning}); used static literal fallback coordinates.",
    )
