// AI-assisted: written with Claude Code (Anthropic) under the team's
// direction; concept, requirements, and design decisions are the team's
// own. See DECISIONS.md and README.md ("AI assistance") for details.
// Fraunces: display face, used sparingly (title + section heads).
import "@fontsource/fraunces/600.css";
import "@fontsource/fraunces/600-italic.css";
// IBM Plex Sans: UI/body text.
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
// IBM Plex Mono: coordinates, dates, wavelengths -- anywhere digits align.
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./style.css";
import { initStarfield } from "./components/starfield";
import { ApiError, getFrames, getLightCurve, getSpectrum, getTargets, resolveName, frameUrl } from "./api";
import { parseRaDeg, parseDecDeg } from "./coords";
import type { TargetInfo } from "./api";
import { applyTranslations, setLang, getLang, t } from "./i18n/i18n";
import { readStateFromUrl, writeStateToUrl, embedSnippet } from "./state";
import type { AppState } from "./state";
import { BlinkPlayer } from "./components/player";
import {
  initAladin,
  recenter,
  drawProperMotionArrow,
  checkSphereXWideFieldAvailable,
  getCurrentView,
  setSphereXBand,
  setIceDustBlend,
  setIceDustOpacity,
} from "./components/aladin";
import { renderSpectrum, renderLightCurve } from "./components/charts";
import { renderGallery } from "./components/gallery";
import { renderMetadataTable } from "./components/metadata-table";
import { setupTutorialDialog } from "./components/tutorial";

let state: AppState = readStateFromUrl();
let currentTargets: TargetInfo[] = [];
let currentCenter: { ra: number; dec: number; fov: number } | null = null;

// Midpoint of the SPHEREx DR1+QR3 observing window -- matches
// backend/app/resolve.py's survey_mid_epoch(), which is the epoch every
// target position is propagated to. Used to place the dim "J2000" marker
// (where the target was at epoch 2000.0) relative to the current position.
const SURVEY_MID_EPOCH = (2025.3 + 2026.6) / 2;

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const statusEl = el<HTMLParagraphElement>("status-message");
const searchForm = el<HTMLFormElement>("search-form");
const searchInput = el<HTMLInputElement>("search-input");
const fovInput = el<HTMLInputElement>("fov-input");
const modeSelect = el<HTMLSelectElement>("mode-select");
const blinkContainer = el<HTMLDivElement>("blink-container");
const metadataHost = el<HTMLDivElement>("metadata-host");

const player = new BlinkPlayer(blinkContainer, {
  onImageClick: (fracX, fracY) => void handleImageClick(fracX, fracY),
});

// Attach the CSS filter only while it actually does something -- see
// .blink-container.contrasted in style.css for why a no-op filter still
// costs sharpness.
function applyDisplayFilters(): void {
  const active = state.contrast !== 1 || state.brightness !== 1;
  blinkContainer.classList.toggle("contrasted", active);
  blinkContainer.style.setProperty("--frame-contrast", String(state.contrast));
  blinkContainer.style.setProperty("--frame-brightness", String(state.brightness));
}

async function handleImageClick(fracX: number, fracY: number): Promise<void> {
  if (!currentCenter) return;
  const { ra, dec, fov } = currentCenter;
  const fovDeg = fov / 60;
  // North-up, east-left convention (matches the backend's render.py,
  // which flips the array vertically and uses a negative RA CDELT): left
  // edge = highest RA, top edge = highest Dec.
  const cosDec = Math.max(Math.cos((dec * Math.PI) / 180), 1e-6);
  const clickRa = ra + (0.5 - fracX) * fovDeg / cosDec;
  const clickDec = dec + (0.5 - fracY) * fovDeg;

  // The light curve follows the clicked position the same way the
  // spectrum does: photometry on the field's cached stacked epochs at
  // that pixel (at_ra/at_dec), so clicking a neighbor of a saturated
  // star shows that neighbor's real curve.
  void getLightCurve(ra, dec, fov, clickRa, clickDec)
    .then((lightcurve) => {
      renderLightCurve(
        el<HTMLCanvasElement>("lightcurve-canvas"),
        lightcurve.points,
        el<HTMLParagraphElement>("lightcurve-message"),
      );
      el<HTMLParagraphElement>("lightcurve-pos").textContent =
        `${t("lightcurve.at")} ${clickRa.toFixed(5)}, ${clickDec.toFixed(5)}`;
    })
    .catch(() => {
      /* off-coverage click: keep the previous curve rather than erroring */
    });

  try {
    const spectrum = await getSpectrum(clickRa, clickDec, fov);
    renderSpectrum(el<HTMLCanvasElement>("spectrum-canvas"), spectrum.points);
  } catch {
    /* clicking off-source or outside coverage just yields an empty/failed spectrum */
  }
}

