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
