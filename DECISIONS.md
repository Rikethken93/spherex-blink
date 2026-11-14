# DECISIONS.md

Running log of non-obvious choices made while building this project, in the
format: **Decision** — Alternatives considered — Reason.

## Environment / stack

- **Backend on Python 3.12 via a dedicated `uv`-managed venv, not the system
  Python 3.14.** — Alternatives: system Python 3.14; pyenv. — Reason: the
  spec asks for 3.12, astropy/astroquery/reproject wheels and their C
  extensions have the most mature support there, and 3.14 is too new (days
  old) to trust for scientific-Python binary wheels. `uv` made fetching 3.12
  a one-line op with no system changes.

- **IRSA access via `astroquery.ipac.irsa.Irsa.query_sia`, not raw `pyvo`
  against a hand-built SIA2 endpoint.** — Alternatives: raw pyvo
  `SIAService`; the CAOM/TAP route (`spherex.artifact`/`spherex.plane`
  tables) used in an older cutouts tutorial. — Reason: confirmed via the
  current (2026) Caltech-IPAC `irsa-tutorials` "Introduction to SPHEREx
  Spectral Images" notebook that `Irsa.query_sia` is the maintained, documented
  path and returns exactly the columns we need (`access_url`,
  `energy_bandpassname`, `t_min`/`t_max`, `em_min`/`em_max`, `s_ra`/`s_dec`).
  `pyvo` is still a direct dependency because astroquery's IRSA module uses it
  under the hood and we need it for `list_collections`.

- **Query both `spherex_dr1`/`spherex_dr1_deep` and `spherex_qr3`/
  `spherex_qr3_deep` collections.** — Alternative: DR1 only. — Reason: IRSA's
  own SPHEREx data-access docs state DR1 and QR3 together supersede the older
  QR2 release, and querying only DR1 could silently miss epochs that fall in
  the QR3 window — which matters a lot for a *blink* tool whose whole premise
  is multiple epochs.

- **All six collection/base-URL strings live in `backend/app/config.py` and
  nowhere else.** — Reason: explicit requirement ("a new data release should
  only need a change to config.py"); also keeps the one hard-coded "epoch
  window" assumption (DR1/QR3 ≈ 2025.5–2026.5) in one place to update later.

## Name resolution / proper motion (the trickiest part of this project)

- **Gaia DR3 cross-match uses a wide (0.12 deg) search radius and picks
  between "nearest" and "brightest-overall" using a brightness-gap
  heuristic, not plain nearest-neighbor matching.** — Alternatives tried
  and rejected, in order: (a) nearest Gaia source to the Sesame-resolved
  position within a tight radius -- failed live for Barnard's Star, matching
  a faint (G=19) field star 9.5" away instead of the real star; (b) nearest
  within a wider radius, ordered by distance -- still failed, because
  Barnard's Star's field has 600+ Gaia sources within 3 arcmin, so the real
  (bright) star isn't even among the nearest few dozen by pure angle; (c)
  brightest star anywhere within a single wide radius -- fixed Barnard's
  Star but broke RW Aurigae, matching an unrelated foreground star 389" away
  (G=9.4) instead of the correct, fainter (G=12.2) match only 1.6" away. —
  Root cause, confirmed live: `SkyCoord.from_name` returns Simbad's
  J2000-equinox position, but Gaia DR3 astrometry is reported at
  `ref_epoch=2016.0`. For a star moving at Barnard's Star's 10.3"/yr, that
  16-year gap is a genuine 166" position difference -- which is *larger*
  than the separation to several unrelated faint field stars, so "nearest"
  alone is structurally unable to find the right source for the fastest
  targets. The final rule (see `resolve.py::gaia_pm_lookup`): take the
  brightest candidate within 15", take the brightest candidate anywhere in
  0.12 deg, and only prefer the latter if it's at least 5 magnitudes
  brighter -- calibrated against live data so neither Barnard's Star (10.9
  mag gap, must override) nor RW Aurigae (2.8 mag gap, must not override)
  breaks.

- **Brown dwarfs (Epsilon Indi Ba/Bb, WISE 0855-0714, Luhman 16 AB, UGPS
  0722-05) use a hard-coded literature proper motion instead of a Gaia DR3
  lookup.** — Alternative: keep trying Gaia DR3 for everything, per the
  task's "apply Gaia DR3 proper motion" instruction literally. — Reason:
  Gaia is an optical mission; these four are red/IR-discovered objects with
  no Gaia DR3 astrometric solution at all (confirmed by empty cone-search
  results live). Using their own discovery-paper proper motions (Luhman &
  Esplin 2014 for WISE 0855-0714; Bedin et al. 2017/2018 for Luhman 16 AB;
  Lucas et al. 2010 for UGPS 0722-05; McCaughrean et al. 2004 for Epsilon
  Indi, via common proper motion with the A component) is the only way
  these five required targets actually land on-target at the SPHEREx
  epoch -- the alternative (no PM correction at all) would silently violate
  the task's own stated requirement ("cutouts will miss the star").
  Documented per-target in `targets.py` with the citation attached, and
  surfaced to the API caller via the `warning` field on `/api/resolve`.

