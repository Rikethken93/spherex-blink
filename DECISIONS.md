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

(See the rest of this file for pipeline, frontend, and target-selection
decisions, appended as each milestone lands.)