function setStatus(message: string): void {
  statusEl.textContent = message;
}

let loadingTimer: ReturnType<typeof setTimeout> | undefined;

// Cache misses trigger a live fetch from IRSA, which can take over a
// minute (the archive is occasionally slow/flaky -- see net.py). A bare
// "…" that never changes reads as a hung page, so switch to a message
// that explains the wait once it's gone on for a few seconds.
function beginLoading(): () => void {
  setStatus(t("status.loading"));
  clearTimeout(loadingTimer);
  loadingTimer = setTimeout(() => setStatus(t("status.loading_slow")), 6000);
  return () => clearTimeout(loadingTimer);
}

function applyLang(lang: string): void {
  setLang(lang);
  state.lang = lang;
  applyTranslations();
  el<HTMLButtonElement>("lang-toggle").querySelector("span")!.textContent =
    getLang() === "es" ? "English" : "Español";
}

async function loadAndShow(raDeg: number, decDeg: number, fovArcmin: number, mode: string): Promise<void> {
  const stopLoading = beginLoading();
  player.setJ2000Marker(null);
  try {
    const result = await getFrames(raDeg, decDeg, fovArcmin, mode);
    stopLoading();
    // Problem-4 guard: trust what the backend actually served. If the
    // served FOV ever differs from the requested one, the URL, the input
    // and the displayed scale bar must all follow it, not the request.
    const servedFov = result.fov_arcmin ?? fovArcmin;
    if (servedFov !== fovArcmin) {
      state.fov = servedFov;
      fovInput.value = String(servedFov);
      writeStateToUrl(state);
    }
    player.setFrames(result.frame_urls.map(frameUrl), servedFov);
    renderMetadataTable(metadataHost, result.epochs);
    setStatus(
      `${result.n_exposures_total} exposures -> ${result.epochs.length} epoch(s)` +
        (result.cache_hit ? " (cached)" : ""),
    );
    recenter(raDeg, decDeg, fovArcmin / 60);
    // Used by handleImageClick to convert a click position back to a sky
    // position; the spectrum view itself only loads on click (see below),
    // starting with the target center so the panel isn't empty at first.
    currentCenter = { ra: raDeg, dec: decDeg, fov: fovArcmin };
    if (!state.lowBandwidth) {
      // Also loads the light curve at the centre via the clicked-position
      // path -- no separate duplicate fetch needed.
      void handleImageClick(0.5, 0.5);
    } else {
      try {
        const lightcurve = await getLightCurve(raDeg, decDeg, fovArcmin);
        renderLightCurve(
          el<HTMLCanvasElement>("lightcurve-canvas"),
          lightcurve.points,
          el<HTMLParagraphElement>("lightcurve-message"),
        );
        el<HTMLParagraphElement>("lightcurve-pos").textContent =
          `${t("lightcurve.at")} ${raDeg.toFixed(5)}, ${decDeg.toFixed(5)}`;
      } catch {
        /* same as above */
      }
    }
  } catch (err) {
    stopLoading();
    if (err instanceof ApiError && err.status === 404) {
      setStatus(t("error.no_coverage"));
    } else if (err instanceof ApiError && err.status === 503) {
      setStatus(t("error.upstream"));
    } else {
      setStatus(t("error.generic"));
    }
  }
}

