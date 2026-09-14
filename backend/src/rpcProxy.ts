import { Hono } from "hono";
import { env } from "./env.ts";

const ALLOWED = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getTransactionCount",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getLogs",
  "eth_sendRawTransaction",
  "eth_syncing",
  "net_version",
  "web3_clientVersion",
]);

export const rpcProxy = new Hono();

rpcProxy.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
  }
  const reqs = Array.isArray(body) ? body : [body];
  if (reqs.length > 20) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch too large" } }, 400);
  for (const r of reqs as { method?: string }[]) {
    if (!r || typeof r.method !== "string" || !ALLOWED.has(r.method)) {
      return c.json({ jsonrpc: "2.0", id: (r as any)?.id ?? null, error: { code: -32601, message: `method not allowed: ${(r as any)?.method}` } }, 403);
    }
  }
  const upstream = await fetch(env.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return new Response(upstream.body, { status: upstream.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
});

rpcProxy.get("/", (c) => c.json({ ok: true, chainId: env.chainId, mode: env.chainMode, allowed: [...ALLOWED] }));
