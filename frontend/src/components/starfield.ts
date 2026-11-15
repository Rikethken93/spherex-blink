/** A quiet, ambient canvas starfield for the header band -- three depth
 * layers (far/mid/near) that drift slowly and shift with mouse position
 * for a subtle parallax, evoking the all-sky survey this tool visualizes.
 * Deliberately confined to the header, not the whole page: the data
 * panels need to stay quiet and legible, not compete with atmosphere.
 *
 * Respects prefers-reduced-motion (renders one static frame, no RAF loop,
 * no parallax) and is pure Canvas 2D -- no WebGL/Three.js dependency, to
 * stay consistent with the low-bandwidth-mode philosophy elsewhere in
 * this app. */

interface Star {
  x: number; // 0..1 fraction of canvas width
  y: number; // 0..1 fraction of canvas height
  r: number; // radius in px
  baseAlpha: number;
  twinklePhase: number;
  twinkleSpeed: number;
  parallax: number; // 0 (far, still) .. 1 (near, moves most)
}

function makeStars(count: number, parallaxRange: [number, number]): Star[] {
  const stars: Star[] = [];
  for (let i = 0; i < count; i++) {
    stars.push({
      x: Math.random(),
      y: Math.random(),
      r: Math.random() * 1.2 + 0.4,
      baseAlpha: Math.random() * 0.5 + 0.35,
      twinklePhase: Math.random() * Math.PI * 2,
      twinkleSpeed: Math.random() * 0.6 + 0.2,
      parallax: parallaxRange[0] + Math.random() * (parallaxRange[1] - parallaxRange[0]),
    });
  }
  return stars;
}

export function initStarfield(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Read the theme's own text color so the starfield adapts automatically
  // between dark (light dots on a night-sky ground) and light (the same
  // dots would vanish against a pale ground, so they need to go dark) --
  // re-read on each theme-media change rather than hardcoding one color.
  function starColor(): string {
    return getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#eef0fa";
  }
  let starRgb = hexToRgb(starColor());
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    starRgb = hexToRgb(starColor());
  });

  function hexToRgb(hex: string): [number, number, number] {
    const h = hex.replace("#", "");
    const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  const layers = [
    ...makeStars(60, [0, 0.15]), // far
    ...makeStars(40, [0.15, 0.4]), // mid
    ...makeStars(20, [0.4, 0.8]), // near
  ];

  let mouseX = 0.5;
  let mouseY = 0.5;
  let width = 0;
  let height = 0;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw(tSeconds: number) {
    ctx!.clearRect(0, 0, width, height);
    const px = (mouseX - 0.5) * 16; // max parallax shift in px
    const py = (mouseY - 0.5) * 10;
    for (const s of layers) {
      const twinkle = prefersReducedMotion
        ? s.baseAlpha
        : s.baseAlpha * (0.7 + 0.3 * Math.sin(tSeconds * s.twinkleSpeed + s.twinklePhase));
      const x = s.x * width + px * s.parallax;
      const y = s.y * height + py * s.parallax;
      ctx!.beginPath();
      ctx!.arc(x, y, s.r, 0, Math.PI * 2);
      ctx!.fillStyle = `rgba(${starRgb[0]}, ${starRgb[1]}, ${starRgb[2]}, ${twinkle})`;
      ctx!.fill();
    }
  }

  resize();
  draw(0);

  if (prefersReducedMotion) {
    window.addEventListener("resize", () => {
      resize();
      draw(0);
    });
    return;
  }

  window.addEventListener("resize", resize);
  canvas.parentElement?.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    mouseX = (e.clientX - rect.left) / rect.width;
    mouseY = (e.clientY - rect.top) / rect.height;
  });

  let rafId: number;
  function loop(tMs: number) {
    draw(tMs / 1000);
    rafId = requestAnimationFrame(loop);
  }
  rafId = requestAnimationFrame(loop);

  // Pause the loop when the tab isn't visible -- no reason to spend
  // battery/CPU animating a decorative backdrop nobody is looking at.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      cancelAnimationFrame(rafId);
    } else {
      rafId = requestAnimationFrame(loop);
    }
  });
}