// Shared by the live-resolve path (runSearch) and the cache-manifest path
// (onGalleryPick) -- both end up with the same four things (position,
// FOV, optional proper motion, optional warning) and need to do the same
// thing with them: update the URL, load the frames, draw the PM arrow.
async function showResolvedTarget(
  raDeg: number,
  decDeg: number,
  fovArcmin: number,
  mode: string,
  pmraMasYr: number | null,
  pmdecMasYr: number | null,
  warning: string | null,
): Promise<void> {
  state.ra = String(raDeg);
  state.dec = String(decDeg);
  state.fov = fovArcmin;
  fovInput.value = String(fovArcmin);
  writeStateToUrl(state);
  if (warning) setStatus(warning);
  await loadAndShow(raDeg, decDeg, fovArcmin, mode);
  if (pmraMasYr != null && pmdecMasYr != null) {
    drawProperMotionArrow(raDeg, decDeg, pmraMasYr, pmdecMasYr);
    // Dim marker at the target's J2000.0 position: makes the accumulated
    // proper motion since 2000 (the whole reason this app corrects
    // positions) directly visible next to the crosshair.
    const dtYr = SURVEY_MID_EPOCH - 2000.0;
    const cosDec = Math.max(Math.cos((decDeg * Math.PI) / 180), 1e-6);
    const raJ2000 = raDeg - (pmraMasYr * dtYr) / 3_600_000 / cosDec;
    const decJ2000 = decDeg - (pmdecMasYr * dtYr) / 3_600_000;
    const fovDeg = state.fov / 60;
    player.setJ2000Marker({
      x: 0.5 - ((raJ2000 - raDeg) * cosDec) / fovDeg,
      y: 0.5 - (decJ2000 - decDeg) / fovDeg,
    });
  }
}

async function runSearch(query: string, fov: number, mode: string): Promise<void> {
  state.fov = fov;
  state.mode = mode;

  const looksLikeCoords = /^[+-]?\d|^\d+h/.test(query.trim());
  if (looksLikeCoords) {
    const parts = query.split(/[\s,]+/).filter(Boolean);
    if (parts.length >= 2) {
      const ra = parseRaDeg(parts[0]);
      const dec = parseDecDeg(parts[1]);
      if (ra === null || dec === null) {
        setStatus(t("error.bad_coords"));
        return;
      }
      state.ra = parts[0];
      state.dec = parts[1];
      writeStateToUrl(state);
      await loadAndShow(ra, dec, fov, mode);
      return;
    }
  }

  const stopLoading = beginLoading();
  try {
    const resolved = await resolveName(query);
    stopLoading();
    await showResolvedTarget(
      resolved.ra_deg, resolved.dec_deg, fov, mode, resolved.pmra_mas_yr, resolved.pmdec_mas_yr, resolved.warning,
    );
  } catch {
    stopLoading();
    setStatus(t("error.generic"));
  }
}

function wireSearchForm(): void {
  searchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const query = searchInput.value.trim();
    if (!query) return;
    void runSearch(query, Number(fovInput.value), modeSelect.value);
  });
}

function wirePlayerControls(): void {
  el<HTMLButtonElement>("player-playpause").addEventListener("click", () => {
    // Deep stack / Difference / RGB produce a single image -- play()
    // correctly no-ops there, but a button that silently does nothing
    // reads as broken. Say why, and point at the mode that animates.
    if (player.frameCount() < 2) {
      setStatus(t("player.single_frame_hint"));
      return;
    }
    player.togglePlay();
    el<HTMLButtonElement>("player-playpause").textContent = player.isPlaying() ? t("player.pause") : t("player.play");
  });
  el<HTMLButtonElement>("player-prev").addEventListener("click", () => player.stepPrev());
  el<HTMLButtonElement>("player-next").addEventListener("click", () => player.stepNext());
  el<HTMLInputElement>("player-speed").addEventListener("input", (e) => {
    player.setSpeed(Number((e.target as HTMLInputElement).value));
  });
  el<HTMLInputElement>("player-rock").addEventListener("change", (e) => {
    player.setRockMode((e.target as HTMLInputElement).checked);
  });
  el<HTMLInputElement>("player-loop").addEventListener("change", (e) => {
    player.setLoop((e.target as HTMLInputElement).checked);
  });
  el<HTMLInputElement>("player-zoom").addEventListener("change", (e) => {
    blinkContainer.classList.toggle("zoomed", (e.target as HTMLInputElement).checked);
  });
  el<HTMLInputElement>("player-smooth").addEventListener("change", (e) => {
    state.smooth = (e.target as HTMLInputElement).checked;
    blinkContainer.classList.toggle("smooth", state.smooth);
    writeStateToUrl(state);
  });
  el<HTMLInputElement>("player-contrast").addEventListener("input", (e) => {
    state.contrast = Number((e.target as HTMLInputElement).value) || 1;
    applyDisplayFilters();
    writeStateToUrl(state);
  });
  el<HTMLInputElement>("player-brightness").addEventListener("input", (e) => {
    state.brightness = Number((e.target as HTMLInputElement).value) || 1;
    applyDisplayFilters();
    writeStateToUrl(state);
  });
  el<HTMLInputElement>("player-j2000").addEventListener("change", (e) => {
    player.setJ2000MarkerEnabled((e.target as HTMLInputElement).checked);
  });

  blinkContainer.addEventListener("keydown", (e) => {
    if (e.key === " ") {
      e.preventDefault();
      el<HTMLButtonElement>("player-playpause").click();
    } else if (e.key === "ArrowRight") {
      player.stepNext();
    } else if (e.key === "ArrowLeft") {
      player.stepPrev();
    }
  });
}

