import { smoothedFrameUrl } from "./smooth";

export interface PlayerCallbacks {
  onFrameChange?: (index: number) => void;
  /** Fired on click with the click position as a fraction of the image
   * (0,0 = top-left, 1,1 = bottom-right), for mapping to a sky position. */
  onImageClick?: (fracX: number, fracY: number) => void;
}

// SPHEREx's native pixel scale is ~6.2"/pixel, and the backend already
// upscales its PNGs by a clean integer factor (see render.py) before this
// ever reaches a browser. The one remaining place a *non*-integer scale
// could sneak back in was here: a plain CSS width:100% stretches the
// image to whatever the responsive container happens to be, which is
// essentially never an exact multiple of the PNG's own pixel grid. Sizing
// explicitly to the nearest whole multiple (capped so it can't blow up on
// a wide screen) keeps every SPHEREx pixel a crisp, perfectly square block
// end to end, not just inside the PNG.
const MAX_DISPLAY_PX = 640;

export class BlinkPlayer {
  private frames: string[] = [];
  private index = 0;
  private playing = false;
  private direction = 1; // for "rock" mode
  private rockMode = false;
  private loop = true;
  private fps = 2;
  private fovArcmin = 3;
  private timer: number | null = null;
  private container: HTMLElement;
  private img: HTMLImageElement;
  private scaleBar: HTMLDivElement;
  private scaleBarTrack: HTMLDivElement;
  private scaleBarLabel: HTMLSpanElement;
  private marker: HTMLDivElement;
  private markerFrac: { x: number; y: number } | null = null;
  private markerEnabled = true;
  private callbacks: PlayerCallbacks;
  private smooth = false;
  // Bumped on every setFrames/setSmooth so a slow async smoothing pass for
  // an old frame set can never overwrite a newer one.
  private generation = 0;
  private displayFrames: string[] = [];

