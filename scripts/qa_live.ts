// AI-assisted: written with Claude Code (Anthropic) under the team's
// direction. See DECISIONS.md and README.md ("AI assistance") for details.
//
// Live end-to-end QA for the deployed SPHEREx Blink app. Exercises the real
// production frontend (Vercel) and backend (Fly.io) -- no mocking -- via
// headless Chromium. Run with:
//
//   node scripts/qa_live.ts
//
// (Node 22's built-in TypeScript type-stripping runs this directly; no
// build step. `playwright` and `axe-core` are root devDependencies, kept
// separate from the app's own frontend/backend dependency trees.)
//
// Writes docs/qa/QA_REPORT.md and screenshots under docs/qa/screenshots/.

import { chromium, type Page, type Browser } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const QA_DIR = path.join(REPO_ROOT, "docs", "qa");
const SHOT_DIR = path.join(QA_DIR, "screenshots");
mkdirSync(SHOT_DIR, { recursive: true });

const FRONTEND = "https://frontend-woad-nu-23.vercel.app";
const BACKEND = "https://spherex-blink-backend.fly.dev";

const TARGETS = [
  "barnards-star",
  "epsilon-indi-b",
  "wise0855",
  "rw-aurigae",
  "r-draconis",
  "proxima-centauri",
  "luhman-16",
  "ugps0722",
];
const MODES = ["blink", "difference", "sum", "rgb"];

type Status = "PASS" | "FAIL" | "WARN";

interface CheckResult {
  section: string;
  name: string;
  status: Status;
  detail: string;
  timingMs?: number;
  screenshot?: string;
}

interface Bug {
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  steps: string;
  evidence: string;
}

const results: CheckResult[] = [];
const bugs: Bug[] = [];

function record(r: CheckResult): void {
  results.push(r);
  const t = r.timingMs !== undefined ? ` (${r.timingMs}ms)` : "";
  console.log(`[${r.status}] ${r.section} :: ${r.name}${t} -- ${r.detail}`);
}

function reportBug(b: Bug): void {
  bugs.push(b);
  console.log(`  !! BUG [${b.severity}] ${b.title}`);
}

function shot(name: string): string {
  return path.join("screenshots", `${name}.png`);
}

interface Diagnostics {
  consoleErrors: string[];
  failedRequests: string[];
}

function wireDiagnostics(page: Page): Diagnostics {
  const d: Diagnostics = { consoleErrors: [], failedRequests: [] };
  page.on("console", (msg) => {
    if (msg.type() === "error") d.consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => d.consoleErrors.push(`[pageerror] ${err.message}`));
  page.on("requestfailed", (req) => {
    d.failedRequests.push(`${req.method()} ${req.url()} -- ${req.failure()?.errorText ?? "?"}`);
  });
  return d;
}

async function timeIt<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = Date.now();
  const out = await fn();
  return [out, Date.now() - t0];
}

