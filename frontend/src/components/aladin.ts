// Aladin Lite v3 is loaded from the CDS CDN (see index.html) and exposes a
// global `A`. We only touch it from here.
declare global {
  interface Window {
    A: any;
  }
}

let aladinInstance: any = null;
let pmOverlay: any = null;

/** Never throws: the sky view is a secondary panel, and the CDS CDN it
 * depends on is an external service outside this app's control (observed
 * down entirely during development) -- a failure here must not block the
 * primary blink view from loading. On failure, shows a short message in
 * the container instead of leaving it blank or crashing page init. */
export async function initAladin(containerId: string, raDeg: number, decDeg: number, fovDeg: number): Promise<void> {
  try {
    await initAladinOrThrow(containerId, raDeg, decDeg, fovDeg);
  } catch (err) {
    console.warn("Aladin Lite failed to initialize (sky view will be unavailable):", err);
    const el = document.getElementById(containerId);
    if (el) {
      el.textContent = "Sky view unavailable (external Aladin Lite service unreachable).";
      el.classList.add("aladin-unavailable");
    }
  }
}

async function initAladinOrThrow(containerId: string, raDeg: number, decDeg: number, fovDeg: number): Promise<void> {
  if (!window.A) {
    throw new Error("Aladin Lite script did not load from the CDS CDN");
  }
  await window.A.init;
  aladinInstance = window.A.aladin(`#${containerId}`, {
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
      window.A.catalogFromVizieR("I/355/gaiadr3", `${raDeg} ${decDeg}`, fovDeg, {
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
      window.A.catalogFromVizieR("II/328/allwise", `${raDeg} ${decDeg}`, fovDeg, {
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
  if (!aladinInstance) return;
  aladinInstance.gotoRaDec(raDeg, decDeg);
  aladinInstance.setFov(fovDeg);
}

/** Draws a schematic proper-motion arrow. Real annual motion is far smaller
 * than one SPHEREx pixel on screen, so the arrow length is exaggerated by
 * `exaggerationYears` and labeled as such -- it shows *direction*, not a
 * to-scale displacement. */
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
  pmOverlay = window.A.graphicOverlay({ color: "#ffd43b", lineWidth: 2 });
  aladinInstance.addOverlay(pmOverlay);

  const cosDec = Math.max(Math.cos((decDeg * Math.PI) / 180), 1e-6);
  const dRa = ((pmraMasYr * exaggerationYears) / 3_600_000) / cosDec;
  const dDec = (pmdecMasYr * exaggerationYears) / 3_600_000;

  const tip = [raDeg + dRa, decDeg + dDec];
  pmOverlay.add(window.A.polyline([[raDeg, decDeg], tip]));
  pmOverlay.add(
    window.A.circle(tip[0], tip[1], 0.0005, { color: "#ffd43b" }),
  );
}

export function isAladinReady(): boolean {
  return aladinInstance !== null;
}
