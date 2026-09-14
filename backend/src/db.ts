import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "./env.ts";

const file = env.databaseUrl ? env.databaseUrl.replace(/^file:/, "") : `${env.dataDir}/app.db`;
mkdirSync(dirname(file), { recursive: true });

export const db = new Database(file, { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'IDLE',
  task TEXT,
  task_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  origin TEXT NOT NULL,            -- schedule | agent:<id> | human
  status TEXT NOT NULL,            -- running | done | failed
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  calls INTEGER NOT NULL DEFAULT 0,
  spent INTEGER NOT NULL DEFAULT 0,  -- USDG units
  contacted INTEGER NOT NULL DEFAULT 0,
  trades INTEGER NOT NULL DEFAULT 0,
  summary TEXT
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL,              -- task | request | payment | response | message | decision | execution | status | system
  app_id TEXT,
  title TEXT NOT NULL,
  detail TEXT,                     -- JSON
  amount INTEGER,                  -- USDG units (payments)
  tx_hash TEXT,
  receipt_id TEXT,
  epoch INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS activity_ts ON activity(ts DESC);
CREATE INDEX IF NOT EXISTS activity_agent ON activity(agent_id, ts DESC);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  app_id TEXT NOT NULL,
  amount INTEGER NOT NULL,         -- total paid, USDG units
  fee INTEGER NOT NULL,
  provider TEXT NOT NULL,
  payer TEXT NOT NULL,
  nonce TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  receipt_no INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  resource TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS payments_ts ON payments(ts DESC);
CREATE INDEX IF NOT EXISTS payments_agent ON payments(agent_id, ts DESC);
CREATE INDEX IF NOT EXISTS payments_app ON payments(app_id, ts DESC);
CREATE UNIQUE INDEX IF NOT EXISTS payments_tx ON payments(tx_hash);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  thread_id TEXT NOT NULL,         -- sorted pair "a|b"
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- text | payment | task
  text TEXT NOT NULL,
  task_id TEXT,
  payment_id INTEGER,
  meta TEXT                        -- JSON
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, ts DESC);
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,              -- long | short
  qty REAL NOT NULL,
  entry REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  closed_at INTEGER,
  exit REAL,
  pnl REAL,
  reason TEXT
);
CREATE TABLE IF NOT EXISTS storage (
  key TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  content TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quotes (
  symbol TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  price REAL NOT NULL,
  change_pct REAL NOT NULL,
  series TEXT NOT NULL,            -- JSON number[] (closes)
  source TEXT NOT NULL
);
`);

export const settings = {
  get(key: string): string | undefined {
    const row = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key);
    return row?.value;
  },
  set(key: string, value: string) {
    db.query("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  },
};

export const now = () => Date.now();

export interface AgentRow {
  id: string;
  name: string;
  role: string;
  address: string;
  status: string;
  task: string | null;
  task_id: string | null;
  created_at: number;
}
export interface TaskRow {
  id: string;
  agent_id: string;
  title: string;
  origin: string;
  status: string;
  started_at: number;
  finished_at: number | null;
  calls: number;
  spent: number;
  contacted: number;
  trades: number;
  summary: string | null;
}
export interface ActivityRow {
  id: number;
  ts: number;
  agent_id: string;
  task_id: string | null;
  kind: string;
  app_id: string | null;
  title: string;
  detail: string | null;
  amount: number | null;
  tx_hash: string | null;
  receipt_id: string | null;
  epoch: number;
}
export interface PaymentRow {
  id: number;
  ts: number;
  agent_id: string;
  task_id: string | null;
  app_id: string;
  amount: number;
  fee: number;
  provider: string;
  payer: string;
  nonce: string;
  tx_hash: string;
  receipt_id: string;
  receipt_no: number;
  block_number: number;
  resource: string;
  epoch: number;
}
export interface MessageRow {
  id: number;
  ts: number;
  thread_id: string;
  from_id: string;
  to_id: string;
  kind: string;
  text: string;
  task_id: string | null;
  payment_id: number | null;
  meta: string | null;
}
export interface PositionRow {
  id: number;
  ts: number;
  agent_id: string;
  symbol: string;
  side: string;
  qty: number;
  entry: number;
  status: string;
  closed_at: number | null;
  exit: number | null;
  pnl: number | null;
  reason: string | null;
}
export interface QuoteRow {
  symbol: string;
  ts: number;
  price: number;
  change_pct: number;
  series: string;
  source: string;
}

export const threadId = (a: string, b: string) => [a, b].sort().join("|");
