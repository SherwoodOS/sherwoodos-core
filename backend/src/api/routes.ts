import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { decodeEventLog, formatUnits, getAddress, isAddress, parseEther, parseUnits, toHex, type Hex } from "viem";
import { env, isFork, relayer } from "../env.ts";
import { db, type ActivityRow, type MessageRow, type PaymentRow, type TaskRow } from "../db.ts";
import { bus } from "../bus.ts";
import { AGENTS, HUMAN, agentById, displayName } from "../agents/identities.ts";
import { allRuntimes, agentRuntime } from "../agents/runtime.ts";
import { APPS, PAID_APPS, appById, appKey, priceUnits, providerAddress } from "../apps/registry.ts";
import { addresses, erc20Abi, publicClient, routerAbi, rpc, shosAbi, stakingAbi, tokenInfo, usdgBalance, walletClient } from "../chain/client.ts";
import { currentEpoch } from "../chain/bootstrap.ts";
import { allPositions, markToMarket } from "../apps/trading.ts";
import { lastKnownPrice } from "../apps/marketData.ts";
import { listDocuments } from "../apps/storage.ts";

export const api = new Hono();

const dayStart = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
};

api.get("/config", (c) => {

  const u = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") ?? u.protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? u.host;
  const origin = env.siteUrl || `${proto}://${host}`;
  return c.json({
    chainMode: env.chainMode,
    chainId: env.chainId,
    rpcUrl: isFork ? `${origin}/rpc` : env.rpcUrl,
    explorerUrl: isFork ? null : env.explorerUrl,
    addresses: { ...addresses, relayer: relayer.address },
    feeBps: env.feeBps,
    policy: env.policy,
    links: { ...env.links, blockscout: env.explorerUrl, site: origin },
    epoch: currentEpoch(),
    human: HUMAN,
  });
});

async function agentSummary(id: string) {
  const def = agentById(id);
  if (!def) return undefined;
  const rt = agentRuntime(id);
  const row = db.query<{ status: string; task: string | null; task_id: string | null }, [string]>("SELECT status, task, task_id FROM agents WHERE id = ?").get(id);
  const since = dayStart();
  const stats = db
    .query<{ calls: number; spent: number }, [string, number]>("SELECT COUNT(*) as calls, COALESCE(SUM(amount),0) as spent FROM payments WHERE agent_id = ? AND ts >= ?")
    .get(id, since)!;
  const total = db
    .query<{ calls: number; spent: number }, [string]>("SELECT COUNT(*) as calls, COALESCE(SUM(amount),0) as spent FROM payments WHERE agent_id = ?")
    .get(id)!;
  const apps = db.query<{ app_id: string; n: number }, [string]>("SELECT app_id, COUNT(*) as n FROM payments WHERE agent_id = ? GROUP BY app_id ORDER BY n DESC").all(id);
  const contacted = db
    .query<{ n: number }, [string, string, string, number]>("SELECT COUNT(DISTINCT CASE WHEN from_id = ? THEN to_id ELSE from_id END) as n FROM messages WHERE (from_id = ? OR to_id = ?) AND ts >= ?")
    .get(id, id, id, since)!;
  const trades = db.query<{ n: number }, [string, number]>("SELECT COUNT(*) as n FROM positions WHERE agent_id = ? AND ts >= ?").get(id, since)!;
  const last = db.query<{ ts: number }, [string]>("SELECT ts FROM activity WHERE agent_id = ? ORDER BY ts DESC LIMIT 1").get(id);
  return {
    id: def.id,
    name: def.name,
    role: def.role,
    address: def.address,
    accent: def.accent,
    watchlist: def.watchlist,
    status: row?.status ?? rt?.status ?? "IDLE",
    task: row?.task ?? null,
    taskId: row?.task_id ?? null,
    balance: (rt?.balance ?? 0n).toString(),
    today: { calls: stats.calls, spent: stats.spent, contacted: contacted.n, trades: trades.n },
    total: { calls: total.calls, spent: total.spent },
    apps: apps.map((a) => ({ id: a.app_id, calls: a.n })),
    lastActivity: last?.ts ?? null,
    policy: { dailyUsd: env.policy.dailyUsd, perRequestUsd: env.policy.perRequestUsd, perAppDailyUsd: env.policy.perAppDailyUsd },
  };
}