- **Proper-motion propagation is simple linear tangent-plane math
  (`resolve.py::propagate_linear`), not `SkyCoord.apply_space_motion`.** —
  Reason: `apply_space_motion` needs a trustworthy parallax/distance and
  radial velocity to integrate full 3D space motion; several targets here
  (faint brown dwarfs) have noisy, missing, or not-applicable (no Gaia row
  at all) values for those. Over the few-decade baselines involved, linear
  and full space-motion propagation agree to much better than one SPHEREx
  pixel (6.2"), so the simpler, always-available path was chosen.

## Operational realities discovered while precaching real data

- **IRSA cutout fetches run concurrently (thread pool, `HTTP_CONCURRENCY`
  in config.py), not sequentially.** — Reason: a single 3' field can
  overlap 250+ individual SPHEREx exposures (especially where DR1 "deep"
  coverage exists), and a first live test fetching them one at a time did
  not finish within a 10-minute timeout; switching to a 12-way thread pool
  (these are plain I/O-bound HTTP downloads) brought the same query down
  to about 3 minutes.

- **A 4xx HTTP response (other than 429) from the cutout endpoint fails
  immediately instead of exhausting the retry/backoff schedule.** —
  Reason: live precaching hit a real, permanent `422 Arrays do not
  overlap` from IRSA for specific exposures (the requested cutout box
  apparently doesn't intersect that exposure's actual footprint closely
  enough for the server's cutout code, despite it showing up in the SIA2
  search results). Retrying an identical request 6 times with exponential
  backoff cannot fix a deterministic rejection; it only wastes ~60
  seconds per such exposure. Added a `NonRetryable` exception
  (`net.py`) that `fetch_cutout` raises on any non-429 4xx, so these fail
  in under a second and the exposure is simply dropped from that epoch's
  stack (logged, not silently lost).

- **`shared_normalization` must tolerate a frame that is entirely NaN.** —
  Reason: Barnard's Star's real epoch grouping (confirmed live) splits
  into several epochs across the ~13-month DR1+QR3 baseline, and at least
  one of those epochs turned out sparse enough (few exposures, several
  dropped to flags/NonRetryable errors) that every pixel of its stacked
  frame was NaN. The original implementation called `np.concatenate` on a
  list that could end up empty in exactly this case, crashing the whole
  `/api/frames` request instead of rendering a mostly-blank (but valid)
  frame. Fixed to fall back to a default [0, 1] normalization range when
  no frame in a sequence has any finite pixel at all.

- **FLAGS masking excludes every documented bit except bit 21 (SOURCE).** —
  Alternative (the original implementation): treat any nonzero FLAGS value
  as "bad, mask it out." — Reason this was wrong, found by actually looking
  at the rendered output: a live Barnard's Star blink render came out
  essentially solid black. Inspecting the real FLAGS data showed ~97% of
  pixels carried only bit 21 set. Downloading and reading the actual
  SPHEREx Explanatory Supplement PDF (Table 16, "Image pixel flags used in
  spectral images at Level 2") confirmed bit 21 is `SOURCE`: "Pixel mapped
  to a known source" -- an informational flag, not a defect, and
  explicitly the one bit the SPHEREx team's own guidance says to keep
  (exclude pixels with any *other* flag). The original "any nonzero bit"
  logic was masking out almost every pixel that actually contains a
  source -- backwards for a tool whose entire purpose is finding sources.
  Fixed in `config.py` (`FLAG_BAD_BITMASK`, all bits except SOURCE) and
  applied in both `reproject_stack.py` and `spectrum.py`. This also
  invalidated and required regenerating every cache entry produced before
  the fix.

- **The Aladin Lite sky-view panel fails gracefully instead of blocking
  app startup.** — Reason: the CDS Aladin Lite CDN
  (`aladin.cds.unistra.fr`) was observed fully down during development
  (its entire `/AladinLite/api/v3/` path tree returned a branded "Page
  unavailable" error, confirmed across multiple pinned version URLs, not
  just a stale "latest" pointer). The original code `await`ed Aladin
  initialization *before* loading the primary blink view, so this one
  external outage silently prevented the main feature from ever loading.
  Fixed so sky-view init runs independently (fire-and-forget) of the
  blink/spectrum/light-curve flow, and shows an inline "unavailable"
  message in its own panel on failure rather than throwing.

- **`/api/spectrum` and `/api/lightcurve` are cached on disk, same as
  `/api/frames`.** — Reason: the first implementation cached frames but
  not spectrum/light-curve, so even after `/api/frames` was an instant
  cache hit for a precached demo target, loading its spectrum or light
  curve would still trigger a full live IRSA fetch (minutes) on every
  single page load -- directly against the "works offline/instantly"
  goal. Added `cache.spectrum_cache_dir`/`lightcurve_cache_dir`, wired
  into `service.get_spectrum`/`get_lightcurve`, with a regression test
  (`test_spectrum_is_cached_and_does_not_requery_on_second_call`) proving
  a second call doesn't re-hit `query_exposure_metadata`.

- **`scripts/precache.py` fetches each target's exposures exactly once**
  (`service.precache_all`), deriving every requested frame mode plus the
  spectrum and light curve from that single fetch. — Alternative (the
  first implementation): call `service.get_frames` per mode, then
  `get_spectrum`, then `get_lightcurve` independently, each doing its own
  full `query_exposure_metadata` + `fetch_exposures`. — Reason: those are
  all the *same* exposures at the *same* position; fetching them 3-6
  times instead of once was pure waste discovered mid-precache-run (each
  extra pass cost several more minutes per target against an already
  slow and occasionally overloaded live archive).

- **Three extra "southern sky" demo targets: Proxima Centauri, Luhman 16
  AB, UGPS 0722-05.** — Alternatives considered: other known high-PM/
  variable objects (e.g. Kapteyn's Star, SCR 1845-6357) were viable but
  less famous or less clearly tied to the "blink discovery" narrative. —
  Reason each was picked: Proxima Centauri is the closest star to the Sun,
  a genuine flare (variable) star, and at Dec -62° sits in the deep
  southern sky many LATAM observers (and few US/European ones) can see
  well -- same "blink" story as Barnard's Star but visible from home.
  Luhman 16 AB (Dec -53°) is the closest brown-dwarf binary to the Sun,
  found in 2013 by exactly the WISE-proper-motion "blink" signature this
  tool visualizes with SPHEREx instead. UGPS 0722-05 sits near the
  celestial equator (Dec -5.7°), so it transits near the zenith from
  Barranquilla specifically, not just "somewhere in the south" -- a
  concrete, locally-relevant target for the LATAM/citizen-science framing
  the challenge asks for.

- **The frontend's direct-coordinate search path parses sexagesimal input
  client-side (`frontend/src/coords.ts`) instead of blindly `Number()`-
  converting it.** — Reason, found by re-reading the task's own
  requirement ("sexagesimal or decimal") against the code: the original
  implementation did `Number(parts[0]) || 0`, which silently turns any
  sexagesimal string (e.g. `08h55m10.831s`) into `0` instead of parsing
  it or erroring -- the backend already handled both formats correctly
  (`backend/app/coords.py`), but the frontend never actually sent the
  real value through. Fixed with a small parser mirroring the backend's
  logic, used both for live search input and for restoring `?ra=&dec=`
  from a shared URL; a clear `error.bad_coords` message replaces the
  silent fallback to `(0, 0)` on genuinely unparseable input.

- **RGB composite mode builds a separate single-band deep stack per
  channel, rather than reusing an already-stacked epoch image.** —
  Reason, found by reasoning through the data flow (not yet by visual
  inspection at the time of the fix): `stack_epoch` combines *every*
  exposure handed to it -- across all detectors present -- into one
  variance-weighted image; it has no concept of "band". The first RGB
  implementation picked "whichever epoch happens to contain detector X"
  and reused that epoch's `.image` per channel, but that image was
  already an all-detectors blend, so all three channels ended up
  identical (a grayscale image masquerading as a composite). Fixed by
  filtering the raw exposures to one detector at a time and calling
  `stack_epoch` fresh for each of the three chosen bands. A regression
  test (`test_rgb_mode_uses_a_distinct_stack_per_band`) asserts the three
  channel values at a synthetic bright pixel are actually different.
  Because this changed RGB's output, pre-cached RGB entries created
  before the fix had to be discarded and are not part of the committed
  demo cache; blink/sum/difference/spectrum/light-curve were unaffected
  (each already operated on a single already-correct stacked image, never
  needed to separate by band after stacking).

(See the rest of this file for pipeline, frontend, and target-selection
decisions, appended as each milestone lands.)
