import { formatUnits, parseUnits, type Address } from "viem";
import { env, relayer } from "../src/env.ts";
import { addresses, publicClient, usdgAbi, usdgBalance, waitForRpc, walletClient } from "../src/chain/client.ts";
import { AGENTS } from "../src/agents/identities.ts";

const args = process.argv.slice(2);
const plan: { name: string; to: Address; amount: bigint }[] = [];
for (const a of AGENTS) {
  const i = args.indexOf(`--${a.id}`);
  if (i < 0) continue;
  const v = Number(args[i + 1]);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`--${a.id} needs a positive USDG amount`);
  plan.push({ name: a.name, to: a.address, amount: parseUnits(String(v), 6) });
}
if (plan.length === 0) {
  console.error("nothing to do: pass --trader 15 --researcher 10 …");
  process.exit(1);
}

const transferAbi = [...usdgAbi, { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;

await waitForRpc(20_000);
const have = await usdgBalance(relayer.address);
const need = plan.reduce((s, p) => s + p.amount, 0n);
console.log(`chain ${env.chainMode} · relayer ${relayer.address} holds ${formatUnits(have, 6)} USDG · sending ${formatUnits(need, 6)}`);
if (have < need) {
  console.error(`not enough USDG on the relayer (${formatUnits(have, 6)} < ${formatUnits(need, 6)})`);
  process.exit(1);
}
for (const p of plan) {
  const hash = await walletClient.writeContract({ address: addresses.usdg, abi: transferAbi, functionName: "transfer", args: [p.to, p.amount], account: relayer, chain: null });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") throw new Error(`transfer to ${p.name} reverted (${hash})`);
  console.log(`  ${p.name.padEnd(10)} +${formatUnits(p.amount, 6)} USDG → ${p.to}  ${hash}`);
}
for (const a of AGENTS) console.log(`  ${a.name.padEnd(10)} balance ${formatUnits(await usdgBalance(a.address), 6)} USDG`);
console.log(`relayer left: ${formatUnits(await usdgBalance(relayer.address), 6)} USDG`);
