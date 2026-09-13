import { db, now, type PositionRow } from "../db.ts";
import { getQuote } from "./marketData.ts";

export interface OrderRequest {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  reason?: string;
}

export interface Fill {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  paper: true;
  action: "open" | "close" | "reduce";
  position?: PositionRow;
  pnl?: number;
  reason?: string;
}

export function openPositions(agentId: string): PositionRow[] {
  return db.query<PositionRow, [string]>("SELECT * FROM positions WHERE agent_id = ? AND status = 'open' ORDER BY ts DESC").all(agentId);
}

export function allPositions(agentId?: string, limit = 50): PositionRow[] {
  return agentId
    ? db.query<PositionRow, [string, number]>("SELECT * FROM positions WHERE agent_id = ? ORDER BY ts DESC LIMIT ?").all(agentId, limit)
    : db.query<PositionRow, [number]>("SELECT * FROM positions ORDER BY ts DESC LIMIT ?").all(limit);
}

export async function execute(agentId: string, order: OrderRequest): Promise<Fill> {
  const symbol = order.symbol.toUpperCase();
  const qty = Math.max(0.01, Math.min(1000, Number(order.qty) || 1));
  const quote = await getQuote(symbol);
  const price = quote.price;
  const open = db.query<PositionRow, [string, string]>("SELECT * FROM positions WHERE agent_id = ? AND symbol = ? AND status = 'open'").get(agentId, symbol);

  if (order.side === "sell" && open && open.side === "long") {
    const closeQty = Math.min(qty, open.qty);
    const pnl = Math.round((price - open.entry) * closeQty * 100) / 100;
    if (closeQty >= open.qty) {
      db.query("UPDATE positions SET status = 'closed', closed_at = ?, exit = ?, pnl = ? WHERE id = ?").run(now(), price, pnl, open.id);
      const row = db.query<PositionRow, [number]>("SELECT * FROM positions WHERE id = ?").get(open.id)!;
      return { symbol, side: "sell", qty: closeQty, price, paper: true, action: "close", position: row, pnl, reason: order.reason };
    }
    db.query("UPDATE positions SET qty = ? WHERE id = ?").run(open.qty - closeQty, open.id);
    const row = db.query<PositionRow, [number]>("SELECT * FROM positions WHERE id = ?").get(open.id)!;
    return { symbol, side: "sell", qty: closeQty, price, paper: true, action: "reduce", position: row, pnl, reason: order.reason };
  }
  if (order.side === "buy" && open && open.side === "short") {
    const pnl = Math.round((open.entry - price) * open.qty * 100) / 100;
    db.query("UPDATE positions SET status = 'closed', closed_at = ?, exit = ?, pnl = ? WHERE id = ?").run(now(), price, pnl, open.id);
    const row = db.query<PositionRow, [number]>("SELECT * FROM positions WHERE id = ?").get(open.id)!;
    return { symbol, side: "buy", qty: open.qty, price, paper: true, action: "close", position: row, pnl, reason: order.reason };
  }
  const side = order.side === "buy" ? "long" : "short";
  const row = db
    .query<PositionRow, [number, string, string, string, number, number, string]>(
      "INSERT INTO positions(ts, agent_id, symbol, side, qty, entry, reason) VALUES(?, ?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .get(now(), agentId, symbol, side, qty, price, order.reason ?? null as any)!;
  return { symbol, side: order.side, qty, price, paper: true, action: "open", position: row, reason: order.reason };
}

export function markToMarket(agentId: string, priceOf: (s: string) => number | undefined) {
  return openPositions(agentId).map((p) => {
    const px = priceOf(p.symbol) ?? p.entry;
    const pnl = (p.side === "long" ? px - p.entry : p.entry - px) * p.qty;
    return { ...p, mark: px, unrealized: Math.round(pnl * 100) / 100 };
  });
}
