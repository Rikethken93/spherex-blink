# NASA Space Apps Challenge 2026 — "Planet X and SPHEREx" — Submission

**Live demo:** https://frontend-woad-nu-23.vercel.app
**Backend health check:** https://spherex-blink-backend.fly.dev/api/health
**Repository:** see `README.md` for local run / build instructions.

## Project summary (~100 words)

SPHEREx Blink turns NASA's SPHEREx all-sky infrared archive into a live
blink comparator — the same technique Clyde Tombaugh used to discover
Pluto in 1930, and that NASA's Backyard Worlds citizen-science project uses
today. Type a star's name or a sky position, and the tool resolves it
(correcting for proper motion so fast-moving targets stay centered),
fetches every real SPHEREx exposure covering that patch of sky, aligns and
stacks them by observing epoch, and plays them back frame by frame so
motion and brightness changes jump out visually — alongside a real
per-pixel spectrum and a light curve, both pulled from the same data.

## Impact

Citizen scientists have already found real brown dwarfs and plausible
Planet Nine candidates by blinking WISE images by eye. SPHEREx adds a
second, independent all-sky infrared dataset with a built-in spectrum at
every pixel (its linear variable filters mean wavelength changes smoothly
across each detector) — something WISE's broadband filters never offered.
SPHEREx Blink is the tool that lets anyone, not just a mission scientist
with TAP query experience, point this new dataset at the sky and see
motion and variability directly, without installing anything.

## Creativity

- The "rock" playback mode (forward-then-backward loop) is literally how a
  mechanical blink comparator worked — a nod to Tombaugh's original
  technique, implemented as a UI toggle instead of a physical switch.
- Four render modes (blink, difference, deep stack, RGB composite) are
  all derived from the exact same aligned, variance-weighted epoch stacks
  — no mode requires its own separate data pipeline.
- A clicked pixel becomes a real spectrum *and* feeds a light curve,
  because a SPHEREx cutout's FLAGS/VARIANCE/WCS-WAVE extensions already
  carry everything needed for both — the tool just has to ask the right
  questions of data that was already downloaded for the blink view.

## Scientific validity

- Every data-access decision was verified live against the real IRSA
  archive during development, not assumed from documentation (see
  `DECISIONS.md`): the SIA2 collection names, the cutout URL parameters,
  the 7-HDU FITS layout, and the spectral WCS used for per-pixel
  wavelength.
- Pixels flagged for a real defect (cosmic ray, saturation, hot/cold pixel,
  etc. — every bit in the SPHEREx L2 FLAGS word except SOURCE, which just
  marks "a catalogued source is here" and is kept) are masked before
  stacking; combination is a proper variance-weighted mean, not a naive
  average.
- Proper-motion correction is necessary, not decorative: Barnard's Star
  moves 10.3"/yr — about 1.7 SPHEREx pixels per year — so a static
  catalog position would visibly drift out of a small field of view within
  a few years. The tool applies real Gaia DR3 astrometry (or, for the
  brown dwarfs too faint/red for Gaia, published literature proper
  motions) propagated to the actual SPHEREx observing epoch.
- Every frame in a blink/diff/sum/RGB sequence shares one normalization
  (asinh + zscale) computed across the whole sequence, so apparent
  brightness changes in the animation reflect the data, not a
  per-frame rescaling artifact.

## Relevance to the challenge

The challenge asks for a tool built on SPHEREx data that helps find moving
or variable objects — candidate signatures of undiscovered solar-system
bodies (a "Planet X") or substellar neighbors. This tool is exactly that
search interface: enter a position, blink the epochs, and a real target
(nearby star, brown dwarf, or variable) visibly declares itself by moving
or changing brightness, with a spectrum and light curve to help confirm
what's being seen.

## LATAM / citizen-science angle

