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

(See the rest of this file for pipeline, frontend, and target-selection
decisions, appended as each milestone lands.)
