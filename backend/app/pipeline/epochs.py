"""Group individual SPHEREx exposures into observing epochs.

SPHEREx resurveys the whole sky roughly every six months; within one all-sky
pass, exposures covering a given point land within a span of days to a few
weeks. We cluster by a simple gap rule on t_min (MJD): sort by time, start a
new epoch whenever the gap since the previous exposure exceeds `gap_days`.
"""
from __future__ import annotations

from collections.abc import Sequence
from typing import TypeVar

from .. import config

T = TypeVar("T")


def group_into_epochs(
    items: Sequence[T],
    get_mjd,
    gap_days: float = config.EPOCH_GAP_DAYS,
) -> list[list[T]]:
    if not items:
        return []
    ordered = sorted(items, key=get_mjd)
    epochs: list[list[T]] = [[ordered[0]]]
    for item in ordered[1:]:
        if get_mjd(item) - get_mjd(epochs[-1][-1]) > gap_days:
            epochs.append([item])
        else:
            epochs[-1].append(item)
    return epochs


def epoch_summary(epoch: Sequence[T], get_mjd) -> dict:
    mjds = [get_mjd(item) for item in epoch]
    return {
        "mjd_min": min(mjds),
        "mjd_max": max(mjds),
        "mjd_mean": sum(mjds) / len(mjds),
        "n_exposures": len(epoch),
    }
