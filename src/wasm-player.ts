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

function nextAnimationFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
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
  variants: Array<{ url: string; bandwidth: number; codecs: string; width: number; height: number }>;
};

type MediaSegment = {
  url: string;
  duration: number;
  sequence: number;
  key: string;
};

async function probePlaylist(url: string): Promise<HlsProbe> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`playlist HTTP ${response.status}`);

  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const variants: HlsProbe["variants"] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
    const attrs = lines[i].slice("#EXT-X-STREAM-INF:".length);
    const bandwidth = Number(attrs.match(/(?:^|,)BANDWIDTH=(\d+)/)?.[1] || 0);
    const codecs = attrs.match(/(?:^|,)CODECS="([^"]*)"/)?.[1] || "";
    const resolution = attrs.match(/(?:^|,)RESOLUTION=(\d+)x(\d+)/i);
    const width = Number(resolution?.[1] || 0);
    const height = Number(resolution?.[2] || 0);
    const uri = lines.slice(i + 1).find((line) => !line.startsWith("#"));
    if (uri) {
      variants.push({
        url: new URL(uri, response.url || url).href,
        bandwidth,
        codecs,
        width,
        height,
      });
    }
  }

  const kind: HlsProbe["kind"] = variants.length
    ? "master"
    : lines.some((line) => line.startsWith("#EXTINF") || line.startsWith("#EXT-X-TARGETDURATION"))
      ? "media"
      : "unknown";

  return {
    url: response.url || url,
    kind,
    status: response.status,
    contentType,
    text,
    variants,
  };
}

async function resolveH264MediaPlaylist(url: string): Promise<{ probe: HlsProbe; diagnostic: string }> {
  let current = url;
  const trail: string[] = [];

  for (let depth = 0; depth < 3; depth++) {
    const probe = await probePlaylist(current);
    trail.push(
      `${probe.kind} HTTP ${probe.status}${probe.contentType ? ` ${probe.contentType.split(";")[0]}` : ""}`,
    );

    if (probe.kind !== "master") return { probe, diagnostic: trail.join(" → ") };

    const explicitlyH264 = probe.variants.filter((variant) =>
      /(?:^|,)(?:avc1|avc3)\./i.test(variant.codecs),
    );
    const candidates = explicitlyH264.length ? explicitlyH264 : probe.variants;

    // The original WASM proof intentionally picked the lowest-bandwidth rung,
    // which is why many channels appeared as 234p/360p even when their HLS
    // master advertised HD. For the real player, prefer the best H.264 rendition
    // up through 1080p. (A later UI can make this user-selectable.)
    const atOrBelow1080 = candidates.filter((variant) => !variant.height || variant.height <= 1080);
    const qualityPool = atOrBelow1080.length ? atOrBelow1080 : candidates;
    qualityPool.sort((a, b) => {
      if (a.height !== b.height) return b.height - a.height;
      if (a.width !== b.width) return b.width - a.width;
      return (b.bandwidth || 0) - (a.bandwidth || 0);
    });

    const selected = qualityPool[0];
    if (!selected) throw new Error("master playlist contains no variants");

    const allCodecsKnown = probe.variants.every((variant) => variant.codecs);
    if (!explicitlyH264.length && allCodecsKnown) {
      const codecs = Array.from(new Set(probe.variants.map((variant) => variant.codecs))).join(" | ");
      throw new Error(`master playlist has no H.264 variant (CODECS: ${codecs})`);
    }

    trail.push(
      `H.264 ${selected.width && selected.height ? `${selected.width}×${selected.height}` : "variant"}${selected.bandwidth ? ` @ ${(selected.bandwidth / 1_000_000).toFixed(1)} Mbps` : ""}`,
    );
    current = selected.url;
  }

  throw new Error("HLS master playlist nesting is deeper than expected");
}

