# Tesla IPTV

iPTV / live-TV web app for the Tesla built-in browser. Load any **M3U / M3U8**
playlist (or Xtream Codes `get.php` live URL), browse channels, and play HLS
streams — with an in-motion rendering mode that keeps video visible while the
car is driving.

## Use it in the car

**One-time wiring (no typing in the car):**

1. On your **phone**, open **https://keylimesoda.github.io/tesla-iptv/** and
   tap the gear ⚙.
2. Paste your **M3U/M3U8 playlist URL** → **Generate wiring link** → **Copy**.
   - Xtream Codes accounts use the live playlist URL:
     `http://<host>/get.php?username=<u>&password=<p>&type=m3u_plus`
3. In the car's browser, open that wiring link **once** (you can add it to
   the browser's home shortcuts). The playlist is saved to the car's browser
   storage — every later launch loads it directly.

**In the car day-to-day:** open the app, tap a channel to play.
**"Canvas in-motion"** is on by default — that's the driving mode. Volume via
steering-wheel scroll wheel or on-screen button.

> **Passenger use only.** The driver must not watch or operate this while
> driving. In-motion front-screen video defeats Tesla's in-motion video
> suppression; that is a safety/regulatory gray area (see below). You are
> responsible for how you use this.

## How in-motion video works

Tesla's infotainment browser suppresses the visual output of HTML5
`<video>` elements while the vehicle is in motion (audio keeps playing).
This app exploits the fact that the suppression does **not** apply to
`<canvas>`:

- The stream plays in a `<video>` element that is pushed off-screen
  (audio + decoding continue normally).
- Every animation frame, the current video frame is copied onto a visible
  `<canvas>` with `drawImage()`.
- Because the visible surface is a canvas — not a video element — it is not
  suppressed while driving.

Toggle off "Canvas in-motion" for normal rendering (parked use).

## Browser viewport (verified, firmware 2026.26+)

The 2026.26 summer update changed the browser's pixel density from dpr 1.0 to
~1.53, and the browser window is **not full-screen while driving**. Measured
values (2024 Model Y / 2023 Model S, Chromium 148):

| State | CSS viewport | dpr | Physical |
|---|---|---|---|
| Parked (M3/Y, 15.4" 1920×1200) | 1254×784 | 1.53 | 1920×1200 (147 PPI) |
| In motion (M3/Y) | ~773×601 | 1.53 | ~1183×920 |
| Parked (S/X 2021+, 17" 2200×1300) | ~1410×833 | 1.56 | 2200×1300 (150 PPI) |

Notes for building for the car:

- Design for **773×601 CSS while driving**; it grows to 1254×784 when parked.
- `pointer: fine` / `hover: hover` are now reported (touch detection via media
  queries is unreliable); `maxTouchPoints` is still 16.
- `prefers-color-scheme` reports light; this app pins a dark theme.
- Pre-update firmware reports the raw panel as CSS (1920×1200 @ dpr 1.0).
- The canvas backing store is capped at 2× device pixels.

Sources: Tesla Motors Club measurement thread (dpr 1.0 → 1.53, in-motion
773×601 window), Not a Tesla App screen comparison (panel sizes/resolutions),
codriver.io summer-2026 guide (Chromium 148, pointer/hover flip).

## Limitations

- **Non-DRM HLS only.** Streams protected by Widevine/FairPlay (Netflix, most
  premium league feeds, some pay-TV channels) will **not** play.
- **CORS.** The playlist URL and its segments must send
  `Access-Control-Allow-Origin` headers. Many IPTV providers do; if your feed
  doesn't, playback will fail in the status line — you'd need a proxy.
- **Connectivity.** Uses the car's Premium Connectivity / Wi-Fi / hotspot.
  Live video is data-heavy; Tesla data caps may apply.
- **Chromium.** Runs on all modern Teslas (the canvas path predates
  WebCodecs, so even older cars work).
- **Safety/legal (US):** NHTSA has scrutinized in-vehicle in-motion
  entertainment ("Passenger Play", investigation PE21-023, closed 2023).
  Watching moving video visible to the driver while in motion is a
  distracted-driving violation in most states. This app is for passengers.

## Development

```sh
npm install
npm run dev      # dev server at http://localhost:5173/tesla-iptv/
npm run build    # production build into dist/ (base=/tesla-iptv/)
```

Stack: Vite + TypeScript + hls.js. No framework.

### Re-deploy to GitHub Pages

```sh
npm run build
git worktree add ../tesla-iptv-ghpages gh-pages 2>/dev/null || git worktree add --checkout ../tesla-iptv-ghpages -b gh-pages
rsync -a --delete dist/ ../tesla-iptv-ghpages/
git -C ../tesla-iptv-ghpages commit -am "deploy"
git -C ../tesla-iptv-ghpages push origin gh-pages
git worktree remove ../tesla-iptv-ghpages --force
```

GitHub Pages is configured to serve the `gh-pages` branch at the repo root.
