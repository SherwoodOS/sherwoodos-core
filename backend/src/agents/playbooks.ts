import type { MessageRow } from "../db.ts";
import { env, isFork } from "../env.ts";
import { HUMAN, AGENTS, agentById } from "./identities.ts";
import { AgentRuntime, TaskCtx, fmtPct, fmtPx, fmtSigned, fmtUsd, pick, type Playbook } from "./runtime.ts";
import { openPositions } from "../apps/trading.ts";
import { forkFundUsdg } from "../chain/bootstrap.ts";
import { usdgBalance } from "../chain/client.ts";
import { listDocuments } from "../apps/storage.ts";

type Quote = { ok: boolean; symbol: string; price: number; changePct: number; series: number[]; stale?: boolean };
type NewsRes = { ok: boolean; sentiment: number; headlines: { title: string }[] };
type ComputeRes = { ok: boolean; rsi14?: number; momentum5?: number; sma20?: number; volatility?: number; signal: string };

const symbolIn = (text: string, fallback: string[]) => {
  const m = text.toUpperCase().match(/\b[A-Z]{2,5}\b/g)?.filter((w) => !["CHECK", "WATCH", "TODAY", "ONLY", "ME", "IF", "SOMETHING", "CHANGES", "SHORT", "SUMMARY", "ON", "NUMBERS", "ANYTHING", "MOVING", "IN", "AND", "OR", "THE", "A", "IS", "RSI", "TOO", "SENTIMENT", "STATUS", "BUDGET", "BEFORE", "CLOSE", "OPEN", "WORTH", "LOOK", "DAY", "SLOW", "DOWN", "OF", "DAILY", "USED", "UP", "NO", "CHANGE", "NOT", "YET", "AT", "TO"].includes(w));
  return m?.[0] ?? pick(fallback);
};

