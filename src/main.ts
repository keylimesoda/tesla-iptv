import { fetchM3U, groupByGroup, type Channel } from "./iptv";
import { Player } from "./player";
import { WasmHlsPlayer } from "./wasm-player";

const $ = <T extends Element>(sel: string): T => document.querySelector(sel) as T;

const els = {
  back: $<HTMLButtonElement>("#back"),
  title: $<HTMLHeadingElement>("#title"),
  listView: $<HTMLElement>("#list-view"),
  playerView: $<HTMLElement>("#player-view"),
  search: $<HTMLInputElement>("#search"),
  channels: $<HTMLOListElement>("#channels"),
  status: $<HTMLElement>("#status"),
  count: $<HTMLElement>("#count"),
  video: $<HTMLVideoElement>("#video"),
  canvas: $<HTMLCanvasElement>("#canvas"),
  wasmCanvas: $<HTMLCanvasElement>("#wasm-canvas"),
  bigPlay: $<HTMLButtonElement>("#big-play"),
  play: $<HTMLButtonElement>("#play"),
  playPath: $<SVGPathElement>("#play-icon path"),
  channelName: $<HTMLElement>("#channel-name"),
  channelSub: $<HTMLElement>("#channel-sub"),
  canvasMode: $<HTMLInputElement>("#canvas-mode"),
  wasmMode: $<HTMLInputElement>("#wasm-mode"),
  wasmToggle: $<HTMLElement>("#wasm-toggle"),
  mute: $<HTMLButtonElement>("#mute"),
  muteWaves: $<SVGPathElement>("#mute-waves"),
  fullscreen: $<HTMLButtonElement>("#fullscreen"),
  stage: $<HTMLElement>("#stage"),
  sheet: $<HTMLElement>("#sheet"),
  m3uUrl: $<HTMLInputElement>("#m3u-url"),
  sheetApply: $<HTMLButtonElement>("#sheet-apply"),
  sheetCancel: $<HTMLButtonElement>("#sheet-cancel"),
  settings: $<HTMLButtonElement>("#settings"),
  genSetup: $<HTMLButtonElement>("#gen-setup"),
  setupResult: $<HTMLElement>("#setup-result"),
  setupLink: $<HTMLInputElement>("#setup-link"),
  copySetup: $<HTMLButtonElement>("#copy-setup"),
};

const LS_M3U = "tesla-iptv.m3u-url";
const LS_MODE = "tesla-iptv.render-mode";
const LS_WASM = "tesla-iptv.wasm-beta";
const DEFAULT_M3U = `${import.meta.env.BASE_URL}channels.m3u`;

const player = new Player(els.video, els.canvas);
const wasmPlayer = new WasmHlsPlayer(els.wasmCanvas);
let wasmActive = false;
let currentChannel: Channel | null = null;
let channels: Channel[] = [];
const collapsedGroups = new Set<string>();

function setStatus(msg: string): void {
  els.status.textContent = msg;
}

function loadChannels(url: string, note = ""): void {
  setStatus("Loading playlist…");
  fetchM3U(url)
    .then((list) => {
      channels = list;
      renderList(els.search.value);
      setStatus(`${list.length} channels loaded.${note ? " " + note : ""}`);
    })
    .catch((err) => {
      channels = [];
      renderList("");
      setStatus(`Could not load playlist: ${err instanceof Error ? err.message : String(err)}`);
    });
}

function channelItem(ch: Channel): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "channel";
  li.dataset.id = ch.id;

  const logo = document.createElement("span");
  logo.className = "logo";
  if (ch.logo) {
    const img = document.createElement("img");
    img.src = ch.logo;
    img.alt = "";
    img.loading = "lazy";
    img.onerror = () => {
      img.remove();
    };
    logo.append(img);
  }

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = ch.name;

  li.append(logo, name);
  li.addEventListener("click", () => showPlayer(ch));
  return li;
}

