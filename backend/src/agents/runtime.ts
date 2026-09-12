import { formatUnits } from "viem";
import { env, usd } from "../env.ts";
import { bus, type AgentStatus } from "../bus.ts";
import { db, now, threadId, type ActivityRow, type MessageRow, type TaskRow } from "../db.ts";
import { AGENTS, HUMAN, agentById, displayName, type AgentDef } from "./identities.ts";
import { appById, type AppDef } from "../apps/registry.ts";
import { payFetch, PaymentRefused } from "../x402/client.ts";
import { usdgBalance, publicClient, routerAbi, addresses } from "../chain/client.ts";
import { currentEpoch } from "../chain/bootstrap.ts";

export const fmtUsd = (units: number | bigint | string) => `$${Number(formatUnits(BigInt(units), 6)).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;

const sleep = (ms: number) => Bun.sleep(ms);
const jitter = (ms: number, pct = 0.4) => ms * (1 - pct + Math.random() * 2 * pct);
export const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

export interface CallResult<T = any> {
  ok: boolean;
  data: T;
  paid?: { amount: number; fee: number; txHash: string; receiptId: string };
  refused?: string;
}

export class TaskCtx {
  readonly id: string;
  readonly startedAt = now();
  calls = 0;
  spent = 0;
  contacted = new Set<string>();
  trades = 0;

  replyTo?: { threadId: string; fromId: string };

  constructor(
    readonly rt: AgentRuntime,
    readonly title: string,
    readonly origin: string,
  ) {
    this.id = `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    db.query("INSERT INTO tasks(id, agent_id, title, origin, status, started_at) VALUES(?, ?, ?, ?, 'running', ?)").run(
      this.id,
      rt.def.id,
      title,
      origin,
      this.startedAt,
    );
    rt.setStatus("THINKING", title, this.id);
    this.log("task", `${rt.def.name} started a task.`, { title, origin });
  }

  get agent() {
    return this.rt.def;
  }

  log(kind: ActivityRow["kind"], title: string, detail?: unknown, extra: Partial<Pick<ActivityRow, "app_id" | "amount" | "tx_hash" | "receipt_id">> = {}) {
    const row = db
      .query(
        `INSERT INTO activity(ts, agent_id, task_id, kind, app_id, title, detail, amount, tx_hash, receipt_id, epoch)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(now(), this.rt.def.id, this.id, kind, extra.app_id ?? null, title, detail === undefined ? null : JSON.stringify(detail), extra.amount ?? null, extra.tx_hash ?? null, extra.receipt_id ?? null, currentEpoch()) as ActivityRow;
    bus.emit({ type: "activity", data: row });
    return row;
  }

  status(s: AgentStatus) {
    this.rt.setStatus(s, this.title, this.id);
  }

  async think(ms = 2200) {
    this.status("THINKING");
    await sleep(jitter(ms));
  }

  async call<T = any>(appId: string, opts: { query?: Record<string, string>; body?: unknown } = {}): Promise<CallResult<T>> {
    const app = appById(appId);
    if (!app || app.system) throw new Error(`unknown paid app ${appId}`);
    this.status("WORKING");
    this.log("request", `${app.name} opened.`, { app: app.id, query: opts.query, body: summarizeBody(opts.body) }, { app_id: app.id });
    await sleep(jitter(900));

    const url = new URL(`http://127.0.0.1:${env.port}/x402${app.path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const init: RequestInit & { taskId?: string } = {
      method: app.method,
      taskId: this.id,
      headers: opts.body ? { "content-type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    };

    try {
      const res = await payFetch<T>(this.rt.def.account, url.toString(), init, {
        onRequirements: async (req) => {
          this.log("request", `${app.name} requested ${fmtUsd(req.maxAmountRequired)}.`, { price: req.extra.price, fee: req.extra.fee, payTo: req.payTo }, { app_id: app.id, amount: Number(req.maxAmountRequired) });
          this.status("PAYING");
          await sleep(jitter(600));
        },
      });
      if (res.payment?.success) {
        const amount = Number(res.payment.amount ?? 0);
        const fee = Number(res.payment.fee ?? 0);
        this.calls += 1;
        this.spent += amount;
        this.log("payment", `${fmtUsd(amount)} paid. Payment settled.`, { app: app.id, txHash: res.payment.transaction, receiptId: res.payment.receiptId, receiptNo: res.payment.receiptNo, block: res.payment.blockNumber, fee }, {
          app_id: app.id,
          amount,
          tx_hash: res.payment.transaction ?? null,
          receipt_id: res.payment.receiptId ?? null,
        });
        if (this.replyTo) {
          this.rt.postMessage(this.replyTo.threadId, this.rt.def.id, this.replyTo.fromId, "payment", `${this.rt.def.name} → ${app.name}: paid ${fmtUsd(amount)}`, {
            taskId: this.id,
            meta: { app: app.id, amount, txHash: res.payment.transaction, receiptId: res.payment.receiptId },
          });
        }
        void this.rt.refreshBalance();
        this.status("WORKING");
        const d = res.data as any;
        this.log("response", responseLine(app, d), { app: app.id, ok: d?.ok !== false, summary: summarizeResponse(app, d) }, { app_id: app.id });
        return {
          ok: d?.ok !== false,
          data: res.data,
          paid: { amount, fee, txHash: res.payment.transaction!, receiptId: res.payment.receiptId! },
        };
      }
      const d = res.data as any;
      this.log("response", responseLine(app, d), { app: app.id }, { app_id: app.id });
      return { ok: d?.ok !== false, data: res.data };
    } catch (e) {
      const reason = e instanceof PaymentRefused ? e.reason : (e as Error).message;
      this.log("system", `${app.name}: payment refused (${reason}).`, { app: app.id, reason }, { app_id: app.id });
      this.status("WORKING");
      return { ok: false, data: undefined as T, refused: reason };
    }
  }

  say(toId: string, text: string, meta?: unknown) {
    const tid = threadId(this.rt.def.id, toId);
    const row = this.rt.postMessage(tid, this.rt.def.id, toId, "text", text, { taskId: this.id, meta });
    if (toId !== HUMAN.id) this.contacted.add(toId);
    this.log("message", `${this.rt.def.name} → ${displayName(toId)}: ${text}`, { to: toId, messageId: row.id });
    if (toId !== HUMAN.id) agentRuntime(toId)?.inbox.push(row);
    return row;
  }

  async ask(toId: string, text: string, timeoutMs = 120_000): Promise<MessageRow | undefined> {
    const sent = this.say(toId, text);
    this.status("WAITING");
    this.log("status", `${this.rt.def.name} is waiting for ${displayName(toId)}.`, { to: toId });
    const reply = await this.rt.waitForReply(sent.id, timeoutMs);
    if (!reply) this.log("system", `No reply from ${displayName(toId)} in ${Math.round(timeoutMs / 1000)}s.`);
    this.status("WORKING");
    return reply;
  }

  decide(text: string, detail?: unknown) {
    this.log("decision", `Decision made: ${text}`, detail);
  }

  execution(text: string, detail?: unknown) {
    this.trades += 1;
    this.log("execution", text, detail);
  }

  done(summary?: string) {
    const secs = Math.max(1, Math.round((now() - this.startedAt) / 1000));
    const line =
      summary ??
      `${this.rt.def.name} finished in ${fmtDuration(secs)}: ${this.calls} paid request${this.calls === 1 ? "" : "s"}, ${fmtUsd(this.spent)} spent, ${this.contacted.size} agent${this.contacted.size === 1 ? "" : "s"} contacted, ${this.trades} trade${this.trades === 1 ? "" : "s"}.`;
    db.query("UPDATE tasks SET status = 'done', finished_at = ?, calls = ?, spent = ?, contacted = ?, trades = ?, summary = ? WHERE id = ?").run(
      now(),
      this.calls,
      this.spent,
      this.contacted.size,
      this.trades,
      line,
      this.id,
    );
    this.log("task", line, { calls: this.calls, spent: this.spent, contacted: [...this.contacted], trades: this.trades, seconds: secs });
    this.rt.setStatus("IDLE", null, null);
  }

  fail(reason: string) {
    db.query("UPDATE tasks SET status = 'failed', finished_at = ?, calls = ?, spent = ?, summary = ? WHERE id = ?").run(now(), this.calls, this.spent, reason, this.id);
    this.log("system", `Task stopped: ${reason}`);
    this.rt.setStatus("IDLE", null, null);
  }
}

export type Playbook = {
  scheduled: (rt: AgentRuntime) => Promise<void>;
  onMessage: (rt: AgentRuntime, msg: MessageRow) => Promise<void>;
};

const MIN_BALANCE = usd(0.05);

const runtimes = new Map<string, AgentRuntime>();
export const agentRuntime = (id: string) => runtimes.get(id);
export const allRuntimes = () => [...runtimes.values()];

export class AgentRuntime {
  status: AgentStatus = "IDLE";
  task: string | null = null;
  taskId: string | null = null;
  inbox: MessageRow[] = [];
  balance = 0n;
  private waiters = new Map<number, (m: MessageRow) => void>();
  private nextScheduled = 0;
  private running = false;
  private pacingNoted = false;
  private fundsNoted = false;
  lastPace = 0;
  lastDayPct = 0;

  async aheadOfBudget(): Promise<boolean> {
    try {
      const spent = await this.spentToday();
      const limit = BigInt(Math.round(env.policy.dailyUsd * 1_000_000));
      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayPct = ((now() - dayStart.getTime()) / 86_400_000) * 100;
      const pace = limit > 0n ? Number((spent * 100n) / limit) : 0;
      this.lastPace = pace;
      this.lastDayPct = Math.round(dayPct);
      return pace > dayPct + 12;
    } catch {
      return false;
    }
  }

  async unfunded(): Promise<boolean> {
    await this.refreshBalance();
    const dry = this.balance < MIN_BALANCE;
    if (!dry && this.fundsNoted) {
      this.fundsNoted = false;
      this.note(`${this.def.name} is funded again: ${fmtUsd(this.balance)} USDG. Back to work.`);
      this.setStatus("IDLE", null, null);
    }
    return dry;
  }

  private declineForFunds(msg: MessageRow) {
    const text = `${this.def.name} is out of USDG (${fmtUsd(this.balance)}). Can't take paid work until the wallet is topped up.`;
    const row = this.postMessage(msg.thread_id, this.def.id, msg.from_id, "text", text, { meta: { replyTo: msg.id, unfunded: true } });
    agentRuntime(msg.from_id)?.resolveReply(msg.id, row);
    if (!this.fundsNoted) this.noteUnfunded();
  }

  private noteUnfunded() {
    this.fundsNoted = true;
    this.note(`${this.def.name} is waiting for a USDG top-up: wallet ${this.def.address} holds ${fmtUsd(this.balance)}.`);
    this.setStatus("IDLE", "waiting for a USDG top-up", null);
  }

  note(text: string) {
    const row = db
      .query("INSERT INTO activity(ts, agent_id, task_id, kind, app_id, title, detail, epoch) VALUES(?, ?, NULL, 'status', NULL, ?, NULL, ?) RETURNING *")
      .get(now(), this.def.id, text, currentEpoch()) as ActivityRow;
    bus.emit({ type: "activity", data: row });
  }

  constructor(
    readonly def: AgentDef,
    readonly playbook: Playbook,
  ) {
    runtimes.set(def.id, this);
    db.query(
      `INSERT INTO agents(id, name, role, address, status, created_at) VALUES(?, ?, ?, ?, 'IDLE', ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role, address = excluded.address, status = 'IDLE', task = NULL, task_id = NULL`,
    ).run(def.id, def.name, def.role, def.address, now());
  }

  setStatus(status: AgentStatus, task: string | null, taskId: string | null) {
    this.status = status;
    this.task = task;
    this.taskId = taskId;
    db.query("UPDATE agents SET status = ?, task = ?, task_id = ? WHERE id = ?").run(status, task, taskId, this.def.id);
    bus.emit({ type: "status", data: { agentId: this.def.id, status, task, taskId } });
  }

  postMessage(tid: string, fromId: string, toId: string, kind: string, text: string, o: { taskId?: string; meta?: unknown; paymentId?: number } = {}) {
    const row = db
      .query("INSERT INTO messages(ts, thread_id, from_id, to_id, kind, text, task_id, payment_id, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *")
      .get(now(), tid, fromId, toId, kind, text, o.taskId ?? null, o.paymentId ?? null, o.meta === undefined ? null : JSON.stringify(o.meta)) as MessageRow;
    bus.emit({ type: "message", data: row });
    return row;
  }

  reply(ctx: TaskCtx, original: MessageRow, text: string, meta?: unknown) {
    const row = this.postMessage(original.thread_id, this.def.id, original.from_id, "text", text, { taskId: ctx.id, meta: { ...(meta as object), replyTo: original.id } });
    ctx.log("message", `${this.def.name} → ${displayName(original.from_id)}: ${text}`, { to: original.from_id, messageId: row.id, replyTo: original.id });
    const target = agentRuntime(original.from_id);
    target?.resolveReply(original.id, row);
    return row;
  }

  waitForReply(messageId: number, timeoutMs: number): Promise<MessageRow | undefined> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiters.delete(messageId);
        resolve(undefined);
      }, timeoutMs);
      this.waiters.set(messageId, (m) => {
        clearTimeout(t);
        this.waiters.delete(messageId);
        resolve(m);
      });
    });
  }

  resolveReply(messageId: number, m: MessageRow) {
    this.waiters.get(messageId)?.(m);
  }

  async refreshBalance() {
    try {
      this.balance = await usdgBalance(this.def.address);
      const spent = await this.spentToday();
      bus.emit({ type: "balance", data: { agentId: this.def.id, balance: this.balance.toString(), spentToday: spent.toString() } });
    } catch {

    }
  }

  async spentToday(): Promise<bigint> {
    if (!addresses.router) return 0n;
    const remaining = (await publicClient.readContract({ address: addresses.router, abi: routerAbi, functionName: "remainingToday", args: [this.def.address] })) as bigint;
    const limit = BigInt(Math.round(env.policy.dailyUsd * 1_000_000));
    return limit > remaining ? limit - remaining : 0n;
  }

  start(delayMs: number) {
    if (this.running) return;
    this.running = true;
    this.nextScheduled = now() + delayMs;
    void this.refreshBalance();
    void this.loop();
  }

  stop() {
    this.running = false;
  }

  private async loop() {
    while (this.running) {
      try {
        const msg = this.inbox.shift();
        if (msg) {
          if (await this.unfunded()) {
            this.declineForFunds(msg);
            continue;
          }
          await this.playbook.onMessage(this, msg);
          continue;
        }
        if (now() >= this.nextScheduled) {
          this.nextScheduled = now() + jitter(env.policy.taskIntervalSec * 1000);
          if (await this.unfunded()) {
            if (!this.fundsNoted) this.noteUnfunded();
            continue;
          }
          if (await this.aheadOfBudget()) {

            if (!this.pacingNoted) {
              this.pacingNoted = true;
              this.note(`${this.def.name} is pacing: ${this.lastPace}% of the daily budget used at ${this.lastDayPct}% of the day.`);
            }
            continue;
          }
          this.pacingNoted = false;
          await this.playbook.scheduled(this);
          continue;
        }
      } catch (e) {
        console.error(`[agent:${this.def.id}]`, e);
        this.setStatus("IDLE", null, null);
        await sleep(5000);
      }
      await sleep(1000);
    }
  }

  startTask(title: string, origin: string) {
    return new TaskCtx(this, title, origin);
  }
}

