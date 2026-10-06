declare global {
  interface Window {
    LibAV?: {
      base?: string;
      LibAV?: (opts?: Record<string, unknown>) => Promise<any>;
    };
  }
}

let libavLoader: Promise<void> | null = null;

function loadLibAV(): Promise<void> {
  if (window.LibAV?.LibAV) return Promise.resolve();
  if (libavLoader) return libavLoader;

  const base = `${location.origin}${import.meta.env.BASE_URL}libav-h264`;
  window.LibAV = { base };
  libavLoader = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${base}/libav-6.10.9.0-h264-poc.js`;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load libav.js H.264 runtime"));
    document.head.append(script);
  });
  return libavLoader;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emitStatus(detail: Record<string, unknown>): void {
  window.dispatchEvent(new CustomEvent("wasm:status", { detail }));
}


type HlsProbe = {
  url: string;
  kind: "master" | "media" | "unknown";
  status: number;
  contentType: string;
  text: string;
  variants: Array<{ url: string; bandwidth: number; codecs: string }>;
};

async function probePlaylist(url: string): Promise<HlsProbe> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`playlist HTTP ${response.status}`);
  }
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  const variants: Array<{ url: string; bandwidth: number; codecs: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
    const attrs = lines[i].slice("#EXT-X-STREAM-INF:".length);
    const bw = Number(attrs.match(/(?:^|,)BANDWIDTH=(\d+)/)?.[1] || 0);
    const codecs = attrs.match(/(?:^|,)CODECS="([^"]*)"/)?.[1] || "";
    const uri = lines.slice(i + 1).find((line) => !line.startsWith("#"));
    if (uri) variants.push({ url: new URL(uri, response.url || url).href, bandwidth: bw, codecs });
  }

  const kind: HlsProbe["kind"] = variants.length
    ? "master"
    : lines.some((line) => line.startsWith("#EXTINF") || line.startsWith("#EXT-X-TARGETDURATION"))
      ? "media"
      : "unknown";

  return { url: response.url || url, kind, status: response.status, contentType, text, variants };
}

async function resolveH264MediaPlaylist(url: string): Promise<{ probe: HlsProbe; diagnostic: string }> {
  let current = url;
  const trail: string[] = [];

  for (let depth = 0; depth < 3; depth++) {
    const probe = await probePlaylist(current);
    trail.push(`${probe.kind} HTTP ${probe.status}${probe.contentType ? ` ${probe.contentType.split(";")[0]}` : ""}`);

    if (probe.kind !== "master") {
      return { probe, diagnostic: trail.join(" → ") };
    }

    const explicitlyH264 = probe.variants.filter((v) => /(?:^|,)(?:avc1|avc3)\./i.test(v.codecs));
    const candidates = explicitlyH264.length ? explicitlyH264 : probe.variants;
    candidates.sort((a, b) => {
      const abw = a.bandwidth || Number.MAX_SAFE_INTEGER;
      const bbw = b.bandwidth || Number.MAX_SAFE_INTEGER;
      return abw - bbw;
    });

    const selected = candidates[0];
    if (!selected) throw new Error("master playlist contains no variants");

    const allCodecsKnown = probe.variants.every((v) => v.codecs);
    if (!explicitlyH264.length && allCodecsKnown) {
      const codecs = Array.from(new Set(probe.variants.map((v) => v.codecs))).join(" | ");
      throw new Error(`master playlist has no H.264 variant (CODECS: ${codecs})`);
    }

    current = selected.url;
  }

  throw new Error("HLS master playlist nesting is deeper than expected");
}

function localizeMediaPlaylist(probe: HlsProbe): { text: string; segmentCount: number } {
  const lines = probe.text.split(/\r?\n/);
  let segmentCount = 0;

  const absolutize = (uri: string): string => {
    const absolute = new URL(uri, probe.url).href;
    return absolute.startsWith("jsfetch:") ? absolute : `jsfetch:${absolute}`;
  };

  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (/^#EXT-X-KEY:/i.test(trimmed)) {
      const method = trimmed.match(/METHOD=([^,]*)/i)?.[1]?.toUpperCase();
      if (method && method !== "NONE") {
        throw new Error(`encrypted HLS is not enabled in the WASM beta (METHOD=${method})`);
      }
    }

    // Tags such as EXT-X-MAP and EXT-X-KEY can carry a URI attribute.
    if (trimmed.startsWith("#")) {
      return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => `URI="${absolutize(uri)}"`);
    }

    segmentCount++;
    const leading = line.slice(0, line.indexOf(trimmed));
    return leading + absolutize(trimmed);
  });

  return { text: rewritten.join("\n"), segmentCount };
}


type MediaSegment = {
  url: string;
  duration: number;
};

function parseMediaSegments(probe: HlsProbe): {
  initUrl: string | null;
  segments: MediaSegment[];
  endList: boolean;
} {
  const lines = probe.text.split(/\r?\n/).map((line) => line.trim());
  let initUrl: string | null = null;
  let pendingDuration = 0;
  const segments: MediaSegment[] = [];

  for (const line of lines) {
    if (!line) continue;

    if (/^#EXT-X-KEY:/i.test(line)) {
      const method = line.match(/METHOD=([^,]*)/i)?.[1]?.toUpperCase();
      if (method && method !== "NONE") {
        throw new Error(`encrypted HLS is not enabled in the WASM beta (METHOD=${method})`);
      }
      continue;
    }

    if (/^#EXT-X-BYTERANGE:/i.test(line)) {
      throw new Error("HLS byte-range segments are not enabled in the WASM beta");
    }

    if (/^#EXT-X-MAP:/i.test(line)) {
      const uri = line.match(/URI="([^"]+)"/i)?.[1];
      if (uri) initUrl = new URL(uri, probe.url).href;
      continue;
    }

    if (/^#EXTINF:/i.test(line)) {
      pendingDuration = Number(line.slice("#EXTINF:".length).split(",")[0]) || 0;
      continue;
    }

    if (line.startsWith("#")) continue;

    segments.push({
      url: new URL(line, probe.url).href,
      duration: pendingDuration,
    });
    pendingDuration = 0;
  }

  return {
    initUrl,
    segments,
    endList: lines.some((line) => /^#EXT-X-ENDLIST/i.test(line)),
  };
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function sniffContainer(data: Uint8Array, firstUrl: string, hasInit: boolean): "mpegts" | "mp4" {
  if (hasInit) return "mp4";

  if (data.length >= 376 && data[0] === 0x47 && data[188] === 0x47) {
    return "mpegts";
  }

  if (data.length >= 8) {
    const box = String.fromCharCode(data[4], data[5], data[6], data[7]);
    if (box === "ftyp" || box === "styp" || box === "moof") return "mp4";
  }

  const pathname = new URL(firstUrl).pathname.toLowerCase();
  if (pathname.endsWith(".ts") || pathname.endsWith(".mpegts")) return "mpegts";
  if (pathname.endsWith(".m4s") || pathname.endsWith(".mp4") || pathname.endsWith(".cmfv")) return "mp4";

  throw new Error(
    `could not identify media container (first bytes ${Array.from(data.slice(0, 8)).map((b) => b.toString(16).padStart(2, "0")).join(" ")})`,
  );
}

async function fetchBytes(url: string, label: string): Promise<{ data: Uint8Array; contentType: string }> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${label} HTTP ${response.status}`);
  }
  const data = new Uint8Array(await response.arrayBuffer());
  if (!data.byteLength) throw new Error(`${label} returned zero bytes`);
  return {
    data,
    contentType: response.headers.get("content-type") || "",
  };
}

