import { fetchM3U, groupByGroup, type Channel } from "./iptv";
import { Player } from "./player";

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
  bigPlay: $<HTMLButtonElement>("#big-play"),
  play: $<HTMLButtonElement>("#play"),
  playPath: $<SVGPathElement>("#play-icon path"),
  channelName: $<HTMLElement>("#channel-name"),
  channelSub: $<HTMLElement>("#channel-sub"),
  canvasMode: $<HTMLInputElement>("#canvas-mode"),
  mute: $<HTMLButtonElement>("#mute"),
  muteWaves: $<SVGPathElement>("#mute-waves"),
  fullscreen: $<HTMLButtonElement>("#fullscreen"),
  stage: $<HTMLElement>("#stage"),
  sheet: $<HTMLElement>("#sheet"),
  m3uUrl: $<HTMLInputElement>("#m3u-url"),
  sheetApply: $<HTMLButtonElement>("#sheet-apply"),
  sheetCancel: $<HTMLButtonElement>("#sheet-cancel"),
  settings: $<HTMLButtonElement>("#settings"),
};

const LS_M3U = "tesla-iptv.m3u-url";
const LS_MODE = "tesla-iptv.render-mode";
const DEFAULT_M3U = `${import.meta.env.BASE_URL}test.m3u`;

const player = new Player(els.video, els.canvas);
let channels: Channel[] = [];

function setStatus(msg: string): void {
  els.status.textContent = msg;
}

function loadChannels(url: string): void {
  setStatus("Loading playlist…");
  fetchM3U(url)
    .then((list) => {
      channels = list;
      renderList(els.search.value);
      setStatus(`${list.length} channels loaded.`);
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

    const header = document.createElement("li");
    header.className = "group";
    header.textContent = group;
    frag.append(header);

    for (const ch of visible) frag.append(channelItem(ch));
  }

  els.channels.replaceChildren(frag);
  els.count.textContent = shown ? `${shown} ch` : "";
}

function showPlayer(ch: Channel): void {
  els.title.textContent = ch.name;
  els.channelName.textContent = ch.name;
  els.channelSub.textContent = ch.group && ch.group !== "General" ? ch.group : "live";
  els.listView.hidden = true;
  els.playerView.hidden = false;
  els.back.hidden = false;

  const saved = (localStorage.getItem(LS_MODE) as "video" | "canvas" | null) ?? "canvas";
  els.canvasMode.checked = saved === "canvas";
  player.setMode(saved === "canvas" ? "canvas" : "video");

  player.load(ch.url);
  updatePlayUI();
  updateMuteUI();
}

function showList(): void {
  player.stop();
  els.playerView.hidden = true;
  els.listView.hidden = false;
  els.back.hidden = true;
  els.title.textContent = "Tesla IPTV";
}

const ICON_PLAY = "M8 5v14l11-7z";
const ICON_PAUSE = "M6 5h4v14H6zM14 5h4v14h-4z";

function updatePlayUI(): void {
  const paused = player.paused;
  els.playPath.setAttribute("d", paused ? ICON_PLAY : ICON_PAUSE);
  els.bigPlay.hidden = !paused;
}

function updateMuteUI(): void {
  els.muteWaves.style.opacity = player.muted ? "0" : "1";
}

// --- wiring ---
els.search.addEventListener("input", () => renderList(els.search.value));

els.back.addEventListener("click", showList);

els.bigPlay.addEventListener("click", () => {
  player.play();
  updatePlayUI();
});

els.play.addEventListener("click", () => {
  player.toggle();
  updatePlayUI();
});

els.canvasMode.addEventListener("change", () => {
  const mode = els.canvasMode.checked ? "canvas" : "video";
  player.setMode(mode);
  localStorage.setItem(LS_MODE, mode);
});

els.mute.addEventListener("click", () => {
  player.setMuted(!player.muted);
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

// --- init ---
const initialUrl = localStorage.getItem(LS_M3U) ?? DEFAULT_M3U;
loadChannels(initialUrl);