function parseMediaSegments(probe: HlsProbe): {
  initUrl: string | null;
  segments: MediaSegment[];
  endList: boolean;
  targetDuration: number;
} {
  const lines = probe.text.split(/\r?\n/).map((line) => line.trim());
  let initUrl: string | null = null;
  let pendingDuration = 0;
  let mediaSequence = 0;
  let targetDuration = 0;
  const segments: MediaSegment[] = [];

  for (const line of lines) {
    if (!line) continue;

    if (/^#EXT-X-MEDIA-SEQUENCE:/i.test(line)) {
      mediaSequence = Number(line.slice("#EXT-X-MEDIA-SEQUENCE:".length)) || 0;
      continue;
    }
    if (/^#EXT-X-TARGETDURATION:/i.test(line)) {
      targetDuration = Number(line.slice("#EXT-X-TARGETDURATION:".length)) || 0;
      continue;
    }
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

    const sequence = mediaSequence + segments.length;
    const segmentUrl = new URL(line, probe.url).href;
    segments.push({
      url: segmentUrl,
      duration: pendingDuration,
      sequence,
      key: `${sequence}|${segmentUrl}`,
    });
    pendingDuration = 0;
  }

  return {
    initUrl,
    segments,
    endList: lines.some((line) => /^#EXT-X-ENDLIST/i.test(line)),
    targetDuration,
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
  if (data.length >= 376 && data[0] === 0x47 && data[188] === 0x47) return "mpegts";

  if (data.length >= 8) {
    const box = String.fromCharCode(data[4], data[5], data[6], data[7]);
    if (box === "ftyp" || box === "styp" || box === "moof") return "mp4";
  }

  const pathname = new URL(firstUrl).pathname.toLowerCase();
  if (pathname.endsWith(".ts") || pathname.endsWith(".mpegts")) return "mpegts";
  if (pathname.endsWith(".m4s") || pathname.endsWith(".mp4") || pathname.endsWith(".cmfv")) return "mp4";

  throw new Error(
    `could not identify media container (first bytes ${Array.from(data.slice(0, 8))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(" ")})`,
  );
}

async function fetchBytes(url: string, label: string): Promise<{ data: Uint8Array; contentType: string }> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);

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
  seenKeys: string[];
  initUrl: string | null;
  targetDuration: number;
}> {
  const parsed = parseMediaSegments(probe);
  if (!parsed.segments.length) throw new Error("media playlist contains no segment URIs");

  const selected = parsed.segments.slice(Math.max(0, parsed.segments.length - 3));
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
  const seconds = selected.reduce((sum, segment) => sum + segment.duration, 0);
  const bytes = parts.reduce((sum, part) => sum + part.byteLength, 0);

  return {
    data: concatBytes(parts),
    container,
    segmentCount: selected.length,
    seconds,
    diagnostic: `${container} · ${selected.length} segment${selected.length === 1 ? "" : "s"} · ${(bytes / 1024 / 1024).toFixed(1)} MiB${firstContentType ? ` · ${firstContentType.split(";")[0]}` : ""}`,
    seenKeys: parsed.segments.map((segment) => segment.key),
    initUrl: parsed.initUrl,
    targetDuration: parsed.targetDuration,
  };
}

function timestamp64(libav: any, frame: any, lowKey: string, highKey: string): number | null {
  const low = frame[lowKey];
  if (!Number.isFinite(low)) return null;

  const high = frame[highKey];
  const value = Number.isFinite(high) && typeof libav.i64tof64 === "function"
    ? libav.i64tof64(low, high)
    : low;

  if (!Number.isFinite(value)) return null;
  if (typeof libav.AV_NOPTS_VALUE === "number" && value === libav.AV_NOPTS_VALUE) return null;
  return value;
}

function frameTimestamp(libav: any, frame: any): number | null {
  return timestamp64(libav, frame, "best_effort_timestamp", "best_effort_timestamphi")
    ?? timestamp64(libav, frame, "pts", "ptshi");
}


const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000,
  22050, 16000, 12000, 11025, 8000, 7350,
];

type AdtsFrame = {
  data: Uint8Array;
  sampleRate: number;
  channels: number;
  audioObjectType: number;
};

function splitAdtsFrames(data: Uint8Array): AdtsFrame[] {
  const out: AdtsFrame[] = [];
  let offset = 0;

  while (offset + 7 <= data.length) {
    // Be tolerant of a few non-AAC bytes at PES boundaries.
    if (data[offset] !== 0xff || (data[offset + 1] & 0xf6) !== 0xf0) {
      offset++;
      continue;
    }

    const frequencyIndex = (data[offset + 2] >> 2) & 0x0f;
    const sampleRate = AAC_SAMPLE_RATES[frequencyIndex] || 0;
    const channels = ((data[offset + 2] & 0x01) << 2) | ((data[offset + 3] >> 6) & 0x03);
    const audioObjectType = ((data[offset + 2] >> 6) & 0x03) + 1;
    const frameLength =
      ((data[offset + 3] & 0x03) << 11) |
      (data[offset + 4] << 3) |
      ((data[offset + 5] >> 5) & 0x07);

    if (!sampleRate || !channels || frameLength < 7 || offset + frameLength > data.length) break;

    out.push({
      data: data.slice(offset, offset + frameLength),
      sampleRate,
      channels,
      audioObjectType,
    });
    offset += frameLength;
  }

  return out;
}

function packetTimestampUs(libav: any, packet: any, stream: any): number | null {
  const pts = timestamp64(libav, packet, "pts", "ptshi")
    ?? timestamp64(libav, packet, "dts", "dtshi");
  const tbNum = packet.time_base_num || stream.time_base_num;
  const tbDen = packet.time_base_den || stream.time_base_den;
  if (pts === null || !tbNum || !tbDen) return null;
  return Math.round(pts * tbNum / tbDen * 1_000_000);
}

function aacCodecForObjectType(audioObjectType: number): string {
  if (audioObjectType === 5) return "mp4a.40.5";
  if (audioObjectType === 29) return "mp4a.40.29";
  return `mp4a.40.${audioObjectType || 2}`;
}

class NativeAacAudio {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private decoder: any = null;
  private decoderCtor: any = null;
  private encodedChunkCtor: any = null;
  private codecpar: any = null;
  private container: "mpegts" | "mp4" = "mpegts";
  private configured = false;
  private nextInputTimestampUs: number | null = null;