async function buildMediaSnapshot(probe: HlsProbe): Promise<{
  data: Uint8Array;
  container: "mpegts" | "mp4";
  segmentCount: number;
  seconds: number;
  diagnostic: string;
}> {
  const parsed = parseMediaSegments(probe);
  if (!parsed.segments.length) throw new Error("media playlist contains no segment URIs");

  // Three segments is enough to prove the transport/demux/decode path without
  // pulling an entire VOD playlist into Tesla memory.
  const selected = parsed.segments.slice(0, Math.min(3, parsed.segments.length));
  const parts: Uint8Array[] = [];
  let initBytes: Uint8Array | null = null;

  if (parsed.initUrl) {
    const init = await fetchBytes(parsed.initUrl, "HLS init segment");
    initBytes = init.data;
    parts.push(init.data);
  }

  let firstMedia: Uint8Array | null = null;
  let firstContentType = "";
  for (let i = 0; i < selected.length; i++) {
    const fetched = await fetchBytes(selected[i].url, `HLS segment ${i + 1}`);
    if (!firstMedia) {
      firstMedia = fetched.data;
      firstContentType = fetched.contentType;
    }
    parts.push(fetched.data);
  }

  if (!firstMedia) throw new Error("no media bytes fetched");
  const container = sniffContainer(initBytes || firstMedia, selected[0].url, !!initBytes);
  const seconds = selected.reduce((sum, seg) => sum + seg.duration, 0);

  return {
    data: concatBytes(parts),
    container,
    segmentCount: selected.length,
    seconds,
    diagnostic: `${container} · ${selected.length} segment${selected.length === 1 ? "" : "s"} · ${(parts.reduce((n, p) => n + p.byteLength, 0) / 1024 / 1024).toFixed(1)} MiB${firstContentType ? ` · ${firstContentType.split(";")[0]}` : ""}`,
  };
}

