export interface Channel {
  id: string;
  name: string;
  url: string;
  logo?: string;
  group?: string;
}

function attr(s: string, key: string): string | undefined {
  return new RegExp(`${key}\\s*=\\s*"([^"]*)"`, "i").exec(s)?.[1];
}

/** Parse an #EXTM3U document into a flat channel list. */
export function parseM3U(text: string): Channel[] {
  const channels: Channel[] = [];
  let pending: { name: string; logo?: string; group?: string } | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("#EXTINF")) {
      const comma = line.indexOf(",");
      const attrs = comma === -1 ? "" : line.slice(0, comma);
      const name = comma === -1 ? "Unknown" : line.slice(comma + 1).trim() || "Unknown";
      pending = {
        name,
        logo: attr(attrs, "tvg-logo") || attr(attrs, "logo"),
        group: attr(attrs, "group-title"),
      };
    } else if (!line.startsWith("#")) {
      if (pending) {
        channels.push({
          id: `ch${channels.length}`,
          name: pending.name,
          logo: pending.logo,
          group: pending.group,
          url: line,
        });
        pending = null;
      }
    }
  }
  return channels;
}

export async function fetchM3U(url: string): Promise<Channel[]> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching playlist`);
  return parseM3U(await res.text());
}

/** Group channels preserving first-seen order. */
export function groupByGroup(channels: Channel[]): [string, Channel[]][] {
  const order: string[] = [];
  const map = new Map<string, Channel[]>();
  for (const ch of channels) {
    const g = ch.group || "General";
    if (!map.has(g)) {
      map.set(g, []);
      order.push(g);
    }
    map.get(g)!.push(ch);
  }
  return order.map((g) => [g, map.get(g)!]);
}
