"""Recognize Solar System bodies typed into the search box.

The tool blinks a *fixed* patch of sky across SPHEREx epochs months apart.
Planets, moons and dwarf planets move degrees across the sky in that time
(and the bright ones saturate SPHEREx), so they can't be shown this way --
and Sesame, a catalog of objects beyond the Solar System, doesn't know
them anyway. Recognizing them lets the API say *why* instead of a generic
"name not recognized".
"""
from __future__ import annotations

import unicodedata

# Canonical English name -> extra accepted spellings (Spanish, etc.).
_BODIES: dict[str, list[str]] = {
    "Sun": ["sol"],
    "Moon": ["luna"],
    "Mercury": ["mercurio"],
    "Venus": [],
    "Earth": ["tierra"],
    "Mars": ["marte"],
    "Jupiter": [],
    "Saturn": ["saturno"],
    "Uranus": ["urano"],
    "Neptune": ["neptuno"],
    "Pluto": ["pluton"],
    "Ceres": [],
    "Eris": [],
    "Makemake": [],
    "Haumea": [],
    "Charon": ["caronte"],
    "Phobos": ["fobos"],
    "Deimos": [],
    "Io": [],
    "Europa": [],
    "Ganymede": ["ganimedes"],
    "Callisto": ["calisto"],
    "Titan": [],
    "Enceladus": ["encelado"],
    "Triton": [],
}


def _normalize(name: str) -> str:
    # Strip accents ("Plutón", "Júpiter", "Titán") and non-alphanumerics.
    decomposed = unicodedata.normalize("NFKD", name)
    return "".join(ch for ch in decomposed.lower() if ch.isalnum())


_LOOKUP: dict[str, str] = {}
for _canonical, _aliases in _BODIES.items():
    for _n in [_canonical, *_aliases]:
        _LOOKUP[_normalize(_n)] = _canonical


def match_solar_system_body(name: str) -> str | None:
    """Canonical English name if `name` is a known Solar System body."""
    return _LOOKUP.get(_normalize(name))
