import { Hono } from "hono";
import { cors } from "hono/cors";
import { compress } from "hono/compress";
import { serveStatic } from "hono/bun";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { env, isFork, relayer } from "./env.ts";
import "./db.ts";
import { bootstrapChain, chainState } from "./chain/bootstrap.ts";
import { x402 } from "./apps/routes.ts";
import { api } from "./api/routes.ts";
import { rpcProxy } from "./rpcProxy.ts";
import { startAgents } from "./agents/index.ts";
import { AGENTS } from "./agents/identities.ts";

const app = new Hono({ strict: false });
app.use("*", compress());
app.use("*", cors({ origin: "*", allowHeaders: ["content-type", "x-payment", "x-agent", "x-task"], exposeHeaders: ["x-payment-response"] }));

app.get("/api/health", (c) => c.json({ ok: chainState.ready, mode: env.chainMode, chain: chainState, rpc: env.rpcUrls, ts: Date.now() }));

app.use("/api/*", async (c, next) => {
  if (chainState.ready) return next();
  return c.json({ error: `chain not ready: ${chainState.error ?? "connecting"}`, chain: chainState }, 503);
});
app.use("/x402/*", async (c, next) => {
  if (chainState.ready) return next();
  return c.json({ error: `chain not ready: ${chainState.error ?? "connecting"}` }, 503);
});
app.route("/api", api);
app.route("/x402", x402);
if (isFork) app.route("/rpc", rpcProxy);

const distDir = join(import.meta.dir, "..", "..", "frontend", "dist");
if (existsSync(distDir)) {
  const indexPath = join(distDir, "index.html");
  let index = readFileSync(indexPath, "utf8");
  let indexMtime = statSync(indexPath).mtimeMs;
  const indexHtml = () => {
    const m = statSync(indexPath).mtimeMs;
    if (m !== indexMtime) {
      index = readFileSync(indexPath, "utf8");
      indexMtime = m;
    }
    return index;
  };
  app.use("/assets/*", serveStatic({ root: distDir, rewriteRequestPath: (p) => p, onFound: (_p, c) => c.header("cache-control", "public, max-age=31536000, immutable") }));
  app.use("/*", serveStatic({ root: distDir, rewriteRequestPath: (p) => p }));
  app.get("*", (c) => {
    if (c.req.path.startsWith("/api") || c.req.path.startsWith("/x402") || c.req.path.startsWith("/rpc")) return c.notFound();
    return c.html(indexHtml());
  });
} else {
  app.get("/", (c) => c.text("Sherwood OS backend is up. Frontend not built (frontend/dist missing)."));
}

async function main() {
  console.log(`[boot] Sherwood OS · mode=${env.chainMode} · relayer=${relayer.address}`);
  for (const a of AGENTS) console.log(`[boot] agent ${a.name.padEnd(10)} ${a.address}`);

  const server = Bun.serve({ port: env.port, hostname: "0.0.0.0", fetch: app.fetch, idleTimeout: 120 });
  console.log(`[boot] listening on http://0.0.0.0:${server.port}`);
  for (;;) {
    chainState.attempts += 1;
    try {
      await bootstrapChain();
      chainState.ready = true;
      chainState.error = undefined;
      break;
    } catch (e) {
      chainState.error = (e as Error).message.split("\n")[0].slice(0, 300);
      console.error(`[chain] bootstrap failed (attempt ${chainState.attempts}): ${chainState.error}`);
      await Bun.sleep(Math.min(60_000, 5_000 * chainState.attempts));
    }
  }
  startAgents();
}

main().catch((e) => {
  console.error("[boot] fatal:", e);
  process.exit(1);
});