class YuvRenderer {
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private textures: WebGLTexture[];
  private textureSizes: Array<[number, number] | null> = [null, null, null];

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("WebGL unavailable");
    this.gl = gl;

    const vertex = `
      attribute vec2 aPos;
      varying vec2 vUV;
      void main() {
        vUV = (aPos + 1.0) * 0.5;
        vUV.y = 1.0 - vUV.y;
        gl_Position = vec4(aPos, 0.0, 1.0);
      }
    `;
    const fragment = `
      precision mediump float;
      varying vec2 vUV;
      uniform sampler2D yTex;
      uniform sampler2D uTex;
      uniform sampler2D vTex;
      void main() {
        float y = texture2D(yTex, vUV).r;
        float u = texture2D(uTex, vUV).r - 0.5;
        float v = texture2D(vTex, vUV).r - 0.5;
        gl_FragColor = vec4(
          y + 1.402 * v,
          y - 0.344136 * u - 0.714136 * v,
          y + 1.772 * u,
          1.0
        );
      }
    `;

    const shader = (type: number, source: string): WebGLShader => {
      const out = gl.createShader(type);
      if (!out) throw new Error("Could not create WebGL shader");
      gl.shaderSource(out, source);
      gl.compileShader(out);
      if (!gl.getShaderParameter(out, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(out) || "WebGL shader compile failed");
      }
      return out;
    };

    const program = gl.createProgram();
    if (!program) throw new Error("Could not create WebGL program");
    gl.attachShader(program, shader(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "WebGL program link failed");
    }
    this.program = program;
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    if (!buffer) throw new Error("Could not create WebGL buffer");
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const pos = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

    const makeTexture = (unit: number, name: string): WebGLTexture => {
      const tex = gl.createTexture();
      if (!tex) throw new Error("Could not create WebGL texture");
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(program, name), unit);
      return tex;
    };

    this.textures = [
      makeTexture(0, "yTex"),
      makeTexture(1, "uTex"),
      makeTexture(2, "vTex"),
    ];
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  private plane(frame: any, index: number, width: number, height: number): Uint8Array {
    const layout = frame.layout?.[index];
    if (!layout) throw new Error(`Decoded frame is missing YUV plane ${index}`);
    if (layout.stride === width) {
      return frame.data.subarray(layout.offset, layout.offset + width * height);
    }
    const out = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      out.set(
        frame.data.subarray(
          layout.offset + y * layout.stride,
          layout.offset + y * layout.stride + width,
        ),
        y * width,
      );
    }
    return out;
  }

  private upload(unit: number, width: number, height: number, data: Uint8Array): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[unit]);
    const old = this.textureSizes[unit];
    if (!old || old[0] !== width || old[1] !== height) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.LUMINANCE,
        width,
        height,
        0,
        gl.LUMINANCE,
        gl.UNSIGNED_BYTE,
        data,
      );
      this.textureSizes[unit] = [width, height];
    } else {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        width,
        height,
        gl.LUMINANCE,
        gl.UNSIGNED_BYTE,
        data,
      );
    }
  }

  render(frame: any): void {
    if (frame.format !== 0) {
      throw new Error(`WASM beta currently requires YUV420P; decoder returned pixel format ${frame.format}`);
    }

    const width = frame.width as number;
    const height = frame.height as number;
    const cw = width >> 1;
    const ch = height >> 1;

    this.upload(0, width, height, this.plane(frame, 0, width, height));
    this.upload(1, cw, ch, this.plane(frame, 1, cw, ch));
    this.upload(2, cw, ch, this.plane(frame, 2, cw, ch));

    const cssWidth = Math.max(1, this.canvas.clientWidth);
    const cssHeight = Math.max(1, this.canvas.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(cssWidth * dpr);
    const pixelHeight = Math.round(cssHeight * dpr);
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }

    const gl = this.gl;
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const scale = Math.min(pixelWidth / width, pixelHeight / height);
    const outWidth = Math.round(width * scale);
    const outHeight = Math.round(height * scale);
    const x = Math.floor((pixelWidth - outWidth) / 2);
    const y = Math.floor((pixelHeight - outHeight) / 2);
    gl.viewport(x, y, outWidth, outHeight);
    gl.useProgram(this.program);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  clear(): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
}

