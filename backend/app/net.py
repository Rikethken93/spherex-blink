"""Shared retry/backoff for every outbound call to IRSA, Gaia or Sesame.

A live probe during development hit seven consecutive 502s from IRSA's SIA
capabilities endpoint before the eighth attempt succeeded -- these archives
are occasionally flaky, not just occasionally down, so retrying with backoff
(rather than failing fast) is what actually makes the tool usable live.
"""
from __future__ import annotations

import logging
import time
from collections.abc import Callable
from typing import TypeVar

from . import config

logger = logging.getLogger("spherex_blink.net")

T = TypeVar("T")


class UpstreamUnavailable(RuntimeError):
    """Raised when an external service fails after all retries."""


class NonRetryable(RuntimeError):
    """Raised by a call to signal "this will never succeed on retry" (e.g. a
    4xx client error other than 429) -- fails immediately instead of
    burning through the full backoff schedule for nothing. A live precache
    run hit a permanent 422 from IRSA for one specific exposure; without
    this, each one costs ~60s of pure waste across 6 doomed retries."""


def with_backoff(
    fn: Callable[[], T],
    *,
    max_retries: int = config.HTTP_MAX_RETRIES,
    base_seconds: float = config.HTTP_BACKOFF_BASE_SECONDS,
    what: str = "external call",
) -> T:
    last_exc: Exception | None = None
    for attempt in range(max_retries):
        try:
            return fn()
        except NonRetryable as exc:
            logger.warning("%s failed permanently: %s", what, exc)
            raise UpstreamUnavailable(f"{what} failed: {exc}") from exc
        except Exception as exc:  # noqa: BLE001 - we deliberately retry anything else
            last_exc = exc
            delay = base_seconds * (2**attempt)
            logger.warning(
                "%s failed (attempt %d/%d): %s. Retrying in %.1fs",
                what,
                attempt + 1,
                max_retries,
                exc,
                delay,
            )
            if attempt < max_retries - 1:
                time.sleep(delay)
    raise UpstreamUnavailable(f"{what} failed after {max_retries} attempts") from last_exc
