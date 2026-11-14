"""Accept RA/Dec as either decimal degrees or sexagesimal strings, per the
spec ("sexagesimal or decimal")."""
from __future__ import annotations

from astropy import units as u
from astropy.coordinates import Angle

from .errors import InvalidRequestError


def parse_ra_deg(raw: str) -> float:
    raw = raw.strip()
    try:
        return float(raw) % 360.0
    except ValueError:
        pass
    try:
        return Angle(raw, unit=u.hourangle).deg % 360.0
    except Exception as exc:
        raise InvalidRequestError(f"Could not parse RA '{raw}'") from exc


def parse_dec_deg(raw: str) -> float:
    raw = raw.strip()
    try:
        return float(raw)
    except ValueError:
        pass
    try:
        return Angle(raw, unit=u.deg).deg
    except Exception as exc:
        raise InvalidRequestError(f"Could not parse Dec '{raw}'") from exc
