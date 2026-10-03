#!/usr/bin/env python3
"""Maintain the bundled default playlist (public/channels.m3u).

The app can only play HLS streams whose CDN sends `Access-Control-Allow-Origin: *`
(hls.js fetches segments cross-origin). So "known good" == CORS + HLS + a live
segment. This script enforces that gate and keeps the playlist reproducible.

Modes:
  python3 scripts/curate.py            # full pipeline: fetch sources -> gate ->
                                       # segment spot-check -> rewrite channels.m3u
  python3 scripts/curate.py --check    # spot-check the existing channels.m3u only;
                                       # report working/dead, exit 1 if any dead (CI)

Stdlib only. Sources listed in scripts/sources.txt (default-group<TAB>url).
"""
import argparse
import concurrent.futures as cf
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES = Path(__file__).resolve().parent / "sources.txt"
OUT = ROOT / "public" / "channels.m3u"
H = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
ORDER = ["Sports", "News", "Weather", "Education", "Demos"]

# Built-in sanity streams (always included, always CORS-enabled).
DEMOS = [
    ("Demos", "Big Buck Bunny (720p)", "", "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"),
    ("Demos", "Tears of Steel (demo)", "", "https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8"),
]


def fetch(url, timeout=10, range_=None):
    h = dict(H)
    if range_:
        h["Range"] = range_
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, dict(r.headers), r.read()


def parse_m3u(text, default_group):
    """Parse #EXTM3U text into (group, name, logo, url) tuples."""
    chans, pending = [], None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#EXTINF"):
            comma = line.rfind(",")
            attrs = line[:comma] if comma != -1 else ""
            name = line[comma + 1:].strip() if comma != -1 else "Unknown"
            gt = re.search(r'group-title="([^"]*)"', attrs)
            logo = re.search(r'tvg-logo="([^"]*)"', attrs)
            lg = logo.group(1) if logo and logo.group(1) else ""
            if lg.endswith("#"):
                lg = lg[:-1]
            if lg and not lg.startswith("http"):
                lg = ""
            group = gt.group(1) if gt and gt.group(1) else default_group
            pending = {"name": name, "group": group, "logo": lg}
        elif not line.startswith("#"):
            if pending and line.startswith("http"):
                chans.append((pending["group"], pending["name"], pending["logo"], line))
                pending = None
    return chans


def first_media_seg(text, base):
    for l in [x.strip() for x in text.splitlines() if x.strip()]:
        if not l.startswith("#") and "." in l:
            return urllib.parse.urljoin(base, l)
    return None


def spotcheck(url):
    """Resolve to a real segment and fetch a slice. Returns (ok, detail)."""
    try:
        st, hdr, dat = fetch(url)
        ct = (hdr.get("Content-Type") or "").lower()
        if st != 200 or "mpegurl" not in ct:
            return False, f"playlist status={st} ct={ct}"
        if hdr.get("Access-Control-Allow-Origin") != "*":
            return False, "no CORS *"
        text = dat.decode("utf-8", "replace")
        base = url
        if "#EXT-X-STREAM-INF" in text:
            ls = [x.strip() for x in text.splitlines() if x.strip()]
            bws = []
            for i, l in enumerate(ls):
                if l.startswith("#EXT-X-STREAM-INF"):
                    m = re.search(r"BANDWIDTH=(\d+)", l)
                    bw = int(m.group(1)) if m else 10**9
                    for j in range(i + 1, len(ls)):
                        if not ls[j].startswith("#"):
                            bws.append((bw, urllib.parse.urljoin(base, ls[j])))
                            break
            if not bws:
                return False, "no variants"
            bws.sort()
            base = bws[0][1]
            _st2, _h2, dat2 = fetch(base)
            text = dat2.decode("utf-8", "replace")
        seg = first_media_seg(text, base)
        if not seg:
            return False, "no segment"
        try:
            st3, _h3, dat3 = fetch(seg, range_="bytes=0-131071")
            ok = st3 in (200, 206) and len(dat3) > 1000
        except urllib.error.HTTPError as e:
            ok, dat3, st3 = False, b"", e.code
        if not ok:
            return False, f"segment status={st3} bytes={len(dat3)}"
        return True, "ok"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except Exception as e:
        return False, f"{type(e).__name__}: {str(e)[:40]}"


def load_sources():
    out = []
    for line in SOURCES.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "\t" in line:
            g, u = line.split("\t", 1)
        else:
            g, u = "General", line
        out.append((g.strip(), u.strip()))
    return out


def run_check(workers):
    text = OUT.read_text()
    chans = parse_m3u(text, "General")
    print(f"Checking {len(chans)} channels in {OUT.name} ...")
    results = []
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        for g, name, _logo, url, (ok, detail) in ex.map(
            lambda c: (c[0], c[1], c[2], c[3], spotcheck(c[3])), chans
        ):
            results.append((g, name, url, ok, detail))
    good = [r for r in results if r[3]]
    bad = [r for r in results if not r[3]]
    print(f"WORKING {len(good)}/{len(results)}   DEAD {len(bad)}")
    for g, name, _url, _ok, detail in sorted(bad, key=lambda x: x[1]):
        print(f"  DEAD {g} | {name} | {detail}")
    sys.exit(1 if bad else 0)


def run_full(workers):
    sources = load_sources()
    print(f"Fetching {len(sources)} sources ...")
    all_chans = []
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        for g, u, chans in ex.map(
            lambda s: (s[0], s[1], fetch(s[1], timeout=15)[2].decode("utf-8", "replace")),
            sources,
        ):
            all_chans += parse_m3u(chans, g)
    all_chans += DEMOS

    seen, uniq = set(), []
    for c in all_chans:
        if c[3] in seen:
            continue
        seen.add(c[3])
        uniq.append(c)
    print(f"{len(all_chans)} channels from {len(sources)} sources ({len(uniq)} unique)")

    print("Gating (CORS + HLS) + segment spot-check ...")
    results = []
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        for g, name, logo, url, (ok, detail) in ex.map(
            lambda c: (c[0], c[1], c[2], c[3], spotcheck(c[3])), uniq
        ):
            results.append((g, name, logo, url, ok, detail))

    good = [r for r in results if r[4]]
    bad = [r for r in results if not r[4]]
    print(f"PASS {len(good)}/{len(results)}   DEAD {len(bad)}")
    for g, name, _logo, _url, _ok, detail in sorted(bad, key=lambda x: x[1]):
        print(f"  DEAD {g} | {name} | {detail}")

    good.sort(key=lambda r: (ORDER.index(r[0]) if r[0] in ORDER else 99, r[1].lower()))
    out = ["#EXTM3U"]
    for g, name, logo, url, _ok, _detail in good:
        inf = "#EXTINF:-1"
        if logo:
            inf += f' tvg-logo="{logo}"'
        inf += f' group-title="{g}",' + name.replace('"', "'")
        out.append(inf)
        out.append(url)
    OUT.write_text("\n".join(out) + "\n")
    print(f"WROTE {OUT} with {len(good)} channels")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="spot-check existing channels.m3u only")
    ap.add_argument("--workers", type=int, default=30)
    args = ap.parse_args()
    if args.check:
        run_check(args.workers)
    else:
        run_full(args.workers)


if __name__ == "__main__":
    main()
