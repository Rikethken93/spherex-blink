import { t } from "../i18n/i18n";

export interface PlayerCallbacks {
  onFrameChange?: (index: number) => void;
  /** Fired on click with the click position as a fraction of the image
   * (0,0 = top-left, 1,1 = bottom-right), for mapping to a sky position. */
  onImageClick?: (fracX: number, fracY: number) => void;
}

export class BlinkPlayer {
  private frames: string[] = [];
  private index = 0;
  private playing = false;
  private direction = 1; // for "rock" mode
  private rockMode = false;
  private loop = true;
  private fps = 2;
  private timer: number | null = null;
  private img: HTMLImageElement;
  private callbacks: PlayerCallbacks;

  constructor(container: HTMLElement, callbacks: PlayerCallbacks = {}) {
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
    container.appendChild(this.img);
  }

  setFrames(urls: string[]): void {
    this.stop();
    this.frames = urls;
    this.index = 0;
    this.render();
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
      return;
    }
    this.img.src = this.frames[this.index];
    this.callbacks.onFrameChange?.(this.index);
  }

  currentIndex(): number {
    return this.index;
  }

  frameCount(): number {
    return this.frames.length;
  }
}

export function labelFor(key: string): string {
  return t(key);
}
