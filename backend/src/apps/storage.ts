import { createHash } from "node:crypto";
import { db, now } from "../db.ts";

export interface StoredDoc {
  key: string;
  sha256: string;
  size: number;
  ts: number;
  agentId: string;
  uri: string;
}

export function putDocument(agentId: string, key: string, content: unknown): StoredDoc {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  if (text.length > 64_000) throw new Error("document too large (64KB max)");
  const sha = createHash("sha256").update(text).digest("hex");
  const k = (key || sha.slice(0, 12)).replace(/[^a-zA-Z0-9._:/-]/g, "").slice(0, 120);
  db.query(
    `INSERT INTO storage(key, agent_id, ts, sha256, size, content) VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET agent_id = excluded.agent_id, ts = excluded.ts, sha256 = excluded.sha256, size = excluded.size, content = excluded.content`,
  ).run(k, agentId, now(), sha, text.length, text);
  return { key: k, sha256: sha, size: text.length, ts: now(), agentId, uri: `sherwood://storage/${k}` };
}

export function getDocument(key: string) {
  return db.query<{ key: string; agent_id: string; ts: number; sha256: string; size: number; content: string }, [string]>("SELECT * FROM storage WHERE key = ?").get(key);
}

export function listDocuments(agentId?: string, limit = 50) {
  return agentId
    ? db.query("SELECT key, agent_id, ts, sha256, size FROM storage WHERE agent_id = ? ORDER BY ts DESC LIMIT ?").all(agentId, limit)
    : db.query("SELECT key, agent_id, ts, sha256, size FROM storage ORDER BY ts DESC LIMIT ?").all(limit);
}