- **Language**: the UI is fully bilingual (English/Spanish). It defaults
  to English (so judges always land on English regardless of browser
  locale), with Spanish one click away via the language toggle or a
  `?lang=es` link — a full translation, not just a few strings, built for
  Spanish-speaking users in the region this tool is partly aimed at.
- **Low bandwidth**: a dedicated low-bandwidth mode (smaller frames, lazy
  loading) targets 3G-class connections, since reliable high-speed
  broadband isn't universal across Latin America.
- **Southern-sky targets**: three of the eight built-in demo targets
  (Proxima Centauri, Luhman 16 AB, UGPS 0722-05) were chosen specifically
  because they're well-placed in the sky from Barranquilla's latitude
  (~11°N) and the wider southern-hemisphere/equatorial band — the same
  patch of sky many LATAM amateur astronomers and students can actually
  look up at.
- **No install, no account**: the tool is a public URL; a student with a
  phone and a slow connection can use the exact same tool as a judge
  reviewing the submission.

## 30-second demo video script

1. (0:00-0:05) Open the app; type "Barnard's Star"; it resolves and the
   blink animation loads.
2. (0:05-0:15) Hit play. Narrate: "This is a real NASA SPHEREx infrared
   image, blinking between separate SPHEREx observing epochs. Watch the
   star near the crosshair — it's the fastest-moving star in the sky."
   Point out the visible jump between frames.
3. (0:15-0:20) Click the star in the image; the spectrum chart appears.
   "Every SPHEREx pixel carries its own wavelength — that's a real,
   extracted spectrum, not a stock image."
4. (0:20-0:27) Switch to the Explore gallery; click RW Aurigae. "This one
   doesn't move — it flickers. That's a real variable star, not an
   animation artifact — same stack, same stretch."
5. (0:27-0:30) Toggle to Spanish; show the embed button. "Bilingual,
   embeddable, and it runs on a 3G connection in low-bandwidth mode."

## NASA Data

- **SPHEREx** Level-2 spectral images (NASA/IPAC Infrared Science Archive,
  collections `spherex_dr1`, `spherex_dr1_deep`, `spherex_qr3`,
  `spherex_qr3_deep`). SPHEREx is a NASA Astrophysics Small Explorer
  mission (JPL/Caltech).
- **WISE / AllWISE** (NASA/IPAC): the sky-view catalog overlay, and, for
  several brown-dwarf targets, the discovery-paper astrometry used as a
  literature proper-motion fallback where no Gaia DR3 solution exists
  (WISE 0855-0714, Luhman 16 AB, UGPS 0722-05 were all WISE/UKIDSS
  discoveries).

## Space Agency Partner Data and Other References

- **Gaia DR3** (ESA/Gaia/DPAC), accessed via NASA/IPAC IRSA's Gaia TAP
  service — proper motions and the sky-view catalog overlay.
- **Aladin Lite** (CDS, Centre de Données astronomiques de Strasbourg /
  Observatoire astronomique de Strasbourg) — the sky-view panel.
- **astropy, astroquery, reproject** (open-source scientific Python
  community) — WCS handling, archive queries, and image reprojection.
- Literature proper motions for targets without a Gaia DR3 solution:
  Luhman & Esplin (2014) for WISE 0855-0714; Bedin et al. (2017/2018) for
  Luhman 16 AB; Lucas et al. (2010) for UGPS 0722-05; McCaughrean et al.
  (2004) for Epsilon Indi Ba/Bb (see `backend/app/targets.py` for the
  full citation on each).

## AI assistance

This project's code was written with [Claude Code](https://claude.com/claude-code)
(Anthropic) under the team's direction. The team specified every data
source, pipeline design choice, and UI/UX requirement, and verified each
one against the real IRSA/Gaia archives during development (the full
reasoning behind each decision — including several real bugs found and
fixed along the way — is logged in `DECISIONS.md`). The concept (a
SPHEREx blink comparator), the target selection, the LATAM/accessibility
framing, and the overall design are the team's own.
