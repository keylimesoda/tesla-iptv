# Tesla IPTV

iPTV / live-TV web app for the Tesla built-in browser. Load any **M3U / M3U8**
playlist (or Xtream Codes `get.php` live URL), browse channels, and play HLS
streams — with an in-motion rendering mode that keeps video visible while the
car is driving.

## Use it in the car

1. Open the app URL in the Tesla browser: **https://keylimesoda.github.io/tesla-iptv/**
2. Tap the gear icon → paste your **M3U/M3U8 playlist URL** → **Load playlist**.
   - Xtream Codes accounts use the live playlist URL:
     `http://<host>/get.php?username=<u>&password=<p>&type=m3u_plus`
   - The URL is remembered in the browser (localStorage) for next time.
3. Tap a channel to play. The **"Canvas in-motion"** toggle is on by default —
   that's the mode to use while driving.
4. Use the steering-wheel scroll wheel or the on-screen buttons for volume.

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
