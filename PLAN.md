# PLAN.md — SPHEREx Blink (NASA Space Apps 2026, "Planet X and SPHEREx")

## What we're building
A public web tool: enter RA/Dec or an object name, get a "blink" animation of
SPHEREx epochs over the same patch of sky (Pluto-discovery style), plus a
spectrum, a light curve, and a Gaia/AllWISE-aware sky view — so a user can see
proper motion or variability directly.

## Milestones
1. **Plan + decisions log** (this file, DECISIONS.md) — done first, updated throughout.
2. **Verify live IRSA SPHEREx access.** Confirm, by actually querying IRSA (not
   guessing), the SIA2 collection names, the cutout URL parameters, the FITS
   HDU layout (IMAGE/FLAGS/VARIANCE/ZODI/EPSF/WCS-WAVE), and the per-pixel
   wavelength solution (linear variable filter, spectral WCS key "W").
3. **Backend skeleton**: FastAPI app, `config.py` holding every IRSA base URL
   and collection name (single place to touch for a new data release).
4. **Pipeline**: epoch grouping, reprojection onto a common grid, flag masking,
   variance-weighted stacking (all-band / per-detector / wavelength-range
   modes), shared asinh/zscale stretch, blink/diff/sum/RGB renderers, spectrum
   extraction, light-curve extraction, disk cache.
5. **API endpoints**: `/api/resolve`, `/api/frames`, `/api/spectrum`,
   `/api/lightcurve`, `/api/health`, with input validation and a distinct
   "no SPHEREx coverage yet" error.
6. **Tests + lint**: pytest (epoch grouping, synthetic-moving-star reprojection
   recovery, proper-motion correction, endpoint tests against a mocked IRSA),
   ruff clean.
7. **Precache**: `scripts/precache.py` resolves the 5 required targets + 3
   southern-sky extras, applies Gaia DR3 proper motion to the SPHEREx epoch,
   queries IRSA for real, and writes the on-disk cache, which gets committed so
   the demo works offline/without hitting IRSA live.
8. **Frontend**: Vite + TS, Aladin Lite v3 side panel (Gaia DR3 + AllWISE
   overlays, PM arrow), blink/rock player, Chart.js spectrum + light curve,
   metadata table, Explore gallery, ES/EN i18n, accessibility, low-bandwidth
   mode, "how to spot a moving object" tutorial, shareable URL state, Embed
   button.
9. **Packaging**: backend Dockerfile, docker-compose.yml, frontend
   vercel.json.
10. **End-to-end verification**: run locally, hit every one of the 5 required
    targets through the real UI, Playwright screenshots into
    `docs/screenshots/`.
11. **Docs**: README.md / README.es.md (science background, architecture
    Mermaid diagram, run/deploy/upgrade instructions, credits, limitations),
    docs/SUBMISSION.md, DECISIONS.md finalized, LICENSE (MIT).

## Working rules
- Never invent SPHEREx data. Any synthetic data is confined to unit tests and
  explicitly labeled as synthetic there.
- Every external IRSA/Gaia/Simbad call gets exponential backoff and falls back
  to the on-disk cache so the tool stays usable if the archive is slow or rate
  limiting.
- Commit after each milestone.
