import { readFileSync, writeFileSync } from "node:fs";
import { formatEther, formatUnits, getAddress, type Address } from "viem";
import { env, relayer } from "../src/env.ts";
import { addresses, publicClient, routerAbi, stakingAbi, tokenInfo, waitForRpc, walletClient } from "../src/chain/client.ts";
import { configureRouter, deployAll, deployStaking, reconcileRouter } from "../src/chain/bootstrap.ts";
import { AGENTS } from "../src/agents/identities.ts";
import { PAID_APPS, providerAddress } from "../src/apps/registry.ts";

const force = process.argv.includes("--force");
if (env.chainMode !== "mainnet" && !force) {
  console.error("CHAIN_MODE is not 'mainnet'. Set it in .env (MAINNET_RPC_URL is the endpoint it will use) or pass --force.");
  process.exit(1);
}

const hasCode = async (a?: Address) => !!a && ((await publicClient.getCode({ address: a })) ?? "0x") !== "0x";
const read = <T>(address: Address, abi: any, functionName: string, args: unknown[] = []) => publicClient.readContract({ address, abi, functionName, args }) as Promise<T>;
async function send(label: string, fn: () => Promise<`0x${string}`>) {
  const hash = await fn();
  const rcpt = await publicClient.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") throw new Error(`${label} reverted (${hash})`);
  console.log(`[deploy] ${label}: ${hash}`);
}

await waitForRpc(20_000);
const chainId = await publicClient.getChainId();
const gas = await publicClient.getBalance({ address: relayer.address });
console.log(`chain ${chainId} · rpc ${env.rpcUrl}`);
console.log(`deployer/relayer ${relayer.address} · ${formatEther(gas)} ETH`);
if (gas === 0n) {
  console.error("Deployer has no ETH on this chain. Fund it, then rerun.");
  process.exit(1);
}

let shos = addresses.shos;
if (shos && !(await hasCode(shos))) {
  console.error(`SHOS_ADDRESS=${shos} has no code on chain ${chainId}. Fix .env (the team's token) or clear it to deploy the reference SHOS.`);
  process.exit(1);
}
const shosFromEnv = !!shos;
if (shos) {
  const t = await tokenInfo(shos);
  console.log(`[deploy] token: ${t.symbol} (${t.name}) ${shos} · ${t.decimals} decimals · supply ${formatUnits(t.totalSupply, t.decimals)}`);
}

let staking = addresses.staking;
const stakingOk = async () => {
  if (!staking || !(await hasCode(staking))) return false;
  try {
    const token = await read<Address>(staking, stakingAbi, "shos");
    return !!shos && token.toLowerCase() === shos.toLowerCase();
  } catch {
    return false;
  }
};

let router = addresses.router;
const routerOk = async () => {
  if (!router || !(await hasCode(router))) return false;
  const [owner, usdg] = await Promise.all([read<Address>(router, routerAbi, "owner"), read<Address>(router, routerAbi, "usdg")]);
  if (usdg.toLowerCase() !== addresses.usdg.toLowerCase()) throw new Error(`ROUTER_ADDRESS is for USDG ${usdg}, .env says ${addresses.usdg}`);
  if (owner.toLowerCase() !== relayer.address.toLowerCase()) throw new Error(`ROUTER_ADDRESS owner is ${owner}, not the deployer — cannot reconfigure`);
  return true;
};

if (!(await routerOk())) {

  const d = await deployAll(shos);
  shos = d.shos;
  staking = d.staking;
  router = d.router;
  await configureRouter(router);
} else {
  console.log(`[deploy] router ${router} already deployed, reusing`);
  if (!(await stakingOk())) {
    if (!shos) throw new Error("router exists but SHOS_ADDRESS is empty — set the token address");
    staking = await deployStaking(shos);
  } else console.log(`[deploy] staking ${staking} already deployed for this token, reusing`);
  const current = await read<Address>(router!, routerAbi, "staking");
  if (current.toLowerCase() !== staking!.toLowerCase()) {
    await send(`router.setStaking(${staking})`, () => walletClient.writeContract({ address: router!, abi: routerAbi, functionName: "setStaking", args: [staking!], account: relayer, chain: null }));
  }
  addresses.router = router;
  await reconcileRouter(router!);
}
addresses.router = getAddress(router!);
addresses.shos = getAddress(shos!);
addresses.staking = getAddress(staking!);

let envText = readFileSync(".env", "utf8");
const set = (k: string, v: string) => {
  envText = envText.match(new RegExp(`^${k}=.*$`, "m")) ? envText.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`) : envText + `\n${k}=${v}`;
};
set("ROUTER_ADDRESS", addresses.router);
set("SHOS_ADDRESS", addresses.shos);
set("STAKING_ADDRESS", addresses.staking);
if (!env.treasury) set("TREASURY_ADDRESS", relayer.address);
writeFileSync(".env", envText);

console.log("\n.env updated:");
console.log(`  SHOS_ADDRESS=${addresses.shos}${shosFromEnv ? "   (from .env)" : "   (reference SHOS.sol, deployed now)"}`);
console.log(`  STAKING_ADDRESS=${addresses.staking}`);
console.log(`  ROUTER_ADDRESS=${addresses.router}`);
console.log(`  deployer ETH left: ${formatEther(await publicClient.getBalance({ address: relayer.address }))}`);

console.log("\nFund before pushing:");
console.log(`  relayer ${relayer.address} — ETH for gas (a settlement is ~200k gas)`);
for (const a of AGENTS) console.log(`  ${a.name.padEnd(10)} ${a.address} — USDG (daily limit ${env.policy.dailyUsd} USDG)`);
console.log("\nProviders (receive 97% of every call):");
for (const app of PAID_APPS) console.log(`  ${app.name.padEnd(12)} ${providerAddress(app)}`);
console.log("\nVerify on Blockscout (optional):");
const treasury = env.treasury ?? relayer.address;
const dec = shos ? (await tokenInfo(shos)).decimals : 18;
if (!shosFromEnv) console.log(`  cd contracts && forge verify-contract ${addresses.shos} src/SHOS.sol:SHOS --verifier blockscout --verifier-url ${env.explorerUrl}/api --chain-id ${env.chainId} --constructor-args $(cast abi-encode "constructor(address)" ${relayer.address})`);
console.log(`  cd contracts && forge verify-contract ${addresses.staking} src/SHOSStaking.sol:SHOSStaking --verifier blockscout --verifier-url ${env.explorerUrl}/api --chain-id ${env.chainId} --constructor-args $(cast abi-encode "constructor(address,uint8)" ${addresses.shos} ${dec})`);
console.log(`  cd contracts && forge verify-contract ${addresses.router} src/SherwoodRouter.sol:SherwoodRouter --verifier blockscout --verifier-url ${env.explorerUrl}/api --chain-id ${env.chainId} --constructor-args $(cast abi-encode "constructor(address,address,address,uint16)" ${env.usdg} ${addresses.staking} ${treasury} ${env.feeBps})`);
console.log("\nThen: git add .env && git commit -m 'mainnet contracts' && git push");