  private baseMediaSeconds: number | null = null;
  private baseContextTime = 0;
  private scheduledUntil = 0;

  // AudioDecoder typically emits one 1024-sample AAC frame at a time (~47/s
  // at 48 kHz). Creating an AudioBuffer + AudioBufferSourceNode for every one
  // of those callbacks is surprisingly expensive on Tesla Chromium, so batch
  // several decoded frames before touching the Web Audio graph.
  private pendingAudio: {
    sampleRate: number;
    channels: number;
    startMediaSeconds: number;
    frames: number;
    planes: Float32Array[][];
  } | null = null;
  private readonly audioBatchFrames = 4096;

  private _status = "audio probe";
  private _muted = false;

  constructor(muted: boolean) {
    this._muted = muted;

    const globalAny = globalThis as any;
    const ContextCtor = globalAny.AudioContext || globalAny.webkitAudioContext;
    this.decoderCtor = globalAny.AudioDecoder;
    this.encodedChunkCtor = globalAny.EncodedAudioChunk;

    if (!ContextCtor) {
      this._status = "Web Audio unavailable";
      return;
    }
    if (!this.decoderCtor || !this.encodedChunkCtor) {
      this._status = "native AudioDecoder unavailable";
      return;
    }

    try {
      // Construct synchronously while the channel click is still a user gesture.
      const context = new ContextCtor({ latencyHint: "interactive" }) as AudioContext;
      const gain = context.createGain();
      gain.gain.value = muted ? 0 : 1;
      gain.connect(context.destination);
      this.context = context;
      this.gain = gain;
      void context.resume().catch(() => {});
      this._status = "native AAC probing";
    } catch (error) {
      this._status = `Web Audio failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  get status(): string {
    return this._status;
  }

  get muted(): boolean {
    return this._muted;
  }

  setMuted(muted: boolean): void {
    this._muted = muted;
    if (this.gain && this.context) {
      this.gain.gain.setValueAtTime(muted ? 0 : 1, this.context.currentTime);
    }
  }

  resume(): void {
    if (this.context) void this.context.resume().catch(() => {});
  }

  suspend(): void {
    if (this.context) void this.context.suspend().catch(() => {});
  }

  disable(reason: string): void {
    this._status = reason;
    this.configured = false;
    this.pendingAudio = null;
    if (this.decoder) {
      try {
        this.decoder.close();
      } catch {
        // Best effort.
      }
      this.decoder = null;
    }
  }

  async prepare(codecName: string, codecpar: any, container: "mpegts" | "mp4"): Promise<void> {
    this.codecpar = codecpar;
    this.container = container;

    if (!this.context || !this.decoderCtor || !this.encodedChunkCtor) return;
    if (codecName !== "aac") {
      this.disable(`native audio unsupported (${codecName || "unknown codec"})`);
      return;
    }

    // MPEG-TS normally carries ADTS. We configure lazily from the first ADTS
    // frame so the decoder sees exactly the profile/rate/channel metadata that
    // accompanies the bytes. fMP4 carries raw AAC and needs AudioSpecificConfig.
    if (container === "mp4") {
      const description = codecpar?.extradata;
      if (!description?.byteLength) {
        this.disable("AAC config missing");
        return;
      }

      const objectType = ((description[0] >> 3) & 0x1f) || 2;
      await this.configure({
        codec: aacCodecForObjectType(objectType),
        sampleRate: codecpar.sample_rate || 48000,
        numberOfChannels: codecpar.channels || 2,
        description,
      });
    } else {
      this._status = "native AAC · waiting for ADTS";
    }
  }

  private async configure(config: Record<string, unknown>): Promise<boolean> {
    if (this.configured) return true;
    if (!this.context || !this.decoderCtor) return false;

    try {
      if (typeof this.decoderCtor.isConfigSupported === "function") {
        const support = await this.decoderCtor.isConfigSupported(config);
        if (!support?.supported) {
          this.disable(`native AAC unsupported (${String(config.codec)})`);
          return false;
        }
      }

      this.decoder = new this.decoderCtor({
        output: (audioData: any) => this.handleOutput(audioData),
        error: (error: unknown) => {
          this._status = `native audio error: ${error instanceof Error ? error.message : String(error)}`;
        },
      });
      this.decoder.configure(config);
      this.configured = true;
      this._status = `native AAC ${String(config.codec)}`;
      return true;
    } catch (error) {
      this.disable(`native AAC setup failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async pushPackets(packets: any[], stream: any, libav: any): Promise<void> {
    if (!this.context || !this.decoderCtor || !this.encodedChunkCtor || !this.codecpar) return;
    if (!packets.length) return;

    for (const packet of packets) {
      if (!packet?.data?.byteLength) continue;

      if (this.container === "mpegts") {
        const adts = splitAdtsFrames(packet.data);
        if (!adts.length) {
          if (!this.configured) this._status = "native AAC · no ADTS frames";
          continue;
        }

        const first = adts[0];
        if (!this.configured) {
          const ok = await this.configure({
            codec: aacCodecForObjectType(first.audioObjectType),
            sampleRate: first.sampleRate,
            numberOfChannels: first.channels,
            // No description: WebCodecs interprets the chunk as ADTS.
          });
          if (!ok) return;
        }

        const packetTs = packetTimestampUs(libav, packet, stream);
        if (packetTs !== null) {
          if (
            this.nextInputTimestampUs === null ||
            Math.abs(packetTs - this.nextInputTimestampUs) > 500_000
          ) {
            this.nextInputTimestampUs = packetTs;
          }
        }
        if (this.nextInputTimestampUs === null) this.nextInputTimestampUs = 0;

        for (const frame of adts) {
          const timestamp = Math.round(this.nextInputTimestampUs);
          const duration = 1024 / frame.sampleRate * 1_000_000;
          const chunk = new this.encodedChunkCtor({
            type: "key",
            timestamp,
            duration: Math.round(duration),
            data: frame.data,
          });
          this.decoder.decode(chunk);
          this.nextInputTimestampUs += duration;
        }
      } else {
        if (!this.configured || !this.decoder) continue;
        const timestamp = packetTimestampUs(libav, packet, stream);
        if (timestamp === null) continue;

        const chunkInit: Record<string, unknown> = {
          type: "key",
          timestamp,
          data: packet.data,
        };

        const duration = timestamp64(libav, packet, "duration", "durationhi");
        const tbNum = packet.time_base_num || stream.time_base_num;
        const tbDen = packet.time_base_den || stream.time_base_den;
        if (duration !== null && tbNum && tbDen) {
          chunkInit.duration = Math.round(duration * tbNum / tbDen * 1_000_000);
        }

        this.decoder.decode(new this.encodedChunkCtor(chunkInit));
      }
    }
  }

  private handleOutput(audioData: any): void {
    const context = this.context;
    if (!context || !this.gain) {
      audioData.close?.();
      return;
    }

    try {
      const channels = audioData.numberOfChannels;
      const frames = audioData.numberOfFrames;
      const sampleRate = audioData.sampleRate;
      const mediaSeconds = audioData.timestamp / 1_000_000;

      const expectedNext = this.pendingAudio
        ? this.pendingAudio.startMediaSeconds + this.pendingAudio.frames / this.pendingAudio.sampleRate
        : mediaSeconds;

      if (
        this.pendingAudio &&
        (
          this.pendingAudio.sampleRate !== sampleRate ||
          this.pendingAudio.channels !== channels ||
          Math.abs(mediaSeconds - expectedNext) > 0.050
        )
      ) {
        this.flushAudioBatch();
      }

      if (!this.pendingAudio) {
        this.pendingAudio = {
          sampleRate,
          channels,
          startMediaSeconds: mediaSeconds,
          frames: 0,
          planes: Array.from({ length: channels }, () => []),
        };
      }

      for (let channel = 0; channel < channels; channel++) {
        const plane = new Float32Array(frames);
        audioData.copyTo(plane, {
          planeIndex: channel,
          format: "f32-planar",
        });
        this.pendingAudio.planes[channel].push(plane);
      }
      this.pendingAudio.frames += frames;

      if (this.pendingAudio.frames >= this.audioBatchFrames) {
        this.flushAudioBatch();
      }
    } catch (error) {
      this._status = `native audio output failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      audioData.close?.();
    }
  }

  private flushAudioBatch(): void {
    const pending = this.pendingAudio;
    const context = this.context;
    const gain = this.gain;
    if (!pending || !context || !gain || !pending.frames) return;
    this.pendingAudio = null;

    try {
      const buffer = context.createBuffer(pending.channels, pending.frames, pending.sampleRate);

      for (let channel = 0; channel < pending.channels; channel++) {
        const destination = buffer.getChannelData(channel);
        let offset = 0;
        for (const plane of pending.planes[channel]) {
          destination.set(plane, offset);
          offset += plane.length;
        }
      }

      const mediaSeconds = pending.startMediaSeconds;
      const lead = 0.12;

      if (this.baseMediaSeconds === null) {
        this.baseMediaSeconds = mediaSeconds;
        this.baseContextTime = context.currentTime + lead;
        this.scheduledUntil = this.baseContextTime;
      }

      let startAt = this.baseContextTime + (mediaSeconds - this.baseMediaSeconds);

      // Recover from discontinuities/underruns by establishing a fresh
      // audio/media mapping instead of creating a growing sync error.
      if (startAt < context.currentTime - 0.05 || startAt > context.currentTime + 8) {
        this.baseMediaSeconds = mediaSeconds;
        this.baseContextTime = context.currentTime + lead;
        this.scheduledUntil = this.baseContextTime;
        startAt = this.baseContextTime;
      }

      // Avoid tiny scheduling gaps between batches without allowing the audio
      // graph to pull the media clock forward.
      startAt = Math.max(startAt, this.scheduledUntil, context.currentTime + 0.005);

      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.start(startAt);
      this.scheduledUntil = startAt + buffer.duration;
    } catch (error) {
      this._status = `native audio output failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  targetWallMs(mediaSeconds: number): number | null {
    const context = this.context;
    if (
      !context ||
      this.baseMediaSeconds === null ||
      context.state !== "running" ||
      !Number.isFinite(mediaSeconds)
    ) {
      return null;
    }

    const targetContextTime = this.baseContextTime + (mediaSeconds - this.baseMediaSeconds);
    return performance.now() + (targetContextTime - context.currentTime) * 1000;
  }

  stop(): void {
    if (this.decoder) {
      try {
        this.decoder.close();
      } catch {
        // Best effort.
      }
      this.decoder = null;
    }
    if (this.context) {
      void this.context.close().catch(() => {});
      this.context = null;
    }
    this.gain = null;
    this.pendingAudio = null;
    this.baseMediaSeconds = null;
    this.scheduledUntil = 0;
    this.nextInputTimestampUs = null;
    this.configured = false;
  }
}

class YuvRenderer {
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private textures: WebGLTexture[];
  private textureSizes: Array<[number, number] | null> = [null, null, null];
  private viewportKey = "";

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

    const compileShader = (type: number, source: string): WebGLShader => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Could not create WebGL shader");
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader) || "WebGL shader compile failed");
      }
      return shader;
    };

