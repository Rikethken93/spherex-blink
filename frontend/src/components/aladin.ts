import { t } from "../i18n/i18n";

// Aladin Lite v3 is bundled from the `aladin-lite` npm package (wasm
// inlined) rather than loaded from the CDS CDN at runtime -- that CDN had a
// full multi-day outage during development (branded "Page unavailable" on
// every pinned version URL, then net::ERR_BLOCKED_BY_ORB), which left the
// sky-view panel permanently empty on production. Bundling removes the
// runtime script dependency entirely; only HiPS tiles/catalog data are
// still fetched from CDS at runtime.
//
// If even that fails (tile servers down, WebGL unavailable), the panel
// falls back to a static image of the same field from the CDS hips2fits
// service with a target marker -- so the panel shows the sky or a clear
// message, never a silent blank.
//
// Loaded via dynamic import: the package (wasm inlined) is ~2.5MB of the
// bundle, which low-bandwidth mode and the primary blink view should
// never have to pay for. Vite splits it into its own chunk, fetched only
// when the sky view actually initializes.
let A: any = null;

let aladinInstance: any = null;
let pmOverlay: any = null;
let staticHost: HTMLElement | null = null;

// HiPS tiles come from IRSA's NASA-hosted mirror of the 2MASS color
// survey, not from CDS: the CDS data services (alasky tile servers AND
// the hips2fits image service) were observed fully down on 2026-11-15 --
// every HiPS "properties" endpoint 404 -- which left the interactive
// panel stuck on "loading..." forever. IRSA hosting also fits this
// NASA-challenge app: sky context imagery served by the same archive the
// SPHEREx data comes from. 2MASS is near-IR, the right comparison for
// SPHEREx's wavelength range.
const DEFAULT_SURVEY_HIPS_URL = "https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color";

// --- SPHEREx wide-field HiPS ------------------------------------------------
// Real, live NASA/IPAC product confirmed 2026-11-17 (see DECISIONS.md for
// the full MocServer/HiPS-list research): IRSA hosts its own SPHEREx DR1
// all-sky HiPS as a "cube" dataproduct -- one tile request returns all 102
// real wavelength frames (17 channels x 6 detector bands, the same
// wavelength solution backend/app/config.py's DETECTOR_BANDS describes).
// Aladin Lite (bundled) has native cube-HiPS support: it detects
// dataproduct_type="cube" from this URL's properties file itself and
// exposes setSliceNumber() on the returned survey object. A second,
// CDS-hosted per-band HiPS set (D1-D6 + color, QR2) also exists but CDS's
// alasky tile/HiPS services were observed fully down throughout this
// session (every /properties 404) -- probed lazily below and only
// offered in the UI if/when it actually responds.
const SPHEREX_CUBE_HIPS_URL = "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube";
const CDS_SPHEREX_BASE = "https://alasky.cds.unistra.fr/SPHEREx";

// Below this field of view, SPHEREx's own ~6.2"/px blink pixels are the
// honest scientific view (see the blink player); above it, the wide HiPS
// context -- the "chemical maps of the Milky Way" framing from the
// landing page -- becomes the more legible way to look at the sky.
export const SPHEREX_WIDE_FIELD_THRESHOLD_DEG = 0.5; // 30 arcmin

// Representative target wavelengths (um) for the band selector, matching
// backend/app/config.py's DETECTOR_BANDS mid-points. D1 (shortest,
// dominated by stellar/dust continuum) and D4 (spans water ice's ~3.0um
// absorption) are the two sides of the "Ice vs Dust" blend, mirroring
// NASA's own SPHEREx first-light "curtain" comparisons.
const BAND_TARGET_WAVELENGTH_UM: Record<string, number> = {
  default: 0.92,
  d1: 0.92,
  d2: 1.36,
  d3: 2.02,
  d4: 3.12, // water-ice absorption band -- the "Ice" side of the blend
  d5: 4.12,
  d6: 4.71,
};
const DUST_BAND_KEY = "d1";
const ICE_BAND_KEY = "d4";