// ---------------------------------------------------------------------
// 1. Landing page
// ---------------------------------------------------------------------
async function sectionLanding(browser: Browser): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, colorScheme: "dark" });
  const diag = wireDiagnostics(page);

  const [, loadMs] = await timeIt(() =>
    page.goto(FRONTEND + "/", { waitUntil: "load", timeout: 30000 }),
  );
  let idleMs = -1;
  try {
    const [, ms] = await timeIt(() => page.waitForLoadState("networkidle", { timeout: 20000 }));
    idleMs = ms;
  } catch {
    /* some external resource (Aladin CDN) may never settle; not fatal */
  }

  const nonAladinFailures = diag.failedRequests.filter((f) => !f.includes("aladin.cds.unistra.fr"));
  const aladinFailures = diag.failedRequests.filter((f) => f.includes("aladin.cds.unistra.fr"));

  record({
    section: "1. Landing",
    name: "Page load (load event)",
    status: "PASS",
    detail: `load event fired`,
    timingMs: loadMs,
  });

  if (diag.consoleErrors.length > 0) {
    record({
      section: "1. Landing",
      name: "Console errors",
      status: "FAIL",
      detail: diag.consoleErrors.join(" | "),
    });
    reportBug({
      severity: "high",
      title: "JS console errors on landing page load",
      steps: `Load ${FRONTEND}/ in Chromium and check devtools console.`,
      evidence: diag.consoleErrors.join(" | "),
    });
  } else {
    record({ section: "1. Landing", name: "Console errors", status: "PASS", detail: "none" });
  }

  if (nonAladinFailures.length > 0) {
    record({
      section: "1. Landing",
      name: "Failed requests (non-Aladin)",
      status: "FAIL",
      detail: nonAladinFailures.join(" | "),
    });
    reportBug({
      severity: "high",
      title: "First-party or unexpected request failed on landing page",
      steps: `Load ${FRONTEND}/ and inspect the network tab.`,
      evidence: nonAladinFailures.join(" | "),
    });
  } else {
    record({
      section: "1. Landing",
      name: "Failed requests (non-Aladin)",
      status: "PASS",
      detail: idleMs >= 0 ? `networkidle after ${idleMs}ms` : "networkidle timed out waiting on an external resource",
    });
  }

  // Aladin Lite: either it actually rendered (CDN up) or the app's own
  // graceful-fallback message is shown (CDN down) -- both are acceptable
  // outcomes; only a blank/broken panel with neither is a bug.
  const aladinState = await page.evaluate(() => {
    const el = document.getElementById("aladin-lite-div");
    if (!el) return "missing-container";
    if (el.querySelector("canvas, iframe")) return "rendered";
    if (el.textContent && el.textContent.trim().length > 0) return "fallback-message";
    return "blank";
  });
  if (aladinState === "rendered") {
    record({ section: "1. Landing", name: "Aladin Lite sky view", status: "PASS", detail: "rendered (CDN reachable)" });
  } else if (aladinState === "fallback-message") {
    record({
      section: "1. Landing",
      name: "Aladin Lite sky view",
      status: "WARN",
      detail: `CDN unreachable (${aladinFailures[0] ?? "no failed-request event captured"}), graceful fallback message shown -- known external dependency outage, not an app bug`,
    });
  } else {
    record({ section: "1. Landing", name: "Aladin Lite sky view", status: "FAIL", detail: `unexpected state: ${aladinState}` });
    reportBug({
      severity: "medium",
      title: "Aladin Lite panel is blank with neither a sky view nor a fallback message",
      steps: `Load ${FRONTEND}/ and inspect #aladin-lite-div.`,
      evidence: aladinState,
    });
  }

  // Language toggle EN -> ES -> EN
  const taglineBefore = await page.textContent(".tagline");
  await page.click("#lang-toggle");
  await page.waitForTimeout(200);
  const taglineEs = await page.textContent(".tagline");
  const htmlLangEs = await page.getAttribute("html", "lang");
  await page.click("#lang-toggle");
  await page.waitForTimeout(200);
  const taglineBack = await page.textContent(".tagline");

  if (taglineBefore !== taglineEs && taglineBack === taglineBefore) {
    record({
      section: "1. Landing",
      name: "Language toggle EN<->ES",
      status: "PASS",
      detail: `EN "${taglineBefore}" -> ES "${taglineEs}" -> EN "${taglineBack}" (html lang=${htmlLangEs})`,
    });
  } else {
    record({
      section: "1. Landing",
      name: "Language toggle EN<->ES",
      status: "FAIL",
      detail: `before="${taglineBefore}" es="${taglineEs}" back="${taglineBack}"`,
    });
    reportBug({
      severity: "high",
      title: "Language toggle does not correctly switch/restore UI text",
      steps: "Click the 'Español' button, then click it again (now 'English').",
      evidence: `before="${taglineBefore}" es="${taglineEs}" back="${taglineBack}"`,
    });
  }

  await page.screenshot({ path: path.join(QA_DIR, shot("01-landing")), fullPage: true });
  await page.close();
}