export class WasmHlsPlayer {
  private renderer: YuvRenderer | null = null;
  private libav: any = null;
  private generation = 0;
  private isPaused = false;
  private lastFrameTime = 0;
  private decodeFrames = 0;
  private decodeStarted = 0;

  constructor(private canvas: HTMLCanvasElement) {}

  get paused(): boolean {
    return this.isPaused;
  }

  play(): void {
    this.isPaused = false;
  }

  pause(): void {
    this.isPaused = true;
  }

  toggle(): void {
    this.isPaused = !this.isPaused;
  }

  stop(): void {
    this.generation++;
    this.isPaused = false;
    this.renderer?.clear();
    if (this.libav?.terminate) {
      try {
        this.libav.terminate();
      } catch {
        // Best-effort worker cleanup.
      }
    }
    this.libav = null;
  }

  async load(url: string): Promise<void> {
    this.stop();
    const generation = this.generation;
    emitStatus({ message: "WASM beta: loading decoder…" });

    await loadLibAV();
    if (generation !== this.generation) return;

    const factory = window.LibAV?.LibAV;
    if (!factory) throw new Error("libav.js loaded without LibAV factory");

    this.renderer ??= new YuvRenderer(this.canvas);
    // Match the standalone diagnostic's known-good execution mode for now.
    // Worker mode can be re-enabled after HLS compatibility is proven.
    const libav = await factory({ noworker: true });
    if (generation !== this.generation) {
      libav.terminate?.();
      return;
    }
    this.libav = libav;

    emitStatus({ message: "WASM beta: probing HLS playlist…" });
    let hlsDiagnostic = "probe unavailable";
    let mediaProbe: HlsProbe;
    try {
      const resolved = await resolveH264MediaPlaylist(url);
      hlsDiagnostic = resolved.diagnostic;
      mediaProbe = resolved.probe;
      emitStatus({ message: `WASM beta: ${hlsDiagnostic} · fetching media segments…` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`HLS probe failed: ${msg}`);
    }

    // Keep HLS transport in JavaScript and give libav a plain media file.
    // This deliberately avoids libav/FFmpeg's HLS demuxer, which is the part
    // failing on the real IPTV playlists even though browser fetch succeeds.
    let snapshot: Awaited<ReturnType<typeof buildMediaSnapshot>>;
    try {
      snapshot = await buildMediaSnapshot(mediaProbe);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`HLS media fetch failed (${hlsDiagnostic}): ${msg}`);
    }
    if (generation !== this.generation) return;

    const mediaName = `wasm-media-${generation}.${snapshot.container === "mpegts" ? "ts" : "mp4"}`;
    await libav.writeFile(mediaName, snapshot.data);
    emitStatus({
      message: `WASM beta: ${hlsDiagnostic} · ${snapshot.diagnostic} · opening media…`,
    });

    let formatContext: any;
    let streams: any[];
    try {
      [formatContext, streams] = await libav.ff_init_demuxer_file(mediaName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not open fetched ${snapshot.container} media (${snapshot.diagnostic}): ${msg}`,
      );
    }
    if (generation !== this.generation) return;

    // AVMEDIA_TYPE_VIDEO is 0 in FFmpeg. Some libav.js worker builds do not
    // reflect enum constants back onto the proxy object, so do not depend on
    // the constant being present.
    const videoType = typeof libav.AVMEDIA_TYPE_VIDEO === "number"
      ? libav.AVMEDIA_TYPE_VIDEO
      : 0;
    const streamSummary = streams
      .map((s: any, i: number) => `${i}:type=${s.codec_type},codec=${s.codec_id}`)
      .join(" ");

    let videoIndex = -1;
    for (let i = 0; i < streams.length; i++) {
      if (Number(streams[i].codec_type) === videoType) {
        videoIndex = i;
        break;
      }
    }
    if (videoIndex < 0) {
      throw new Error(
        `No video stream found (${hlsDiagnostic}; videoType=${videoType}; streams=${streamSummary || "none"})`,
      );
    }

    const stream = streams[videoIndex];
    const [, codecContext, packet, frame] = await libav.ff_init_decoder(
      stream.codec_id,
      stream.codecpar,
    );

    this.decodeFrames = 0;
    this.decodeStarted = performance.now();
    this.lastFrameTime = 0;
    let basePts: number | null = null;
    let baseWall = performance.now();

    emitStatus({
      message: `WASM beta: decoding H.264 · JS HLS bridge · ${snapshot.segmentCount} segments${snapshot.seconds ? ` / ~${snapshot.seconds.toFixed(1)}s` : ""}`,
      width: stream.codecpar?.width,
      height: stream.codecpar?.height,
    });

    while (generation === this.generation) {
      while (this.isPaused && generation === this.generation) await sleep(50);
      if (generation !== this.generation) break;

      const [result, packets] = await libav.ff_read_frame_multi(
        formatContext,
        packet,
        { limit: 512 * 1024 },
      );
      if (generation !== this.generation) break;

      const videoPackets = packets[videoIndex] || [];
      const frames = await libav.ff_decode_multi(
        codecContext,
        packet,
        frame,
        videoPackets,
        {
          fin: result === libav.AVERROR_EOF,
          copyoutFrame: "video",
        },
      );

      for (const decoded of frames) {
        if (generation !== this.generation) break;
        while (this.isPaused && generation === this.generation) await sleep(50);
        if (generation !== this.generation) break;

        const pts = Number.isFinite(decoded.best_effort_timestamp)
          ? decoded.best_effort_timestamp
          : decoded.pts;
        const tbNum = decoded.time_base_num || stream.time_base_num;
        const tbDen = decoded.time_base_den || stream.time_base_den;
        const seconds = Number.isFinite(pts) && tbNum && tbDen ? pts * tbNum / tbDen : NaN;

        if (Number.isFinite(seconds)) {
          if (basePts === null) {
            basePts = seconds;
            baseWall = performance.now();
          }
          let wait = baseWall + (seconds - basePts) * 1000 - performance.now();
          if (wait < -1500 || wait > 5000) {
            basePts = seconds;
            baseWall = performance.now();
            wait = 0;
          }
          if (wait > 1) await sleep(Math.min(wait, 1000));
        }

        this.renderer.render(decoded);
        this.decodeFrames++;
        this.lastFrameTime = performance.now();

        if (this.decodeFrames === 1 || this.decodeFrames % 30 === 0) {
          const elapsed = Math.max(0.001, (performance.now() - this.decodeStarted) / 1000);
          emitStatus({
            message: `WASM beta · ${decoded.width}×${decoded.height} · ${(this.decodeFrames / elapsed).toFixed(1)} decoded fps · JS HLS bridge · video only`,
            frames: this.decodeFrames,
            width: decoded.width,
            height: decoded.height,
            decodeFps: this.decodeFrames / elapsed,
          });
        }
      }

      if (result === libav.AVERROR_EOF) {
        emitStatus({ message: "WASM beta: stream ended" });
        break;
      }
    }
  }
}
