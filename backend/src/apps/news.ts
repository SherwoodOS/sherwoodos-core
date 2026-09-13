export interface Headline {
  title: string;
  url: string;
  publishedAt?: string;
  publisher?: string;
}

const UA = "Mozilla/5.0 (compatible; SherwoodOS/0.1; +https://x.com/SherwoodOSrh)";

const POS = ["beat", "beats", "surge", "surges", "soar", "soars", "record", "rally", "rallies", "upgrade", "upgrades", "bullish", "growth", "gain", "gains", "jump", "jumps", "strong", "profit", "profits", "outperform", "buy", "expands", "wins", "win", "boost", "boosts", "high", "highs", "rebound"];
const NEG = ["miss", "misses", "plunge", "plunges", "fall", "falls", "drop", "drops", "downgrade", "downgrades", "bearish", "loss", "losses", "lawsuit", "probe", "cut", "cuts", "weak", "slump", "slumps", "warning", "warns", "recall", "layoffs", "decline", "declines", "sell", "selloff", "low", "lows", "fear", "fears", "risk", "risks", "tumble", "tumbles", "crash"];

export function sentimentOf(titles: string[]): number {
  let score = 0;
  let n = 0;
  for (const t of titles) {
    const words = t.toLowerCase().split(/[^a-z]+/);
    let s = 0;
    for (const w of words) {
      if (POS.includes(w)) s += 1;
      if (NEG.includes(w)) s -= 1;
    }
    score += Math.max(-2, Math.min(2, s)) / 2;
    n += 1;
  }
  return n ? Math.round((score / n) * 100) / 100 : 0;
}

function decode(s: string) {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

async function googleNews(q: string): Promise<Headline[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`gnews ${res.status}`);
  const xml = await res.text();
  const items = [...xml.matchAll(/<item>(.*?)<\/item>/gs)].slice(0, 8);
  return items.map((m) => {
    const block = m[1];
    const title = decode(/<title>(.*?)<\/title>/s.exec(block)?.[1] ?? "");
    const link = decode(/<link>(.*?)<\/link>/s.exec(block)?.[1] ?? "");
    const pub = /<pubDate>(.*?)<\/pubDate>/s.exec(block)?.[1];
    const source = decode(/<source[^>]*>(.*?)<\/source>/s.exec(block)?.[1] ?? "");
    return { title: title.replace(/ - [^-]+$/, ""), url: link, publishedAt: pub, publisher: source };
  });
}

export async function news(q: string): Promise<{ query: string; headlines: Headline[]; sentiment: number; source: string }> {
  const query = q.trim().slice(0, 120);
  if (!query) throw new Error("q required");
  try {
    const headlines = (await googleNews(query)).filter((h) => h.title.length >= 12);
    return { query, headlines, sentiment: sentimentOf(headlines.map((h) => h.title)), source: "google-news" };
  } catch {
    return { query, headlines: [], sentiment: 0, source: "none" };
  }
}
