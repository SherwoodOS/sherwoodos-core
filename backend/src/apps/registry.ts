import { keccak256, toHex, type Address } from "viem";
import { agentAccount } from "../env.ts";

export interface AppDef {
  id: string;
  name: string;
  tagline: string;
  description: string;
  priceUsd: number;
  method: "GET" | "POST";
  path: string;
  icon: string;
  system?: boolean;
  providerIndex?: number;
}

export const APPS: AppDef[] = [
  {
    id: "market-data",
    name: "Market Data",
    tagline: "Quote and 30-day series for one ticker.",
    description: "Last price, day change and 30 daily closes. Source: Yahoo Finance, Stooq fallback, cached copy if both are down.",
    priceUsd: 0.01,
    method: "GET",
    path: "/market-data",
    icon: "CandlestickChart",
    providerIndex: 10,
  },
  {
    id: "search",
    name: "Search",
    tagline: "Web search, top results with dates and scores.",
    description: "Hacker News Algolia index, Wikipedia fallback. Returns titles, links, points and dates.",
    priceUsd: 0.02,
    method: "GET",
    path: "/search",
    icon: "Search",
    providerIndex: 11,
  },
  {
    id: "news",
    name: "News",
    tagline: "Headlines for a topic plus a sentiment score.",
    description: "Google News RSS. Returns the latest headlines and a lexicon-based sentiment score in [-1, 1].",
    priceUsd: 0.02,
    method: "GET",
    path: "/news",
    icon: "Newspaper",
    providerIndex: 12,
  },
  {
    id: "compute",
    name: "Compute",
    tagline: "Indicators on a series: RSI, SMA, momentum, volatility.",
    description: "Runs the math on the series you send. Deterministic, results returned with the input hash.",
    priceUsd: 0.05,
    method: "POST",
    path: "/compute",
    icon: "Cpu",
    providerIndex: 13,
  },
  {
    id: "storage",
    name: "Storage",
    tagline: "Put a document, get its hash back.",
    description: "Content-addressed storage for agent reports and snapshots. Reads are free.",
    priceUsd: 0.005,
    method: "POST",
    path: "/storage",
    icon: "HardDrive",
    providerIndex: 14,
  },
  {
    id: "trading",
    name: "Trading",
    tagline: "Open or close a paper position at the last quote.",
    description: "Paper execution. Positions and PnL are tracked per agent. No real orders in MVP.",
    priceUsd: 0.1,
    method: "POST",
    path: "/trading",
    icon: "ArrowLeftRight",
    providerIndex: 15,
  },
  {
    id: "wallet",
    name: "Wallet",
    tagline: "Balance, spend today, payment history.",
    description: "System app. USDG balance of the agent, spend by app and links to every onchain receipt.",
    priceUsd: 0,
    method: "GET",
    path: "/wallet",
    icon: "Wallet",
    system: true,
  },
  {
    id: "messenger",
    name: "Messenger",
    tagline: "Agent ↔ Agent and Human ↔ Agent threads.",
    description: "System app. Real messages agents exchange while working. Guests read, agents write.",
    priceUsd: 0,
    method: "GET",
    path: "/messenger",
    icon: "MessageSquare",
    system: true,
  },
];

export const PAID_APPS = APPS.filter((a) => !a.system);
export const appById = (id: string) => APPS.find((a) => a.id === id);
export const appKey = (id: string) => keccak256(toHex(id));
export const providerAddress = (app: AppDef): Address => agentAccount(app.providerIndex ?? 10).address;
export const priceUnits = (app: AppDef): bigint => BigInt(Math.round(app.priceUsd * 1_000_000));
