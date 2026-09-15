import { readFileSync, writeFileSync } from "node:fs";
import { formatUnits, getAddress, isAddress, type Address } from "viem";
import { env, relayer } from "../src/env.ts";
import { addresses, publicClient, routerAbi, shosAbi, waitForRpc, walletClient } from "../src/chain/client.ts";

const args = process.argv.slice(2);
const opt = (name: string): Address | undefined => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || !isAddress(v) || /^0x0{40}$/.test(v)) throw new Error(`--${name} needs a non-zero address`);
  return getAddress(v);
};
const treasury = opt("treasury");
const shosTo = opt("shos-to");
const owner = opt("owner");
if (!treasury && !shosTo && !owner) {
  console.error("nothing to do: pass --treasury 0x…, --shos-to 0x… and/or --owner 0x…");
  process.exit(1);
}
if (!addresses.router || !addresses.shos) throw new Error("ROUTER_ADDRESS / SHOS_ADDRESS missing in .env — deploy first");

await waitForRpc(20_000);
const router = addresses.router;
const currentOwner = (await publicClient.readContract({ address: router, abi: routerAbi, functionName: "owner" })) as Address;
if (currentOwner.toLowerCase() !== relayer.address.toLowerCase()) throw new Error(`router owner is ${currentOwner}, not the relayer ${relayer.address}`);
console.log(`chain ${env.chainMode} · router ${router} · relayer ${relayer.address}`);

async function send(label: string, fn: () => Promise<`0x${string}`>) {

  for (let attempt = 1; ; attempt++) {
    try {
      const hash = await fn();
      const rcpt = await publicClient.waitForTransactionReceipt({ hash });
      if (rcpt.status !== "success") throw new Error(`${label} reverted (${hash})`);
      console.log(`  ${label}: ${hash}`);
      return;
    } catch (e) {
      const msg = (e as Error).message;
      if (attempt < 5 && /nonce|already known|replacement/i.test(msg)) {
        console.log(`  ${label}: nonce clash, retrying (${attempt})`);
        await Bun.sleep(1500);
        continue;
      }
      throw e;
    }
  }
}

if (treasury) {
  const feeBps = (await publicClient.readContract({ address: router, abi: routerAbi, functionName: "feeBps" })) as number;
  await send(`setTreasury(${treasury}, ${feeBps} bps)`, () => walletClient.writeContract({ address: router, abi: routerAbi, functionName: "setTreasury", args: [treasury, feeBps], account: relayer, chain: null }));
  let envText = readFileSync(".env", "utf8");
  envText = envText.match(/^TREASURY_ADDRESS=.*$/m) ? envText.replace(/^TREASURY_ADDRESS=.*$/m, `TREASURY_ADDRESS=${treasury}`) : envText + `\nTREASURY_ADDRESS=${treasury}`;
  writeFileSync(".env", envText);
  console.log(`  .env TREASURY_ADDRESS=${treasury}`);
}
if (shosTo) {
  const bal = (await publicClient.readContract({ address: addresses.shos, abi: shosAbi, functionName: "balanceOf", args: [relayer.address] })) as bigint;
  if (bal === 0n) console.log("  relayer holds no SHOS, skipping");
  else await send(`SHOS.transfer(${shosTo}, ${formatUnits(bal, 18)})`, () => walletClient.writeContract({ address: addresses.shos!, abi: shosAbi, functionName: "transfer", args: [shosTo, bal], account: relayer, chain: null }));
}
if (owner) {
  await send(`setOwner(${owner})`, () => walletClient.writeContract({ address: router, abi: routerAbi, functionName: "setOwner", args: [owner], account: relayer, chain: null }));
  console.log("  note: price/limit changes now need the new owner; the backend will only warn about drift");
}
console.log("done. commit .env if it changed: git add .env && git commit -m 'treasury' && git push");