// ---------------------------------------------------------------------
// 2. 8 targets x 4 modes
// ---------------------------------------------------------------------
async function sectionTargetsModes(browser: Browser): Promise<void> {
  for (const key of TARGETS) {
    for (const mode of MODES) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, colorScheme: "dark" });
      const diag = wireDiagnostics(page);
      const label = `${key} / ${mode}`;
      try {
        await page.goto(`${FRONTEND}/?mode=${mode}&fov=3`, { waitUntil: "domcontentloaded", timeout: 20000 });

        const framesResponsePromise = page.waitForResponse(
          (res) => res.url().includes("/api/frames") && res.request().method() === "GET",
          { timeout: 180000 },
        );
        const t0 = Date.now();
        await page.fill("#search-input", key);
        await page.click("#search-form button[type=submit]");
        const framesRes = await framesResponsePromise;
        await page.waitForSelector(".blink-frame[src]", { timeout: 15000 });
        const elapsedMs = Date.now() - t0;

        const body = (await framesRes.json()) as { frames: string[]; epochs: unknown[]; mode: string };
        const expectedFrames = mode === "blink" ? body.epochs.length : 1;
        const frameCountOk = body.frames.length === expectedFrames;

        if (!frameCountOk) {
          record({
            section: "2. Targets x modes",
            name: label,
            status: "FAIL",
            detail: `frames=${body.frames.length} expected=${expectedFrames} (epochs=${body.epochs.length})`,
            timingMs: elapsedMs,
          });
          reportBug({
            severity: "high",
            title: `Frame count mismatch for ${label}`,
            steps: `Load ${FRONTEND}/?mode=${mode}&fov=3 and search "${key}".`,
            evidence: `frames=${body.frames.length}, expected=${expectedFrames}, epochs=${body.epochs.length}`,
          });
        }

        // Player controls: step prev/next must never crash regardless of
        // frame count. Play/Pause toggling only applies to multi-frame
        // (blink) results -- player.ts's play() is a deliberate no-op below
        // 2 frames (nothing to animate in sum/difference/rgb's single
        // combined frame), so a single-frame result staying on "Play" is
        // correct behavior, not a bug.
        const playBtn = page.locator("#player-playpause");
        await playBtn.click();
        await page.waitForTimeout(300);
        const labelAfterPlay = await playBtn.textContent();
        await playBtn.click();
        await page.waitForTimeout(100);
        const labelAfterPause = await playBtn.textContent();
        await page.locator("#player-next").click();
        await page.locator("#player-prev").click();

        const multiFrame = body.frames.length >= 2;
        const playerOk =
          frameCountOk &&
          diag.consoleErrors.length === 0 &&
          (multiFrame
            ? labelAfterPlay?.trim().toLowerCase() === "pause" && labelAfterPause?.trim().toLowerCase() === "play"
            : labelAfterPlay?.trim().toLowerCase() === "play" && labelAfterPause?.trim().toLowerCase() === "play");

        if (playerOk) {
          record({
            section: "2. Targets x modes",
            name: label,
            status: "PASS",
            detail: `frames=${body.frames.length} epochs=${body.epochs.length} player ${multiFrame ? "play/pause/step" : "step (single-frame, play correctly a no-op)"} ok`,
            timingMs: elapsedMs,
          });
        } else if (frameCountOk) {
          record({
            section: "2. Targets x modes",
            name: `${label} (player)`,
            status: "FAIL",
            detail: `multiFrame=${multiFrame} playpause label after play="${labelAfterPlay}" after pause="${labelAfterPause}" consoleErrors=${diag.consoleErrors.length}`,
            timingMs: elapsedMs,
          });
          reportBug({
            severity: "medium",
            title: `Player play/pause control did not behave correctly for ${label}`,
            steps: `Load ${label}, click Play then Pause, observe button label.`,
            evidence: `multiFrame=${multiFrame} after play="${labelAfterPlay}" after pause="${labelAfterPause}"`,
          });
        }

        if (mode === "blink") {
          await page.screenshot({ path: path.join(QA_DIR, shot(`02-${key}`)), fullPage: false });
        }
      } catch (err) {
        record({
          section: "2. Targets x modes",
          name: label,
          status: "FAIL",
          detail: `exception: ${(err as Error).message}`,
        });
        reportBug({
          severity: "high",
          title: `${label} failed to load/play`,
          steps: `Load ${FRONTEND}/?mode=${mode}&fov=3 and search "${key}".`,
          evidence: (err as Error).message,
        });
        await page.screenshot({ path: path.join(QA_DIR, shot(`02-FAIL-${key}-${mode}`)), fullPage: true }).catch(() => {});
      } finally {
        await page.close();
      }
    }
  }
}

// ---------------------------------------------------------------------
// 3. URL params + name search
// ---------------------------------------------------------------------
async function sectionUrlAndNameSearch(browser: Browser): Promise<void> {
  // 3a. Direct URL params (WISE 0855)
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, colorScheme: "dark" });
    try {
      // These exact decimal coordinates don't match any precached position
      // (the cache key is the literal float, and the real WISE 0855 position
      // used by scripts/precache.py differs in the 3rd decimal), so this is
      // a deliberate cache-miss / live-IRSA-fetch exercise, not a cache hit --
      // give it a generous timeout and don't gate navigation on
      // "networkidle" (fragile on a cold, uncached context with ~15 separate
      // font subresources; domcontentloaded + an explicit element wait is
      // the reliable signal, same as every other section of this script).
      await page.goto(`${FRONTEND}/?ra=133.795&dec=-7.245&fov=3&mode=blink`, {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });
      const [, ms] = await timeIt(() => page.waitForSelector(".blink-frame[src]", { timeout: 200000 }));
      const status = await page.textContent("#status-message");
      const ok = /exposures/.test(status ?? "");
      record({
        section: "3. URL params / name search",
        name: "Direct URL ?ra=133.795&dec=-7.245&fov=3 (WISE 0855)",
        status: ok ? "PASS" : "FAIL",
        detail: status ?? "(empty status)",
        timingMs: ms,
      });
      if (!ok) {
        reportBug({
          severity: "high",
          title: "Direct ra/dec/fov URL params do not auto-load frames",
          steps: `Open ${FRONTEND}/?ra=133.795&dec=-7.245&fov=3&mode=blink directly.`,
          evidence: status ?? "(empty)",
        });
      }
      await page.screenshot({ path: path.join(QA_DIR, shot("03a-url-params-wise0855")) });
    } catch (err) {
      record({ section: "3. URL params / name search", name: "Direct URL params", status: "FAIL", detail: (err as Error).message });
      reportBug({
        severity: "high",
        title: "Direct ra/dec/fov URL params threw an error",
        steps: `Open ${FRONTEND}/?ra=133.795&dec=-7.245&fov=3&mode=blink directly.`,
        evidence: (err as Error).message,
      });
    } finally {
      await page.close();
    }
  }

  // 3b/3c. Name search variants
  for (const query of ["Barnard's Star", "R Dra"]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, colorScheme: "dark" });
    try {
      await page.goto(`${FRONTEND}/?mode=blink&fov=3`, { waitUntil: "domcontentloaded", timeout: 20000 });
      const [, ms] = await timeIt(async () => {
        await page.fill("#search-input", query);
        await page.click("#search-form button[type=submit]");
        await page.waitForSelector(".blink-frame[src]", { timeout: 60000 });
      });
      const status = await page.textContent("#status-message");
      const ok = /exposures/.test(status ?? "");
      record({
        section: "3. URL params / name search",
        name: `Name search "${query}"`,
        status: ok ? "PASS" : "FAIL",
        detail: status ?? "(empty status)",
        timingMs: ms,
      });
      if (!ok) {
        reportBug({
          severity: "high",
          title: `Name search "${query}" did not resolve to frames`,
          steps: `Type "${query}" into the search box and submit.`,
          evidence: status ?? "(empty)",
        });
      }
      await page.screenshot({ path: path.join(QA_DIR, shot(`03-name-${query.replace(/[^a-z0-9]/gi, "_")}`)) });
    } catch (err) {
      record({
        section: "3. URL params / name search",
        name: `Name search "${query}"`,
        status: "FAIL",
        detail: (err as Error).message,
      });
      reportBug({
        severity: "medium",
        title: `Name search "${query}" threw/timed out`,
        steps: `Type "${query}" into the search box and submit.`,
        evidence: (err as Error).message,
      });
    } finally {
      await page.close();
    }
  }
}

