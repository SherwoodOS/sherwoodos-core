import { createHash } from "node:crypto";

export interface ComputeRequest {
  series: number[];
  indicators?: string[];
}

export interface ComputeResult {
  inputHash: string;
  n: number;
  last: number;
  rsi14?: number;
  sma20?: number;
  sma5?: number;
  momentum5?: number;
  volatility?: number;
  drawdown?: number;
  signal: "bullish" | "bearish" | "neutral";
}

export function rsi(series: number[], period = 14): number | undefined {
  if (series.length <= period) return undefined;
  let gains = 0;
  let losses = 0;
  for (let i = series.length - period; i < series.length; i++) {
    const d = series[i] - series[i - 1];
    if (d > 0) gains += d;
    else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = gains / period / (losses / period);
  return Math.round((100 - 100 / (1 + rs)) * 10) / 10;
}

export const sma = (s: number[], n: number) => (s.length >= n ? Math.round((s.slice(-n).reduce((a, b) => a + b, 0) / n) * 100) / 100 : undefined);

export function compute(req: ComputeRequest): ComputeResult {
  const series = (req.series ?? []).filter((x) => typeof x === "number" && Number.isFinite(x)).slice(-200);
  if (series.length < 2) throw new Error("series needs at least 2 points");
  const inputHash = createHash("sha256").update(JSON.stringify(series)).digest("hex").slice(0, 16);
  const last = series.at(-1)!;
  const r = rsi(series);
  const s20 = sma(series, 20);
  const s5 = sma(series, 5);
  const mom = series.length > 5 ? Math.round(((last - series.at(-6)!) / series.at(-6)!) * 10000) / 100 : undefined;
  const rets = series.slice(1).map((v, i) => (v - series[i]) / series[i]);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.round(Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length) * 10000) / 100;
  let peak = series[0];
  let dd = 0;
  for (const v of series) {
    if (v > peak) peak = v;
    dd = Math.min(dd, (v - peak) / peak);
  }
  let score = 0;
  if (r !== undefined) score += r > 70 ? -1 : r < 30 ? 1 : 0;
  if (s20 !== undefined) score += last > s20 ? 1 : -1;
  if (mom !== undefined) score += mom > 2 ? 1 : mom < -2 ? -1 : 0;
  const signal = score >= 2 ? "bullish" : score <= -2 ? "bearish" : "neutral";
  return { inputHash, n: series.length, last, rsi14: r, sma20: s20, sma5: s5, momentum5: mom, volatility: vol, drawdown: Math.round(dd * 10000) / 100, signal };
}
