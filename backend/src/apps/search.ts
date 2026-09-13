export interface SearchHit {
  title: string;
  url: string;
  points?: number;
  date?: string;
  source: string;
}

const UA = "Mozilla/5.0 (compatible; SherwoodOS/0.1; +https://x.com/SherwoodOSrh)";

async function hn(q: string): Promise<SearchHit[]> {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=6`;
  const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`hn ${res.status}`);
  const j = (await res.json()) as any;
  return (j.hits ?? [])
    .filter((h: any) => h.title)
    .map((h: any) => ({
      title: h.title,
      url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
      points: h.points ?? 0,
      date: h.created_at,
      source: "hn",
    }));
}

async function wikipedia(q: string): Promise<SearchHit[]> {
  const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=6&format=json`;
  const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`wiki ${res.status}`);
  const [, titles, , urls] = (await res.json()) as [string, string[], string[], string[]];
  return titles.map((t, i) => ({ title: t, url: urls[i], source: "wikipedia" }));
}

export async function search(q: string): Promise<{ query: string; hits: SearchHit[]; source: string }> {
  const query = q.trim().slice(0, 120);
  if (!query) throw new Error("q required");
  for (const src of [hn, wikipedia]) {
    try {
      const hits = await src(query);
      if (hits.length) return { query, hits, source: hits[0].source };
    } catch {

    }
  }
  return { query, hits: [], source: "none" };
}