// ---------------------------------------------------------------------
// 4. Spectrum click + light curve
// ---------------------------------------------------------------------
async function sectionSpectrumLightcurve(browser: Browser): Promise<void> {
  // Click image -> spectrum
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, colorScheme: "dark" });
    try {
      await page.goto(`${FRONTEND}/?mode=blink&fov=3`, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.fill("#search-input", "wise0855");
      await page.click("#search-form button[type=submit]");
      await page.waitForSelector(".blink-frame[src]", { timeout: 20000 });

      const spectrumPromise = page.waitForResponse((res) => res.url().includes("/api/spectrum"), { timeout: 20000 });
      const box = await page.locator("#blink-container").boundingBox();
      if (!box) throw new Error("blink-container has no bounding box");
      await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.6);
      const res = await spectrumPromise;
      const points = (await res.json()) as { points: unknown[] };
      const ok = Array.isArray(points.points) && points.points.length > 0;
      record({
        section: "4. Spectrum / light curve",
        name: "Click image -> spectrum chart (WISE 0855)",
        status: ok ? "PASS" : "FAIL",
        detail: `points=${points.points?.length ?? 0}`,
      });
      if (!ok) {
        reportBug({
          severity: "high",
          title: "Clicking the blink image does not populate the spectrum chart",
          steps: "Load WISE 0855, click anywhere inside the blink viewport.",
          evidence: `points=${points.points?.length ?? 0}`,
        });
      }
      await page.screenshot({ path: path.join(QA_DIR, shot("04-spectrum-click")) });
    } catch (err) {
      record({ section: "4. Spectrum / light curve", name: "Click image -> spectrum chart", status: "FAIL", detail: (err as Error).message });
      reportBug({
        severity: "high",
        title: "Spectrum-on-click threw/timed out",
        steps: "Load WISE 0855, click anywhere inside the blink viewport.",
        evidence: (err as Error).message,
      });
    } finally {
      await page.close();
    }
  }

  // Light curve for RW Aur and R Dra
  for (const key of ["rw-aurigae", "r-draconis"]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, colorScheme: "dark" });
    try {
      const lcPromise = page.waitForResponse((res) => res.url().includes("/api/lightcurve"), { timeout: 30000 });
      await page.goto(`${FRONTEND}/?mode=blink&fov=3`, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.fill("#search-input", key);
      await page.click("#search-form button[type=submit]");
      const res = await lcPromise;
      await page.waitForSelector(".blink-frame[src]", { timeout: 15000 });
      // /api/lightcurve returns {ra_deg, dec_deg, points: [...]}, not a bare array.
      const body = (await res.json()) as { points: unknown[] };
      const ok = Array.isArray(body.points) && body.points.length > 0;
      record({
        section: "4. Spectrum / light curve",
        name: `Light curve: ${key}`,
        status: ok ? "PASS" : "FAIL",
        detail: `points=${Array.isArray(body.points) ? body.points.length : "n/a"}`,
      });
      if (!ok) {
        reportBug({
          severity: "high",
          title: `Light curve empty/missing for ${key}`,
          steps: `Search "${key}" and inspect the Light curve panel.`,
          evidence: JSON.stringify(body).slice(0, 200),
        });
      }
      await page.screenshot({ path: path.join(QA_DIR, shot(`04-lightcurve-${key}`)) });
    } catch (err) {
      record({ section: "4. Spectrum / light curve", name: `Light curve: ${key}`, status: "FAIL", detail: (err as Error).message });
      reportBug({
        severity: "high",
        title: `Light curve request for ${key} threw/timed out`,
        steps: `Search "${key}" and inspect the Light curve panel.`,
        evidence: (err as Error).message,
      });
    } finally {
      await page.close();
    }
  }
}