api.get("/agents", async (c) => c.json(await Promise.all(AGENTS.map((a) => agentSummary(a.id)))));

api.get("/agents/:id", async (c) => {
  const s = await agentSummary(c.req.param("id"));
  if (!s) return c.json({ error: "unknown agent" }, 404);
  const rt = agentRuntime(s.id);
  const remaining = rt ? Number(BigInt(Math.round(env.policy.dailyUsd * 1e6)) - (await rt.spentToday())) : 0;
  const tasks = db.query<TaskRow, [string]>("SELECT * FROM tasks WHERE agent_id = ? ORDER BY started_at DESC LIMIT 12").all(s.id);
  const positions = markToMarket(s.id, lastKnownPrice);
  const closed = allPositions(s.id, 20).filter((p) => p.status === "closed");
  return c.json({ ...s, remainingToday: Math.max(0, remaining), tasks, positions, closed, documents: listDocuments(s.id, 10) });
});

api.get("/apps", (c) => {
  const since = dayStart();
  const list = APPS.map((a) => {
    const total = db.query<{ calls: number; spent: number; last: number | null }, [string]>("SELECT COUNT(*) as calls, COALESCE(SUM(amount),0) as spent, MAX(ts) as last FROM payments WHERE app_id = ?").get(a.id)!;
    const today = db.query<{ calls: number }, [string, number]>("SELECT COUNT(*) as calls FROM payments WHERE app_id = ? AND ts >= ?").get(a.id, since)!;
    const agents = db.query<{ agent_id: string }, [string]>("SELECT DISTINCT agent_id FROM payments WHERE app_id = ?").all(a.id).map((r) => r.agent_id);
    const price = priceUnits(a);
    const fee = (price * BigInt(env.feeBps)) / 10_000n;
    return {
      id: a.id,
      name: a.name,
      tagline: a.tagline,
      description: a.description,
      icon: a.icon,
      system: !!a.system,
      method: a.method,
      endpoint: a.system ? null : `/x402${a.path}`,
      priceUsd: a.priceUsd,
      price: price.toString(),
      fee: fee.toString(),
      total: (price + fee).toString(),
      provider: a.system ? null : providerAddress(a),
      appId: a.system ? null : appKey(a.id),
      calls: total.calls,
      callsToday: today.calls,
      spent: total.spent,
      agents: a.system ? AGENTS.map((x) => x.id) : agents,
      lastCall: total.last,
    };
  });
  return c.json(list);
});

api.get("/apps/:id", (c) => {
  const a = appById(c.req.param("id"));
  if (!a) return c.json({ error: "unknown app" }, 404);
  const payments = db.query<PaymentRow, [string]>("SELECT * FROM payments WHERE app_id = ? ORDER BY ts DESC LIMIT 30").all(a.id);
  const calls = db.query<ActivityRow, [string]>("SELECT * FROM activity WHERE app_id = ? AND kind IN ('request','response') ORDER BY ts DESC LIMIT 40").all(a.id);
  let providerBalance = "0";
  return (async () => {
    if (!a.system) {
      try {
        providerBalance = (await usdgBalance(providerAddress(a))).toString();
      } catch {

      }
    }
    return c.json({ id: a.id, payments, calls, providerBalance });
  })();
});

api.get("/activity", (c) => {
  const limit = Math.min(200, Number(c.req.query("limit") ?? 60));
  const before = Number(c.req.query("before") ?? 0);
  const agent = c.req.query("agent");
  const kind = c.req.query("kind");
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (before) (where.push("id < ?"), args.push(before));
  if (agent) (where.push("agent_id = ?"), args.push(agent));
  if (kind) (where.push("kind = ?"), args.push(kind));
  const rows = db.query<ActivityRow, any[]>(`SELECT * FROM activity ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`).all(...args, limit);
  return c.json(rows);
});