function wireLangAndBandwidthToggles(): void {
  el<HTMLButtonElement>("lang-toggle").addEventListener("click", () => {
    applyLang(getLang() === "es" ? "en" : "es");
    writeStateToUrl(state);
    // The gallery's target names/notes/categories are baked into innerHTML
    // at render time (not data-i18n attributes), so applyTranslations()
    // alone won't re-localize it -- re-render explicitly.
    renderGallery(el<HTMLDivElement>("gallery-host"), currentTargets, onGalleryPick);
  });

  const lowbwBtn = el<HTMLButtonElement>("lowbw-toggle");
  lowbwBtn.addEventListener("click", () => {
    state.lowBandwidth = !state.lowBandwidth;
    lowbwBtn.setAttribute("aria-pressed", String(state.lowBandwidth));
    document.body.classList.toggle("low-bandwidth", state.lowBandwidth);
    writeStateToUrl(state);
  });
}

function wireEmbedDialog(): void {
  const dialog = el<HTMLDialogElement>("embed-dialog");
  el<HTMLButtonElement>("embed-button").addEventListener("click", () => {
    el<HTMLTextAreaElement>("embed-code").value = embedSnippet(state);
    dialog.showModal();
    void navigator.clipboard?.writeText(embedSnippet(state)).then(() => setStatus(t("embed.copied")));
  });
  el<HTMLButtonElement>("embed-close").addEventListener("click", () => dialog.close());
}

function wireTutorial(): void {
  setupTutorialDialog(
    el<HTMLDialogElement>("tutorial-dialog"),
    el<HTMLButtonElement>("tutorial-button"),
    el<HTMLDivElement>("tutorial-content"),
  );
  el<HTMLButtonElement>("tutorial-close").addEventListener("click", () => el<HTMLDialogElement>("tutorial-dialog").close());
}

