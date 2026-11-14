import "./style.css";
import { ApiError, getFrames, getLightCurve, getSpectrum, getTargets, resolveName, frameUrl } from "./api";
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

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const statusEl = el<HTMLParagraphElement>("status-message");
const searchForm = el<HTMLFormElement>("search-form");
const searchInput = el<HTMLInputElement>("search-input");
const fovInput = el<HTMLInputElement>("fov-input");
const modeSelect = el<HTMLSelectElement>("mode-select");
const blinkContainer = el<HTMLDivElement>("blink-container");
const metadataHost = el<HTMLDivElement>("metadata-host");

const player = new BlinkPlayer(blinkContainer);

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

    try {
      const spectrum = await getSpectrum(raDeg, decDeg, fovArcmin);
      renderSpectrum(el<HTMLCanvasElement>("spectrum-canvas"), spectrum.points);
    } catch {
      /* spectrum is a bonus view; frames are the main event */
    }
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
      state.ra = parts[0];
      state.dec = parts[1];
      writeStateToUrl(state);
      await loadAndShow(Number(parts[0]) || 0, Number(parts[1]) || 0, fov, mode);
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

async function loadGallery(): Promise<void> {
  try {
    currentTargets = await getTargets();
    renderGallery(el<HTMLDivElement>("gallery-host"), currentTargets, (target) => {
      searchInput.value = target.display_name[getLang() === "es" ? "es" : "en"];
      // Resolve by key (not the raw fallback ra/dec) so this hits the same
      // Gaia-DR3-proper-motion-corrected position precache.py computed --
      // the static fallback coordinates alone would miss the pre-cached
      // entry and fall back to a slow live query.
      void runSearch(target.key, Number(fovInput.value), modeSelect.value);
    });
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

  const initialRa = state.ra ? Number(state.ra) : NaN;
  const initialDec = state.dec ? Number(state.dec) : NaN;
  // The sky view (initAladin) depends on an external CDN and must never
  // block the primary blink view -- run them independently, not sequentially.
  if (!Number.isNaN(initialRa) && !Number.isNaN(initialDec)) {
    searchInput.value = `${initialRa} ${initialDec}`;
    void initAladin("aladin-lite-div", initialRa, initialDec, state.fov / 60);
    await loadAndShow(initialRa, initialDec, state.fov, state.mode);
  } else {
    void initAladin("aladin-lite-div", 266.4, -29.0, state.fov / 60);
  }

  window.addEventListener("popstate", () => {
    state = readStateFromUrl();
    applyLang(state.lang);
  });
}

void init();
