// Takes one screenshot per demo target for docs/screenshots/.
// Usage: node scripts/screenshot.mjs <frontend-base-url>
// Assumes both the backend (VITE_API_BASE) and this frontend dev/preview
// server are already running.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../docs/screenshots");
const BASE_URL = process.argv[2] ?? "http://localhost:5173";

const TARGET_KEYS = [
  "barnards-star",
  "epsilon-indi-b",
  "wise0855",
  "rw-aurigae",
  "r-draconis",
  "proxima-centauri",
  "luhman-16",
  "ugps0722",
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  for (const key of TARGET_KEYS) {
    console.log(`Screenshotting ${key}...`);
    await page.goto(`${BASE_URL}/?mode=blink&fov=3`, { waitUntil: "networkidle" });
    // The search box accepts a target key directly, the same way
    // /api/resolve?name=<key> does -- this hits the exact precached,
    // proper-motion-corrected position precache.py computed.
    await page.fill("#search-input", key);
    await page.click("#search-form button[type=submit]");
    await page.waitForSelector(".blink-frame[src]", { timeout: 60000 });
    await page.waitForTimeout(1500); // let the Aladin view + charts settle
    await page.screenshot({ path: path.join(OUT_DIR, `${key}.png`), fullPage: true });
  }

  await browser.close();
  console.log(`Done. Screenshots in ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
