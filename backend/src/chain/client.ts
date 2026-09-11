import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { env, relayer } from "../env.ts";
import RouterArtifact from "./artifacts/SherwoodRouter.json" with { type: "json" };
import ShosArtifact from "./artifacts/SHOS.json" with { type: "json" };
import StakingArtifact from "./artifacts/SHOSStaking.json" with { type: "json" };

export const routerAbi = RouterArtifact.abi;
export const shosAbi = ShosArtifact.abi;
export const stakingAbi = StakingArtifact.abi;
export const routerBytecode = RouterArtifact.bytecode as `0x${string}`;
export const shosBytecode = ShosArtifact.bytecode as `0x${string}`;
export const stakingBytecode = StakingArtifact.bytecode as `0x${string}`;

export const usdgAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
  { type: "function", name: "isFrozen", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "bool" }] },
] as const;

export const erc20Abi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export interface TokenInfo {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
}

export async function tokenInfo(token: Address): Promise<TokenInfo> {
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "name" }).catch(() => "Sherwood OS"),
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => "SHOS"),
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }).catch(() => 0n),
  ]);
  return { name, symbol, decimals: Number(decimals), totalSupply };
}

export const robinhoodChain = defineChain({
  id: env.chainId,
  name: env.chainMode === "fork" ? "Robinhood Chain (fork)" : "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env.rpcUrl] } },
  blockExplorers: { default: { name: "Blockscout", url: env.explorerUrl } },
});

const transport = () =>
  env.rpcUrls.length > 1
    ? fallback(
        env.rpcUrls.map((u) => http(u, { timeout: 10_000, retryCount: 1 })),
        { rank: { interval: 60_000, sampleCount: 2, timeout: 3_000 } },
      )
    : http(env.rpcUrl, { timeout: 30_000, retryCount: 3 });

export const publicClient: PublicClient = createPublicClient({ chain: robinhoodChain, transport: transport(), pollingInterval: 800 });

export const walletClient: WalletClient = createWalletClient({ account: relayer, chain: robinhoodChain, transport: transport(), pollingInterval: 800 });

export const addresses: { usdg: Address; router?: Address; shos?: Address; staking?: Address; treasury: Address } = {
  usdg: env.usdg,
  router: env.router,
  shos: env.shos,
  staking: env.staking,
  treasury: env.treasury ?? relayer.address,
};

export function requireRouter(): Address {
  if (!addresses.router) throw new Error("router not deployed yet");
  return addresses.router;
}

export async function usdgBalance(a: Address): Promise<bigint> {
  return publicClient.readContract({ address: addresses.usdg, abi: usdgAbi, functionName: "balanceOf", args: [a] });
}

export async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(env.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result as T;
}

export async function waitForRpc(maxMs = 120_000) {
  const start = Date.now();
  for (;;) {
    try {
      const id = await publicClient.getChainId();
      if (id !== env.chainId) throw new Error(`chain id ${id}, expected ${env.chainId}`);
      return;
    } catch (e) {
      if (Date.now() - start > maxMs) throw e;
      await Bun.sleep(1500);
    }
  }
}
