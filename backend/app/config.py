"""Single place to touch for a new SPHEREx data release.

Every value below was confirmed against the live IRSA archive on 2026-11-14
(see DECISIONS.md) rather than guessed from documentation alone:

- ``Irsa.list_collections(servicetype="SIA", filter="spherex")`` returned
  exactly ``SIA_COLLECTIONS`` below.
- A live ``Irsa.query_sia`` + cutout fetch against the WISE 0855-0714
  position returned a 7-HDU FITS (PRIMARY, IMAGE, FLAGS, VARIANCE, ZODI,
  EPSF, WCS-WAVE), confirming ``CUTOUT_URL_TEMPLATE`` and
  ``FITS_EXTENSIONS`` below.

AI-assisted: written with Claude Code (Anthropic) under the team's
direction; concept, requirements, and design decisions are the team's
own. See DECISIONS.md and README.md ("AI assistance") for details.
"""
from __future__ import annotations

# --- IRSA SIA2 access -------------------------------------------------------

IRSA_BASE_URL = "https://irsa.ipac.caltech.edu"

# DR1 and QR3 together supersede the older QR2 release (per IRSA's SPHEREx
# data-access docs), so both must be queried to not silently miss epochs.
SIA_COLLECTIONS: list[str] = [
    "spherex_dr1",
    "spherex_dr1_deep",
    "spherex_qr3",
    "spherex_qr3_deep",
]

# astroquery.ipac.irsa.Irsa.query_sia returns an access_url pointing at the
# full exposure FITS file. IRSA's IBE cutout service accepts a center+size
# query string appended to that same URL -- confirmed live, returns a
# cropped multi-extension FITS rather than the full frame.
CUTOUT_URL_TEMPLATE = "{access_url}?center={ra_deg},{dec_deg}d&size={size_deg}"

# HDU layout of a SPHEREx L2 spectral-image cutout, confirmed live.
FITS_EXTENSIONS = {
    "image": "IMAGE",
    "flags": "FLAGS",
    "variance": "VARIANCE",
    "zodi": "ZODI",
    "epsf": "EPSF",
    "wcs_wave": "WCS-WAVE",
}

# Which FLAGS bits mark a pixel unusable for science, per Table 16 ("Image
# pixel flags used in spectral images at Level 2") of the SPHEREx
# Explanatory Supplement (v2.1, confirmed by downloading and reading the
# actual PDF -- see DECISIONS.md). Every defined bit means "exclude this
# pixel" EXCEPT bit 21 (SOURCE, "pixel mapped to a known source" -- purely
# informational, not a defect). A live cutout showed ~97% of pixels with
# only bit 21 set; masking on "any nonzero bit" as a first pass treated
# nearly every real source pixel as bad data and produced blank-looking
# stacks -- exactly backwards for a tool whose purpose is finding sources.
_SOURCE_BIT = 21
# Bits 0-29 are the documented range (Table 16); FLAGS is a signed int32
# array, so the mask must stay within int32 range (0xFFFFFFFF would
# overflow a bitwise AND against it).
FLAG_BAD_BITMASK = 0x3FFFFFFF & ~(1 << _SOURCE_BIT)

# --- Detectors / linear variable filter bands -------------------------------
# Wavelength coverage and resolving power per detector array (SPHEREx
# "Spectral Response" instrument papers). energy_bandpassname in SIA results
# is literally "SPHEREx-D<n>".
DETECTOR_BANDS = {
    1: {"wl_min_um": 0.75, "wl_max_um": 1.09, "R": 39},
    2: {"wl_min_um": 1.10, "wl_max_um": 1.62, "R": 41},
    3: {"wl_min_um": 1.63, "wl_max_um": 2.41, "R": 41},
    4: {"wl_min_um": 2.42, "wl_max_um": 3.82, "R": 35},
    5: {"wl_min_um": 3.83, "wl_max_um": 4.41, "R": 112},
    6: {"wl_min_um": 4.42, "wl_max_um": 5.00, "R": 128},
}
PIXEL_SCALE_ARCSEC = 6.2

# --- Epoch grouping ----------------------------------------------------------
# SPHEREx resurveys the whole sky roughly every 6 months; exposures within one
# all-sky pass are taken over a span of days to weeks. Default gap used to
# cluster individual exposures (t_min, in MJD) into observing epochs.
EPOCH_GAP_DAYS = 60.0

# Rough epoch window covered by the collections above -- used only to sanity
# check proper-motion propagation targets, not to filter queries.
SURVEY_EPOCH_START_DECIMALYEAR = 2025.3
SURVEY_EPOCH_END_DECIMALYEAR = 2026.6

# --- Gaia DR3 (proper motion source) ----------------------------------------
GAIA_TABLE = "gaiadr3.gaia_source"
# 0.12 deg = 432", wide enough to clear Barnard's Star's 166" Simbad/Gaia
# epoch-gap offset (see resolve.py). GAIA_BRIGHTNESS_MARGIN_MAG decides
# whether a distant-but-much-brighter candidate (a genuine high-PM target
# whose resolved name position has drifted from its Gaia-epoch position)
# should override a closer, fainter one (an ordinary star correctly
# matched in a crowded field) -- calibrated against live RW Aurigae
# (correct match is 2.8 mag fainter than a 389"-away interloper -> must
# NOT trigger) vs Barnard's Star (correct match is 10.9 mag brighter than
# anything within 15" -> must trigger).
GAIA_MATCH_RADIUS_DEG = 0.12
GAIA_BRIGHTNESS_MARGIN_MAG = 5.0

# --- Field of view / validation ---------------------------------------------
FOV_MIN_ARCMIN = 1.0
FOV_MAX_ARCMIN = 15.0
# SPHEREx's native pixel scale is ~6.2"/pixel, so 3' was only ~29 native
# pixels across -- enough context to be genuinely tight around a target but
# not much margin to see a mover's motion land inside the frame, or to read
# the field around it. 6' (~58 native pixels) gives meaningfully more
# context and still keeps even modest proper motions comfortably visible.
FOV_DEFAULT_ARCMIN = 6.0

# --- Networking (IRSA/Gaia/Simbad are observed to be occasionally flaky --
# a live probe during development hit seven consecutive 502s from the SIA
# capabilities endpoint before succeeding) --------------------------------
HTTP_MAX_RETRIES = 6
HTTP_BACKOFF_BASE_SECONDS = 1.0
HTTP_TIMEOUT_SECONDS = 60.0
# A single field (especially a SPHEREx "deep" survey position) can have
# hundreds of exposures; fetched concurrently rather than one at a time.
HTTP_CONCURRENCY = 12

# --- Cache -------------------------------------------------------------------
import os

CACHE_DIR = os.environ.get(
    "SPHEREX_BLINK_CACHE_DIR",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cache"),
)
DATA_RELEASE_TAG = "dr1_qr3"  # bump when SIA_COLLECTIONS changes meaningfully