    const program = gl.createProgram();
    if (!program) throw new Error("Could not create WebGL program");
    gl.attachShader(program, compileShader(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "WebGL program link failed");
    }
    this.program = program;
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    if (!buffer) throw new Error("Could not create WebGL buffer");
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const makeTexture = (unit: number, uniform: string): WebGLTexture => {
      const texture = gl.createTexture();
      if (!texture) throw new Error("Could not create WebGL texture");
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(program, uniform), unit);
      return texture;
    };

    this.textures = [makeTexture(0, "yTex"), makeTexture(1, "uTex"), makeTexture(2, "vTex")];
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
        frame.data.subarray(layout.offset + y * layout.stride, layout.offset + y * layout.stride + width),
        y * width,
      );
    }
    return out;
  }

  private upload(unit: number, width: number, height: number, data: Uint8Array): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[unit]);

    const oldSize = this.textureSizes[unit];
    if (!oldSize || oldSize[0] !== width || oldSize[1] !== height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, width, height, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, data);
      this.textureSizes[unit] = [width, height];
      return;
    }

    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.LUMINANCE, gl.UNSIGNED_BYTE, data);
  }

  render(frame: any): void {
    if (frame.format !== 0) {
      throw new Error(`WASM beta currently requires YUV420P; decoder returned pixel format ${frame.format}`);
    }

    const width = frame.width as number;
    const height = frame.height as number;
    const chromaWidth = width >> 1;
    const chromaHeight = height >> 1;

    this.upload(0, width, height, this.plane(frame, 0, width, height));
    this.upload(1, chromaWidth, chromaHeight, this.plane(frame, 1, chromaWidth, chromaHeight));
    this.upload(2, chromaWidth, chromaHeight, this.plane(frame, 2, chromaWidth, chromaHeight));

    const pixelWidth = Math.max(1, Math.round(this.canvas.clientWidth));
    const pixelHeight = Math.max(1, Math.round(this.canvas.clientHeight));
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
      this.viewportKey = "";
    }

    const scale = Math.min(pixelWidth / width, pixelHeight / height);
    const outputWidth = Math.round(width * scale);
    const outputHeight = Math.round(height * scale);
    const x = Math.floor((pixelWidth - outputWidth) / 2);
    const y = Math.floor((pixelHeight - outputHeight) / 2);
    const viewportKey = `${x},${y},${outputWidth},${outputHeight},${pixelWidth},${pixelHeight}`;

    const gl = this.gl;
    if (viewportKey !== this.viewportKey) {
      gl.viewport(0, 0, pixelWidth, pixelHeight);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.viewport(x, y, outputWidth, outputHeight);
      this.viewportKey = viewportKey;
    }

    gl.useProgram(this.program);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  clear(): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.viewportKey = "";
  }
}