function responseLine(app: AppDef, d: any): string {
  if (!d || d.ok === false) return `${app.name}: no result (${d?.error ?? "empty"}).`;
  switch (app.id) {
    case "market-data":
      return `Quote received: ${d.symbol} ${fmtPx(d.price)} (${fmtPct(d.changePct)})${d.stale ? ", cached" : ""}.`;
    case "search":
      return `Search results received: ${d.hits?.length ?? 0} for "${d.query}".`;
    case "news":
      return `News received: ${d.headlines?.length ?? 0} headlines, sentiment ${fmtSigned(d.sentiment)}.`;
    case "compute":
      return `Compute finished: RSI ${d.rsi14 ?? "—"}, momentum ${fmtPct(d.momentum5)}, ${d.signal}.`;
    case "storage":
      return `Stored ${d.size} bytes, sha256 ${String(d.sha256).slice(0, 10)}….`;
    case "trading":
      return `Fill: ${d.side} ${d.qty} ${d.symbol} @ ${fmtPx(d.price)} (paper, ${d.action}).`;
    default:
      return `${app.name}: response received.`;
  }
}

function summarizeResponse(app: AppDef, d: any) {
  if (!d) return undefined;
  switch (app.id) {
    case "market-data":
      return { symbol: d.symbol, price: d.price, changePct: d.changePct, source: d.source, points: d.series?.length };
    case "search":
      return { query: d.query, hits: (d.hits ?? []).slice(0, 3).map((h: any) => h.title) };
    case "news":
      return { query: d.query, sentiment: d.sentiment, headlines: (d.headlines ?? []).slice(0, 3).map((h: any) => h.title) };
    case "compute":
      return { rsi14: d.rsi14, sma20: d.sma20, momentum5: d.momentum5, volatility: d.volatility, signal: d.signal };
    case "storage":
      return { key: d.key, sha256: d.sha256, size: d.size };
    case "trading":
      return { symbol: d.symbol, side: d.side, qty: d.qty, price: d.price, action: d.action, pnl: d.pnl };
  }
}

function summarizeBody(b: unknown) {
  if (!b || typeof b !== "object") return b;
  const o = b as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = Array.isArray(v) ? `[${v.length} items]` : typeof v === "string" && v.length > 80 ? v.slice(0, 80) + "…" : v;
  return out;
}

export const fmtPx = (n?: number) => (typeof n === "number" ? (n >= 100 ? n.toFixed(2) : n.toFixed(2)) : "—");
export const fmtPct = (n?: number) => (typeof n === "number" ? `${n >= 0 ? "+" : ""}${n.toFixed(2)}%` : "—");
export const fmtSigned = (n?: number) => (typeof n === "number" ? `${n > 0 ? "+" : ""}${n.toFixed(2)}` : "—");
export function fmtDuration(secs: number) {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}
export { AGENTS, agentById };