function renderList(filter: string): void {
  const q = filter.trim().toLowerCase();
  const frag = document.createDocumentFragment();
  let shown = 0;

  for (const [group, list] of groupByGroup(channels)) {
    const visible = q ? list.filter((c) => c.name.toLowerCase().includes(q)) : list;
    if (!visible.length) continue;
    shown += visible.length;

    // Searching shows every match; otherwise honour the collapse state.
    const open = q ? true : !collapsedGroups.has(group);

    const header = document.createElement("li");
    header.className = "group" + (open ? "" : " is-collapsed");
    const chev = document.createElement("span");
    chev.className = "chev";
    const label = document.createElement("span");
    label.className = "group-label";
    label.textContent = group;
    const cnt = document.createElement("span");
    cnt.className = "group-count";
    cnt.textContent = String(visible.length);
    header.append(chev, label, cnt);
    header.addEventListener("click", () => {
      if (q) return; // no toggling while a search filter is active
      if (collapsedGroups.has(group)) collapsedGroups.delete(group);
      else collapsedGroups.add(group);
      renderList(els.search.value);
    });
    frag.append(header);

    if (open) {
      for (const ch of visible) frag.append(channelItem(ch));
    }
  }

  els.channels.replaceChildren(frag);
  els.count.textContent = shown ? `${shown} ch` : "";
}

function channelSubLabel(ch: Channel): string {
  return ch.group && ch.group !== "General" ? ch.group : "live";
}

function applyLegacyMode(): void {
  const saved = (localStorage.getItem(LS_MODE) as "video" | "canvas" | null) ?? "canvas";
  els.canvasMode.checked = saved === "canvas";
  player.setMode(saved === "canvas" ? "canvas" : "video");
}

function setWasmUi(enabled: boolean): void {
  wasmActive = enabled;
  els.wasmMode.checked = enabled;
  els.wasmCanvas.classList.toggle("active", enabled);
  els.stage.classList.toggle("wasm-active", enabled);
  els.canvasMode.disabled = enabled;
  els.mute.disabled = false;
}

function startWasm(ch: Channel): void {
  wasmPlayer.setMuted(player.muted);
  player.stop();
  setWasmUi(true);
  els.channelSub.textContent = "WASM beta · starting…";
  updateMuteUI();
  void wasmPlayer.load(ch.url).catch((err) => {
    if (!wasmActive) return;
    const msg = err instanceof Error ? err.message : String(err);
    els.channelSub.textContent = `WASM error · ${msg}`;
    window.dispatchEvent(new CustomEvent("player:error", { detail: { message: msg } }));
  });
}

function startLegacy(ch: Channel): void {
  wasmPlayer.stop();
  setWasmUi(false);
  els.channelSub.textContent = channelSubLabel(ch);
  applyLegacyMode();
  player.load(ch.url);
  updateMuteUI();
}

function showPlayer(ch: Channel): void {
  currentChannel = ch;
  els.title.textContent = ch.name;
  els.channelName.textContent = ch.name;
  els.channelSub.textContent = channelSubLabel(ch);
  els.listView.hidden = true;
  els.playerView.hidden = false;
  els.back.hidden = false;

  const useWasm = localStorage.getItem(LS_WASM) === "1";
  if (useWasm) startWasm(ch);
  else startLegacy(ch);

  updatePlayUI();
}

function showList(): void {
  player.stop();
  wasmPlayer.stop();
  currentChannel = null;
  setWasmUi(false);
  els.playerView.hidden = true;
  els.listView.hidden = false;
  els.back.hidden = true;
  els.title.textContent = "Tesla IPTV";
}

const ICON_PLAY = "M8 5v14l11-7z";
const ICON_PAUSE = "M6 5h4v14H6zM14 5h4v14h-4z";

function updatePlayUI(): void {
  const paused = wasmActive ? wasmPlayer.paused : player.paused;
  els.playPath.setAttribute("d", paused ? ICON_PLAY : ICON_PAUSE);
  els.bigPlay.hidden = !paused;
}

function updateMuteUI(): void {
  const muted = wasmActive ? wasmPlayer.muted : player.muted;
  els.muteWaves.style.opacity = muted ? "0" : "1";
}

// --- wiring ---
els.search.addEventListener("input", () => renderList(els.search.value));