async function traderCheck(rt: AgentRuntime, symbol: string, origin: string, replyTo?: MessageRow) {
  const ctx = rt.startTask(`Check ${symbol}`, origin);
  if (replyTo) ctx.replyTo = { threadId: replyTo.thread_id, fromId: replyTo.from_id };
  try {
    await ctx.think();
    const q = await ctx.call<Quote>("market-data", { query: { symbol } });
    if (!q.ok || !q.data?.price) {
      ctx.decide(`no quote for ${symbol}, skip.`);
      if (replyTo) rt.reply(ctx, replyTo, `${symbol}: no quote right now. Skipping.`);
      return ctx.done();
    }
    await ctx.think(1500);
    const n = await ctx.call<NewsRes>("news", { query: { q: `${symbol} stock` } });
    const sentiment = n.ok ? n.data.sentiment : 0;

    const reply = await ctx.ask("researcher", `Check ${symbol} sentiment. RSI and momentum too.`);
    const meta = reply?.meta ? (JSON.parse(reply.meta) as { rsi?: number; momentum?: number; sentiment?: number; signal?: string }) : {};
    const rsi = meta.rsi ?? 50;
    const mom = meta.momentum ?? q.data.changePct;
    const s = typeof meta.sentiment === "number" ? (meta.sentiment + sentiment) / 2 : sentiment;

    await ctx.think(1800);
    const open = openPositions(rt.def.id).find((p) => p.symbol === symbol);
    const qty = Math.max(1, Math.floor(200 / q.data.price));
    let action: "buy" | "sell" | null = null;
    let why = "";
    if (open?.side === "long") {
      if (s < -0.3 || rsi > 72 || mom < -4) {
        action = "sell";
        why = s < -0.3 ? `sentiment ${fmtSigned(s)}` : rsi > 72 ? `RSI ${rsi}` : `momentum ${fmtPct(mom)}`;
      }
    } else if (open?.side === "short") {
      if (s > 0.3 || rsi < 30 || mom > 4) {
        action = "buy";
        why = s > 0.3 ? `sentiment ${fmtSigned(s)}` : rsi < 30 ? `RSI ${rsi}` : `momentum ${fmtPct(mom)}`;
      }
    } else if ((s >= 0.1 && rsi < 65 && mom > 0) || rsi < 32) {
      action = "buy";
      why = rsi < 32 ? `RSI ${rsi}, oversold` : `sentiment ${fmtSigned(s)}, RSI ${rsi}, momentum ${fmtPct(mom)}`;
    } else if (s <= -0.3 && rsi > 60 && mom < 0) {
      action = "sell";
      why = `sentiment ${fmtSigned(s)}, RSI ${rsi}, momentum ${fmtPct(mom)}`;
    }

    if (!action) {
      ctx.decide(`hold ${symbol}. Sentiment ${fmtSigned(s)}, RSI ${rsi}, momentum ${fmtPct(mom)}.`, { symbol, sentiment: s, rsi, momentum: mom });
    } else {
      const verb = open ? (action === "sell" && open.side === "long" ? "close long" : action === "buy" && open.side === "short" ? "cover short" : action) : action === "buy" ? "open long" : "open short";
      ctx.decide(`${verb} ${symbol}. ${why}.`, { symbol, action, qty: open?.qty ?? qty, sentiment: s, rsi, momentum: mom });
      const fill = await ctx.call<any>("trading", { body: { symbol, side: action, qty: open?.qty ?? qty, reason: why } });
      if (fill.ok && fill.data?.price) {
        const pnl = typeof fill.data.pnl === "number" ? `, PnL ${fill.data.pnl >= 0 ? "+" : ""}$${fill.data.pnl.toFixed(2)}` : "";
        ctx.execution(`Trader changed position: ${fill.data.action} ${fill.data.side} ${fill.data.qty} ${symbol} @ ${fmtPx(fill.data.price)} (paper${pnl}).`, fill.data);
      }
    }

    await ctx.call("storage", {
      body: {
        key: `trader/${symbol}/${new Date().toISOString().slice(0, 16)}`,
        content: { symbol, price: q.data.price, changePct: q.data.changePct, sentiment: s, rsi, momentum: mom, action: action ?? "hold", why, task: ctx.id },
      },
    });

    if (replyTo) {
      const line = action ? `${symbol} ${fmtPx(q.data.price)} (${fmtPct(q.data.changePct)}). ${action === "buy" ? "Bought" : "Sold"}: ${why}.` : `${symbol} ${fmtPx(q.data.price)} (${fmtPct(q.data.changePct)}). RSI ${rsi}, sentiment ${fmtSigned(s)}. No change worth a message.`;
      rt.reply(ctx, replyTo, line);
    }
    ctx.done();
  } catch (e) {
    ctx.fail((e as Error).message);
  }
}

const trader: Playbook = {
  async scheduled(rt) {
    await traderCheck(rt, pick(rt.def.watchlist), "schedule");
  },
  async onMessage(rt, msg) {
    const text = msg.text.toLowerCase();
    if (msg.from_id === "scout" && /worth a look|moving|up|down/.test(text)) {
      const sym = symbolIn(msg.text, rt.def.watchlist);
      const ctx = rt.startTask(`Reply to Scout`, `agent:${msg.from_id}`);
      rt.reply(ctx, msg, `Noted. Checking ${sym} now.`);
      ctx.done(`Trader acknowledged Scout.`);
      await traderCheck(rt, sym, `agent:${msg.from_id}`);
      return;
    }
    if (msg.from_id === "researcher") return;
    if (msg.from_id === HUMAN.id) {
      const sym = symbolIn(msg.text, rt.def.watchlist);
      const ctx = rt.startTask(`Reply to ${HUMAN.name}`, "human");
      rt.reply(ctx, msg, `On it. Watching ${sym}. Will message on change.`);
      ctx.done(`Trader acknowledged the operator.`);
      await traderCheck(rt, sym, "human", msg);
      return;
    }
    if (msg.from_id === "operator") {
      const ctx = rt.startTask(`Reply to Operator`, "agent:operator");
      rt.reply(ctx, msg, `Understood. Slowing down until reset.`);
      ctx.done(`Trader acknowledged Operator.`);
    }
  },
};

