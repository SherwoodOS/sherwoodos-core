import { encodeAbiParameters, getAddress, keccak256, parseEther, toHex, type Address, type Hex } from "viem";
import { env, isFork, relayer, usd } from "../env.ts";
import { db, settings } from "../db.ts";
import { PAID_APPS, appKey, priceUnits, providerAddress } from "../apps/registry.ts";
import {
  addresses,
  publicClient,
  routerAbi,
  routerBytecode,
  rpc,
  shosAbi,
  shosBytecode,
  stakingAbi,
  stakingBytecode,
  tokenInfo,
  usdgBalance,
  waitForRpc,
  walletClient,
} from "./client.ts";
import { AGENTS } from "../agents/identities.ts";

const log = (...a: unknown[]) => console.log("[chain]", ...a);

export const chainState: { ready: boolean; error?: string; attempts: number; since: number } = { ready: false, attempts: 0, since: Date.now() };

async function hasCode(a?: Address) {
  if (!a) return false;
  const code = await publicClient.getCode({ address: a });
  return !!code && code !== "0x";
}

async function deploy(abi: any, bytecode: Hex, args: unknown[]): Promise<Address> {
  const hash = await walletClient.deployContract({ abi, bytecode, args, account: relayer, chain: null });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash });
  if (!rcpt.contractAddress) throw new Error("deploy failed");
  return getAddress(rcpt.contractAddress);
}

async function write(address: Address, abi: any, functionName: string, args: unknown[]) {
  const hash = await walletClient.writeContract({ address, abi, functionName, args, account: relayer, chain: null });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") throw new Error(`${functionName} reverted`);
  return hash;
}

export async function forkFundUsdg(who: Address, amount: bigint) {
  const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [who, 1n]));
  await rpc("anvil_setStorageAt", [addresses.usdg, slot, toHex(amount, { size: 32 })]);
}

export async function deployStaking(shos: Address): Promise<Address> {
  const { decimals } = await tokenInfo(shos);
  const staking = await deploy(stakingAbi, stakingBytecode, [shos, decimals]);
  log(`SHOSStaking ${staking} (token ${shos}, ${decimals} decimals)`);
  return staking;
}

export async function deployAll(existingShos?: Address): Promise<{ shos: Address; staking: Address; router: Address }> {
  const treasury = addresses.treasury;
  let shos = existingShos;
  if (!shos) {
    log("deploying SHOS…");
    shos = await deploy(shosAbi, shosBytecode, [relayer.address]);
    log("SHOS", shos);
  }
  const staking = await deployStaking(shos);
  const router = await deploy(routerAbi, routerBytecode, [addresses.usdg, staking, treasury, env.feeBps]);
  log("SherwoodRouter", router);
  return { shos, staking, router };
}

export async function configureRouter(router: Address) {
  for (const app of PAID_APPS) {
    await write(router, routerAbi, "setApp", [appKey(app.id), app.name, providerAddress(app), priceUnits(app), true]);
  }
  for (const agent of AGENTS) {
    await write(router, routerAbi, "setPolicy", [
      agent.address,
      relayer.address,
      usd(env.policy.dailyUsd),
      usd(env.policy.perRequestUsd),
      true,
    ]);
    for (const app of PAID_APPS) {
      await write(router, routerAbi, "setAppLimit", [agent.address, appKey(app.id), usd(env.policy.perAppDailyUsd)]);
    }
  }
  log(`router configured: ${PAID_APPS.length} apps, ${AGENTS.length} agent policies`);
}

async function read<T>(router: Address, functionName: string, args: unknown[]): Promise<T> {
  return publicClient.readContract({ address: router, abi: routerAbi, functionName, args }) as Promise<T>;
}

export async function reconcileRouter(router: Address): Promise<number> {
  const owner = (await read<Address>(router, "owner", [])).toLowerCase();
  const diffs: { what: string; write: () => Promise<unknown> }[] = [];
  for (const app of PAID_APPS) {
    const [provider, price, active, name] = await read<[Address, bigint, boolean, string]>(router, "apps", [appKey(app.id)]);
    const want = { provider: providerAddress(app), price: priceUnits(app), name: app.name };
    if (provider.toLowerCase() !== want.provider.toLowerCase() || price !== want.price || !active || name !== want.name) {
      diffs.push({ what: `app ${app.id} → ${app.priceUsd} USD, provider ${want.provider}`, write: () => write(router, routerAbi, "setApp", [appKey(app.id), app.name, want.provider, want.price, true]) });
    }
  }
  const daily = usd(env.policy.dailyUsd);
  const perReq = usd(env.policy.perRequestUsd);
  const perApp = usd(env.policy.perAppDailyUsd);
  for (const agent of AGENTS) {
    const [dailyLimit, perRequestMax, agentOwner, active] = await read<[bigint, bigint, Address, boolean]>(router, "policies", [agent.address]);
    if (dailyLimit !== daily || perRequestMax !== perReq || !active || agentOwner.toLowerCase() !== relayer.address.toLowerCase()) {
      diffs.push({ what: `policy ${agent.name} → ${env.policy.dailyUsd}/day, ${env.policy.perRequestUsd}/request`, write: () => write(router, routerAbi, "setPolicy", [agent.address, relayer.address, daily, perReq, true]) });
    }
    for (const app of PAID_APPS) {
      const limit = await read<bigint>(router, "perAppDailyLimit", [agent.address, appKey(app.id)]);
      if (limit !== perApp) diffs.push({ what: `app limit ${agent.name}/${app.id} → ${env.policy.perAppDailyUsd}/day`, write: () => write(router, routerAbi, "setAppLimit", [agent.address, appKey(app.id), perApp]) });
    }
  }
  if (diffs.length === 0) {
    log("router config matches the registry");
    return 0;
  }
  if (owner !== relayer.address.toLowerCase()) {
    console.warn(`[chain] router config drifted in ${diffs.length} place(s) but the relayer is not the owner (${owner}); apply manually:`);
    for (const d of diffs) console.warn(`[chain]   ${d.what}`);
    return 0;
  }
  for (const d of diffs) {
    log(`router: ${d.what}`);
    await d.write();
  }
  log(`router reconciled: ${diffs.length} transaction(s)`);
  return diffs.length;
}