api.get("/payments", (c) => {
  const limit = Math.min(200, Number(c.req.query("limit") ?? 50));
  const agent = c.req.query("agent");
  const app = c.req.query("app");
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (agent) (where.push("agent_id = ?"), args.push(agent));
  if (app) (where.push("app_id = ?"), args.push(app));
  const rows = db.query<PaymentRow, any[]>(`SELECT * FROM payments ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`).all(...args, limit);
  return c.json(rows);
});

api.get("/threads", (c) => {
  const rows = db
    .query<{ thread_id: string; last_ts: number; n: number }, []>("SELECT thread_id, MAX(ts) as last_ts, COUNT(*) as n FROM messages GROUP BY thread_id ORDER BY last_ts DESC")
    .all();
  return c.json(
    rows.map((r) => {
      const [a, b] = r.thread_id.split("|");
      const last = db.query<MessageRow, [string]>("SELECT * FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1").get(r.thread_id)!;
      return { id: r.thread_id, participants: [a, b].map((id) => ({ id, name: displayName(id), human: id === HUMAN.id })), count: r.n, last, lastTs: r.last_ts };
    }),
  );
});

api.get("/messages", (c) => {
  const thread = c.req.query("thread");
  const limit = Math.min(300, Number(c.req.query("limit") ?? 120));
  const rows = thread
    ? db.query<MessageRow, [string, number]>("SELECT * FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?").all(thread, limit)
    : db.query<MessageRow, [number]>("SELECT * FROM messages ORDER BY id DESC LIMIT ?").all(limit);
  return c.json(rows.reverse());
});

api.get("/tasks", (c) => {
  const rows = db.query<TaskRow, [number]>("SELECT * FROM tasks ORDER BY started_at DESC LIMIT ?").all(Math.min(100, Number(c.req.query("limit") ?? 30)));
  return c.json(rows);
});

api.get("/wallet/:agent", async (c) => {
  const def = agentById(c.req.param("agent"));
  if (!def) return c.json({ error: "unknown agent" }, 404);
  const rt = agentRuntime(def.id);
  let balance = rt?.balance ?? 0n;
  try {
    balance = await usdgBalance(def.address);
  } catch {

  }
  const since = dayStart();
  const byApp = db.query<{ app_id: string; calls: number; spent: number; today: number }, [number, string]>(
    "SELECT app_id, COUNT(*) as calls, COALESCE(SUM(amount),0) as spent, COALESCE(SUM(CASE WHEN ts >= ? THEN amount ELSE 0 END),0) as today FROM payments WHERE agent_id = ? GROUP BY app_id ORDER BY spent DESC",
  ).all(since, def.id);
  const spentToday = rt ? await rt.spentToday() : 0n;
  const payments = db.query<PaymentRow, [string]>("SELECT * FROM payments WHERE agent_id = ? ORDER BY id DESC LIMIT 40").all(def.id);
  const daily = db.query<{ day: string; spent: number; calls: number }, [string]>(
    "SELECT date(ts/1000, 'unixepoch') as day, SUM(amount) as spent, COUNT(*) as calls FROM payments WHERE agent_id = ? GROUP BY day ORDER BY day DESC LIMIT 14",
  ).all(def.id);
  return c.json({
    agent: def.id,
    address: def.address,
    balance: balance.toString(),
    spentToday: spentToday.toString(),
    dailyLimit: Math.round(env.policy.dailyUsd * 1e6).toString(),
    perRequestMax: Math.round(env.policy.perRequestUsd * 1e6).toString(),
    perAppDaily: Math.round(env.policy.perAppDailyUsd * 1e6).toString(),
    byApp,
    payments,
    daily: daily.reverse(),
  });
});

