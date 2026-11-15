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

## Submission-polish requirements (added mid-build by the team)

- **UI language default changed from "Spanish for es-\* browsers" to
  "always English unless toggled."** — Alternative: keep the original
  locale-auto-detect behavior (which was itself a deliberate, documented
  earlier decision for the LATAM angle). — Reason: the team explicitly
  asked that judges never land on Spanish by accident because of their
  own browser's locale setting. Spanish is still a full translation, one
  click (or `?lang=es`) away — this only changes what happens with no
  explicit signal from the user. Updated the one place in `SUBMISSION.md`
  that described the old auto-detect behavior to match.

- **AI-assistance disclosure added to README.md, README.es.md,
  SUBMISSION.md, a short header comment in each main source entry point
  (`backend/app/main.py`, `backend/app/service.py`, `backend/app/
  config.py`, `frontend/src/main.ts`, `scripts/precache.py`), and
  `ai-assisted` in both package manifests (`frontend/package.json`
  description/keywords; new `backend/pyproject.toml` added purely for
  this metadata, since requirements.txt has no description/keywords
  field and the backend previously had no PEP 621 manifest at all).** —
  Reason: the team wants this stated plainly and in multiple places a
  judge might look, not buried in one footnote. The wording is specific
  on purpose (code written with Claude Code under the team's direction;
  concept, requirements, and design decisions are the team's own) rather
  than a vague "AI-generated" label, because that's the actual, accurate
  division of labor on this project.

- **NASA logo/insignia audit: no changes needed.** — Checked every image
  file in the repo (only `favicon.svg`, the default Vite scaffold mark,
  unrelated to NASA) and grepped all docs/code for logo/insignia/seal
  references; every "NASA" mention in the repo is already a plain-text
  credit (e.g. "NASA/IPAC"), never an image or embedded mark. Documented
  here rather than silently assuming compliance, since the team asked for
  an explicit audit.

- **SUBMISSION.md's data-credit section split into "NASA Data" and "Space
  Agency Partner Data and Other References."** — NASA Data: SPHEREx and
  WISE/AllWISE, both NASA missions accessed via IRSA. Partner/Other:
  Gaia DR3 (ESA), Aladin Lite (CDS/Strasbourg, not a space agency), the
  open-source astropy/astroquery/reproject stack, and the literature
  proper-motion papers used for the four Gaia-invisible brown dwarfs.

- **`docs/DEMO_SCRIPT.md` is a separate file from the narrative demo
  script already embedded in `SUBMISSION.md`.** — Alternative: replace
  the existing script in SUBMISSION.md in place. — Reason: the team asked
  for a specific timestamped structure (0:00 team / 0:02 challenge / 0:05
  name+tagline / 0:10 live demo on WISE 0855 / 0:20 future impact) plus
  subtitle lines and a 7-slide alternative -- different enough in
  structure and purpose (a shot list for filming, not a narrative pitch)
  that it earns its own file; SUBMISSION.md's existing walkthrough
  (centered on Barnard's Star) stays as the written narrative version.

- **Cloud Run added as a third deploy target, alongside Render/Fly.io, not
  a replacement.** — Reason: `backend/Dockerfile` already builds a
  standard container, so `gcloud run deploy` from it is close to free to
  document and gives the team a third concrete, judge-checkable option
  without committing to any one platform.

- **`precache.py` gained a `--epoch-gap-days` override (threaded through
  `service.precache_all`/`_fetch_and_stack`, not exposed on the public
  API).** — Reason: R Draconis, at Dec +66.75° (close to the north
  ecliptic pole), turned out to have 2,529 exposures across the DR1+QR3
  baseline -- far more than any other target -- because SPHEREx's scan
  geometry revisits near the poles much more densely than near the
  ecliptic. Under the default 60-day epoch gap, that dense, near-
  continuous coverage never produces a single gap over 60 days across
  the whole ~520-day span, so it all collapsed into *one* epoch -- a
  "blink" with exactly one frame, which can't blink. Re-ran just this
  target with a 14-day gap to recover a real multi-epoch sequence,
  instead of changing the global default (which would risk re-splitting
  the other four already-good, already-cached targets' clean 3-4 epoch
  groupings for no reason, and would require re-fetching all of them
  again to verify).

- **Fly.io chosen as the actual deploy target over Google Cloud Run/Azure,
  with `backend/fly.toml` committed and `flyctl` installed.** — Reason:
  the team had already used their NASA Space Apps Google Cloud and
  Microsoft Azure credits on other projects and wasn't eligible for more,
  and neither this sandbox nor the team had gcloud/az/aws CLIs or
  credentials configured locally (checked directly: no `gcloud`, `az`, or
  `aws` binaries, no `~/.config/gcloud`, `~/.azure`, or `~/.aws`, no
  related environment variables). Fly.io's free tier needs no credit card
  and no pre-existing account, so it was the lowest-friction path to an
  actually-live deployment. Cloud Run and Azure instructions stay in the
  README as documented alternatives (the Dockerfile is portable to any of
  them unchanged) in case the team's credit situation changes later.

- **Actually deployed, not just documented.** Backend: Fly.io
  (`https://spherex-blink-backend.fly.dev`), built straight from
  `backend/Dockerfile` with `fly launch` + `fly deploy` once the team
  authenticated. Frontend: Vercel
  (`https://frontend-woad-nu-23.vercel.app`), built with
  `VITE_API_BASE` pointed at the live Fly.io backend via `vercel deploy
  --build-env`. Both verified live end-to-end (health check, a cached
  frame's metadata, and the actual PNG bytes all confirmed over HTTPS)
  before calling this done -- a submission with a dead or unverified
  "live demo" link is worse than no link at all.

- **Visual redesign grounded in the subject, not a generic facelift.**
  Palette: a night-sky indigo-black ground (`#0a0d18`) vs. a star-atlas-
  paper light ground (`#f6f3ec`); an "infrared ember" accent
  (`#e8793f`/`#a8441a`) chosen deliberately -- SPHEREx observes in
  infrared, and observatories have historically used red light to
  preserve night vision, so the accent is a real double reference, not a
  generic neon pop (explicitly avoided the "near-black with one acid-
  green/vermilion accent" cliché by giving the ember accent an actual
  reason to exist and a second, distinct cool accent for a different
  semantic role). Type: Fraunces (a characterful serif, used sparingly
  for the title and section heads only -- evokes old star-atlas/journal
  typography) + IBM Plex Sans for UI (real technical-documentation
  heritage, not the generic "Inter/Space Grotesk" default) + IBM Plex
  Mono for every numeric value (coordinates, dates, wavelengths),
  tabular-aligned. All contrast pairs verified ≥4.5:1 (text) / ≥3:1
  (focus ring, UI elements) in both themes before implementation, not
  after.
  - A quiet ambient canvas starfield (`frontend/src/components/
    starfield.ts`) is confined to the header band only -- not the whole
    page -- with gentle mouse parallax across three depth layers. It
    reads its star color from the `--text` CSS custom property at
    runtime so it inverts correctly between themes (light dots on the
    dark ground, dark dots on the light ground) instead of vanishing in
    one theme, which is what a hardcoded color would have done. It's
    pure Canvas 2D (no Three.js/WebGL), skipped entirely in low-bandwidth
    mode, and pauses its animation loop on tab-hidden; a
    prefers-reduced-motion check renders one static frame with no
    parallax and no RAF loop at all.
  - The blink viewport got an "instrument display" treatment (dark
    bezel, inset ring, soft accent-tinted glow) rather than a styling
    pass identical to every other panel, since it's the one element
    users actually watch.
  - Boldness was spent in one place (header, primary action button,
    epoch/category badges) and kept quiet everywhere else (tables,
    charts, secondary buttons) per the "scanned, not read" nature of a
    data tool -- this is editorial for the identity, informational for
    the instruments.

(See the rest of this file for pipeline, frontend, and target-selection
decisions, appended as each milestone lands.)