els.back.addEventListener("click", showList);

els.bigPlay.addEventListener("click", () => {
  if (wasmActive) wasmPlayer.play();
  else player.play();
  updatePlayUI();
});

els.play.addEventListener("click", () => {
  if (wasmActive) wasmPlayer.toggle();
  else player.toggle();
  updatePlayUI();
});

els.canvasMode.addEventListener("change", () => {
  if (wasmActive) return;
  const mode = els.canvasMode.checked ? "canvas" : "video";
  player.setMode(mode);
  localStorage.setItem(LS_MODE, mode);
});

els.wasmMode.addEventListener("change", () => {
  const enabled = els.wasmMode.checked;
  localStorage.setItem(LS_WASM, enabled ? "1" : "0");
  if (!currentChannel) {
    setWasmUi(enabled);
    return;
  }
  if (enabled) startWasm(currentChannel);
  else startLegacy(currentChannel);
  updatePlayUI();
});

els.mute.addEventListener("click", () => {
  if (wasmActive) wasmPlayer.setMuted(!wasmPlayer.muted);
  else player.setMuted(!player.muted);
  updateMuteUI();
});

els.fullscreen.addEventListener("click", () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void els.stage.requestFullscreen().catch(() => {});
});

els.video.addEventListener("play", updatePlayUI);
els.video.addEventListener("pause", updatePlayUI);
els.video.addEventListener("volumechange", updateMuteUI);

window.addEventListener("player:error", (e) => {
  const detail = (e as CustomEvent).detail as { message?: string } | undefined;
  setStatus(`Playback error: ${detail?.message ?? "stream failed"}`);
});

window.addEventListener("wasm:status", (e) => {
  if (!wasmActive) return;
  const detail = (e as CustomEvent).detail as { message?: string } | undefined;
  if (detail?.message) els.channelSub.textContent = detail.message;
});

// --- settings sheet ---
function openSheet(): void {
  els.m3uUrl.value = localStorage.getItem(LS_M3U) ?? "";
  els.sheet.hidden = false;
  els.m3uUrl.focus();
}

function closeSheet(): void {
  els.sheet.hidden = true;
}

els.settings.addEventListener("click", openSheet);
els.sheetCancel.addEventListener("click", closeSheet);
els.m3uUrl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    els.sheetApply.click();
  }
});
els.sheetApply.addEventListener("click", () => {
  const url = els.m3uUrl.value.trim();
  if (!url) {
    closeSheet();
    return;
  }
  localStorage.setItem(LS_M3U, url);
  closeSheet();
  loadChannels(url);
});
els.sheet.addEventListener("click", (e) => {
  if (e.target === els.sheet) closeSheet();
});

// --- wiring: one-time setup link ---
function base64urlEncode(s: string): string {
  return btoa(encodeURIComponent(s)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s: string): string | null {
  try {
    return decodeURIComponent(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

/** Consume a #setup=<b64url(m3u-url)> hash: wire the playlist into localStorage. */
function applySetupHash(): boolean {
  const m = location.hash.match(/^#setup=(.+)$/);
  if (!m) return false;
  const url = base64urlDecode(m[1]);
  if (!url || !/^https?:\/\//i.test(url)) return false;
  localStorage.setItem(LS_M3U, url);
  history.replaceState(null, "", location.pathname + location.search);
  return true;
}

function buildSetupLink(m3uUrl: string): string {
  return `${location.origin}${import.meta.env.BASE_URL}#setup=${base64urlEncode(m3uUrl)}`;
}

els.genSetup.addEventListener("click", () => {
  const url = els.m3uUrl.value.trim();
  els.setupLink.value = url ? buildSetupLink(url) : "";
  els.setupResult.hidden = !url;
});

els.copySetup.addEventListener("click", () => {
  void navigator.clipboard.writeText(els.setupLink.value).catch(() => {
    els.setupLink.select();
  });
});

// --- init ---
const wired = applySetupHash();
const initialUrl = localStorage.getItem(LS_M3U) ?? DEFAULT_M3U;
loadChannels(initialUrl, wired ? "(wired from setup link)" : "");
