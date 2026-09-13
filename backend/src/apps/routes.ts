import { Hono } from "hono";
import { appById, PAID_APPS, appKey, priceUnits, providerAddress } from "./registry.ts";
import { paywall, requirementsFor, type PaywallVars } from "../x402/paywall.ts";
import { getQuote } from "./marketData.ts";
import { search } from "./search.ts";
import { news } from "./news.ts";
import { compute } from "./compute.ts";
import { getDocument, putDocument } from "./storage.ts";
import { execute } from "./trading.ts";
import { agentByAddress } from "../agents/identities.ts";
import { addresses } from "../chain/client.ts";
import { env } from "../env.ts";

export const x402 = new Hono<{ Variables: PaywallVars }>();

const app = (id: string) => appById(id)!;

x402.get("/", (c) => {
  return c.json({
    x402Version: 1,
    network: "robinhood",
    chainId: env.chainId,
    asset: addresses.usdg,
    payTo: addresses.router,
    feeBps: env.feeBps,
    resources: PAID_APPS.map((a) => ({
      id: a.id,
      name: a.name,
      method: a.method,
      path: `/x402${a.path}`,
      priceUsd: a.priceUsd,
      priceUnits: priceUnits(a).toString(),
      appId: appKey(a.id),
      provider: providerAddress(a),
      description: a.description,
    })),
  });
});

x402.get("/market-data", paywall(app("market-data")), async (c) => {
  const symbol = c.req.query("symbol") ?? "NVDA";
  try {
    const q = await getQuote(symbol);
    return c.json({ ok: true, ...q });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 200);
  }
});

x402.get("/search", paywall(app("search")), async (c) => {
  const r = await search(c.req.query("q") ?? "");
  return c.json({ ok: true, ...r });
});

x402.get("/news", paywall(app("news")), async (c) => {
  const r = await news(c.req.query("q") ?? "");
  return c.json({ ok: true, ...r });
});

x402.post("/compute", paywall(app("compute")), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { series?: number[]; indicators?: string[] };
  try {
    return c.json({ ok: true, ...compute({ series: body.series ?? [], indicators: body.indicators }) });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 200);
  }
});

x402.post("/storage", paywall(app("storage")), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { key?: string; content?: unknown };
  const payer = c.get("payment").payer;
  const agent = agentByAddress(payer);
  try {
    return c.json({ ok: true, ...putDocument(agent?.id ?? payer, body.key ?? "", body.content ?? "") });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 200);
  }
});

x402.get("/storage/:key", (c) => {
  const doc = getDocument(c.req.param("key"));
  if (!doc) return c.json({ ok: false, error: "not found" }, 404);
  return c.json({ ok: true, key: doc.key, agentId: doc.agent_id, ts: doc.ts, sha256: doc.sha256, size: doc.size, content: safeJson(doc.content) });
});

x402.post("/trading", paywall(app("trading")), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { symbol?: string; side?: "buy" | "sell"; qty?: number; reason?: string };
  const payer = c.get("payment").payer;
  const agent = agentByAddress(payer);
  if (!body.symbol || !body.side) return c.json({ ok: false, error: "symbol and side required" }, 200);
  try {
    const fill = await execute(agent?.id ?? payer, { symbol: body.symbol, side: body.side, qty: body.qty ?? 1, reason: body.reason });
    return c.json({ ok: true, ...fill });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 200);
  }
});

x402.get("/quote/:id", async (c) => {
  const a = appById(c.req.param("id"));
  if (!a || a.system) return c.json({ error: "unknown app" }, 404);
  const price = priceUnits(a);
  const fee = (price * BigInt(env.feeBps)) / 10_000n;
  const u = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") ?? u.protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? u.host;
  return c.json(requirementsFor(a, `${proto}://${host}/x402${a.path}`, { price, fee, total: price + fee }));
});

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