// ---------------------------------------------------------------------
// 5. FOV changes + one uncached coordinate (exercises the slow-fetch message)
// ---------------------------------------------------------------------
async function sectionFovAndUncached(browser: Browser): Promise<void> {
  for (const fov of [1, 3, 10]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, colorScheme: "dark" });
    try {
      await page.goto(`${FRONTEND}/?mode=blink&fov=${fov}`, { waitUntil: "domcontentloaded", timeout: 20000 });
      const [, ms] = await timeIt(async () => {
        await page.fill("#search-input", "wise0855");
        await page.click("#search-form button[type=submit]");
        // fov=1/10 are cache misses (only fov=3 is precached) -> a genuine
        // live IRSA fetch, which this app's own IRSA client retries through
        // for several minutes in the worst case (see net.py) -- give this
        // enough headroom to distinguish "slow" from "actually stuck".
        await page.waitForSelector(".blink-frame[src]", { timeout: 240000 });
      });
      const status = await page.textContent("#status-message");
      record({
        section: "5. FOV / uncached",
        name: `FOV=${fov} arcmin (WISE 0855)`,
        status: /exposures/.test(status ?? "") ? "PASS" : "FAIL",
        detail: status ?? "(empty)",
        timingMs: ms,
      });
    } catch (err) {
      record({ section: "5. FOV / uncached", name: `FOV=${fov} arcmin (WISE 0855)`, status: "FAIL", detail: (err as Error).message });
      reportBug({
        severity: "high",
        title: `FOV=${fov} arcmin search failed/timed out`,
        steps: `Open ${FRONTEND}/?mode=blink&fov=${fov}, search "wise0855".`,
        evidence: (err as Error).message,
      });
    } finally {
      await page.close();
    }
  }

  // Uncached coordinate: verify the progressive loading message, then wait
  // (generously -- IRSA is a real, occasionally-slow archive) for a result
  // or a clear error, never a silent hang.
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, colorScheme: "dark" });
    try {
      await page.goto(`${FRONTEND}/?mode=blink&fov=3`, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.fill("#search-input", "83.8 -5.4");
      const t0 = Date.now();
      await page.click("#search-form button[type=submit]");

      await page.waitForTimeout(1000);
      const early = await page.textContent("#status-message");

      await page.waitForTimeout(6500);
      const late = await page.textContent("#status-message");
      const slowMessageShown = /still working|fetching live data/i.test(late ?? "");

      record({
        section: "5. FOV / uncached",
        name: "Slow-fetch status message appears after ~6s",
        status: slowMessageShown ? "PASS" : "FAIL",
        detail: `t=1s: "${early}" | t=7.5s: "${late}"`,
      });
      if (!slowMessageShown) {
        reportBug({
          severity: "high",
          title: "Progressive loading message did not appear for an uncached search",
          steps: 'Search "83.8 -5.4" (uncached coordinates), wait 7 seconds, read the status line.',
          evidence: `t=7.5s status: "${late}"`,
        });
      }

      // Now wait for a terminal state: a frame, or a recognizable error.
      const deadline = Date.now() + 180000;
      let finalStatus = late;
      let outcome: "success" | "error" | "timeout" = "timeout";
      while (Date.now() < deadline) {
        const hasFrame = await page.locator(".blink-frame[src]").count();
        if (hasFrame > 0) {
          outcome = "success";
          break;
        }
        finalStatus = await page.textContent("#status-message");
        if (finalStatus && /(no SPHEREx coverage|IRSA archive is slow|went wrong talking)/i.test(finalStatus)) {
          outcome = "error";
          break;
        }
        await page.waitForTimeout(3000);
      }
      const totalMs = Date.now() - t0;
      record({
        section: "5. FOV / uncached",
        name: "Uncached coordinate reaches a terminal state (success or clear error)",
        status: outcome === "timeout" ? "FAIL" : "PASS",
        detail: `outcome=${outcome} finalStatus="${finalStatus}"`,
        timingMs: totalMs,
      });
      if (outcome === "timeout") {
        reportBug({
          severity: "critical",
          title: "Uncached search never resolves to a result or an error within 3 minutes",
          steps: 'Search "83.8 -5.4" and wait.',
          evidence: `status stuck at: "${finalStatus}"`,
        });
      }
      await page.screenshot({ path: path.join(QA_DIR, shot("05-uncached-coordinate")) });
    } catch (err) {
      record({ section: "5. FOV / uncached", name: "Uncached coordinate", status: "FAIL", detail: (err as Error).message });
    } finally {
      await page.close();
    }
  }
}