export class WasmHlsPlayer {
  private renderer: YuvRenderer | null = null;
  private libav: any = null;
  private generation = 0;
  private isPaused = false;
  private isMuted = false;
  private audio: NativeAacAudio | null = null;

  constructor(private canvas: HTMLCanvasElement) {}

  get paused(): boolean {
    return this.isPaused;
  }

  play(): void {
    this.isPaused = false;
    this.audio?.resume();
  }

  pause(): void {
    this.isPaused = true;
    this.audio?.suspend();
  }

  toggle(): void {
    if (this.isPaused) this.play();
    else this.pause();
  }

  setMuted(muted: boolean): void {
    this.isMuted = muted;
    this.audio?.setMuted(muted);
  }

  get muted(): boolean {
    return this.isMuted;
  }

  stop(): void {
    this.generation++;
    this.isPaused = false;
    this.audio?.stop();
    this.audio = null;
    this.renderer?.clear();
    if (this.libav?.terminate) {
      try {
        this.libav.terminate();
      } catch {
        // Best effort cleanup.
      }
    }
    this.libav = null;
  }

  async load(url: string): Promise<void> {
    this.stop();
    const generation = this.generation;

    // Prime native audio while this call is still on the channel-click gesture;
    // Chromium may otherwise leave AudioContext suspended by autoplay policy.
    this.audio = new NativeAacAudio(this.isMuted);
    emitStatus({ message: `WASM beta: loading decoder… · ${this.audio.status}` });

    await loadLibAV();
    if (generation !== this.generation) return;

    const factory = window.LibAV?.LibAV;
    if (!factory) throw new Error("libav.js loaded without LibAV factory");

    this.renderer ??= new YuvRenderer(this.canvas);

    // HLS transport now lives in the page, so libav can safely go back to its
    // worker. Keeping H.264 decode off the UI thread is important for stable rAF.
    const libav = await factory();
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`HLS probe failed: ${message}`);
    }

    let snapshot: Awaited<ReturnType<typeof buildMediaSnapshot>>;
    try {
      snapshot = await buildMediaSnapshot(mediaProbe);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`HLS media fetch failed (${hlsDiagnostic}): ${message}`);
    }
    if (generation !== this.generation) return;

    const readerName = `wasm-live-${generation}.${snapshot.container === "mpegts" ? "ts" : "mp4"}`;
    await libav.mkreaderdev(readerName);
    await libav.ff_reader_dev_send(readerName, snapshot.data);

    const seen = new Set<string>(snapshot.seenKeys);
    let currentInitUrl = snapshot.initUrl;
    let feedPromise: Promise<void> | null = null;
    let deliveredSegments = snapshot.segmentCount;

    const feedMore = (): Promise<void> => {
      if (feedPromise) return feedPromise;

      feedPromise = (async () => {
        while (generation === this.generation) {
          const latestProbe = await probePlaylist(mediaProbe.url);
          const parsed = parseMediaSegments(latestProbe);

          if (parsed.initUrl && parsed.initUrl !== currentInitUrl) {
            const init = await fetchBytes(parsed.initUrl, "HLS init segment");
            await libav.ff_reader_dev_send(readerName, init.data);
            currentInitUrl = parsed.initUrl;
            return;
          }

          const pending = parsed.segments.filter((segment) => !seen.has(segment.key));
          if (pending.length) {
            for (const segment of pending) {
              const fetched = await fetchBytes(segment.url, `HLS segment ${segment.sequence}`);
              if (generation !== this.generation) return;
              await libav.ff_reader_dev_send(readerName, fetched.data);
              seen.add(segment.key);
              deliveredSegments++;
            }
            return;
          }

          if (parsed.endList) {
            await libav.ff_reader_dev_send(readerName, null);
            return;
          }

          const target = parsed.targetDuration || snapshot.targetDuration || 2;
          await sleep(Math.max(500, Math.min(3000, target * 500)));
        }

        try {
          await libav.ff_reader_dev_send(readerName, null);
        } catch {
          // libav may already have been terminated.
        }
      })().finally(() => {
        feedPromise = null;
      });

      return feedPromise;
    };

    libav.onread = (name: string) => {
      if (name !== readerName) return;
      return feedMore();
    };

    emitStatus({
      message: `WASM beta: ${hlsDiagnostic} · ${snapshot.diagnostic} · opening live media stream…`,
    });

    let formatContext: any;
    let streams: any[];
    try {
      [formatContext, streams] = await libav.ff_init_demuxer_file(readerName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not open live ${snapshot.container} stream (${snapshot.diagnostic}): ${message}`);
    }
    if (generation !== this.generation) return;

    const videoType = typeof libav.AVMEDIA_TYPE_VIDEO === "number" ? libav.AVMEDIA_TYPE_VIDEO : 0;
    const streamSummary = streams
      .map((candidate: any, index: number) => `${index}:type=${candidate.codec_type},codec=${candidate.codec_id}`)
      .join(" ");
    const videoIndex = streams.findIndex((candidate: any) => Number(candidate.codec_type) === videoType);
    if (videoIndex < 0) {
      throw new Error(
        `No video stream found (${hlsDiagnostic}; videoType=${videoType}; streams=${streamSummary || "none"})`,
      );
    }

    const stream = streams[videoIndex];

    const audioType = typeof libav.AVMEDIA_TYPE_AUDIO === "number" ? libav.AVMEDIA_TYPE_AUDIO : 1;
    const audioIndex = streams.findIndex((candidate: any) => Number(candidate.codec_type) === audioType);
    const audioStream = audioIndex >= 0 ? streams[audioIndex] : null;

    if (this.audio && audioStream) {
      try {
        const [codecName, audioCodecpar] = await Promise.all([
          libav.avcodec_get_name(audioStream.codec_id),
          libav.ff_copyout_codecpar(audioStream.codecpar),
        ]);
        await this.audio.prepare(codecName, audioCodecpar, snapshot.container);
      } catch (error) {
        this.audio.disable(`native audio setup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (this.audio) {
      this.audio.disable("no audio track");
    }

    const [, codecContext, packet, frame] = await libav.ff_init_decoder(stream.codec_id, {
      codecpar: stream.codecpar,
      time_base: [stream.time_base_num, stream.time_base_den],
    });

    let decodedFrames = 0;
    let presentedFrames = 0;
    let droppedFrames = 0;
    let decodeMs = 0;
    let lastMediaSeconds: number | null = null;
    let estimatedFrameMs = 1000 / 30;
    let avDriftMs = 0;
    let lastStatusAt = 0;
    let lastRafTimestamp: number | null = null;
    let cadenceBudgetMs = 0;
    let renderMsEma = 0;
    let syncState: "waiting" | "armed" | "running" = audioStream ? "waiting" : "running";
    let syncWaitStartedAt = performance.now();
    let videoStartWallMs: number | null = null;
    let initialSyncMs = 0;
    let startupSkipped = 0;

    type QueuedVideoFrame = {
      frame: any;
      mediaSeconds: number | null;
    };

    const frameQueue: QueuedVideoFrame[] = [];
    const presentationTimes: number[] = [];
    const rafTimes: number[] = [];

    // rAF-budget presenter. The browser gives us a stable 60 Hz callback in the
    // Tesla, and the decoder tells us the source cadence. Accumulate real rAF
    // time and consume exactly one source-frame interval per presentation.
    // This avoids depending on absolute PTS/audio wall-clock mapping for cadence.
    const present = (timestamp: number): void => {
      if (generation !== this.generation) return;

      rafTimes.push(timestamp);
      while (rafTimes.length > 2 && rafTimes[0] < timestamp - 5000) rafTimes.shift();

      if (lastRafTimestamp === null) lastRafTimestamp = timestamp;
      const rafDelta = Math.max(0, Math.min(100, timestamp - lastRafTimestamp));
      lastRafTimestamp = timestamp;
      const now = performance.now();

      // Establish A/V phase exactly once at startup. Crucially, keep demuxing
      // until the native audio clock actually exists; the old 24-frame queue
      // backpressure could stop demux before enough AAC had arrived to start
      // Web Audio, so video timed out and began ~1.5 s before audio.
      if (!this.isPaused && frameQueue.length && syncState === "waiting") {
        let alignedIndex = -1;
        let alignedTarget: number | null = null;

        // Once AudioContext has a media-time mapping, discard only pre-roll
        // video frames whose matching audio time has already passed. Start on
        // the first frame at/just ahead of the audio playhead.
        for (let i = 0; i < frameQueue.length; i++) {
          const mediaSeconds = frameQueue[i].mediaSeconds;
          if (mediaSeconds === null) continue;
          const target = this.audio?.targetWallMs(mediaSeconds) ?? null;
          if (target === null) break;

          alignedIndex = i;
          alignedTarget = target;
          if (target >= now + 15) break;
        }

        if (alignedIndex >= 0 && alignedTarget !== null) {
          if (alignedIndex > 0) {
            frameQueue.splice(0, alignedIndex);
            startupSkipped += alignedIndex;
          }

          avDriftMs = alignedTarget - now;
          initialSyncMs = avDriftMs;
          videoStartWallMs = Math.max(now, alignedTarget);
          syncState = "armed";
          cadenceBudgetMs = 0;
        } else if (now - syncWaitStartedAt > 5000) {
          // Audio may be unsupported/broken on an otherwise valid video feed.
          // After a generous pre-roll, keep video usable rather than hanging.
          syncState = "running";
          cadenceBudgetMs = estimatedFrameMs;
        }
      }

      if (!this.isPaused && syncState === "armed" && videoStartWallMs !== null) {
        if (now + 2 >= videoStartWallMs) {
          syncState = "running";
          cadenceBudgetMs = estimatedFrameMs;
          lastRafTimestamp = timestamp;
        }
      }

      if (this.isPaused) {
        cadenceBudgetMs = 0;
      } else if (syncState === "running") {
        cadenceBudgetMs = Math.min(
          cadenceBudgetMs + rafDelta,
          Math.max(estimatedFrameMs * 2, 40),
        );
      }

      if (
        !this.isPaused &&
        syncState === "running" &&
        frameQueue.length &&
        cadenceBudgetMs + 0.5 >= estimatedFrameMs
      ) {
        // Audio no longer controls frame-by-frame cadence. It only establishes
        // the initial phase above; source PTS/rAF determine ongoing 30 fps.
        const queued = frameQueue.shift()!;
        cadenceBudgetMs = Math.max(0, cadenceBudgetMs - estimatedFrameMs);

          const renderStart = performance.now();
          this.renderer!.render(queued.frame);
          const renderMs = performance.now() - renderStart;
          renderMsEma = renderMsEma
            ? renderMsEma * 0.9 + renderMs * 0.1
            : renderMs;

          presentedFrames++;

          const presentedAt = performance.now();
          presentationTimes.push(presentedAt);
          while (presentationTimes.length > 2 && presentationTimes[0] < presentedAt - 5000) {
            presentationTimes.shift();
          }

          if (queued.mediaSeconds !== null) {
            const target = this.audio?.targetWallMs(queued.mediaSeconds) ?? null;
            if (target !== null) avDriftMs = target - presentedAt;
          }

          if (presentedFrames === 1 || presentedAt - lastStatusAt >= 1000) {
            lastStatusAt = presentedAt;
            const windowMs = presentationTimes.length > 1
              ? presentationTimes[presentationTimes.length - 1] - presentationTimes[0]
              : 0;
            const displayFps = windowMs > 0 ? (presentationTimes.length - 1) * 1000 / windowMs : 0;
            const decodeFps = decodeMs > 0 ? decodedFrames / (decodeMs / 1000) : 0;
            const rafWindowMs = rafTimes.length > 1 ? rafTimes[rafTimes.length - 1] - rafTimes[0] : 0;
            const rafFps = rafWindowMs > 0 ? (rafTimes.length - 1) * 1000 / rafWindowMs : 0;
            const sourceFps = estimatedFrameMs > 0 ? 1000 / estimatedFrameMs : 0;

            emitStatus({
              message: `WASM beta · ${queued.frame.width}×${queued.frame.height} · ${displayFps.toFixed(1)} display fps · ${sourceFps.toFixed(1)} source fps · ${rafFps.toFixed(1)} rAF fps · ${decodeFps.toFixed(1)} decode fps · render ${renderMsEma.toFixed(1)}ms · ${droppedFrames} dropped · q${frameQueue.length} · pre ${startupSkipped} · AV ${avDriftMs >= 0 ? "+" : ""}${avDriftMs.toFixed(0)}ms · init ${initialSyncMs >= 0 ? "+" : ""}${initialSyncMs.toFixed(0)}ms · live HLS · ${this.audio?.status ?? "video only"}`,
              frames: presentedFrames,
              decodedFrames,
              droppedFrames,
              width: queued.frame.width,
              height: queued.frame.height,
              displayFps,
              sourceFps,
              rafFps,
              decodeFps,
              renderMs: renderMsEma,
              frameMs: estimatedFrameMs,
              queueDepth: frameQueue.length,
              avDriftMs,
              initialSyncMs,
              startupSkipped,
              deliveredSegments,
            });
          }
      }

      requestAnimationFrame(present);
    };
    requestAnimationFrame(present);

    emitStatus({
      message: `WASM beta: decoding H.264 · audio-phased source-cadence rAF queue · ${this.audio?.status ?? "video only"} · ${snapshot.segmentCount}-segment startup buffer${snapshot.seconds ? ` / ~${snapshot.seconds.toFixed(1)}s` : ""}`,
      width: stream.codecpar?.width,
      height: stream.codecpar?.height,
    });

    while (generation === this.generation) {
      while (this.isPaused && generation === this.generation) await sleep(50);
      if (generation !== this.generation) break;

      // Keep a modest decoded cushion during normal playback. While waiting for
      // the native audio clock, NEVER stop demuxing on video queue depth: AAC
      // may appear later in the interleaved stream. Instead retain only a rolling
      // 24-frame video window so audio can continue arriving without unbounded
      // raw-frame memory growth.
      if (syncState === "waiting" && frameQueue.length > 24) {
        const trim = frameQueue.length - 24;
        frameQueue.splice(0, trim);
        startupSkipped += trim;
      } else {
        while (frameQueue.length >= 24 && generation === this.generation && !this.isPaused) {
          await sleep(5);
        }
      }
      if (generation !== this.generation) break;

      const [result, packets] = await libav.ff_read_frame_multi(formatContext, packet, { limit: 32 * 1024 });
      if (generation !== this.generation) break;

      if (audioStream && audioIndex >= 0 && this.audio) {
        try {
          await this.audio.pushPackets(packets[audioIndex] || [], audioStream, libav);
        } catch (error) {
          this.audio.disable(`native audio failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const videoPackets = packets[videoIndex] || [];
      const decodeStart = performance.now();
      const frames = await libav.ff_decode_multi(codecContext, packet, frame, videoPackets, {
        fin: result === libav.AVERROR_EOF,
        copyoutFrame: "video",
      });
      decodeMs += performance.now() - decodeStart;
      decodedFrames += frames.length;

      for (const decoded of frames) {
        if (generation !== this.generation) break;

        const framePts = frameTimestamp(libav, decoded);
        const tbNum = decoded.time_base_num || stream.time_base_num;
        const tbDen = decoded.time_base_den || stream.time_base_den;
        const mediaSeconds = framePts !== null && tbNum && tbDen
          ? framePts * tbNum / tbDen
          : null;

        if (mediaSeconds !== null && Number.isFinite(mediaSeconds)) {
          if (lastMediaSeconds !== null) {
            const deltaMs = (mediaSeconds - lastMediaSeconds) * 1000;
            if (deltaMs >= 4 && deltaMs <= 250) {
              estimatedFrameMs = estimatedFrameMs * 0.85 + deltaMs * 0.15;
            }
          }
          lastMediaSeconds = mediaSeconds;
        }

        frameQueue.push({ frame: decoded, mediaSeconds });
      }

      if (result === libav.AVERROR_EOF) {
        while (frameQueue.length && generation === this.generation) await sleep(20);
        emitStatus({ message: "WASM beta: stream ended (HLS source reached EOF)" });
        break;
      }
    }
  }
}
