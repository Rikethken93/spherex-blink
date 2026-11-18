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

- Redesign deployed to production (Vercel deployment
  `dpl_HqqQz4Nbhendogo581pNujuRgwuY`, aliased to
  https://frontend-woad-nu-23.vercel.app) and verified live with a
  Playwright screenshot against the production URL itself (not just the
  local dev server): Fraunces/IBM Plex fonts, the ember/cyan accent
  pair, and the header starfield all render correctly from the CDN
  build; a live WISE 0855-0714 search against the Fly.io backend
  returned real cached data (3 epochs, spectrum, light curve) rendered
  in the new styling. The Aladin CDN outage noted earlier in this file
  is still handled by the same graceful fallback panel, now restyled
  to match (dashed border, monospace message) rather than left in the
  old look.
- `docs/screenshots/*.png` were regenerated after the redesign so the
  images referenced from SUBMISSION.md and DEMO_SCRIPT.md match what
  judges will actually see on the live site, instead of the pre-redesign
  styling.

- Bug report ("is not loading well") traced to two real issues, both
  fixed and redeployed:
  1. Any cache-miss search (switching mode on a target whose non-blink
     modes weren't precached, typing raw coordinates, or changing the
     field of view) falls through to a live IRSA fetch. IRSA is
     genuinely flaky right now (frequent 503s, confirmed live), so this
     can take over two minutes -- and the UI only ever showed a static
     "…" the whole time, which reads as a hung page rather than a slow
     one. Fixed in `frontend/src/main.ts` (`beginLoading()`): the status
     line now switches to an explicit "still working, fetching live
     data, can take up to a couple of minutes" message after 6 seconds,
     in both `en.json` and `es.json`.
  2. Three of the eight gallery targets (Proxima Centauri, Luhman 16,
     UGPS 0722) had only `blink` mode precached from an earlier run --
     `sum`/`difference`/`rgb` were missing entirely, so switching mode
     on any of those cards guaranteed the slow live-fetch path above.
     Backfilled via `scripts/precache.py --targets
     proxima-centauri,luhman-16,ugps0722 --modes sum,difference,rgb`;
     all 8 targets x all 4 modes are now cache hits (verified live,
     mostly <1s, worst case ~8s during a Fly.io cold start).
  Both fixes verified against the production URLs after redeploying
  the backend (new cache baked into the image) and the frontend.

- Live end-to-end QA added (`scripts/qa_live.ts`, root-level `package.json`
  with `playwright` + `axe-core` as QA-only devDependencies, kept separate
  from `backend/` and `frontend/`'s own dependency trees): headless
  Chromium exercises the real production frontend and backend -- no
  mocking -- across landing-page health, all 8 targets x 4 modes, URL
  params, name search, spectrum/light-curve, FOV changes, an uncached
  coordinate, invalid input, the embed snippet, a 390px mobile viewport,
  backend health/CORS, and an axe-core accessibility scan. Written in
  TypeScript and run directly via Node 22's built-in type-stripping (no
  build step, no `ts-node`/`tsx` dependency).
  - Result: 52/58 checks passed, 0 reproducible application bugs. The 4
    apparent failures were investigated by hand (direct `curl` + `fly
    logs`) and all trace to one external cause: Fly.io's free-trial plan
    force-kills every machine after 5 minutes of continuous uptime,
    independent of in-flight requests -- confirmed via the exact
    `runner[...] Trial machine stopping` log line, which can otherwise be
    misread as an OOM kill (the kernel log phrases it that way, but the
    preceding line names the real cause and `anon-rss` was nowhere near
    the 512MB limit). This is **not fixable by changing application code**
    -- flagged to the team as a decision that needs a human call (add a
    payment method to Fly to lift the cap, or accept the risk for the
    judging window). See docs/qa/QA_REPORT.md for the full investigation.
  - Two bugs were found and fixed in the QA script itself before trusting
    its results: it asserted Play/Pause always toggles, when
    `player.ts`'s `play()` deliberately no-ops below 2 frames (single-frame
    `sum`/`difference`/`rgb` results correctly never animate); and it
    assumed `/api/lightcurve` returns a bare array, when it actually
    returns `{ra_deg, dec_deg, points: [...]}` like `/api/spectrum` does.
    Recorded here as a reminder that a failing automated check is a lead
    to investigate, not an automatic bug report -- the harness's own
    assumptions are also a potential point of failure.

