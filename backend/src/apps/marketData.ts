import { db, now, type QuoteRow } from "../db.ts";

export interface Quote {
  symbol: string;
  price: number;
  changePct: number;
  series: number[];
  source: string;
  asOf: number;
  stale: boolean;
}

const mem = new Map<string, Quote>();
const UA = "Mozilla/5.0 (compatible; SherwoodOS/0.1; +https://x.com/SherwoodOSrh)";

async function fromYahoo(symbol: string): Promise<Quote> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2mo&interval=1d`;
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`yahoo ${res.status}`);
  const j = (await res.json()) as any;
  const r = j?.chart?.result?.[0];
  const rawCloses: (number | null)[] = r?.indicators?.quote?.[0]?.close ?? [];
  const stamps: number[] = r?.timestamp ?? [];
  const closes: number[] = rawCloses.filter((x): x is number => typeof x === "number");
  const price: number = r?.meta?.regularMarketPrice ?? closes.at(-1);

  const sessionStart: number | undefined = r?.meta?.currentTradingPeriod?.regular?.start;
  let prev: number | undefined;
  if (sessionStart && stamps.length === rawCloses.length) {
    for (let i = rawCloses.length - 1; i >= 0; i--) {
      if (stamps[i] < sessionStart && typeof rawCloses[i] === "number") {
        prev = rawCloses[i] as number;
        break;
      }
    }
  }
  if (prev === undefined) prev = closes.length > 1 && Math.abs(closes.at(-1)! - price) / price < 0.02 ? closes.at(-2)! : closes.at(-1)!;
  if (!price || closes.length < 5) throw new Error("yahoo: empty");
  return { symbol, price, changePct: ((price - prev) / prev) * 100, series: closes.slice(-30), source: "yahoo", asOf: now(), stale: false };
}

async function fromStooq(symbol: string): Promise<Quote> {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol.toLowerCase())}.us&i=d`;
  const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`stooq ${res.status}`);
  const text = await res.text();
  const rows = text.trim().split("\n").slice(1);
  const closes = rows.map((l) => Number(l.split(",")[4])).filter((n) => Number.isFinite(n));
  if (closes.length < 5) throw new Error("stooq: empty");
  const price = closes.at(-1)!;
  const prev = closes.at(-2)!;
  return { symbol, price, changePct: ((price - prev) / prev) * 100, series: closes.slice(-30), source: "stooq", asOf: now(), stale: false };
}

function fromDb(symbol: string): Quote | undefined {
  const row = db.query<QuoteRow, [string]>("SELECT * FROM quotes WHERE symbol = ?").get(symbol);
  if (!row) return undefined;
  return { symbol, price: row.price, changePct: row.change_pct, series: JSON.parse(row.series), source: `${row.source} (cached)`, asOf: row.ts, stale: true };
}

function persist(q: Quote) {
  db.query(
    `INSERT INTO quotes(symbol, ts, price, change_pct, series, source) VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET ts = excluded.ts, price = excluded.price, change_pct = excluded.change_pct, series = excluded.series, source = excluded.source`,
  ).run(q.symbol, q.asOf, q.price, q.changePct, JSON.stringify(q.series), q.source);
}

export async function getQuote(symbolRaw: string): Promise<Quote> {
  const symbol = symbolRaw.toUpperCase().replace(/[^A-Z.\-]/g, "").slice(0, 8);
  if (!symbol) throw new Error("symbol required");
  const cached = mem.get(symbol);
  if (cached && now() - cached.asOf < 60_000) return cached;
  for (const src of [fromYahoo, fromStooq]) {
    try {
      const q = await src(symbol);
      mem.set(symbol, q);
      persist(q);
      return q;
    } catch {

    }
  }
  const stale = fromDb(symbol);
  if (stale) return stale;
  throw new Error(`no data for ${symbol}`);
}

export function lastKnownPrice(symbol: string): number | undefined {
  return mem.get(symbol.toUpperCase())?.price ?? fromDb(symbol.toUpperCase())?.price;
}
