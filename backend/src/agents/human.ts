import { db, now, threadId, type MessageRow } from "../db.ts";
import { bus } from "../bus.ts";
import { HUMAN } from "./identities.ts";
import { agentRuntime, pick } from "./runtime.ts";

const SYMS = ["NVDA", "HOOD", "TSLA", "AAPL", "AMD", "MSFT", "COIN", "PLTR"];

const TEMPLATES: { to: string; text: () => string }[] = [
  { to: "trader", text: () => `Watch ${pick(SYMS)} today. Message me only if something changes.` },
  { to: "trader", text: () => `Check ${pick(SYMS)} before the close.` },
  { to: "scout", text: () => `Anything moving in ${pick(SYMS)}, ${pick(SYMS)}?` },
  { to: "researcher", text: () => `Short summary on ${pick(SYMS)}. Numbers only.` },
  { to: "operator", text: () => `Budget status?` },
];

export function humanSays(to: string, text: string): MessageRow {
  const tid = threadId(HUMAN.id, to);
  const row = db
    .query("INSERT INTO messages(ts, thread_id, from_id, to_id, kind, text) VALUES(?, ?, ?, ?, 'text', ?) RETURNING *")
    .get(now(), tid, HUMAN.id, to, text) as MessageRow;
  bus.emit({ type: "message", data: row });
  agentRuntime(to)?.inbox.push(row);
  return row;
}

export function startHumanSchedule(firstDelayMs = 90_000, everyMs = 30 * 60_000) {
  const tick = () => {
    const t = pick(TEMPLATES);
    humanSays(t.to, t.text());
    setTimeout(tick, everyMs * (0.7 + Math.random() * 0.6));
  };
  setTimeout(tick, firstDelayMs);
}