async function researcherAnswer(rt: AgentRuntime, msg: MessageRow) {
  const symbol = symbolIn(msg.text, rt.def.watchlist);
  const ctx = rt.startTask(`${symbol} for ${agentById(msg.from_id)?.name ?? HUMAN.name}`, `agent:${msg.from_id}`);
  ctx.replyTo = { threadId: msg.thread_id, fromId: msg.from_id };
  try {
    await ctx.think(1500);
    const q = await ctx.call<Quote>("market-data", { query: { symbol } });
    let comp: ComputeRes | undefined;
    if (q.ok && q.data?.series?.length > 5) {
      const c = await ctx.call<ComputeRes>("compute", { body: { series: q.data.series, indicators: ["rsi", "sma20", "momentum"] } });
      if (c.ok) comp = c.data;
    }
    const n = await ctx.call<NewsRes>("news", { query: { q: `${symbol}` } });
    const sentiment = n.ok ? n.data.sentiment : 0;
    const rsi = comp?.rsi14;
    const mom = comp?.momentum5;
    const trend = sentiment <= -0.2 ? "Sentiment deteriorating." : sentiment >= 0.2 ? "Sentiment improving." : "Sentiment flat.";
    await ctx.think(1200);
    const line = q.ok
      ? `${symbol}: ${fmtPx(q.data.price)} (${fmtPct(q.data.changePct)}). RSI ${rsi ?? "—"}, momentum ${fmtPct(mom)}, sentiment ${fmtSigned(sentiment)}. ${trend} ${n.ok ? `${n.data.headlines.length} headlines.` : ""}`.trim()
      : `${symbol}: no quote. Sentiment ${fmtSigned(sentiment)}. ${trend}`;
    rt.reply(ctx, msg, line, { symbol, rsi, momentum: mom, sentiment, signal: comp?.signal });
    ctx.done();
  } catch (e) {
    ctx.fail((e as Error).message);
  }
}

const TOPICS = ["AI chips", "tokenized stocks", "x402 agents", "Robinhood Chain", "GPU supply", "retail flows", "rate cuts"];

const researcher: Playbook = {
  async scheduled(rt) {
    const topic = pick(TOPICS);
    const ctx = rt.startTask(`Scan: ${topic}`, "schedule");
    try {
      await ctx.think();
      const sr = await ctx.call<{ ok: boolean; hits: { title: string; url: string }[] }>("search", { query: { q: topic } });
      const n = await ctx.call<NewsRes>("news", { query: { q: topic } });
      await ctx.call("storage", {
        body: { key: `research/${topic.replace(/\s+/g, "-")}/${new Date().toISOString().slice(0, 13)}`, content: { topic, hits: sr.data?.hits?.slice(0, 5), headlines: n.data?.headlines?.slice(0, 5), sentiment: n.data?.sentiment } },
      });
      const top = n.data?.headlines?.[0]?.title ?? sr.data?.hits?.[0]?.title;
      ctx.decide(`${topic}: sentiment ${fmtSigned(n.data?.sentiment ?? 0)}. ${top ? `Top: "${top.slice(0, 70)}"` : "Nothing new."}`);
      if (top) ctx.say("trader", `${topic}: sentiment ${fmtSigned(n.data?.sentiment ?? 0)}. ${top.slice(0, 90)}`);
      ctx.done();
    } catch (e) {
      ctx.fail((e as Error).message);
    }
  },
  async onMessage(rt, msg) {
    if (msg.from_id === "operator") {
      const ctx = rt.startTask(`Reply to Operator`, "agent:operator");
      rt.reply(ctx, msg, `Understood.`);
      ctx.done(`Researcher acknowledged Operator.`);
      return;
    }
    await researcherAnswer(rt, msg);
  },
};

