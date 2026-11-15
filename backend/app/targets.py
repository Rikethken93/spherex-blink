"""The 8 targets this tool guarantees work: the 5 required by the challenge
plus 3 extras chosen for southern-sky / Colombia visibility.

Why these 3 extras (see DECISIONS.md for the full writeup):
- Proxima Centauri: closest star to the Sun, huge proper motion, a flare
  (variable) star, deep-southern declination -- a textbook "blink" target
  that happens to sit almost overhead from Barranquilla's latitude band.
- Luhman 16 AB: the closest brown-dwarf binary to the Sun (Dec -53), found
  by its extreme proper motion in WISE data -- the same "blink" signature
  this tool visualizes, just like the 2013 discovery.
- UGPS 0722-05: a very cool (T9) brown dwarf near the celestial equator,
  so it transits near the zenith for low-latitude observers, and has a
  well-measured large proper motion.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Target:
    key: str
    display_name: dict[str, str]  # {"en": ..., "es": ...}
    resolve_names: list[str]  # names to try with Sesame, in order
    fallback_ra_deg: float
    fallback_dec_deg: float
    fallback_epoch_decimalyear: float
    category: str  # "high-pm", "brown-dwarf", "variable"
    required: bool
    note: dict[str, str]
    # Literature proper motion, used instead of a Gaia DR3 lookup for targets
    # too faint/red to have a Gaia DR3 astrometric solution (the brown
    # dwarfs below -- Gaia is an optical mission, these are IR-discovered).
    # None means "look this up in Gaia DR3 at request time" (see resolve.py).
    known_pmra_mas_yr: float | None = None
    known_pmdec_mas_yr: float | None = None
    known_pm_source: str | None = None


REQUIRED_TARGETS: list[Target] = [
    Target(
        key="barnards-star",
        display_name={"en": "Barnard's Star", "es": "Estrella de Barnard"},
        resolve_names=["Barnard's Star", "GJ 699"],
        # Gaia DR3 4472832130942575872, astrometry at ref_epoch 2016.0.
        # Cached locally (not looked up live) because a sustained Gaia TAP
        # outage (observed 2026-11-15) made every live lookup fall back to
        # the static Sesame J2000 position -- which for this star is ~269"
        # (over 43 SPHEREx pixels) away from its true 2026 position,
        # putting it entirely outside a 6' cutout. See DECISIONS.md.
        fallback_ra_deg=269.4485025254,
        fallback_dec_deg=4.7394200511,
        fallback_epoch_decimalyear=2016.0,
        category="high-pm",
        required=True,
        note={
            "en": "Highest proper motion of any star visible from Earth (~10.3\"/yr).",
            "es": "El movimiento propio más alto de cualquier estrella visible desde la Tierra (~10,3\"/año).",
        },
        known_pmra_mas_yr=-801.551,
        known_pmdec_mas_yr=10362.394,
        known_pm_source="Gaia DR3 4472832130942575872 (ref_epoch 2016.0), cached locally so resolution never depends on live Gaia TAP availability.",
    ),
    Target(
        key="epsilon-indi-b",
        display_name={"en": "Epsilon Indi Ba/Bb", "es": "Épsilon Indi Ba/Bb"},
        resolve_names=["Epsilon Indi B", "eps Ind B"],
        fallback_ra_deg=331.0608,
        fallback_dec_deg=-56.7868,
        fallback_epoch_decimalyear=2000.0,
        category="brown-dwarf",
        required=True,
        note={
            "en": "Nearest brown-dwarf pair to the Sun, orbiting the Epsilon Indi system.",
            "es": "El par de enanas marrones más cercano al Sol, en órbita del sistema Épsilon Indi.",
        },
        known_pmra_mas_yr=3976.0,
        known_pmdec_mas_yr=-2500.0,
        known_pm_source="Common proper motion with Epsilon Indi A (McCaughrean et al. 2004; SIMBAD compiled astrometry) -- too faint/red for a Gaia DR3 solution.",
    ),
    Target(
        key="wise0855",
        display_name={"en": "WISE 0855-0714", "es": "WISE 0855-0714"},
        resolve_names=["WISE J085510.83-071442.5", "WISEA J085510.83-071442.5"],
        fallback_ra_deg=133.79513,
        fallback_dec_deg=-7.24515,
        fallback_epoch_decimalyear=2010.5,
        category="brown-dwarf",
        required=True,
        note={
            "en": "One of the coldest brown dwarfs known outside our solar system.",
            "es": "Una de las enanas marrones más frías conocidas fuera de nuestro sistema solar.",
        },
        known_pmra_mas_yr=-8123.7,
        known_pmdec_mas_yr=673.2,
        known_pm_source="Luhman & Esplin (2014), ApJL -- discovered by its extreme WISE proper motion; no Gaia DR3 solution (optically invisible).",
    ),
    Target(
        key="rw-aurigae",
        display_name={"en": "RW Aurigae", "es": "RW Aurigae"},
        resolve_names=["RW Aurigae", "RW Aur"],
        fallback_ra_deg=76.9565,
        fallback_dec_deg=30.4014,
        fallback_epoch_decimalyear=2000.0,
        category="variable",
        required=True,
        note={
            "en": "Young binary with a dramatic, irregularly dimming circumstellar disk.",
            "es": "Binaria joven con un disco circumestelar que se atenúa de forma dramática e irregular.",
        },
    ),
    Target(
        key="r-draconis",
        display_name={"en": "R Draconis", "es": "R Draconis"},
        resolve_names=["R Draconis", "R Dra"],
        fallback_ra_deg=248.1676,
        fallback_dec_deg=66.7547,
        fallback_epoch_decimalyear=2000.0,
        category="variable",
        required=True,
        note={
            "en": "Mira-type pulsating variable star that changes brightness over months.",
            "es": "Estrella variable pulsante tipo Mira que cambia de brillo en meses.",
        },
    ),
]

EXTRA_TARGETS: list[Target] = [
    Target(
        key="proxima-centauri",
        display_name={"en": "Proxima Centauri", "es": "Próxima Centauri"},
        resolve_names=["Proxima Centauri", "GJ 551"],
        # Gaia DR3 5853498713190525696, astrometry at ref_epoch 2016.0.
        # Cached locally for the same reason as Barnard's Star above: the
        # J2000 position is ~98" (~16 SPHEREx pixels) from the true 2026
        # position, which visibly misplaced the star off the crosshair
        # (and outside a 3' cutout) when Gaia TAP was unreachable.
        fallback_ra_deg=217.3923214720,
        fallback_dec_deg=-62.6760751168,
        fallback_epoch_decimalyear=2016.0,
        category="variable",
        required=False,
        note={
            "en": "Closest star to the Sun; a flare star best seen from southern latitudes like Colombia.",
            "es": "La estrella más cercana al Sol; una estrella fulgurante que se ve mejor desde latitudes sureñas como Colombia.",
        },
        known_pmra_mas_yr=-3781.741,
        known_pmdec_mas_yr=769.465,
        known_pm_source="Gaia DR3 5853498713190525696 (ref_epoch 2016.0), cached locally so resolution never depends on live Gaia TAP availability.",
    ),
    Target(
        key="luhman-16",
        display_name={"en": "Luhman 16 AB", "es": "Luhman 16 AB"},
        resolve_names=["Luhman 16", "WISE J104915.57-531906.1"],
        fallback_ra_deg=162.3298,
        fallback_dec_deg=-53.3192,
        fallback_epoch_decimalyear=2010.5,
        category="brown-dwarf",
        required=False,
        note={
            "en": "Closest brown-dwarf binary to the Sun, found by its large proper motion -- deep-southern sky.",
            "es": "El binario de enanas marrones más cercano al Sol, descubierto por su gran movimiento propio -- cielo profundo del sur.",
        },
        known_pmra_mas_yr=-2768.511,
        known_pmdec_mas_yr=358.472,
        known_pm_source="Bedin et al. 2017/2018 (HST astrometry) -- too faint for a Gaia DR3 solution.",
    ),
    Target(
        key="ugps0722",
        display_name={"en": "UGPS 0722-05", "es": "UGPS 0722-05"},
        resolve_names=["UGPS J072227.51-054031.2"],
        fallback_ra_deg=110.6146,
        fallback_dec_deg=-5.6753,
        fallback_epoch_decimalyear=2010.0,
        category="brown-dwarf",
        required=False,
        note={
            "en": "Very cool T9 brown dwarf near the celestial equator -- passes near the zenith from Colombia.",
            "es": "Enana marrón muy fría tipo T9 cerca del ecuador celeste -- pasa cerca del cénit desde Colombia.",
        },
        known_pmra_mas_yr=-904.14,
        known_pmdec_mas_yr=352.025,
        known_pm_source="Lucas et al. 2010 (UKIDSS Galactic Plane Survey discovery) -- no Gaia DR3 solution.",
    ),
]

ALL_TARGETS: list[Target] = REQUIRED_TARGETS + EXTRA_TARGETS
TARGETS_BY_KEY: dict[str, Target] = {t.key: t for t in ALL_TARGETS}