  constructor(container: HTMLElement, callbacks: PlayerCallbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;
    this.img = document.createElement("img");
    this.img.className = "blink-frame";
    this.img.alt = "";
    this.img.style.cursor = "crosshair";
    this.img.addEventListener("click", (e) => {
      const rect = this.img.getBoundingClientRect();
      const fracX = (e.clientX - rect.left) / rect.width;
      const fracY = (e.clientY - rect.top) / rect.height;
      this.callbacks.onImageClick?.(fracX, fracY);
    });
    this.img.addEventListener("load", () => {
      this.applyIntegerScale();
      this.updateScaleBar();
      this.positionMarker();
      // Content that renders *after* the image (metadata table, status
      // line, badges) can reflow ancestors by a fractional pixel,
      // un-doing the whole-device-pixel alignment applyIntegerScale just
      // computed -- observed live as a constant 0.5px offset that visibly
      // softens pixelated rendering. Re-align once more after the layout
      // has settled.
      window.setTimeout(() => {
        this.applyIntegerScale();
        this.positionMarker();
      }, 250);
    });
    container.appendChild(this.img);

    this.scaleBar = document.createElement("div");
    this.scaleBar.className = "scale-bar";
    this.scaleBar.setAttribute("aria-hidden", "true");
    this.scaleBarTrack = document.createElement("div");
    this.scaleBarTrack.className = "scale-bar-track";
    this.scaleBarLabel = document.createElement("span");
    this.scaleBar.appendChild(this.scaleBarTrack);
    this.scaleBar.appendChild(this.scaleBarLabel);
    container.appendChild(this.scaleBar);

    // Dim "J2000 position" marker: where this target *was* at epoch
    // J2000.0, so the gap to the crosshair makes its proper motion
    // since 2000 visible and explains why older charts point elsewhere.
    this.marker = document.createElement("div");
    this.marker.className = "j2000-marker";
    this.marker.setAttribute("aria-hidden", "true");
    this.marker.style.display = "none";
    const markerLabel = document.createElement("span");
    markerLabel.textContent = "J2000";
    this.marker.appendChild(markerLabel);
    container.appendChild(this.marker);

    let resizeTimer: number | null = null;
    window.addEventListener("resize", () => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        this.applyIntegerScale();
        this.positionMarker();
      }, 150);
    });
  }

  setFrames(urls: string[], fovArcmin?: number): void {
    this.stop();
    this.frames = urls;
    this.displayFrames = urls;
    if (fovArcmin !== undefined) this.fovArcmin = fovArcmin;
    this.index = 0;
    this.render();
    this.refreshDisplayFrames();
  }

  /** Smooth = real bicubic interpolation of the native pixels (see
   * smooth.ts), not just CSS smoothing of the pre-blocked PNG. */
  setSmooth(on: boolean): void {
    this.smooth = on;
    this.refreshDisplayFrames();
  }

  private refreshDisplayFrames(): void {
    const gen = ++this.generation;
    if (!this.smooth) {
      this.displayFrames = this.frames;
      this.render();
      return;
    }
    // Swap in all smoothed frames at once, so a playing blink never
    // alternates between smoothed and blocky frames.
    void Promise.all(this.frames.map(smoothedFrameUrl)).then((urls) => {
      if (gen !== this.generation) return;
      this.displayFrames = urls;
      this.render();
    });
  }

  /** Place the J2000 marker at an image-fraction position (same convention
   * as onImageClick: 0,0 = top-left). Pass null (or an off-image fraction)
   * to hide it. */
  setJ2000Marker(frac: { x: number; y: number } | null): void {
    this.markerFrac =
      frac && frac.x >= 0.02 && frac.x <= 0.98 && frac.y >= 0.02 && frac.y <= 0.98 ? frac : null;
    this.positionMarker();
  }

  setJ2000MarkerEnabled(on: boolean): void {
    this.markerEnabled = on;
    this.positionMarker();
  }

  private positionMarker(): void {
    if (!this.markerFrac || !this.markerEnabled || this.frames.length === 0) {
      this.marker.style.display = "none";
      return;
    }
    const imgRect = this.img.getBoundingClientRect();
    const containerRect = this.container.getBoundingClientRect();
    if (!imgRect.width) {
      this.marker.style.display = "none";
      return;
    }
    const left = imgRect.left - containerRect.left + this.markerFrac.x * imgRect.width;
    const top = imgRect.top - containerRect.top + this.markerFrac.y * imgRect.height;
    this.marker.style.left = `${left}px`;
    this.marker.style.top = `${top}px`;
    this.marker.style.display = "block";
  }

  setRockMode(on: boolean): void {
    this.rockMode = on;
  }

  setLoop(on: boolean): void {
    this.loop = on;
  }

  setSpeed(fps: number): void {
    this.fps = Math.max(0.5, Math.min(10, fps));
    if (this.playing) {
      this.stop();
      this.play();
    }
  }

  play(): void {
    if (this.frames.length < 2) return;
    this.playing = true;
    this.timer = window.setInterval(() => this.advance(), 1000 / this.fps);
  }

  pause(): void {
    this.playing = false;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  stop(): void {
    this.pause();
  }

  isPlaying(): boolean {
    return this.playing;
  }

  togglePlay(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  frameCount(): number {
    return this.frames.length;
  }

  stepNext(): void {
    this.pause();
    this.advance();
  }

  stepPrev(): void {
    this.pause();
    this.advance(-1);
  }

  private advance(forcedStep?: number): void {
    if (this.frames.length === 0) return;
    const step = forcedStep ?? this.direction;

    if (this.rockMode) {
      let next = this.index + step;
      if (next >= this.frames.length) {
        this.direction = -1;
        next = this.frames.length - 2 >= 0 ? this.frames.length - 2 : 0;
      } else if (next < 0) {
        this.direction = 1;
        next = Math.min(1, this.frames.length - 1);
      }
      this.index = next;
    } else {
      let next = this.index + step;
      if (next >= this.frames.length) {
        next = this.loop ? 0 : this.frames.length - 1;
        if (!this.loop) this.pause();
      } else if (next < 0) {
        next = this.loop ? this.frames.length - 1 : 0;
      }
      this.index = next;
    }
    this.render();
  }

  private render(): void {
    if (this.frames.length === 0) {
      this.img.removeAttribute("src");
      this.scaleBar.style.display = "none";
      return;
    }
    this.img.src = this.displayFrames[this.index] ?? this.frames[this.index];
    this.callbacks.onFrameChange?.(this.index);
  }

  // Snaps the displayed width/height to the nearest whole multiple of the
  // image's own (already integer-upscaled) pixel grid, capped at
  // MAX_DISPLAY_PX -- see the module comment above.
  private applyIntegerScale(): void {
    const nw = this.img.naturalWidth;
    const nh = this.img.naturalHeight;
    if (!nw || !nh) return;
    // All integer math happens in *device* pixels, not CSS pixels: on a
    // display with fractional scaling (devicePixelRatio 1.25/1.5/1.67...,
    // common on Linux/Windows laptops), "406 CSS px" lands on a
    // non-integer number of physical pixels, so each image pixel spans
    // e.g. 1.67 device px and pixelated rendering produces uneven,
    // softened blocks no matter how careful the CSS-pixel alignment is
    // (observed on a 165%-scaled screen). Choosing a whole number of
    // device pixels per image pixel and converting back to (possibly
    // fractional) CSS px keeps every block identical and crisp.
    const dpr = window.devicePixelRatio || 1;
    const availableCss = Math.min(this.container.clientWidth || nw, MAX_DISPLAY_PX);
    const kDev = Math.max(1, Math.floor((availableCss * dpr) / nw));
    const width = (nw * kDev) / dpr;
    this.img.style.width = `${width}px`;
    this.img.style.height = `${(nh * kDev) / dpr}px`;
    // Center manually -- see the CSS comment on .blink-container for why
    // justify-content can't be trusted to land on a whole pixel. Rounding
    // the margin against the immediate container isn't enough on its own:
    // an *ancestor* can still contribute its own fractional offset to the
    // final on-screen position, which no local arithmetic can predict in
    // advance. So: set a first-pass rounded margin, measure where the
    // browser actually put it, and cancel out whatever fractional pixel
    // remains -- guaranteeing the final edge lands on a whole device
    // pixel, which pixelated image-rendering needs to actually read as
    // crisp rather than softened at the boundary.
    const containerWidth = this.container.clientWidth;
    const idealMargin = Math.max(0, (containerWidth - width) / 2);
    // Idempotent alignment: reset margins, measure where layout naturally
    // puts the image, then set margins that land its edge on a *whole*
    // pixel. (The previous version applied a correction on top of an
    // unrounded base margin and re-derived it from an already-corrected
    // state on each call, so a second pass -- or an odd-width container --
    // left the edge on a half pixel, which visibly softens pixelated
    // rendering. Observed live as a constant -0.5px offset.)
    this.img.style.marginLeft = "0px";
    this.img.style.marginTop = "0px";
    const r0 = this.img.getBoundingClientRect();
    // Snap the edge to a whole *device* pixel (CSS-pixel rounding is only
    // equivalent when devicePixelRatio is an integer).
    const snap = (cssPos: number) => Math.round(cssPos * dpr) / dpr;
    this.img.style.marginLeft = `${snap(r0.left + idealMargin) - r0.left}px`;
    const r1 = this.img.getBoundingClientRect();
    this.img.style.marginTop = `${snap(r1.top) - r1.top}px`;
  }

  private updateScaleBar(): void {
    const displayedWidth = this.img.getBoundingClientRect().width;
    if (!displayedWidth || !this.fovArcmin) {
      this.scaleBar.style.display = "none";
      return;
    }
    const pxPerArcmin = displayedWidth / this.fovArcmin;
    // Below ~20px a 1' bar reads as a stray tick, not a scale reference --
    // show "30"" (half an arcmin) instead so it stays legible at a tight FOV.
    const arcminSpan = pxPerArcmin >= 20 ? 1 : 0.5;
    const label = arcminSpan === 1 ? "1′" : "30″";
    this.scaleBarTrack.style.width = `${pxPerArcmin * arcminSpan}px`;
    this.scaleBarLabel.textContent = label;
    this.scaleBar.style.display = "flex";
  }
}