function resetDataOnModeChange() {
  const stored = settings.get("chain_mode");
  if (stored === env.chainMode) return;
  if (stored) {
    log(`data was written in ${stored} mode, now ${env.chainMode}: clearing activity, payments, messages, tasks, positions, storage`);
    db.exec("DELETE FROM activity; DELETE FROM payments; DELETE FROM messages; DELETE FROM tasks; DELETE FROM positions; DELETE FROM storage; DELETE FROM quotes;");
    db.exec("UPDATE agents SET status = 'IDLE', task = NULL, task_id = NULL");
    settings.set("epoch", "1");
    if (env.chainMode === "mainnet") settings.set("contracts", "");
  }
  settings.set("chain_mode", env.chainMode);
}

export async function bootstrapChain() {
  log(`mode=${env.chainMode} rpc=${env.rpcUrl} chainId=${env.chainId}`);
  resetDataOnModeChange();
  await waitForRpc(30_000);

  if (isFork) {

    await rpc("anvil_setBalance", [relayer.address, toHex(parseEther("100"))]);

    const stored = settings.get("contracts");
    let deployed = stored ? (JSON.parse(stored) as { shos: Address; staking: Address; router: Address }) : undefined;
    if (!deployed || !(await hasCode(deployed.router))) {
      deployed = await deployAll();
      await configureRouter(deployed.router);
      settings.set("contracts", JSON.stringify(deployed));
      const epoch = Number(settings.get("epoch") ?? "0") + 1;
      settings.set("epoch", String(epoch));
      log(`fork epoch ${epoch}`);
    } else {
      log("contracts present:", deployed);
      await reconcileRouter(deployed.router);
    }
    addresses.shos = getAddress(deployed.shos);
    addresses.staking = getAddress(deployed.staking);
    addresses.router = getAddress(deployed.router);

    for (const agent of AGENTS) {
      const bal = await usdgBalance(agent.address);
      if (bal < usd(env.policy.fundUsd) / 2n) {
        await forkFundUsdg(agent.address, usd(env.policy.fundUsd));
        log(`funded ${agent.name} ${agent.address} with ${env.policy.fundUsd} USDG (test)`);
      }
    }
  } else {
    if (!(await hasCode(addresses.router))) throw new Error("ROUTER_ADDRESS has no code on mainnet — run `bun run deploy:mainnet` first");
    if (!(await hasCode(addresses.shos))) throw new Error("SHOS_ADDRESS has no code on mainnet");
    if (!(await hasCode(addresses.staking))) throw new Error("STAKING_ADDRESS has no code on mainnet");
    const facilitator = (await read<Address>(addresses.router!, "facilitator", [])).toLowerCase();
    if (facilitator !== relayer.address.toLowerCase()) throw new Error(`router facilitator is ${facilitator}, but PRIVATE_KEY is ${relayer.address} — settlements would revert (NotFacilitator)`);
    const usdgOnRouter = (await read<Address>(addresses.router!, "usdg", [])).toLowerCase();
    if (usdgOnRouter !== addresses.usdg.toLowerCase()) throw new Error(`router was deployed for USDG ${usdgOnRouter}, .env says ${addresses.usdg}`);
    const stakingOnRouter = (await read<Address>(addresses.router!, "staking", [])).toLowerCase();
    if (stakingOnRouter !== addresses.staking!.toLowerCase()) throw new Error(`router points at staking ${stakingOnRouter}, .env says ${addresses.staking} — rerun \`bun run deploy:mainnet\``);
    const tokenOnStaking = ((await publicClient.readContract({ address: addresses.staking!, abi: stakingAbi, functionName: "shos" })) as Address).toLowerCase();
    if (tokenOnStaking !== addresses.shos!.toLowerCase()) throw new Error(`staking is for token ${tokenOnStaking}, .env SHOS_ADDRESS is ${addresses.shos} — rerun \`bun run deploy:mainnet\``);
    const t = await tokenInfo(addresses.shos!);
    log(`token ${t.symbol} (${t.name}) ${addresses.shos} · ${t.decimals} decimals · supply ${Number(t.totalSupply) / 10 ** t.decimals}`);
    await reconcileRouter(addresses.router!);
    const gas = await publicClient.getBalance({ address: relayer.address });
    log(`relayer ${relayer.address} ETH: ${Number(gas) / 1e18}`);
    if (gas === 0n) console.warn("[chain] relayer has no ETH — settlements will fail until funded");
    for (const agent of AGENTS) {
      const bal = await usdgBalance(agent.address);
      log(`${agent.name} ${agent.address} USDG: ${Number(bal) / 1e6}${bal === 0n ? "  ← needs USDG" : ""}`);
    }
  }
  settings.set("epoch", settings.get("epoch") ?? "1");
  return addresses;
}

export const currentEpoch = () => Number(settings.get("epoch") ?? "1");