- User reported the live site "feels slow" (2026-11-15). Investigated live
  and found a real, currently-active bug: `/api/resolve` had no cache of
  its own, unlike `/api/frames`/`/api/spectrum`/`/api/lightcurve` -- every
  single name search re-ran a live Gaia DR3 cone search, and Gaia's TAP
  endpoint was genuinely unreachable at the time (observed directly:
  `[Errno 110] Connection timed out` and `[Errno -5] No address associated
  with hostname`, each retry taking well over a minute with
  `with_backoff`'s default 6 retries -- a multi-minute hang per request,
  every request, for every Gaia-PM target (4 of the 5 required targets).
  Fixed in `backend/app/main.py`: a short in-memory TTL cache on
  `/api/resolve` (15 min for a successful resolve, 60s for a failure) --
  safe because even Barnard's Star, the fastest-moving target here, drifts
  ~0.0003" in 15 minutes, three orders of magnitude below this app's own
  0.36" position rounding. Also halved Gaia's retry budget
  (`resolve.py`'s `gaia_pm_lookup`, 6 -> 3) so even the first, uncached
  request during a real outage fails/falls-back faster rather than
  compounding to the full multi-minute worst case. Verified live:
  `resolve_target_with_fallback`'s existing graceful-degradation path
  (fall back to Sesame's static position with a warning when Gaia is
  genuinely unreachable) kicked in and got cached, so repeat searches for
  the same name return in ~0.3-0.4s instead of hanging every time.
  - Note: during a real Gaia outage, the overall "search by name" flow for
    an affected target is still slow (~2 minutes observed for Barnard's
    Star) because the Sesame fallback position differs from the
    Gaia-PM-corrected position baked into the precache, so `/api/frames`
    still cache-misses and pays a genuine live IRSA fetch -- this is the
    same, already-accepted and already-communicated (progressive
    loading-message) IRSA-flakiness tradeoff from the prior session, not a
    new issue. What's fixed is that the *resolve* step itself no longer
    hangs repeatedly; what's not fixable is Gaia (or IRSA) itself being
    down, which is outside this app's control.

- User flagged a screenshot looking blurry/low-detail ("no se ve muy
  grande") (2026-11-15). Root cause: SPHEREx's real pixel scale is ~6.2"/
  pixel, so a 3' field of view is a genuine ~29x29px native image (checked
  directly: `naturalWidth`/`naturalHeight` on the live `.blink-frame` were
  29x29) -- `.blink-frame` CSS had no `image-rendering` rule in its default
  state (only in `.zoomed` and `body.low-bandwidth`), so the browser's
  default smooth upscaling to fill a ~300-600px viewport blurred that
  handful of real pixels into mush, which reads as "not much detail" even
  though the detail genuinely isn't there to begin with -- a 29px source
  can't look sharp at 600px no matter what, but smooth interpolation makes
  it look like missing/broken data instead of what it is: a real,
  low-resolution instrument's native output. Moved `image-rendering:
  pixelated` into the base `.blink-frame` rule (always on, not just
  zoomed/low-bandwidth) -- crisp nearest-neighbor scaling shows the actual
  pixels honestly, which also reads better against the "instrument
  display" bezel/glow treatment the redesign already gave this element.
  Verified live: `getComputedStyle(...).imageRendering === "pixelated"` on
  production, visually crisp square pixels instead of a blurred blob.

- Follow-up to the `/api/resolve` fix above: the Gaia outage turned out to
  be worse than first measured. A single attempt was observed live taking
  anywhere from ~2 to ~5 minutes to fail (not the sub-2-minute figure a
  plain OS TCP timeout would suggest -- astroquery's TAP+ client appears to
  make more than one internal round-trip before surfacing one exception),
  so the earlier 3-retry budget could still compound to 10+ minutes during
  a sustained outage, and separately, the resulting pile of concurrent
  overlapping requests (several retries x several simultaneous searches)
  OOM-killed the backend machine once (confirmed via `fly logs`: genuine
  `anon-rss` near the 512MB limit this time, not the trial-timer kill from
  the earlier entry). Cut Gaia's retry budget to 1 (`resolve.py`): during a
  real outage, a retry is not "a second chance at a flaky connection", it
  is "wait several more minutes for the identical failure again" -- one
  attempt, then straight to the static-position fallback, bounds the worst
  case to one outage-length wait instead of multiplying it. Verified live:
  a cold resolve for Barnard's Star during the live outage completed in
  146s (previously compounding past 5+ minutes with the 3-retry budget),
  fell back correctly with its warning, and was cached -- a repeat request
  immediately after returned in 0.28s, and the full search-by-name flow
  (resolve + the live IRSA frames fetch the fallback position still
  requires) completed end-to-end on the production site.

- User reported a screenshot still looking "distorted", not just small
  (2026-11-15), after the earlier CSS pixelated-rendering fix. Root cause
  was deeper than CSS: `render.py` drew the proper-motion crosshair at a
  *fixed pixel size* (6px arm) directly onto the native array before any
  scaling -- on a genuine ~29x29px cutout (SPHEREx's ~6.2"/pixel scale at
  a 3' FOV), that crosshair spans more than half the frame, reading as a
  big red blob rather than a small marker. Fixed in
  `backend/app/pipeline/render.py`: added `_upsample_nearest()` (nearest-
  neighbor block-repeat, matching the CSS `pixelated` treatment -- crisp
  real pixels, not invented smooth detail) that brings every rendered
  frame (`_png_bytes_gray`, `render_difference`, `render_rgb`) up to a
  sane minimum on-screen size *before* `_draw_crosshair` runs, so the
  marker is drawn proportionally correct regardless of the native cutout
  size (which varies 10-145px across this app's 1'-15' FOV range).
  Verified live after redeploying + re-running `scripts/precache.py`
  (the fix only affects newly-rendered PNGs -- cached ones needed
  regenerating, since the Docker image bakes `backend/cache/` in at build
  time): Barnard's Star blink mode now renders at 406x406 with a small,
  correctly-proportioned crosshair instead of 29x29 with an oversized one.
  - Re-running precache hit two more live-archive problems the same day:
    Gaia DR3 fell back to the static Sesame position again (still the
    ongoing outage from the earlier entry), and IRSA's own SIA capabilities
    endpoint started returning a flat `502` mid-session (confirmed
    directly: `curl .../SIA/capabilities` -> 502), which is a distinct,
    harder failure than the SIA cutout-fetch flakiness seen earlier --
    blocked backfilling RGB mode for 7 of the 8 targets (blink/sum/
    difference for all 8, and everything for R Draconis, did complete
    before IRSA went down). RGB mode for those 7 targets will still show
    the old small-crosshair image until IRSA recovers and the backfill is
    re-run (`scripts/precache.py --targets
    barnards-star,epsilon-indi-b,wise0855,rw-aurigae,proxima-centauri,
    luhman-16,ugps0722 --modes rgb`).

- Follow-up to the crosshair/upsampling fix: the viewer could still read
  as soft because CSS `width:100%` stretches the backend's own (already
  integer-upscaled) PNG to whatever width a responsive container happens
  to be -- essentially never an exact multiple of the PNG's own pixel
  grid, which reintroduces a non-integer scale even with
  `image-rendering: pixelated` set. Fixed end to end:
  1. `frontend/src/components/player.ts` now measures the loaded image's
     natural size on every frame swap and sets an explicit pixel width/
     height equal to the nearest whole multiple of that size (capped at
     `MAX_DISPLAY_PX = 640` so it can't blow up on a wide screen), instead
     of leaving it to CSS. Re-applied on window resize.
  2. `image-rendering: crisp-edges` added ahead of the existing
     `pixelated` as a fallback for engines that only recognize the older
     keyword (the later declaration wins where both are supported).
  3. A "Smooth" checkbox (default off, same opt-in posture as the
     existing Zoom checkbox) lets anyone who prefers the browser's
     interpolated look opt into `image-rendering: auto` instead.
  4. A small scale bar ("1′", or "30″" below ~20px/arcmin so it stays
     legible at a tight FOV) and a one-line note ("Each square is one
     SPHEREx pixel (~6″)...") in EN/ES make the real pixel scale explicit
     rather than leaving a viewer to guess whether the blockiness is a
     bug.
  5. The app's default field of view moved from 3' to 6'
     (`backend/app/config.py FOV_DEFAULT_ARCMIN`, `frontend/src/
     state.ts`, `index.html`'s fov input) -- 3' was only ~29 native
     SPHEREx pixels across; 6' (~58) gives meaningfully more context
     around a target without losing visible proper motion for this app's
     demo targets. `scripts/precache.py` gained a `--fov` flag (default
     now matching the app's 6') instead of a hardcoded constant.
  The crosshair (baked into the PNG, see the earlier fix) and the Gaia
  proper-motion arrow (a separate Aladin sky-view overlay, unaffected by
  blink-image CSS) both stay correctly aligned -- verified visually at
  both FOVs.
  - Re-precached 6 of 8 targets at fov=6 (blink/sum/difference) during a
    window where IRSA recovered; `ugps0722` and `r-draconis` still need a
    fov=6 precache run once IRSA's SIA capabilities endpoint (still
    flapping between `200` and `502` today) stays up long enough -- until
    then, searching those two at the new 6' default falls through to a
    live fetch rather than an instant cache hit, same honest tradeoff as
    every other uncached-position case in this app.
  - Verified live with Playwright at both 3' and 6' on WISE 0855-0714 and
    Barnard's Star (screenshots): integer display/natural-size ratio
    is exactly 1 in all four cases (no residual non-integer stretch), the
    scale bar correctly halves in on-screen length from 3' to 6' (same
    display width now spans twice the sky), and the Smooth checkbox
    correctly flips `image-rendering` from `pixelated` to `auto` and back.

(See the rest of this file for pipeline, frontend, and target-selection
decisions, appended as each milestone lands.)

## Final-day fixes (2026-11-15, submission day)

- **Root-caused the "Proxima looks blurry/black-cored/off-centre" report
  to three independent, compounding causes** (full writeup with
  before/after images: `docs/qa/BLUR_DIAGNOSIS.md`): (1) proper motion
  silently not applied -- the ongoing Gaia TAP outage made Proxima and
  Barnard's Star fall back to static J2000 positions, confirmed by the
  live SIA logs (`POS=CIRCLE 217.429 -62.6795` *is* Proxima's J2000
  position, ~98" from its 2026 position; Barnard's is ~269" off --
  outside a 6' half-width entirely); (2) the ZScale display stretch,
  which in a galactic-latitude -2 field amplifies the noise floor into
  wall-to-wall fake "stars"; (3) saturated bright-star cores (OVERFLOW/
  SUR_ERROR/BLOOM/NONLINEAR flags confirmed set in every real exposure's
  core pixels) masked to NaN and then filled with the stretch minimum --
  a pure black blob exactly on the star. The displayed "blur" was the sum
  of these, not a resampling bug: the reprojection grid was already at
  SPHEREx's native 6.2"/px, PNGs lossless, display scaling integer.

- **Gaia DR3 astrometry for Proxima Centauri and Barnard's Star is now
  cached locally in `targets.py`** (source_ids 5853498713190525696 /
  4472832130942575872, ref_epoch 2016.0 positions + proper motions),
  flowing through the same `known_pm` path as the literature-PM brown
  dwarfs. — Alternative: keep the live Gaia TAP lookup and hope the
  outage ends. — Reason: the outage was observed again today from this
  network (both ESA TAP and TAPVizieR timing out); a demo target's
  scientific correctness cannot depend on a third-party service being up
  at judging time. Live Gaia lookup remains for arbitrary name searches.
  Regression tests pin the J2000->survey-epoch displacements (~98" and
  ~265-270", `tests/test_proper_motion.py`).

- **Proper motion now propagates to the survey mid-epoch
  ((2025.3+2026.6)/2), not `Time.now()`.** — Reason: the blinked frames
  span the DR1+QR3 window; centring on its midpoint splits a mover's
  drift evenly across the sequence instead of biasing it toward the last
  epoch, and (unlike "now") it doesn't drift between precache time and
  request time, so precached positions and live resolutions agree
  permanently.

- **`/api/frames|spectrum|lightcurve` snap to a precached position within
  20" (same FOV, and mode where applicable)** instead of treating a
  sub-arcsecond difference between a live resolution and the precached
  centre as a cache miss that triggers a multi-minute live IRSA fetch.
  20" is ~3 SPHEREx pixels -- invisible at the app's FOV range but wide
  enough to absorb resolution-path differences. The response's
  ra/dec are the cache's own, so the crosshair stays truthful.

- **Stretch: ZScale -> asinh over a 1-99.5 percentile clip computed
  across all frames of a sequence** (`pipeline/stretch.py`), still one
  shared normalization per sequence so blinking doesn't flicker; plus a
  client-side Contrast slider (CSS `filter: contrast()`, cached PNGs
  untouched).

- **Saturated cores render white with a thin red outline; other
  fully-masked pixels render dark grey; "Saturated core" is surfaced in
  the epoch metadata table.** New `config.FLAG_SATURATION_BITMASK`
  (OVERFLOW/SUR_ERROR/NONLINEAR/BLOOM, bit meanings confirmed from the
  `MSKNnnnn` keywords in the real FLAGS HDUs). A covered-but-empty pixel
  is "saturated" when >=30% of covering exposures flagged it saturated.
  Tests: `tests/test_saturation.py`.

- **Reprojection switched from bilinear `reproject_interp` to
  `reproject_adaptive`** (anti-aliased DeForest resampling,
  `conserve_flux=False` for MJy/sr surface-brightness data) for
  image/variance; masks reproject nearest-neighbor, and the mask
  reprojection's footprint provides the *geometric* coverage needed to
  classify saturated cores (adaptive's own footprint is zero where the
  masked input was NaN -- discovered when the first classification
  attempt silently produced zero saturated pixels on real data).

- **Spectrum extraction falls back to the nearest usable pixel within a
  radius-2 neighborhood when the exact target pixel is flagged in an
  exposure.** — Reason, found immediately after the PM fix: with Proxima
  finally centred, the centre pixel is its *saturated core* in every
  exposure, and the strict "skip flagged" rule produced a 0-point
  spectrum for the demo's headline target. A PSF-wing spectrum is biased
  in absolute flux but preserves spectral shape -- better than an empty
  panel, and honestly derived from unflagged pixels.

- **Aladin Lite is now bundled from the `aladin-lite` npm package
  (dynamic import, own Vite chunk) instead of loaded from the CDS CDN at
  runtime; on any init failure (12s timeout included) the panel falls
  back to a static CDS hips2fits image (2MASS color) of the same field
  with a centre marker, and only shows the "unavailable" text if even
  that image fails.** — Reason: the CDN outage this week left the panel
  permanently empty on production; bundling removes the script
  dependency entirely (the frontend has no CSP that would block the
  inlined wasm -- verified `vercel.json` sets none), and hips2fits was
  confirmed reachable today even while the Aladin CDN path was not. The
  2.6MB aladin chunk is code-split so the primary blink view and
  low-bandwidth mode never download it.

- **FOV state sync (Problem 4):** gallery picks now try the FOV in the
  input first, then the standard 6'->3' preference, and when the served
  FOV differs from the requested one the input, URL and scale bar all
  follow the *served* value, with an explicit status note. `loadAndShow`
  additionally trusts the backend's `fov_arcmin` echo over the request.

- **Dim "J2000" marker in the blink viewport** (player checkbox, on by
  default): a dashed circle at the target's epoch-2000 position computed
  from its proper motion, hidden automatically when outside the frame
  (e.g. Barnard's Star at 6', whose 270" displacement doesn't fit). The
  gap between the marker and the crosshair is the accumulated proper
  motion this app corrects for -- the pedagogical point of the tool.

- **`/api/targets` fills a cached position's null pm fields from the
  target's own cached/literature PM** -- older manifest entries recorded
  null when the precache run resolved through a fallback path, which
  silently disabled the frontend's PM arrow and J2000 marker.

- **Re-precache scope:** Proxima + Barnard re-fetched live at corrected
  positions (FOV 3' and 6', all four modes + spectrum/light curve) --
  IRSA was 502/503-flapping throughout but completed under retry/backoff
  with 2-way concurrency and jitter. All other targets re-rendered from
  the local raw-exposure cache at their existing (correct) positions.

- Follow-up to the user's "loads slow and looks blurrier" report
  (2026-11-15 evening), both reproduced and fixed live:
  1. **Slow:** Fly scale-to-zero (`min_machines_running = 0`) made every
     first visit pay a cold start (6.2s observed for /api/health; the
     first page load occasionally erroring while the proxy woke a
     machine). With the trial cap already lifted, `fly.toml` now keeps
     one machine warm (`min_machines_running = 1`) through judging.
  2. **Blurrier:** two compounding display regressions/latent bugs.
     (a) The new Contrast slider attached `filter: contrast(1)` to the
     image by default -- a no-op mathematically, but a filter forces the
     element into its own composited layer where the engine can
     re-rasterize it; the filter now only attaches while the slider is
     away from 1. (b) The whole-device-pixel alignment in `player.ts`
     applied its correction on top of an *unrounded* base margin and
     re-derived it from an already-corrected state on each call -- not
     idempotent, so any later reflow (the new Notes column/status text)
     or an odd-width container left the image edge on a half pixel
     (observed live: a constant -0.5px), which softens `pixelated`
     rendering everywhere. Rewrote it to reset margins, measure, and
     place the edge on a whole pixel in one deterministic step, plus a
     single re-align pass 250ms after each frame load to absorb late
     reflows. Verified on production at devicePixelRatio 1 and 2:
     fracLeft/fracTop exactly 0, `filter: none`, frame visible in ~1.7s.

- Second follow-up to the blurriness report: the user's screen runs
  fractional display scaling (~165%), where the previous integer-scaling
  logic -- correct in *CSS* pixels -- still mapped each image pixel onto
  1.67 *physical* pixels, rendering uneven softened blocks. The user's
  screenshots (17:45/17:56) also predated both earlier fixes (deployed
  17:52/18:02) in a session holding the old JS bundle. `player.ts` now
  does all integer math in device pixels (whole device pixels per image
  pixel, edge snapped to a whole device pixel, converting back to
  possibly-fractional CSS px), verified live at devicePixelRatio 1.25,
  1.65 and 2: exactly 1/2/3 device px per image pixel, edge fraction
  <=0.013 device px. Note for the record: UGPS 0722 in sum mode at 3'
  (the view in the user's screenshots) is a genuine 29x29-native-pixel
  image of a faint field -- it looks soft because the data is that
  coarse, which the on-page pixel note already explains; the dramatic
  before/after is on Proxima/Barnard blink.

- Play-button UX (user report "no da play", 2026-11-15 evening): the
  user was in RGB-composite mode, where the product is a single image
  and play() correctly no-ops -- but a button that silently does nothing
  reads as broken. Clicking Play with fewer than 2 frames now explains
  itself in the status line ("this mode produces a single image --
  switch Mode to Blink to animate", EN/ES) instead of doing nothing.
  Blink playback itself verified advancing live (frame_0->1->2 loop at
  the default 2 fps) right after deploying.

- "The first version looked better" (user, 2026-11-15 evening): the
  soft, photographic look of the pre-fix build was the browser's smooth
  upscaling -- aesthetically pleasing, scientifically dishonest about
  where the data's resolution ends. Rather than re-defaulting to it
  (the task spec explicitly requires Smooth default OFF), the Smooth
  checkbox + Contrast slider now persist in the URL and the share/embed
  links (&smooth=1&contrast=1.4), so the team can hand judges a demo
  link that opens with the soft look while the app's own default stays
  honest-pixels. Verified live: the parameterized URL opens with
  image-rendering:auto, contrast(1.4), both controls reflecting it.

- Brightness slider added next to Contrast (user kept preferring the
  original ZScale look, 2026-11-15 evening): the first build's "rich"
  appearance came from ZScale lifting faint sources (and noise) into
  view. Rather than reverting the scientifically-honest percentile
  stretch baked into the cached PNGs, a client-side brightness filter
  (same composited-layer guard as contrast, URL-persisted as &bright=)
  recovers that dense luminous look on demand -- smooth=1&contrast=1.2&
  bright=1.9 closely reproduces the v1 aesthetic on Proxima with the
  star correctly centred. Defaults remain honest (no filter, pixelated).

- Sky-view tiles moved off CDS entirely (user report "no muestra el
  cielo", 2026-11-15 evening): the CDS outage turned out to cover the
  tile servers and hips2fits too (every alasky.cds.unistra.fr HiPS
  "properties" endpoint and a live hips2fits query all returned 404),
  so the bundled Aladin initialized but hung on "P/DSS2/color
  loading..." forever. The interactive view now loads the 2MASS color
  HiPS from IRSA's NASA-hosted mirror (probed 200 live; also the right
  wavelength context for an infrared mission, and pleasingly the same
  archive the SPHEREx data comes from), and the static fallback image
  now comes from NASA SkyView (DSS2 Red; probed live, real JPEG) instead
  of CDS hips2fits. Verified on production: the Proxima field renders
  dense 2MASS color imagery with the reticle on target. VizieR catalog
  overlays (Gaia/AllWISE dots) still depend on CDS and will reappear
  when it recovers -- they are wrapped in try/catch and degrade quietly.

## Post-submission bugfix (2026-11-16, committed after the deadline, not yet deployed)

- **Empty light-curve chart on saturated targets (Proxima Centauri,
  Barnard's Star, R Draconis) fixed honestly.** Root cause: the 2-px
  photometry aperture sits on the target's saturated core, every pixel is
  (correctly) masked, so /api/lightcurve returns flux null for every
  epoch -- and the frontend silently drew an empty axis frame. No
  photometry is invented from saturated pixels; instead: (1) the chart
  plots only epochs with finite flux, shows "N epoch(s) saturated" when
  some are missing, and replaces the empty chart with a clear EN/ES
  explanation when none are measurable; (2) the light curve now follows
  the clicked pixel exactly like the spectrum does (/api/lightcurve
  at_ra/at_dec), measured on per-field stacked-epoch npz caches
  (backend/cache/stack/, ~620KB total for all 14 fields, committed) so a
  click never re-fetches from IRSA; (3) regression tests
  (tests/test_lightcurve_saturated.py) pin the null-flux JSON contract,
  the offset-aperture behavior, and the out-of-frame edge case. Verified
  in the local UI on proxima-centauri, barnards-star, r-draconis
  (saturation message), rw-aurigae (real curve), and a clicked Proxima
  neighbor (real curve at the clicked position). Labeled transparently
  as a post-deadline bugfix; deploy deliberately held for the team's
  explicit go-ahead.

## "Explore the sky" feature reverted (2026-11-17, same evening)

The wide-field SPHEREx feature above was built, deployed, and then
**reverted** (`git revert` of both its commits, non-destructive) after
the user reported the live production symptom directly ("Sky view no
carga en zoom out") and I reproduced it exactly via the real Aladin
zoom-out control (not just Featured Region navigation): the canvas goes
solid black the moment the SPHEREx layer activates, in a real browser,
not only in this session's sandboxed Playwright.

**Root cause, finally correctly isolated**: with `SPHEREX_WIDE_FIELD_
THRESHOLD_DEG` temporarily set absurdly high (disabling SPHEREx
entirely), the exact same 2MASS layer, through the exact same zoom
sequence, out to the exact same 33 degree field, rendered perfectly --
proving conclusively this was never a generic "wide zoom" or
SwiftShader/sandbox limitation (the caveat written earlier in this file
was wrong; corrected here). Swapping the activation target to the
*same, already-working* 2MASS HiPS URL through the *exact* SPHEREx
activation code path (identical overlay creation, `setSliceNumber`,
redraw) also rendered perfectly -- isolating the bug to the real
SPHEREx cube's own tile data/slicing specifically, not this app's
layer-management code. One genuine bug *was* found and fixed along the
way (`setSliceNumber(0)` -- used everywhere as the "force the first
tile request" nudge -- maps to real frame 102, one past the cube's
valid 0-101 range, 404ing on every tile unconditionally; fixed to
`setSliceNumber(1)`, confirmed individually to map to a real, loading
frame). That fix alone was not sufficient: the exact same 20-click
zoom-out reproduction still went black afterward, suggesting the
idx<->real-frame mapping calibrated at one position/order does not
hold at every order Aladin requests while zooming continuously through
a wide range -- a deeper, order-dependent inconsistency in how this
specific cube HiPS's tiles interact with Aladin's generic cube-slicing
machinery that needs a fundamentally different investigation (likely:
either a different calibration *per order*, or abandoning Aladin's
built-in cube-slice mechanism for this particular HiPS and requesting
tiles some other way) rather than another targeted patch.

Given real users (confirmed: the team, in their own browser, not just
this sandbox) could hit a solid-black sky-view panel simply by zooming
out -- the one interaction the landing page's own new one-liner told
them to try -- shipping it broken was worse than not shipping it.
Reverted to the last known-good state (sky view always shows 2MASS,
the pre-existing, thoroughly reliable behavior) rather than leave a
half-disabled, confusing intermediate state live. All of the research,
the real discovery that a genuine live NASA SPHEREx HiPS exists at
IRSA, and every dead end explored, stays recorded above and in the two
reverted commits' history (`1b85ceb`, `5d52488`, and their reverts
`cc6f24b`, `712a4e5`) for whoever picks this back up -- the HiPS
discovery, the calibration technique, and the per-zoom-redraw fix are
all still genuinely useful groundwork; what's missing is a correct,
order-robust way to pick a valid slice for *this* cube specifically.
