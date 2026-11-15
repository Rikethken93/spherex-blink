import math

from app.resolve import propagate_linear


def test_propagate_zero_pm_is_identity():
    ra, dec = propagate_linear(100.0, 20.0, 0.0, 0.0, 2016.0, 2026.0)
    assert ra == 100.0
    assert dec == 20.0


def test_propagate_dec_direction():
    # 1000 mas/yr for 10 years = 10000 mas = 10 arcsec = 10/3600 deg
    ra, dec = propagate_linear(100.0, 0.0, 0.0, 1000.0, 2016.0, 2026.0)
    assert math.isclose(dec, 10.0 / 3600.0, rel_tol=1e-9)
    assert ra == 100.0


def test_propagate_ra_scaled_by_cos_dec():
    # At dec=60deg, cos(dec)=0.5, so the same pmra*cos(dec) mas/yr should
    # produce twice the raw RA-degree shift it would at the equator.
    dt_yr = 10.0
    pmra = 1000.0  # mas/yr, already pmra*cosdec per the Gaia convention
    ra_eq, _ = propagate_linear(100.0, 0.0, pmra, 0.0, 2016.0, 2016.0 + dt_yr)
    ra_60, _ = propagate_linear(100.0, 60.0, pmra, 0.0, 2016.0, 2016.0 + dt_yr)
    shift_eq = ra_eq - 100.0
    shift_60 = ra_60 - 100.0
    assert math.isclose(shift_60 / shift_eq, 2.0, rel_tol=1e-6)


def test_propagate_wraps_ra_into_0_360():
    ra, _ = propagate_linear(359.999, 0.0, 10_000_000.0, 0.0, 2016.0, 2017.0)
    assert 0.0 <= ra < 360.0


def test_barnards_star_known_motion_matches_literature():
    # Real Gaia DR3 astrometry for Barnard's Star (confirmed live against
    # the archive during development): pmra=-801.55, pmdec=+10362.39 mas/yr
    # at ref_epoch 2016.0. Over 10 years it should move about 0.8" in RA*
    # and 103.6" in Dec -- i.e. almost entirely a Dec-ward motion.
    ra0, dec0 = 269.4485, 4.7394
    ra1, dec1 = propagate_linear(ra0, dec0, -801.5509783684709, 10362.394206546573, 2016.0, 2026.0)
    dec_shift_arcsec = (dec1 - dec0) * 3600.0
    assert math.isclose(dec_shift_arcsec, 103.62, abs_tol=0.1)
    assert dec1 > dec0  # moving toward +Dec
    assert ra1 < ra0  # moving toward -RA (pmra is negative)


# --- Offline, deterministic PM for the demo targets (2026-11-15) ------------
# A sustained live Gaia TAP outage silently degraded Proxima Centauri and
# Barnard's Star to their static J2000 positions (the SIA logs showed
# POS=CIRCLE 217.429 -62.6795 -- Proxima's J2000 position, ~98" from where
# the star actually is at the SPHEREx epoch). Their Gaia DR3 astrometry is
# now cached in targets.py, so resolution is deterministic and offline.

import astropy.units as u
from astropy.coordinates import SkyCoord

from app.resolve import resolve_target_with_fallback, survey_mid_epoch
from app.targets import TARGETS_BY_KEY


def _separation_from_j2000_arcsec(key: str) -> float:
    target = TARGETS_BY_KEY[key]
    resolved = resolve_target_with_fallback(target)
    # J2000 position derived from the same cached astrometry.
    ra_j2000, dec_j2000 = propagate_linear(
        target.fallback_ra_deg, target.fallback_dec_deg,
        target.known_pmra_mas_yr, target.known_pmdec_mas_yr,
        target.fallback_epoch_decimalyear, 2000.0,
    )
    sep = SkyCoord(resolved.ra_deg * u.deg, resolved.dec_deg * u.deg).separation(
        SkyCoord(ra_j2000 * u.deg, dec_j2000 * u.deg)
    )
    return float(sep.arcsec)


def test_proxima_moves_about_98_arcsec_from_j2000():
    # ~3.86"/yr of total proper motion over the ~26 years from J2000 to the
    # SPHEREx DR1+QR3 mid-epoch: about 98-100 arcsec.
    sep = _separation_from_j2000_arcsec("proxima-centauri")
    assert 90.0 <= sep <= 110.0, sep


def test_barnards_star_moves_about_265_arcsec_from_j2000():
    # ~10.4"/yr over the same baseline: about 265-270 arcsec.
    sep = _separation_from_j2000_arcsec("barnards-star")
    assert 255.0 <= sep <= 280.0, sep


def test_demo_targets_resolve_offline_and_propagate_to_survey_epoch():
    for key in ("proxima-centauri", "barnards-star", "wise0855", "luhman-16", "epsilon-indi-b", "ugps0722"):
        resolved = resolve_target_with_fallback(TARGETS_BY_KEY[key])
        assert resolved.pmra_mas_yr is not None, key
        assert resolved.propagated_to_epoch == survey_mid_epoch(), key


def test_proxima_resolved_position_is_not_the_j2000_position():
    # The exact regression: the IRSA query centre must not be the J2000
    # position (217.4289, -62.6795) that showed up in the live SIA logs.
    resolved = resolve_target_with_fallback(TARGETS_BY_KEY["proxima-centauri"])
    sep = SkyCoord(resolved.ra_deg * u.deg, resolved.dec_deg * u.deg).separation(
        SkyCoord(217.4289 * u.deg, -62.6795 * u.deg)
    )
    assert sep.arcsec > 60.0
