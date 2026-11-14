// AI-assisted: written with Claude Code (Anthropic) under the team's
// direction; concept, requirements, and design decisions are the team's
// own. See DECISIONS.md and README.md ("AI assistance") for details.
import "./style.css";
import { ApiError, getFrames, getLightCurve, getSpectrum, getTargets, resolveName, frameUrl } from "./api";
import { parseRaDeg, parseDecDeg } from "./coords";
import type { TargetInfo } from "./api";
import { applyTranslations, setLang, getLang, t } from "./i18n/i18n";
import { readStateFromUrl, writeStateToUrl, embedSnippet } from "./state";
import type { AppState } from "./state";
import { BlinkPlayer } from "./components/player";
import { initAladin, recenter, drawProperMotionArrow } from "./components/aladin";
import { renderSpectrum, renderLightCurve } from "./components/charts";
import { renderGallery } from "./components/gallery";
import { renderMetadataTable } from "./components/metadata-table";
import { setupTutorialDialog } from "./components/tutorial";

let state: AppState = readStateFromUrl();
let currentTargets: TargetInfo[] = [];
let currentCenter: { ra: number; dec: number; fov: number } | null = null;

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

function applyLang(lang: string): void {
  setLang(lang);
  state.lang = lang;
  applyTranslations();
  el<HTMLButtonElement>("lang-toggle").querySelector("span")!.textContent =
    getLang() === "es" ? "English" : "Español";
}

async function loadAndShow(raDeg: number, decDeg: number, fovArcmin: number, mode: string): Promise<void> {
  setStatus("…");
  try {
    const result = await getFrames(raDeg, decDeg, fovArcmin, mode);
    player.setFrames(result.frame_urls.map(frameUrl));
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
    if (!state.lowBandwidth) void handleImageClick(0.5, 0.5);

    try {
      const lightcurve = await getLightCurve(raDeg, decDeg, fovArcmin);
      renderLightCurve(el<HTMLCanvasElement>("lightcurve-canvas"), lightcurve.points);
    } catch {
      /* same as above */
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      setStatus(t("error.no_coverage"));
    } else if (err instanceof ApiError && err.status === 503) {
      setStatus(t("error.upstream"));
    } else {
      setStatus(t("error.generic"));
    }
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

  setStatus("…");
  try {
    const resolved = await resolveName(query);
    state.ra = String(resolved.ra_deg);
    state.dec = String(resolved.dec_deg);
    writeStateToUrl(state);
    if (resolved.warning) setStatus(resolved.warning);
    await loadAndShow(resolved.ra_deg, resolved.dec_deg, fov, mode);
    if (resolved.pmra_mas_yr != null && resolved.pmdec_mas_yr != null) {
      drawProperMotionArrow(resolved.ra_deg, resolved.dec_deg, resolved.pmra_mas_yr, resolved.pmdec_mas_yr);
    }
  } catch {
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

function onGalleryPick(target: TargetInfo): void {
  searchInput.value = target.display_name[getLang() === "es" ? "es" : "en"];
  // Resolve by key (not the raw fallback ra/dec) so this hits the same
  // Gaia-DR3-proper-motion-corrected position precache.py computed -- the
  // static fallback coordinates alone would miss the pre-cached entry and
  // fall back to a slow live query.
  void runSearch(target.key, Number(fovInput.value), modeSelect.value);
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
  if (state.lowBandwidth) {
    document.body.classList.add("low-bandwidth");
    el<HTMLButtonElement>("lowbw-toggle").setAttribute("aria-pressed", "true");
  }

  wireSearchForm();
  wirePlayerControls();
  wireLangAndBandwidthToggles();
  wireEmbedDialog();
  wireTutorial();
  void loadGallery();

  const initialRa = state.ra ? parseRaDeg(state.ra) : null;
  const initialDec = state.dec ? parseDecDeg(state.dec) : null;
  // The sky view (initAladin) depends on an external CDN and must never
  // block the primary blink view -- run them independently, not sequentially.
  // Low bandwidth mode skips the sky view entirely: Aladin Lite pulls in
  // its own JS bundle plus HiPS tile and catalog imagery from an external
  // CDN, none of which the blink/spectrum/light-curve views need.
  const maybeInitAladin = (ra: number, dec: number) => {
    if (state.lowBandwidth) {
      const container = el<HTMLDivElement>("aladin-lite-div");
      container.textContent = t("lowbw.sky_view_skipped");
    } else {
      void initAladin("aladin-lite-div", ra, dec, state.fov / 60);
    }
  };

  if (initialRa !== null && initialDec !== null) {
    searchInput.value = `${initialRa} ${initialDec}`;
    maybeInitAladin(initialRa, initialDec);
    await loadAndShow(initialRa, initialDec, state.fov, state.mode);
  } else {
    maybeInitAladin(266.4, -29.0);
  }

  window.addEventListener("popstate", () => {
    state = readStateFromUrl();
    applyLang(state.lang);
  });
}

void init();