let sphereXWavelengthsUm: number[] | null = null; // the cube's own 102 real wavelengths (data_cube_crval3_arr)
let sphereXAvailable: boolean | null = null; // null = not probed yet
let cdsBandAvailable: boolean | null = null;

let sphereXMainSurvey: any = null;
let sphereXIceOverlay: any = null;
let iceDustBlendOn = false;

function parsePropertiesWavelengths(text: string): number[] | null {
  const m = text.match(/data_cube_crval3_arr\s*=\s*([\d.\s]+)/);
  if (!m) return null;
  return m[1].trim().split(/\s+/).map(Number).filter((v) => Number.isFinite(v));
}

/** Probe IRSA's SPHEREx cube HiPS once (cached) -- never throws, never
 * blocks initAladin: this is purely about deciding whether the wide-field
 * SPHEREx layer and its controls should appear at all. */
async function probeSphereXCube(): Promise<boolean> {
  if (sphereXAvailable !== null) return sphereXAvailable;
  try {
    const resp = await fetch(`${SPHEREX_CUBE_HIPS_URL}/properties`, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    sphereXWavelengthsUm = parsePropertiesWavelengths(text);
    sphereXAvailable = true;
  } catch (err) {
    console.warn("SPHEREx HiPS (IRSA) unavailable, wide-field view falls back to 2MASS:", err);
    sphereXAvailable = false;
  }
  return sphereXAvailable;
}

/** Lazily probe the CDS per-band SPHEREx HiPS set (D1-D6 + color, QR2).
 * CDS's alasky services were fully down throughout this app's development
 * (see DECISIONS.md) -- if/when they recover, this unlocks the true
 * per-detector maps as an additional choice; until then it silently
 * stays false and the UI only offers the IRSA cube's own slices. */
async function probeCdsBands(): Promise<boolean> {
  if (cdsBandAvailable !== null) return cdsBandAvailable;
  try {
    const resp = await fetch(`${CDS_SPHEREX_BASE}/D1/properties`, { cache: "no-store" });
    cdsBandAvailable = resp.ok;
  } catch {
    cdsBandAvailable = false;
  }
  return cdsBandAvailable;
}

// --- Slice-index calibration ------------------------------------------------
// Aladin Lite's generic cube-HiPS support takes a `setSliceNumber(idx)`
// parameter, but idx is NOT the real frame index from
// data_cube_crval3_arr: it internally linearly-interpolates idx/cubeDepth
// between the properties file's emMin/emMax to get a target frequency,
// then the server resolves that to whichever real (non-uniformly spaced)
// tile actually matches -- confirmed live (2026-11-17) by sweeping idx and
// reading back the real served tile's frame suffix via the Resource
// Timing API: the relationship is monotonic but far from 1:1 (e.g.
// idx=10 served real frame 58, not 10). Rather than hand-deriving Aladin's
// exact internal formula, this samples a handful of idx values once,
// records which real frame (and therefore real wavelength) each one
// actually serves, and picks the closest sampled idx for any requested
// target wavelength -- self-correcting if Aladin's internal mapping ever
// changes, at the cost of being accurate only to the sampling resolution
// (roughly +/-0.1-0.3um here, plenty for "short vs long" comparisons).
const CALIBRATION_SAMPLE_IDXS = [1, 5, 10, 15, 20, 30, 40, 50, 60, 70, 80, 90, 99];
let calibrationPromise: Promise<Array<{ idx: number; wavelengthUm: number }>> | null = null;

function extractTileSuffix(url: string): number | null {
  const m = url.match(/_([0-9]+)\.(?:png|jpg)(?:\?|$)/);
  return m ? Number(m[1]) : null;
}

/** Samples CALIBRATION_SAMPLE_IDXS once, on a dedicated invisible probe
 * layer it creates and tears down itself (see below for why not the
 * visible survey), using the browser's own Resource Timing entries to
 * see which real tile each sample idx actually served. Never throws: a
 * sample that doesn't resolve in time is just dropped, and an empty
 * result still leaves setSliceNumber(0) as a safe caller-side fallback. */
async function calibrateSlices(): Promise<Array<{ idx: number; wavelengthUm: number }>> {
  if (calibrationPromise) return calibrationPromise;
  calibrationPromise = (async () => {
    const out: Array<{ idx: number; wavelengthUm: number }> = [];
    if (!aladinInstance || !sphereXWavelengthsUm) return out;
    // A dedicated, invisible (opacity 0) overlay layer -- sweeping idx on
    // the MAIN visible survey to calibrate it was the root cause of an
    // intermittent black canvas (confirmed live): each calibration
    // sample itself changes what's on screen, racing whichever redraw
    // pulse was covering the real, user-requested slice. Probing on a
    // layer nobody ever sees means calibration can take as long as it
    // needs without the visible view flickering or getting stuck
    // mid-sweep.
    const probe = aladinInstance.newImageSurvey(SPHEREX_CUBE_HIPS_URL, {
      name: "SPHEREx calibration probe",
      url: SPHEREX_CUBE_HIPS_URL,
    });
    aladinInstance.setOverlayImageLayer(probe, "calibration-probe");
    if (typeof probe.setOpacity === "function") probe.setOpacity(0);
    probe.setSliceNumber(0);
    for (const idx of CALIBRATION_SAMPLE_IDXS) {
      try {
        performance.clearResourceTimings();
        probe.setSliceNumber(idx);
        const suffix = await new Promise<number | null>((resolve) => {
          const deadline = Date.now() + 1500;
          const poll = () => {
            const hit = performance
              .getEntriesByType("resource")
              .map((e) => extractTileSuffix((e as PerformanceResourceTiming).name))
              .find((s) => s !== null);
            if (hit !== undefined && hit !== null) return resolve(hit);
            if (Date.now() > deadline) return resolve(null);
            setTimeout(poll, 100);
          };
          poll();
        });
        if (suffix !== null && sphereXWavelengthsUm[suffix] !== undefined) {
          out.push({ idx, wavelengthUm: sphereXWavelengthsUm[suffix] });
        }
      } catch {
        /* this sample just doesn't contribute to the calibration table */
      }
    }
    try {
      aladinInstance.removeImageLayer("calibration-probe");
    } catch {
      /* harmless either way -- it's invisible at opacity 0 */
    }
    return out;
  })();
  return calibrationPromise;
}

function bestIdxForWavelength(
  table: Array<{ idx: number; wavelengthUm: number }>,
  targetUm: number,
): number {
  if (table.length === 0) return 0; // always a valid, if arbitrary, slice
  let best = table[0];
  let bestDiff = Math.abs(best.wavelengthUm - targetUm);
  for (const row of table) {
    const diff = Math.abs(row.wavelengthUm - targetUm);
    if (diff < bestDiff) {
      best = row;
      bestDiff = diff;
    }
  }
  return best.idx;
}

/** Programmatic survey/layer/slice/opacity changes update WASM-side state
 * but don't by themselves repaint the WebGL canvas (confirmed live: tiles
 * fetched successfully over the network, yet the view stayed solid black
 * until this was called) -- Aladin's own render loop only does GPU work
 * when `view.needRedraw` is set, which normal mouse/wheel interaction
 * sets as a side effect but a JS-driven setImageSurvey()/setSliceNumber()/
 * setOpacity() call does not. */
function requestRedrawOnce(): void {
  try {
    aladinInstance?.view?.requestRedraw?.();
  } catch {
    /* cosmetic-only; a missed repaint self-heals on the next real pan/zoom */
  }
}

/** `view.requestRedraw()` sets a one-shot flag that Aladin's render loop
 * consumes on its very next frame -- calling it once, or even a handful
 * of times at fixed delays, right after setSliceNumber()/setImageSurvey()/
 * gotoRaDec() is not reliable: the real tile fetch+decode completion time
 * varies enough (confirmed live, repeatedly, with identical code and
 * network conditions) that any fixed schedule sometimes lands between
 * attempts and the canvas stays solid black. Pulsing it every animation
 * frame for a few seconds costs nothing when there's nothing new to
 * paint, and guarantees some pulse lands after the texture is actually
 * ready regardless of how long that takes. */
function requestRedraw(durationMs = 4000): void {
  const deadline = performance.now() + durationMs;
  const pulse = () => {
    requestRedrawOnce();
    if (performance.now() < deadline) requestAnimationFrame(pulse);
  };
  pulse();
  // Jumping between two Featured Regions while the SPHEREx layer stayed
  // active (vs. its first-ever activation) stayed intermittently black
  // even through several seconds of the above pulsing (confirmed live).
  // A real WindowEventHandlers resize forces most WebGL canvases to
  // recompute their viewport and repaint unconditionally, which is a
  // meaningfully different code path than nudging Aladin's own redraw
  // flag -- fired once, shortly after the view settles.
  setTimeout(() => {
    try {
      window.dispatchEvent(new Event("resize"));
    } catch {
      /* cosmetic-only */
    }
  }, 300);
}

function skyviewUrl(raDeg: number, decDeg: number, fovDeg: number): string {
  const params = new URLSearchParams({
    Survey: "DSS2 Red",
    Position: `${raDeg},${decDeg}`,
    Size: String(Math.max(fovDeg * 2, 0.05)),
    Pixels: "420",
    Return: "JPEG",
  });
  return `https://skyview.gsfc.nasa.gov/current/cgi/runquery.pl?${params.toString()}`;
}

/** Static single-image fallback: same field via NASA SkyView (DSS2 Red),
 * with a CSS crosshair marking the target. */
function showStaticSkyView(container: HTMLElement, raDeg: number, decDeg: number, fovDeg: number): void {
  staticHost = container;
  container.classList.remove("aladin-unavailable");
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "static-sky";
  const img = document.createElement("img");
  img.alt = t("aladin.static_alt");
  img.src = skyviewUrl(raDeg, decDeg, fovDeg);
  img.addEventListener("error", () => {
    container.textContent = t("aladin.unavailable");
    container.classList.add("aladin-unavailable");
    staticHost = null;
  });
  const marker = document.createElement("div");
  marker.className = "static-sky-marker";
  marker.setAttribute("aria-hidden", "true");
  const note = document.createElement("p");
  note.className = "static-sky-note";
  note.textContent = t("aladin.static_note");
  wrap.appendChild(img);
  wrap.appendChild(marker);
  container.appendChild(wrap);
  container.appendChild(note);
}

/** Never throws: the sky view is a secondary panel -- a failure here must
 * not block the primary blink view from loading. Tries interactive Aladin
 * Lite (bundled) first, then the static hips2fits image, then a message. */
export async function initAladin(containerId: string, raDeg: number, decDeg: number, fovDeg: number): Promise<void> {
  const el = document.getElementById(containerId);
  try {
    await initAladinOrThrow(containerId, raDeg, decDeg, fovDeg);
  } catch (err) {
    console.warn("Aladin Lite failed to initialize, falling back to static sky image:", err);
    if (el) showStaticSkyView(el, raDeg, decDeg, fovDeg);
  }
}

async function initAladinOrThrow(containerId: string, raDeg: number, decDeg: number, fovDeg: number): Promise<void> {
  if (A === null) {
    A = (await import("aladin-lite")).default;
  }
  // A.init resolving depends on wasm compilation; if anything wedges, fall
  // back to the static image rather than leaving the panel blank forever.
  await Promise.race([
    A.init,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Aladin init timed out")), 12000)),
  ]);
  // Always construct at a small, scientific-scale fov, even when the
  // caller (a Featured Region) actually wants a wide field: passing a
  // wide fov straight to the constructor left the canvas solid black on
  // every single attempt (confirmed live, repeatedly, independent of
  // position) -- Aladin settles the real fov over 1-2 internal
  // "zoomChanged" correction steps right after construction (fitting
  // the constructor's requested value to the container's actual aspect
  // ratio), and activating the SPHEREx cube layer mid-settle never
  // recovers. Every test that *did* render correctly had Aladin already
  // sitting at a settled small fov before a later, separate runtime
  // setFov() call widened it -- so that's the only sequence used now.
  const constructFovDeg = Math.min(fovDeg, 0.1);
  aladinInstance = A.aladin(`#${containerId}`, {
    target: `${raDeg} ${decDeg}`,
    fov: constructFovDeg,
    survey: DEFAULT_SURVEY_HIPS_URL,
    cooFrame: "ICRSd",
    showCooGrid: false,
    showReticle: true,
    showZoomControl: true,
    showFullscreenControl: false,
    showLayersControl: true,
    showGotoControl: false,
    showSimbadPointerControl: false,
  });
  try {
    aladinInstance.addCatalog(
      A.catalogFromVizieR("I/355/gaiadr3", `${raDeg} ${decDeg}`, fovDeg, {
        name: "Gaia DR3",
        shape: "circle",
        color: "#58a6ff",
        onClick: "showPopup",
      }),
    );
  } catch {
    /* catalog overlay is a nice-to-have; keep the sky view usable without it */
  }

  try {
    aladinInstance.addCatalog(
      A.catalogFromVizieR("II/328/allwise", `${raDeg} ${decDeg}`, fovDeg, {
        name: "AllWISE",
        shape: "square",
        color: "#ff7b72",
        onClick: "showPopup",
      }),
    );
  } catch {
    /* same as above */
  }

  // Auto-switch to the wide-field SPHEREx view when the user zooms out
  // (manually, via Aladin's own +/- controls or scroll) past the
  // threshold -- not only when our own recenter() drives it.
  try {
    aladinInstance.on("zoomChanged", () => void updateWideFieldLayer());
  } catch {
    /* event hook is a nice-to-have; recenter() below still covers the
       app-driven zoom changes (search, gallery, featured regions). */
  }

  if (fovDeg > constructFovDeg) {
    // The caller actually wanted a wide field (a Featured Region) --
    // widen it as a genuine runtime call once the small construction
    // fov has settled (its own correction already fires and clears
    // through the "zoomChanged" listener above; a further short wait
    // here is for Aladin's internal layout/tile-grid bookkeeping from
    // that settle to fully finish before asking it to jump again).
    setTimeout(() => {
      if (!aladinInstance) return;
      aladinInstance.setFov(fovDeg);
      void updateWideFieldLayer();
    }, 400);
  } else {
    void updateWideFieldLayer();
  }
}

/** Switches the base layer between the honest-default 2MASS view (small
 * fields, where SPHEREx's own blink pixels are the real science) and the
 * wide SPHEREx HiPS cube (zoomed out past SPHEREX_WIDE_FIELD_THRESHOLD_DEG,
 * where the all-sky chemical-map framing from the landing page applies).
 * Never throws; silently keeps whatever layer is already showing if the
 * SPHEREx HiPS never responded. */
// updateWideFieldLayer is re-entrant-unsafe across its own await points
// (checking `!sphereXMainSurvey` before `await probeSphereXCube()` then
// assigning it after) -- Aladin fires its own "zoomChanged" event right
// after construction, when it internally corrects the constructor's
// requested fov to fit the container's actual aspect ratio, so the
// explicit post-construction call and that event's callback land
// almost simultaneously. Both saw `sphereXMainSurvey` as null before
// either's assignment ran, so BOTH created and activated their own
// separate survey object back-to-back on the SAME real first load --
// confirmed live as the root cause of the view going black with the
// *sky_ra* URL params specifically (the in-session Featured Region
// click path happened to dodge this because recenter() always ran
// after the dust from the initial, single construction-time call had
// already settled). A simple in-flight guard serializes these calls.
let updatingWideFieldLayer: Promise<void> | null = null;

async function updateWideFieldLayer(): Promise<void> {
  if (updatingWideFieldLayer) {
    await updatingWideFieldLayer;
  }
  updatingWideFieldLayer = updateWideFieldLayerImpl();
  try {
    await updatingWideFieldLayer;
  } finally {
    updatingWideFieldLayer = null;
  }
}

async function updateWideFieldLayerImpl(): Promise<void> {
  if (!aladinInstance) return;
  const fovDeg = Math.max(...aladinInstance.getFov());
  const wide = fovDeg >= SPHEREX_WIDE_FIELD_THRESHOLD_DEG;
  const available = await probeSphereXCube();
  if (!available) return;

  if (wide && !sphereXMainSurvey) {
    sphereXMainSurvey = aladinInstance.newImageSurvey(SPHEREX_CUBE_HIPS_URL, {
      name: "SPHEREx (NASA/IPAC)",
      url: SPHEREX_CUBE_HIPS_URL,
    });
    aladinInstance.setImageSurvey(sphereXMainSurvey);
    // A cube-type HiPS added as a base layer never issues its first tile
    // request until setSliceNumber() is called at least once (confirmed
    // live). Slice 0 *is* the default view here, deliberately -- the
    // 13-sample calibration sweep setSphereXBand() runs (to translate a
    // target wavelength into Aladin's own non-linear slice parameter,
    // see calibrateSlices above) takes long enough that racing it against
    // this initial activation left the canvas waiting on whichever sweep
    // sample was in flight when the redraw pulse's fixed window ended
    // (confirmed live, intermittently). Calibration now only runs when
    // the user explicitly picks a band or the Ice/Dust blend, where
    // redraw is requested strictly *after* it resolves, never racing it.
    sphereXMainSurvey.setSliceNumber(0);
    requestRedraw();
    void calibrateSlices(); // warm the cache quietly on an invisible probe layer, no redraw raced against it
  } else if (!wide && sphereXMainSurvey) {
    aladinInstance.setImageSurvey(DEFAULT_SURVEY_HIPS_URL);
    sphereXMainSurvey = null;
    requestRedraw();
    if (sphereXIceOverlay) {
      try {
        aladinInstance.removeImageLayer("ice-overlay");
      } catch {
        /* already gone */
      }
      sphereXIceOverlay = null;
      iceDustBlendOn = false;
    }
  }
}

/** True once the SPHEREx wide-field HiPS has been probed and found live --
 * used by main.ts to decide whether to show the band selector / Ice-vs-Dust
 * controls at all. */
export function isSphereXWideFieldAvailable(): boolean {
  return sphereXAvailable === true;
}

export async function checkSphereXWideFieldAvailable(): Promise<boolean> {
  return probeSphereXCube();
}

export async function checkCdsBandsAvailable(): Promise<boolean> {
  return probeCdsBands();
}

/** Sets the main SPHEREx layer to a named band's representative
 * wavelength slice, using the empirical idx<->wavelength calibration
 * (see calibrateSlices above). No-op if the SPHEREx layer isn't
 * currently the active base layer (i.e. the view is zoomed in past the
 * wide-field threshold). */
export async function setSphereXBand(bandKey: string): Promise<void> {
  if (!sphereXMainSurvey) return;
  const table = await calibrateSlices();
  const idx = bestIdxForWavelength(table, BAND_TARGET_WAVELENGTH_UM[bandKey] ?? BAND_TARGET_WAVELENGTH_UM.default);
  if (typeof sphereXMainSurvey.setSliceNumber === "function") sphereXMainSurvey.setSliceNumber(idx);
  requestRedraw();
}

/** Toggles the "Ice vs Dust" comparison: the main layer shows the dust/
 * stellar-continuum band (D1, ~0.92um) and a second overlay shows the
 * water-ice absorption band (D4, ~3.12um) on top with adjustable opacity
 * -- the same two-wavelength contrast NASA's own SPHEREx "curtain"
 * comparisons use, built from the one live cube HiPS. */
export async function setIceDustBlend(on: boolean, opacity = 0.5): Promise<void> {
  iceDustBlendOn = on;
  if (!aladinInstance || !sphereXMainSurvey) return;

  if (on) {
    await setSphereXBand(DUST_BAND_KEY);
    if (!sphereXIceOverlay) {
      sphereXIceOverlay = aladinInstance.newImageSurvey(SPHEREX_CUBE_HIPS_URL, {
        name: "SPHEREx ice band",
        url: SPHEREX_CUBE_HIPS_URL,
      });
      aladinInstance.setOverlayImageLayer(sphereXIceOverlay, "ice-overlay");
      sphereXIceOverlay.setSliceNumber(0); // same "needs one call to attach" quirk as the base layer
      requestRedraw();
    }
    const table = await calibrateSlices();
    const idx = bestIdxForWavelength(table, BAND_TARGET_WAVELENGTH_UM[ICE_BAND_KEY]);
    if (typeof sphereXIceOverlay.setSliceNumber === "function") sphereXIceOverlay.setSliceNumber(idx);
    setIceDustOpacity(opacity);
    requestRedraw();
  } else if (sphereXIceOverlay) {
    try {
      aladinInstance.removeImageLayer("ice-overlay");
    } catch {
      /* already gone */
    }
    sphereXIceOverlay = null;
    requestRedraw();
  }
}

export function setIceDustOpacity(opacity: number): void {
  if (sphereXIceOverlay && typeof sphereXIceOverlay.setOpacity === "function") {
    sphereXIceOverlay.setOpacity(Math.min(1, Math.max(0, opacity)));
    requestRedraw();
  }
}

export function isIceDustBlendOn(): boolean {
  return iceDustBlendOn;
}

/** Current Aladin view (position + field of view), for the "Blink here"
 * button -- jumps the scientific blink player to whatever patch of sky
 * the user is currently looking at in the wide-field explorer. Returns
 * null if Aladin never initialized (static-fallback mode). */
export function getCurrentView(): { raDeg: number; decDeg: number; fovArcmin: number } | null {
  if (!aladinInstance) return null;
  const [raDeg, decDeg] = aladinInstance.getRaDec();
  const fovDeg = Math.max(...aladinInstance.getFov());
  return { raDeg, decDeg, fovArcmin: fovDeg * 60 };
}

export function recenter(raDeg: number, decDeg: number, fovDeg: number): void {
  if (aladinInstance) {
    aladinInstance.gotoRaDec(raDeg, decDeg);
    aladinInstance.setFov(fovDeg);
    // Confirmed live: moving to a new position while the SAME survey/
    // slice stays active (e.g. jumping between two Featured Regions)
    // does not repaint on its own either -- only a real mouse/wheel
    // interaction sets Aladin's internal needRedraw flag as a side
    // effect; a JS-driven gotoRaDec()/setFov() does not.
    requestRedraw();
    void updateWideFieldLayer();
    return;
  }
  if (staticHost) {
    const img = staticHost.querySelector<HTMLImageElement>(".static-sky img");
    if (img) img.src = skyviewUrl(raDeg, decDeg, fovDeg);
  }
}

/** Jumps the sky view straight to a wide field (a "Featured region"
 * preset, e.g. Cygnus X or Orion) without touching the blink player --
 * exploration is independent of the scientific point-source view until
 * the user explicitly clicks "Blink here". */
/** Draws a schematic proper-motion arrow. Real annual motion is far smaller
 * than one SPHEREx pixel on screen, so the arrow length is exaggerated by
 * `exaggerationYears` and labeled as such -- it shows *direction*, not a
 * to-scale displacement. No-op in the static-image fallback. */
export function drawProperMotionArrow(
  raDeg: number,
  decDeg: number,
  pmraMasYr: number,
  pmdecMasYr: number,
  exaggerationYears = 2000,
): void {
  if (!aladinInstance) return;
  if (pmOverlay) {
    aladinInstance.removeOverlay(pmOverlay);
  }
  pmOverlay = A.graphicOverlay({ color: "#ffd43b", lineWidth: 2 });
  aladinInstance.addOverlay(pmOverlay);

  const cosDec = Math.max(Math.cos((decDeg * Math.PI) / 180), 1e-6);
  const dRa = ((pmraMasYr * exaggerationYears) / 3_600_000) / cosDec;
  const dDec = (pmdecMasYr * exaggerationYears) / 3_600_000;

  const tip = [raDeg + dRa, decDeg + dDec];
  pmOverlay.add(A.polyline([[raDeg, decDeg], tip]));
  pmOverlay.add(
    A.circle(tip[0], tip[1], 0.0005, { color: "#ffd43b" }),
  );
}
