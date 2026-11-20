// "Smooth" display mode: real interpolation of the native SPHEREx pixels.
//
// The backend ships PNGs already nearest-neighbor upscaled (render.py,
// MIN_DISPLAY_PX): a 3' cutout is ~29x29 real pixels, each repeated as a
// ~14x14 block. Asking the browser to smooth *that* image (CSS
// image-rendering: auto) only softens the 1px seams between blocks -- the
// blocks themselves are baked into the PNG, so "Smooth" looked identical
// to the crisp view.
//
// Here we undo the block upscale (recover one value per real pixel, using
// a per-channel median of the block so the 1px crosshair / saturation
// outline drawn into it can't contaminate the value), then resample with
// a Catmull-Rom bicubic back to the PNG's own size and redraw the
// crosshair on top. Each real pixel's value is preserved exactly at its
// own center; only the space *between* pixel centers is interpolated. No
// sharpening, denoising or detail synthesis -- display only, the cached
// data and the default crisp view are untouched.

const CROSSHAIR = { r: 255, g: 90, b: 90, arm: 18, gap: 7 }; // mirrors render.py _draw_crosshair

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // backend serves CORS *; needed for getImageData
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${url}`));
    img.src = url;
  });
}

/** Largest integer block size k (dividing both dimensions) for which
 * horizontally/vertically adjacent pixels *inside* a block are almost
 * always identical -- i.e. the nearest-neighbor upscale factor. */
function detectBlockSize(data: Uint8ClampedArray, w: number, h: number): number {
  const same = (i: number, j: number) =>
    data[i] === data[j] && data[i + 1] === data[j + 1] && data[i + 2] === data[j + 2];
  let best = 1;
  for (let k = 2; k <= Math.min(64, w, h); k++) {
    if (w % k !== 0 || h % k !== 0) continue;
    let pairs = 0;
    let mismatches = 0;
    // Sample every 3rd row/column to keep this cheap.
    for (let y = 0; y < h; y += 3) {
      for (let x = 0; x < w - 1; x++) {
        if ((x + 1) % k === 0) continue; // crosses a block boundary
        pairs++;
        const i = (y * w + x) * 4;
        if (!same(i, i + 4)) mismatches++;
      }
    }
    for (let x = 0; x < w; x += 3) {
      for (let y = 0; y < h - 1; y++) {
        if ((y + 1) % k === 0) continue;
        pairs++;
        const i = (y * w + x) * 4;
        if (!same(i, i + w * 4)) mismatches++;
      }
    }
    // Crosshair + saturation outlines are thin lines, a few % at most.
    if (pairs > 0 && mismatches / pairs < 0.03) best = k;
  }
  return best;
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  return values[values.length >> 1];
}

function hasCrosshair(data: Uint8ClampedArray, w: number, h: number): boolean {
  const cx = w >> 1;
  const cy = h >> 1;
  const i = (cy * w + (cx - CROSSHAIR.gap - 2)) * 4;
  return data[i] === CROSSHAIR.r && data[i + 1] === CROSSHAIR.g && data[i + 2] === CROSSHAIR.b;
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t)
  );
}

async function smoothFrame(url: string): Promise<string> {
  const img = await loadImage(url);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const src = ctx.getImageData(0, 0, w, h);
  const k = detectBlockSize(src.data, w, h);
  if (k < 2) return url; // not block-upscaled: nothing to undo

  // 1) Recover the native grid: per-channel median of each k x k block.
  const nw = w / k;
  const nh = h / k;
  const native = new Float32Array(nw * nh * 3);
  for (let by = 0; by < nh; by++) {
    for (let bx = 0; bx < nw; bx++) {
      const rs: number[] = [];
      const gs: number[] = [];
      const bs: number[] = [];
      for (let y = by * k; y < (by + 1) * k; y++) {
        for (let x = bx * k; x < (bx + 1) * k; x++) {
          const i = (y * w + x) * 4;
          rs.push(src.data[i]);
          gs.push(src.data[i + 1]);
          bs.push(src.data[i + 2]);
        }
      }
      const o = (by * nw + bx) * 3;
      native[o] = median(rs);
      native[o + 1] = median(gs);
      native[o + 2] = median(bs);
    }
  }

  // 2) Bicubic (Catmull-Rom) resample back to w x h. Output pixel centers
  // map onto native pixel centers, so each real pixel keeps its value at
  // its own center.
  const out = ctx.createImageData(w, h);
  const at = (x: number, y: number, c: number) => {
    const cx = Math.min(nw - 1, Math.max(0, x));
    const cy = Math.min(nh - 1, Math.max(0, y));
    return native[(cy * nw + cx) * 3 + c];
  };
  for (let y = 0; y < h; y++) {
    const fy = (y + 0.5) / k - 0.5;
    const y1 = Math.floor(fy);
    const ty = fy - y1;
    for (let x = 0; x < w; x++) {
      const fx = (x + 0.5) / k - 0.5;
      const x1 = Math.floor(fx);
      const tx = fx - x1;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const row = (yy: number) =>
          catmullRom(at(x1 - 1, yy, c), at(x1, yy, c), at(x1 + 1, yy, c), at(x1 + 2, yy, c), tx);
        const v = catmullRom(row(y1 - 1), row(y1), row(y1 + 1), row(y1 + 2), ty);
        out.data[o + c] = v; // Uint8ClampedArray clamps the bicubic overshoot
      }
      out.data[o + 3] = 255;
    }
  }
  const hadCrosshair = hasCrosshair(src.data, w, h);
  ctx.putImageData(out, 0, 0);

  // 3) Redraw the target crosshair crisply on top (it was median-filtered out).
  if (hadCrosshair) {
    const cx = w >> 1;
    const cy = h >> 1;
    const { arm, gap } = CROSSHAIR;
    ctx.fillStyle = `rgb(${CROSSHAIR.r}, ${CROSSHAIR.g}, ${CROSSHAIR.b})`;
    ctx.fillRect(cx - arm - gap, cy, arm + 1, 1);
    ctx.fillRect(cx + gap, cy, arm + 1, 1);
    ctx.fillRect(cx, cy - arm - gap, 1, arm + 1);
    ctx.fillRect(cx, cy + gap, 1, arm + 1);
  }
  return canvas.toDataURL("image/png");
}

const cache = new Map<string, Promise<string>>();

/** Smoothed data URL for a frame URL (memoized). Falls back to the
 * original URL if the frame can't be read (e.g. a CORS failure). */
export function smoothedFrameUrl(url: string): Promise<string> {
  let p = cache.get(url);
  if (!p) {
    p = smoothFrame(url).catch(() => url);
    cache.set(url, p);
  }
  return p;
}
