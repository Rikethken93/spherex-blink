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

const STATIC_HIPS = "CDS/P/2MASS/color";

function hips2fitsUrl(raDeg: number, decDeg: number, fovDeg: number): string {
  const params = new URLSearchParams({
    hips: STATIC_HIPS,
    ra: String(raDeg),
    dec: String(decDeg),
    fov: String(Math.max(fovDeg * 2, 0.05)),
    width: "420",
    height: "420",
    projection: "TAN",
    format: "jpg",
  });
  return `https://alasky.cds.unistra.fr/hips-image-services/hips2fits?${params.toString()}`;
}

/** Static single-image fallback: same field via CDS hips2fits (2MASS
 * color), with a CSS crosshair marking the target. */
function showStaticSkyView(container: HTMLElement, raDeg: number, decDeg: number, fovDeg: number): void {
  staticHost = container;
  container.classList.remove("aladin-unavailable");
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "static-sky";
  const img = document.createElement("img");
  img.alt = t("aladin.static_alt");
  img.src = hips2fitsUrl(raDeg, decDeg, fovDeg);
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
  aladinInstance = A.aladin(`#${containerId}`, {
    target: `${raDeg} ${decDeg}`,
    fov: fovDeg,
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
}

export function recenter(raDeg: number, decDeg: number, fovDeg: number): void {
  if (aladinInstance) {
    aladinInstance.gotoRaDec(raDeg, decDeg);
    aladinInstance.setFov(fovDeg);
    return;
  }
  if (staticHost) {
    const img = staticHost.querySelector<HTMLImageElement>(".static-sky img");
    if (img) img.src = hips2fitsUrl(raDeg, decDeg, fovDeg);
  }
}

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