// Wide-field "Explore the sky" controls: a real, live NASA/IPAC SPHEREx
// HiPS (see components/aladin.ts and DECISIONS.md) auto-replaces the
// default 2MASS sky-view base layer once the user zooms out past 30' --
// these controls (band slice, Ice-vs-Dust blend, Featured regions,
// "Blink here") only make sense once that layer is confirmed reachable,
// so they stay hidden until the one-time probe resolves. Nothing here
// touches the scientific blink player until the user explicitly asks
// for it via "Blink here" -- exploring the wide map never silently
// changes what's being measured.
async function wireSkyExploreControls(): Promise<void> {
  if (state.lowBandwidth) return; // sky view itself is skipped there
  const available = await checkSphereXWideFieldAvailable();
  if (!available) return;

  el<HTMLDivElement>("sky-explore-controls").style.display = "flex";

  el<HTMLSelectElement>("sky-band-select").addEventListener("change", (e) => {
    void setSphereXBand((e.target as HTMLSelectElement).value);
  });

  const opacitySlider = el<HTMLInputElement>("sky-icedust-opacity");
  el<HTMLInputElement>("sky-icedust-toggle").addEventListener("change", (e) => {
    const on = (e.target as HTMLInputElement).checked;
    void setIceDustBlend(on, Number(opacitySlider.value));
    opacitySlider.disabled = !on;
  });
  opacitySlider.addEventListener("input", (e) => {
    setIceDustOpacity(Number((e.target as HTMLInputElement).value));
  });

  el<HTMLButtonElement>("blink-here-button").addEventListener("click", () => {
    const view = getCurrentView();
    if (!view) return;
    const fovArcmin = Math.min(15, Math.max(1, Math.round(view.fovArcmin * 2) / 2));
    state.ra = String(view.raDeg);
    state.dec = String(view.decDeg);
    state.fov = fovArcmin;
    fovInput.value = String(fovArcmin);
    searchInput.value = `${view.raDeg.toFixed(5)} ${view.decDeg.toFixed(5)}`;
    writeStateToUrl(state);
    void loadAndShow(view.raDeg, view.decDeg, fovArcmin, state.mode);
  });
}

// Query params read once at startup (see init()) to open the sky-view
// panel directly on a Featured Region, independent of the blink
// player's own ra/dec/fov -- these two views are deliberately decoupled
// (per the task: exploring the wide map never silently changes what the
// blink player is measuring).
const SKY_RA_PARAM = "sky_ra";
const SKY_DEC_PARAM = "sky_dec";
const SKY_FOV_PARAM = "sky_fov";

function wireFeaturedRegions(): void {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".featured-region-btn"));
  for (const btn of buttons) {
    btn.addEventListener("click", () => {
      // A full page navigation, not an in-page Aladin camera move: every
      // in-session attempt to swap the SPHEREx wide-field layer to a new
      // position (redraw retries, an isolated calibration probe, a full
      // teardown+reinit of the widget, even a forced layout-settle delay)
      // left the canvas intermittently solid black for some positions,
      // reproducible and position-specific, while a direct URL load to
      // the exact same coordinates never once failed across dozens of
      // attempts (see DECISIONS.md). A real navigation is the one code
      // path proven 100% reliable, at the cost of a visible page reload
      // for this deliberately infrequent "jump to a different region"
      // action.
      const url = new URL(window.location.href);
      url.searchParams.set(SKY_RA_PARAM, btn.dataset.ra!);
      url.searchParams.set(SKY_DEC_PARAM, btn.dataset.dec!);
      url.searchParams.set(SKY_FOV_PARAM, btn.dataset.fov!);
      window.location.href = url.toString();
    });
  }
}

// Preferred-first list of FOVs to try against a target's cached_positions
// -- 6' is the app's own default (more context), falling back to 3' (the
// originally-precached FOV, always complete for all 8 demo targets) if
// 6' isn't done yet for this target/mode. Never falls through to a live
// resolve()+fetch for a gallery target: if neither is cached for the
// current mode, this is a genuine precache gap (see DECISIONS.md,
// 2026-11-15, for which targets/modes that still applies to) and the
// click is a no-op with a status message rather than a slow surprise.
const GALLERY_FOV_PREFERENCE = ["6", "3"];

function onGalleryPick(target: TargetInfo): void {
  searchInput.value = target.display_name[getLang() === "es" ? "es" : "en"];
  const mode = modeSelect.value;
  const positions = target.cached_positions ?? {};
  const requestedFov = Number(fovInput.value) || Number(GALLERY_FOV_PREFERENCE[0]);

  // Try the FOV currently in the input first, then the standard preference
  // order, so picking a card honors the user's chosen FOV when that cache
  // exists -- and says so when it has to fall back to a different one.
  const tryOrder = [...new Set([String(requestedFov), ...GALLERY_FOV_PREFERENCE])];
  for (const fovKey of tryOrder) {
    const entry = positions[fovKey];
    if (entry && entry.modes.includes(mode)) {
      const fellBack = Number(fovKey) !== requestedFov;
      void showResolvedTarget(
        entry.ra_deg, entry.dec_deg, Number(fovKey), mode, entry.pmra_mas_yr, entry.pmdec_mas_yr, null,
      ).then(() => {
        if (fellBack) {
          setStatus(`${statusEl.textContent} · ${t("note.fov_fallback").replace("{fov}", fovKey)}`);
        }
      });
      return;
    }
  }

  setStatus(t("gallery.not_cached"));
}

