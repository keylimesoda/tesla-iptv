import Hls from "hls.js";

export type RenderMode = "video" | "canvas";

/**
 * Plays an HLS (or native) stream into a <video> element and optionally blits
 * frames onto a <canvas>.
 *
 * In "canvas" mode the <video> is pushed off-screen but keeps playing
 * (audio + decode continue); we drawImage() its current frame to a visible
 * canvas every animation frame. Because the visible surface is a canvas — not
 * a video element — Tesla's in-motion video suppression does not apply to it.
 */
export class Player {
  mode: RenderMode = "video";

  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private hls: Hls | null = null;
  private raf = 0;
  private lastUrl: string | null = null;

  constructor(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
  }

  get url(): string | null {
    return this.lastUrl;
  }

  load(url: string): void {
    this.stop();
    this.lastUrl = url;
    const v = this.video;

    if (Hls.isSupported()) {
      const hls = new Hls({
        // Live-tolerant defaults; works for VOD too.
        maxBufferLength: 30,
      });
      this.hls = hls;
      hls.loadSource(url);
      hls.attachMedia(v);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        void v.play().catch(() => {
          // Unmuted autoplay was blocked (play() runs after the manifest
          // fetch, outside the click gesture). Retry muted so the picture
          // still starts; the user unmutes from the controls.
          v.muted = true;
          void v.play().catch(() => {});
        });
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              // Surface fatal errors to the page.
              window.dispatchEvent(new CustomEvent("player:error", { detail: data }));
              break;
          }
        }
      });
    } else if (v.canPlayType("application/vnd.apple.mpegurl")) {
      v.src = url;
      v.addEventListener("loadedmetadata", () => {
        void v.play().catch(() => {
          v.muted = true;
          void v.play().catch(() => {});
        });
      }, { once: true });
    } else {
      window.dispatchEvent(new CustomEvent("player:error", { detail: { message: "HLS not supported" } }));
    }

    // Re-apply the current render mode: stop() above cancelled the canvas blit.
    this.setMode(this.mode);
  }

  setMode(mode: RenderMode): void {
    this.mode = mode;
    this.video.classList.toggle("offscreen", mode === "canvas");
    this.canvas.classList.toggle("active", mode === "canvas");
    if (mode === "canvas") this.startBlit();
    else this.stopBlit();
  }

  private startBlit(): void {
    const v = this.video;
    const c = this.canvas;
    const ctx = this.ctx;
    if (!ctx) return;

    const blit = () => {
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (w > 0 && h > 0 && v.videoWidth > 0 && v.videoHeight > 0) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const pw = Math.round(w * dpr);
        const ph = Math.round(h * dpr);
        if (c.width !== pw || c.height !== ph) {
          c.width = pw;
          c.height = ph;
        }
        // Contain-fit the frame, letterboxed on black.
        const s = Math.min(pw / v.videoWidth, ph / v.videoHeight);
        const dw = v.videoWidth * s;
        const dh = v.videoHeight * s;
        const dx = (pw - dw) / 2;
        const dy = (ph - dh) / 2;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, pw, ph);
        ctx.drawImage(v, dx, dy, dw, dh);
      }
      this.raf = requestAnimationFrame(blit);
    };
    this.raf = requestAnimationFrame(blit);
  }

  private stopBlit(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  play(): void {
    void this.video.play().catch(() => {});
  }

  pause(): void {
    this.video.pause();
  }

  toggle(): void {
    if (this.video.paused) this.play();
    else this.pause();
  }

  get paused(): boolean {
    return this.video.paused;
  }

  setMuted(m: boolean): void {
    this.video.muted = m;
  }

  get muted(): boolean {
    return this.video.muted;
  }

  stop(): void {
    this.stopBlit();
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    const v = this.video;
    v.pause();
    v.removeAttribute("src");
    v.load();
  }
}