api.get("/receipt/:tx", async (c) => {
  const tx = c.req.param("tx") as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return c.json({ error: "bad hash" }, 400);
  const payment = db.query<PaymentRow, [string]>("SELECT * FROM payments WHERE tx_hash = ?").get(tx);
  let onchain: unknown = null;
  let error: string | undefined;
  try {
    const rcpt = await publicClient.getTransactionReceipt({ hash: tx });
    const block = await publicClient.getBlock({ blockNumber: rcpt.blockNumber });
    const paid = rcpt.logs
      .map((l) => {
        try {
          const ev = decodeEventLog({ abi: routerAbi, data: l.data, topics: l.topics });
          return ev.eventName === "Paid" ? { ...(ev.args as any), logIndex: l.logIndex } : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .map((e: any) => ({
        receiptId: e.receiptId,
        agent: e.agent,
        appId: e.appId,
        provider: e.provider,
        amount: e.amount.toString(),
        fee: e.fee.toString(),
        nonce: e.nonce,
        receiptNo: Number(e.receiptNo),
        logIndex: e.logIndex,
      }));
    const transfers = rcpt.logs
      .filter((l) => l.address.toLowerCase() === addresses.usdg.toLowerCase() && l.topics[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef")
      .map((l) => ({ from: `0x${l.topics[1]!.slice(26)}`, to: `0x${l.topics[2]!.slice(26)}`, value: BigInt(l.data).toString() }));
    onchain = {
      status: rcpt.status,
      blockNumber: Number(rcpt.blockNumber),
      blockHash: rcpt.blockHash,
      timestamp: Number(block.timestamp) * 1000,
      from: rcpt.from,
      to: rcpt.to,
      gasUsed: rcpt.gasUsed.toString(),
      logs: rcpt.logs.length,
      paid,
      transfers,
    };
  } catch (e) {
    error = (e as Error).message.split("\n")[0];
  }
  return c.json({
    tx,
    payment,
    onchain,
    error,
    explorer: isFork ? null : `${env.explorerUrl}/tx/${tx}`,
    chainMode: env.chainMode,
    epoch: currentEpoch(),
  });
});

api.get("/stats", async (c) => {
  const since = dayStart();
  const week = Date.now() - 7 * 86_400_000;
  const today = db.query<{ calls: number; spent: number }, [number]>("SELECT COUNT(*) as calls, COALESCE(SUM(amount),0) as spent FROM payments WHERE ts >= ?").get(since)!;
  const weekly = db.query<{ calls: number; spent: number }, [number]>("SELECT COUNT(*) as calls, COALESCE(SUM(amount),0) as spent FROM payments WHERE ts >= ?").get(week)!;
  const total = db.query<{ calls: number; spent: number; fees: number }, []>("SELECT COUNT(*) as calls, COALESCE(SUM(amount),0) as spent, COALESCE(SUM(fee),0) as fees FROM payments").get()!;
  const messages = db.query<{ n: number }, [number]>("SELECT COUNT(*) as n FROM messages WHERE ts >= ?").get(since)!;
  const tasks = db.query<{ n: number }, [number]>("SELECT COUNT(*) as n FROM tasks WHERE started_at >= ?").get(since)!;
  const trades = db.query<{ n: number }, [number]>("SELECT COUNT(*) as n FROM positions WHERE ts >= ?").get(since)!;
  const hourly = db.query<{ h: string; calls: number; spent: number }, [number]>(
    "SELECT strftime('%Y-%m-%dT%H', ts/1000, 'unixepoch') as h, COUNT(*) as calls, SUM(amount) as spent FROM payments WHERE ts >= ? GROUP BY h ORDER BY h",
  ).all(Date.now() - 24 * 3_600_000);
  const working = allRuntimes().filter((r) => r.status !== "IDLE").length;
  return c.json({ today, weekly, total, messagesToday: messages.n, tasksToday: tasks.n, tradesToday: trades.n, agentsWorking: working, agents: AGENTS.length, hourly, epoch: currentEpoch() });
});

api.get("/shos", async (c) => {
  const out: Record<string, unknown> = { address: addresses.shos, staking: addresses.staking, router: addresses.router, supply: "0", decimals: 18, symbol: "SHOS", name: "Sherwood OS", external: !isFork };
  try {
    let decimals = 18;
    if (addresses.shos) {
      const t = await tokenInfo(addresses.shos);
      decimals = t.decimals;
      out.name = t.name;
      out.symbol = t.symbol;
      out.decimals = t.decimals;
      out.supply = formatUnits(t.totalSupply, t.decimals);
      out.treasuryBalance = formatUnits((await publicClient.readContract({ address: addresses.shos, abi: erc20Abi, functionName: "balanceOf", args: [addresses.treasury] })) as bigint, t.decimals);
    }
    if (addresses.staking) {
      const [totalStaked, tierCount] = await Promise.all([
        publicClient.readContract({ address: addresses.staking, abi: stakingAbi, functionName: "totalStaked" }) as Promise<bigint>,
        publicClient.readContract({ address: addresses.staking, abi: stakingAbi, functionName: "tierCount" }) as Promise<bigint>,
      ]);
      const tiers = [];
      for (let i = 0n; i < tierCount; i++) {
        const t = (await publicClient.readContract({ address: addresses.staking, abi: stakingAbi, functionName: "tiers", args: [i] })) as [bigint, number];
        tiers.push({ minStake: formatUnits(t[0], decimals), discountBps: t[1] });
      }
      out.totalStaked = formatUnits(totalStaked, decimals);
      out.tiers = tiers;
    }
    if (addresses.router) {
      const [receipts, settled, fee] = await Promise.all([
        publicClient.readContract({ address: addresses.router, abi: routerAbi, functionName: "receiptCount" }) as Promise<bigint>,
        publicClient.readContract({ address: addresses.router, abi: routerAbi, functionName: "totalSettled" }) as Promise<bigint>,
        publicClient.readContract({ address: addresses.router, abi: routerAbi, functionName: "feeBps" }) as Promise<number>,
      ]);
      out.router = { address: addresses.router, receipts: Number(receipts), totalSettled: settled.toString(), feeBps: fee };
    }
  } catch (e) {
    out.error = (e as Error).message.split("\n")[0];
  }
  return c.json(out);
});

const faucetSeen = new Map<string, number>();
api.post("/faucet", async (c) => {
  if (!isFork) return c.json({ error: "faucet exists only in fork mode" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { address?: string };
  if (!body.address || !isAddress(body.address)) return c.json({ error: "address required" }, 400);
  const to = getAddress(body.address);
  const last = faucetSeen.get(to) ?? 0;
  if (Date.now() - last < 10 * 60_000) return c.json({ error: "faucet: once per 10 minutes per address" }, 429);
  if (!addresses.shos) return c.json({ error: "SHOS not deployed" }, 503);
  try {
    await rpc("anvil_setBalance", [to, toHex(parseEther("1"))]);
    const amount = parseUnits("50000", 18);
    const tx = await walletClient.writeContract({ address: addresses.shos, abi: shosAbi, functionName: "transfer", args: [to, amount], account: relayer, chain: null });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    faucetSeen.set(to, Date.now());
    return c.json({ ok: true, tx, shos: "50000", eth: "1" });
  } catch (e) {
    return c.json({ error: (e as Error).message.split("\n")[0] }, 500);
  }
});

api.get("/stream", (c) => {
  return streamSSE(c, async (stream) => {
    let id = 0;
    const send = (e: { type: string; data: unknown }) => stream.writeSSE({ event: e.type, data: JSON.stringify(e.data), id: String(++id) });
    const off = bus.on((e) => void send(e));
    await send({ type: "system", data: { text: "connected", epoch: currentEpoch() } });
    const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: String(Date.now()) }), 20_000);
    stream.onAbort(() => {
      off();
      clearInterval(ping);
    });

    await new Promise<void>((resolve) => stream.onAbort(resolve));
  });
});
