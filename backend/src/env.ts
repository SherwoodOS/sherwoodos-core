import { mnemonicToAccount, privateKeyToAccount, type HDAccount, type PrivateKeyAccount } from "viem/accounts";
import { getAddress, isAddress, type Address, type Hex } from "viem";

function str(key: string, fallback = ""): string {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
}
function num(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && process.env[key] !== "" && process.env[key] !== undefined ? v : fallback;
}
function addr(key: string): Address | undefined {
  const v = str(key);
  if (!isAddress(v) || /^0x0{40}$/.test(v)) return undefined;
  return getAddress(v);
}

export const usd = (n: number): bigint => BigInt(Math.round(n * 1_000_000));

export type ChainMode = "fork" | "mainnet";

const chainMode = (str("CHAIN_MODE", "fork") === "mainnet" ? "mainnet" : "fork") as ChainMode;
const privateKey = str("PRIVATE_KEY") as Hex;
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("PRIVATE_KEY missing or malformed (expected 0x + 64 hex)");
const mnemonic = str("AGENT_MNEMONIC").replace(/^"|"$/g, "");
if (mnemonic.split(/\s+/).length < 12) throw new Error("AGENT_MNEMONIC missing (12+ words)");

export const relayer: PrivateKeyAccount = privateKeyToAccount(privateKey);
export const agentAccount = (index: number): HDAccount => mnemonicToAccount(mnemonic, { addressIndex: index });

export const env = {
  chainMode,
  chainId: num("CHAIN_ID", 4663),

  rpcUrl: (chainMode === "fork" ? str("RPC_URL", "http://127.0.0.1:8663") : str("MAINNET_RPC_URL", "https://rpc.mainnet.chain.robinhood.com")).split(",")[0].trim(),

  rpcUrls: (chainMode === "fork" ? str("RPC_URL", "http://127.0.0.1:8663") : str("MAINNET_RPC_URL", "https://rpc.mainnet.chain.robinhood.com"))
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean),
  forkRpcUrl: str("FORK_RPC_URL", "https://rpc.mainnet.chain.robinhood.com"),
  explorerUrl: str("EXPLORER_URL", "https://robinhoodchain.blockscout.com").replace(/\/$/, ""),
  usdg: addr("USDG_ADDRESS") ?? ("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address),
  router: addr("ROUTER_ADDRESS"),
  shos: addr("SHOS_ADDRESS"),
  staking: addr("STAKING_ADDRESS"),
  treasury: addr("TREASURY_ADDRESS"),
  feeBps: num("PLATFORM_FEE_BPS", 300),
  port: num("PORT", num("APP_PORT", 3000)),
  dataDir: str("DATA_DIR", process.env.DATABASE_URL ? "/data" : "./data"),
  databaseUrl: str("DATABASE_URL"),
  siteUrl: str("SITE_URL").replace(/\/$/, ""),
  policy: {
    dailyUsd: num("AGENT_DAILY_LIMIT_USD", 5),
    perRequestUsd: num("AGENT_PER_REQUEST_MAX_USD", 0.25),
    perAppDailyUsd: num("AGENT_PER_APP_DAILY_USD", 2),
    fundUsd: num("AGENT_FUND_USD", 25),
    taskIntervalSec: num("AGENT_TASK_INTERVAL_SEC", 150),
  },
  links: {
    x: str("X_URL", "https://x.com/SherwoodOSrh"),
    xHandle: str("X_HANDLE", "SherwoodOSrh"),
    telegram: str("TELEGRAM_URL"),
    github: str("GITHUB_URL"),
  },
  isDev: process.env.NODE_ENV !== "production",
};

export const isFork = env.chainMode === "fork";