const scout: Playbook = {
  async scheduled(rt) {
    const symbols = [...rt.def.watchlist].sort(() => Math.random() - 0.5).slice(0, 3);
    const ctx = rt.startTask(`Scan ${symbols.join(", ")}`, "schedule");
    try {
      await ctx.think(1500);
      const quotes: Quote[] = [];
      for (const s of symbols) {
        const q = await ctx.call<Quote>("market-data", { query: { symbol: s } });
        if (q.ok && q.data?.price) quotes.push(q.data);
      }
      if (!quotes.length) {
        ctx.decide("no quotes, nothing to report.");
        return ctx.done();
      }
      const mover = quotes.reduce((a, b) => (Math.abs(b.changePct) > Math.abs(a.changePct) ? b : a));
      const n = await ctx.call<NewsRes>("news", { query: { q: `${mover.symbol} stock` } });
      const sentiment = n.ok ? n.data.sentiment : 0;
      await ctx.think(1200);
      if (Math.abs(mover.changePct) >= 1.5) {
        ctx.decide(`${mover.symbol} ${fmtPct(mover.changePct)} is the mover. Tell Trader.`, { mover: mover.symbol, changePct: mover.changePct, sentiment });
        ctx.say("trader", `${mover.symbol} ${fmtPct(mover.changePct)} on the day. Sentiment ${fmtSigned(sentiment)}. Worth a look?`);
      } else {
        ctx.decide(`quiet tape. Biggest move ${mover.symbol} ${fmtPct(mover.changePct)}.`, { mover: mover.symbol, changePct: mover.changePct });
      }
      await ctx.call("storage", { body: { key: `scout/${new Date().toISOString().slice(0, 16)}`, content: { quotes: quotes.map((q) => ({ s: q.symbol, p: q.price, c: q.changePct })), mover: mover.symbol, sentiment } } });
      ctx.done();
    } catch (e) {
      ctx.fail((e as Error).message);
    }
  },
  async onMessage(rt, msg) {
    if (msg.from_id === HUMAN.id) {
      const syms = (msg.text.toUpperCase().match(/\b[A-Z]{2,5}\b/g) ?? []).filter((w) => rt.def.watchlist.includes(w) || /^(NVDA|HOOD|TSLA|AAPL|MSFT|AMD|COIN|MSTR|PLTR|GOOG|AMZN|META)$/.test(w)).slice(0, 2);
      const list = syms.length ? syms : rt.def.watchlist.slice(0, 2);
      const ctx = rt.startTask(`Check ${list.join(", ")} for ${HUMAN.name}`, "human");
      ctx.replyTo = { threadId: msg.thread_id, fromId: msg.from_id };
      try {
        await ctx.think(1200);
        const lines: string[] = [];
        for (const s of list) {
          const q = await ctx.call<Quote>("market-data", { query: { symbol: s } });
          if (q.ok && q.data?.price) lines.push(`${s} ${fmtPx(q.data.price)} (${fmtPct(q.data.changePct)})`);
        }
        rt.reply(ctx, msg, lines.length ? `${lines.join(", ")}. ${lines.some((l) => /\([+-][2-9]|\([+-]\d\d/.test(l)) ? "Something is moving." : "Nothing unusual."}` : "No quotes right now.");
        ctx.done();
      } catch (e) {
        ctx.fail((e as Error).message);
      }
      return;
    }
    if (msg.from_id === "operator") {
      const ctx = rt.startTask(`Reply to Operator`, "agent:operator");
      rt.reply(ctx, msg, `Understood. Fewer scans until reset.`);
      ctx.done(`Scout acknowledged Operator.`);
    }
  },
};