// ---------------------------------------------------------------------
// 6. Invalid input
// ---------------------------------------------------------------------
async function sectionInvalidInput(browser: Browser): Promise<void> {
  // ra=999 via URL params (out of valid range)
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, colorScheme: "dark" });
    const diag = wireDiagnostics(page);
    try {
      await page.goto(`${FRONTEND}/?ra=999&dec=10&fov=3&mode=blink`, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(1500);
      const status = await page.textContent("#status-message");
      const bodyText = await page.textContent("body");
      const crashed = diag.consoleErrors.some((e) => /uncaught|TypeError|ReferenceError/i.test(e));
      const hasFriendlyMessage = !!status && status.trim().length > 0 && !/^\s*…?\s*$/.test(status);
      record({
        section: "6. Invalid input",
        name: "ra=999 (out of range)",
        status: !crashed && hasFriendlyMessage ? "PASS" : "FAIL",
        detail: `status="${status}" consoleErrors=${diag.consoleErrors.length} pageRendered=${!!bodyText}`,
      });
      if (crashed || !hasFriendlyMessage) {
        reportBug({
          severity: "medium",
          title: "ra=999 does not produce a friendly, informative error",
          steps: `Open ${FRONTEND}/?ra=999&dec=10&fov=3&mode=blink`,
          evidence: `status="${status}"`,
        });
      }
    } catch (err) {
      record({ section: "6. Invalid input", name: "ra=999", status: "FAIL", detail: (err as Error).message });
    } finally {
      await page.close();
    }
  }

  // Empty search
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, colorScheme: "dark" });
    const diag = wireDiagnostics(page);
    try {
      await page.goto(`${FRONTEND}/?mode=blink&fov=3`, { waitUntil: "domcontentloaded", timeout: 20000 });
      const statusBefore = await page.textContent("#status-message");
      await page.click("#search-form button[type=submit]");
      await page.waitForTimeout(500);
      const statusAfter = await page.textContent("#status-message");
      const ok = diag.consoleErrors.length === 0 && statusAfter === statusBefore;
      record({
        section: "6. Invalid input",
        name: "Empty search submit",
        status: ok ? "PASS" : "FAIL",
        detail: `before="${statusBefore}" after="${statusAfter}" consoleErrors=${diag.consoleErrors.length}`,
      });
      if (!ok) {
        reportBug({
          severity: "low",
          title: "Submitting an empty search changes state or logs an error",
          steps: "Load the app, immediately click Search with an empty input.",
          evidence: `before="${statusBefore}" after="${statusAfter}"`,
        });
      }
    } catch (err) {
      record({ section: "6. Invalid input", name: "Empty search submit", status: "FAIL", detail: (err as Error).message });
    } finally {
      await page.close();
    }
  }

  // Gibberish name
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, colorScheme: "dark" });
    const diag = wireDiagnostics(page);
    try {
      await page.goto(`${FRONTEND}/?mode=blink&fov=3`, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.fill("#search-input", "zzzqwerty123nonsense");
      await page.click("#search-form button[type=submit]");
      await page.waitForTimeout(15000);
      const status = await page.textContent("#status-message");
      const crashed = diag.consoleErrors.some((e) => /uncaught|TypeError|ReferenceError/i.test(e));
      const hasFriendlyMessage = !!status && status.trim().length > 0 && !/^\s*…?\s*$/.test(status);
      record({
        section: "6. Invalid input",
        name: 'Gibberish name "zzzqwerty123nonsense"',
        status: !crashed && hasFriendlyMessage ? "PASS" : "FAIL",
        detail: `status="${status}" consoleErrors=${diag.consoleErrors.length}`,
      });
      if (crashed || !hasFriendlyMessage) {
        reportBug({
          severity: "medium",
          title: "Gibberish name search does not resolve to a friendly error",
          steps: 'Search "zzzqwerty123nonsense".',
          evidence: `status="${status}"`,
        });
      }
      await page.screenshot({ path: path.join(QA_DIR, shot("06-gibberish-name")) });
    } catch (err) {
      record({ section: "6. Invalid input", name: "Gibberish name", status: "FAIL", detail: (err as Error).message });
    } finally {
      await page.close();
    }
  }
}