async function loadGallery(): Promise<void> {
  try {
    currentTargets = await getTargets();
    renderGallery(el<HTMLDivElement>("gallery-host"), currentTargets, onGalleryPick);
  } catch {
    /* gallery is supplementary */
  }
}

async function init(): Promise<void> {
  applyLang(state.lang);
  fovInput.value = String(state.fov);
  modeSelect.value = state.mode;
  // Shareable display preferences (&smooth=1&contrast=1.4): a demo link
  // can carry the soft interpolated look without changing the honest
  // pixelated default.
  if (state.smooth) {
    el<HTMLInputElement>("player-smooth").checked = true;
    blinkContainer.classList.add("smooth");
  }
  el<HTMLInputElement>("player-contrast").value = String(state.contrast);
  el<HTMLInputElement>("player-brightness").value = String(state.brightness);
  applyDisplayFilters();
  if (state.lowBandwidth) {
    document.body.classList.add("low-bandwidth");
    el<HTMLButtonElement>("lowbw-toggle").setAttribute("aria-pressed", "true");
  }

  wireSearchForm();
  wirePlayerControls();
  wireLangAndBandwidthToggles();
  wireEmbedDialog();
  wireTutorial();
  wireFeaturedRegions();
  void wireSkyExploreControls();
  void loadGallery();
  // Purely decorative ambient backdrop -- skip it in low-bandwidth mode,
  // same philosophy as skipping the Aladin sky view there.
  if (!state.lowBandwidth) initStarfield(el<HTMLCanvasElement>("starfield"));

  const initialRa = state.ra ? parseRaDeg(state.ra) : null;
  const initialDec = state.dec ? parseDecDeg(state.dec) : null;
  // The sky view (initAladin) depends on an external CDN and must never
  // block the primary blink view -- run them independently, not sequentially.
  // Low bandwidth mode skips the sky view entirely: Aladin Lite pulls in
  // its own JS bundle plus HiPS tile and catalog imagery from an external
  // CDN, none of which the blink/spectrum/light-curve views need.
  const maybeInitAladin = (ra: number, dec: number, fovDeg: number) => {
    if (state.lowBandwidth) {
      const container = el<HTMLDivElement>("aladin-lite-div");
      container.textContent = t("lowbw.sky_view_skipped");
    } else {
      void initAladin("aladin-lite-div", ra, dec, fovDeg);
    }
  };

  // A Featured Region link (?sky_ra=&sky_dec=&sky_fov=, see
  // wireFeaturedRegions) opens the sky-view panel on that wide field --
  // deliberately independent of the blink player below it, which still
  // opens on whatever ra/dec/fov (if any) the URL separately carries.
  const skyParams = new URLSearchParams(window.location.search);
  const skyOverride =
    skyParams.has(SKY_RA_PARAM) && skyParams.has(SKY_DEC_PARAM)
      ? {
          ra: Number(skyParams.get(SKY_RA_PARAM)),
          dec: Number(skyParams.get(SKY_DEC_PARAM)),
          fovDeg: Number(skyParams.get(SKY_FOV_PARAM)) || 4,
        }
      : null;

  if (initialRa !== null && initialDec !== null) {
    searchInput.value = `${initialRa} ${initialDec}`;
    maybeInitAladin(
      skyOverride?.ra ?? initialRa,
      skyOverride?.dec ?? initialDec,
      skyOverride?.fovDeg ?? state.fov / 60,
    );
    await loadAndShow(initialRa, initialDec, state.fov, state.mode);
  } else if (skyOverride) {
    maybeInitAladin(skyOverride.ra, skyOverride.dec, skyOverride.fovDeg);
  } else {
    maybeInitAladin(266.4, -29.0, state.fov / 60);
  }

  window.addEventListener("popstate", () => {
    state = readStateFromUrl();
    applyLang(state.lang);
  });
}

void init();