async function budgetReport(rt: AgentRuntime, origin: string, replyTo?: MessageRow) {
  const ctx = rt.startTask("Budget check", origin);
  if (replyTo) ctx.replyTo = { threadId: replyTo.thread_id, fromId: replyTo.from_id };
  try {
    await ctx.think(1500);
    const limit = BigInt(Math.round(env.policy.dailyUsd * 1_000_000));
    const rows: { id: string; name: string; used: number; balance: bigint }[] = [];
    for (const a of AGENTS) {
      const r = agentById(a.id)!;
      const balance = await usdgBalance(r.address);
      const spent = await (await import("./runtime.ts")).agentRuntime(a.id)!.spentToday();
      rows.push({ id: a.id, name: a.name, used: limit ? Number((spent * 100n) / limit) : 0, balance });
    }
    ctx.log("response", `Budgets read from the router: ${rows.map((r) => `${r.name} ${r.used}%`).join(", ")}.`, rows.map((r) => ({ ...r, balance: r.balance.toString() })));
    await ctx.think(800);
    const spendSeries = rows.map((r) => r.used);
    await ctx.call("compute", { body: { series: [...spendSeries, ...spendSeries.map((x) => x + 1)], indicators: ["volatility"] } });
    await ctx.call("storage", { body: { key: `operator/budget/${new Date().toISOString().slice(0, 13)}`, content: rows.map((r) => ({ ...r, balance: r.balance.toString() })) } });

    for (const r of rows) {
      if (r.used >= 80 && r.id !== "operator") {
        ctx.decide(`${r.name} at ${r.used}% of daily budget. Ask to slow down.`);
        ctx.say(r.id, `${r.used}% of daily budget used. Slow down until the daily reset.`);
      }
      if (r.balance < BigInt(5_000_000)) {
        if (isFork) {
          await forkFundUsdg(agentById(r.id)!.address, BigInt(Math.round(env.policy.fundUsd * 1_000_000)));
          ctx.execution(`Operator topped up ${r.name}: +${env.policy.fundUsd} USDG (test funds, fork).`, { agent: r.id });
          void (await import("./runtime.ts")).agentRuntime(r.id)?.refreshBalance();
        } else {
          ctx.decide(`${r.name} balance ${fmtUsd(r.balance)}. Needs a top-up.`);
        }
      }
    }
    const summary = rows.map((r) => `${r.name} ${r.used}% · ${fmtUsd(r.balance)}`).join(" | ");
    const low = rows.filter((r) => r.balance < BigInt(5_000_000) && !isFork);
    const text = `Daily budgets: ${summary}.${low.length ? ` Top-up needed: ${low.map((r) => r.name).join(", ")}.` : ""}`;
    if (replyTo) rt.reply(ctx, replyTo, text);
    else ctx.say(HUMAN.id, text);
    ctx.done();
  } catch (e) {
    ctx.fail((e as Error).message);
  }
}

const operator: Playbook = {
  async scheduled(rt) {
    if (Math.random() < 0.65) return budgetReport(rt, "schedule");
    const ctx = rt.startTask("Storage audit", "schedule");
    try {
      await ctx.think(1200);
      const docs = listDocuments(undefined, 200) as { size: number; agent_id: string }[];
      const byAgent = docs.reduce<Record<string, number>>((m, d) => ((m[d.agent_id] = (m[d.agent_id] ?? 0) + 1), m), {});
      ctx.log("response", `Storage holds ${docs.length} documents: ${Object.entries(byAgent).map(([k, v]) => `${agentById(k)?.name ?? k} ${v}`).join(", ") || "none"}.`, byAgent);
      await ctx.call("compute", { body: { series: docs.slice(0, 50).map((d) => d.size).concat([1, 2]), indicators: ["volatility"] } });
      await ctx.call("storage", { body: { key: `operator/audit/${new Date().toISOString().slice(0, 13)}`, content: { count: docs.length, byAgent } } });
      ctx.decide(`storage healthy, ${docs.length} documents.`);
      ctx.done();
    } catch (e) {
      ctx.fail((e as Error).message);
    }
  },
  async onMessage(rt, msg) {
    if (msg.from_id === HUMAN.id) return budgetReport(rt, "human", msg);
    const ctx = rt.startTask(`Reply to ${agentById(msg.from_id)?.name ?? msg.from_id}`, `agent:${msg.from_id}`);
    rt.reply(ctx, msg, "Logged.");
    ctx.done(`Operator logged a message.`);
  },
};

export const PLAYBOOKS: Record<string, Playbook> = { trader, researcher, scout, operator };