// ---------------------------------------------------------------------
// 7. Embed button
// ---------------------------------------------------------------------
async function sectionEmbed(browser: Browser): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, colorScheme: "dark" });
  try {
    await page.goto(`${FRONTEND}/?mode=blink&fov=3`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.fill("#search-input", "wise0855");
    await page.click("#search-form button[type=submit]");
    await page.waitForSelector(".blink-frame[src]", { timeout: 20000 });

    await page.click("#embed-button");
    await page.waitForSelector("#embed-dialog[open]", { timeout: 5000 });
    const code = await page.inputValue("#embed-code");
    const match = code.match(/src="([^"]+)"/);
    const iframeSrc = match?.[1];

    if (!iframeSrc) {
      record({ section: "7. Embed", name: "Embed snippet contains iframe src", status: "FAIL", detail: code });
      reportBug({
        severity: "high",
        title: "Embed dialog does not produce a usable iframe snippet",
        steps: "Search a target, click Embed, inspect the textarea.",
        evidence: code,
      });
    } else {
      const resp = await page.request.get(iframeSrc, { timeout: 20000 });
      const ok = resp.ok();
      record({
        section: "7. Embed",
        name: "Embed iframe URL resolves",
        status: ok ? "PASS" : "FAIL",
        detail: `GET ${iframeSrc} -> ${resp.status()}`,
      });
      if (!ok) {
        reportBug({
          severity: "high",
          title: "Embed iframe src URL does not load",
          steps: `Fetch ${iframeSrc} directly.`,
          evidence: `HTTP ${resp.status()}`,
        });
      }
    }
    await page.screenshot({ path: path.join(QA_DIR, shot("07-embed-dialog")) });
  } catch (err) {
    record({ section: "7. Embed", name: "Embed button", status: "FAIL", detail: (err as Error).message });
    reportBug({
      severity: "high",
      title: "Embed button flow threw an error",
      steps: "Search a target, click Embed.",
      evidence: (err as Error).message,
    });
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------
// 8. Mobile viewport
// ---------------------------------------------------------------------
async function sectionMobile(browser: Browser): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: "dark", isMobile: true, hasTouch: true });
  try {
    await page.goto(`${FRONTEND}/?mode=blink&fov=3`, { waitUntil: "domcontentloaded", timeout: 20000 });
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const viewportWidth = 390;
    const noHorizontalScroll = scrollWidth <= viewportWidth + 1; // 1px rounding tolerance

    record({
      section: "8. Mobile (390x844)",
      name: "No horizontal overflow on load",
      status: noHorizontalScroll ? "PASS" : "FAIL",
      detail: `document.scrollWidth=${scrollWidth}px (viewport=${viewportWidth}px)`,
    });
    if (!noHorizontalScroll) {
      reportBug({
        severity: "high",
        title: "Horizontal scroll/overflow on 390px-wide mobile viewport",
        steps: `Open ${FRONTEND}/ at 390x844.`,
        evidence: `scrollWidth=${scrollWidth}px`,
      });
    }

    await page.tap("#search-input");
    await page.fill("#search-input", "wise0855");
    await page.tap("#search-form button[type=submit]");
    await page.waitForSelector(".blink-frame[src]", { timeout: 20000 });
    const scrollWidthAfter = await page.evaluate(() => document.documentElement.scrollWidth);
    record({
      section: "8. Mobile (390x844)",
      name: "Search usable via tap, no overflow after results",
      status: scrollWidthAfter <= viewportWidth + 1 ? "PASS" : "FAIL",
      detail: `document.scrollWidth=${scrollWidthAfter}px after loading results`,
    });
    await page.screenshot({ path: path.join(QA_DIR, shot("08-mobile")), fullPage: true });
  } catch (err) {
    record({ section: "8. Mobile (390x844)", name: "Mobile flow", status: "FAIL", detail: (err as Error).message });
    reportBug({
      severity: "high",
      title: "Mobile viewport flow threw an error",
      steps: "Open the app at 390x844, search a target.",
      evidence: (err as Error).message,
    });
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------
// 9. Backend: health, CORS, cold start note
// ---------------------------------------------------------------------
async function sectionBackend(): Promise<void> {
  const [res, ms] = await timeIt(() => fetch(`${BACKEND}/api/health`));
  const bodyText = await res.text();
  record({
    section: "9. Backend",
    name: "GET /api/health",
    status: res.ok ? "PASS" : "FAIL",
    detail: `HTTP ${res.status} :: ${bodyText}`,
    timingMs: ms,
  });
  if (!res.ok) {
    reportBug({
      severity: "critical",
      title: "Backend health check failing",
      steps: `curl ${BACKEND}/api/health`,
      evidence: `HTTP ${res.status}`,
    });
  }

  const corsRes = await fetch(`${BACKEND}/api/health`, { headers: { Origin: FRONTEND } });
  const allowOrigin = corsRes.headers.get("access-control-allow-origin");
  const corsOk = allowOrigin === "*" || allowOrigin === FRONTEND;
  record({
    section: "9. Backend",
    name: `CORS header for Origin: ${FRONTEND}`,
    status: corsOk ? "PASS" : "FAIL",
    detail: `access-control-allow-origin="${allowOrigin}"`,
  });
  if (!corsOk) {
    reportBug({
      severity: "critical",
      title: "Backend does not send a CORS header allowing the production frontend origin",
      steps: `curl -H "Origin: ${FRONTEND}" -I ${BACKEND}/api/health`,
      evidence: `access-control-allow-origin="${allowOrigin}"`,
    });
  }

  record({
    section: "9. Backend",
    name: "Cold start behavior",
    status: "WARN",
    detail:
      "fly.toml sets auto_stop_machines=stop, min_machines_running=0, so the machine can scale to zero and cold-start on the next request. Not forced here (would disrupt the live judged demo); current /api/health latency above is a warm-machine baseline. See DECISIONS.md for previously observed cold-start timing (~3-9s).",
  });
}

// ---------------------------------------------------------------------
// 10. Accessibility (axe-core)
// ---------------------------------------------------------------------
async function sectionAccessibility(browser: Browser): Promise<void> {
  const axeSource = readFileSync(path.join(REPO_ROOT, "node_modules", "axe-core", "axe.min.js"), "utf-8");
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, colorScheme: "dark" });
  try {
    await page.goto(`${FRONTEND}/?mode=blink&fov=3`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.fill("#search-input", "wise0855");
    await page.click("#search-form button[type=submit]");
    await page.waitForSelector(".blink-frame[src]", { timeout: 20000 });

    await page.addScriptTag({ content: axeSource });
    const axeResults = await page.evaluate(async () => {
      // @ts-expect-error -- axe is injected globally by the script tag above
      return await window.axe.run(document, { resultTypes: ["violations"] });
    });

    interface AxeNode { target: string[] }
    interface AxeViolation { id: string; impact: string; description: string; help: string; nodes: AxeNode[] }
    const violations = (axeResults as { violations: AxeViolation[] }).violations;
    const severe = violations.filter((v) => v.impact === "serious" || v.impact === "critical");

    record({
      section: "10. Accessibility",
      name: "axe-core scan (loaded result page)",
      status: severe.length === 0 ? "PASS" : "FAIL",
      detail:
        severe.length === 0
          ? `0 serious/critical violations (${violations.length} total incl. minor/moderate)`
          : severe.map((v) => `[${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s): ${v.nodes[0]?.target.join(" ")})`).join(" | "),
    });
    for (const v of severe) {
      reportBug({
        severity: v.impact === "critical" ? "critical" : "high",
        title: `axe-core ${v.impact}: ${v.id} -- ${v.help}`,
        steps: `Run axe-core on ${FRONTEND}/ (loaded result page). Affected selector(s): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
        evidence: v.description,
      });
    }
  } catch (err) {
    record({ section: "10. Accessibility", name: "axe-core scan", status: "FAIL", detail: (err as Error).message });
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------
// Report writer
// ---------------------------------------------------------------------
function writeReport(): void {
  const now = new Date().toISOString();
  const passCount = results.filter((r) => r.status === "PASS").length;
  const failCount = results.filter((r) => r.status === "FAIL").length;
  const warnCount = results.filter((r) => r.status === "WARN").length;

  const severityOrder: Record<Bug["severity"], number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const sortedBugs = [...bugs].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const lines: string[] = [];
  lines.push("# Live QA Report -- SPHEREx Blink");
  lines.push("");
  lines.push(`Generated: ${now}`);
  lines.push(`Frontend: ${FRONTEND}`);
  lines.push(`Backend: ${BACKEND}`);
  lines.push("");
  lines.push(`**Summary: ${passCount} passed, ${failCount} failed, ${warnCount} warnings (${results.length} checks total)**`);
  lines.push("");
  lines.push("AI assistance: this report and the QA script that produced it");
  lines.push("(`scripts/qa_live.ts`) were written with Claude Code under the team's");
  lines.push("direction. See DECISIONS.md and README.md (\"AI assistance\").");
  lines.push("");

  lines.push("## Results");
  lines.push("");
  lines.push("| Section | Check | Status | Timing | Detail |");
  lines.push("|---|---|---|---|---|");
  for (const r of results) {
    const detail = r.detail.replace(/\|/g, "\\|").slice(0, 300);
    lines.push(`| ${r.section} | ${r.name} | ${r.status} | ${r.timingMs !== undefined ? r.timingMs + "ms" : "-"} | ${detail} |`);
  }
  lines.push("");

  lines.push("## Bugs found");
  lines.push("");
  if (sortedBugs.length === 0) {
    lines.push("None.");
  } else {
    for (const b of sortedBugs) {
      lines.push(`### [${b.severity.toUpperCase()}] ${b.title}`);
      lines.push("");
      lines.push(`- **Steps to reproduce:** ${b.steps}`);
      lines.push(`- **Evidence:** ${b.evidence}`);
      lines.push("");
    }
  }

  lines.push("## Screenshots");
  lines.push("");
  lines.push("See `docs/qa/screenshots/`.");
  lines.push("");

  writeFileSync(path.join(QA_DIR, "QA_REPORT.md"), lines.join("\n"), "utf-8");
  console.log(`\nReport written to ${path.join(QA_DIR, "QA_REPORT.md")}`);
  console.log(`${passCount} passed, ${failCount} failed, ${warnCount} warnings, ${sortedBugs.length} bugs recorded.`);
}

// ---------------------------------------------------------------------
async function main(): Promise<void> {
  const browser = await chromium.launch();
  try {
    await sectionLanding(browser);
    await sectionTargetsModes(browser);
    await sectionUrlAndNameSearch(browser);
    await sectionSpectrumLightcurve(browser);
    await sectionFovAndUncached(browser);
    await sectionInvalidInput(browser);
    await sectionEmbed(browser);
    await sectionMobile(browser);
    await sectionBackend();
    await sectionAccessibility(browser);
  } finally {
    await browser.close();
  }
  writeReport();
}

main().catch((err) => {
  console.error("QA run failed:", err);
  writeReport();
  process.exit(1);
});
