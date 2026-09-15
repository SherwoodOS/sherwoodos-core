import { formatEther, formatUnits, parseEther, parseUnits, type Address, type Hex } from "viem";
import { env, relayer } from "../src/env.ts";
import { addresses, publicClient, usdgBalance, waitForRpc, walletClient } from "../src/chain/client.ts";
import { AGENTS } from "../src/agents/identities.ts";

const args = process.argv.slice(2);
const yes = args.includes("--yes");
const minEth = parseEther(args.includes("--min-eth") ? args[args.indexOf("--min-eth") + 1] : "0.03");
const plan: { name: string; to: Address; usdg: bigint }[] = [];
for (const a of AGENTS) {
  const i = args.indexOf(`--${a.id}`);
  if (i < 0) continue;
  const v = Number(args[i + 1]);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`--${a.id} needs a positive USDG amount`);
  plan.push({ name: a.name, to: a.address, usdg: parseUnits(String(v), 6) });
}
if (plan.length === 0) {
  console.error("nothing to do: pass --trader 15 --researcher 10 … (add --yes to send)");
  process.exit(1);
}

interface Quote {
  details: { currencyIn: { amountFormatted: string; amountUsd: string }; currencyOut: { amountFormatted: string; amountUsd: string }; totalImpact: { percent: string } };
  steps: { id: string; kind: string; items: { data: { to: Address; data: Hex; value: string; chainId: number } }[] }[];
  message?: string;
}

async function quote(to: Address, usdg: bigint): Promise<Quote> {
  const res = await fetch("https://api.relay.link/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      user: relayer.address,
      recipient: to,
      originChainId: env.chainId,
      destinationChainId: env.chainId,
      originCurrency: "0x0000000000000000000000000000000000000000",
      destinationCurrency: addresses.usdg,
      amount: usdg.toString(),
      tradeType: "EXACT_OUTPUT",
    }),
  });
  const q = (await res.json()) as Quote;
  if (!res.ok || q.message) throw new Error(`relay quote: ${q.message ?? res.status}`);
  return q;
}

await waitForRpc(20_000);
const eth = await publicClient.getBalance({ address: relayer.address });
console.log(`chain ${env.chainMode} (${env.chainId}) · relayer ${relayer.address} · ${formatEther(eth)} ETH`);

let totalIn = 0n;
const quotes: { p: (typeof plan)[number]; q: Quote }[] = [];
for (const p of plan) {
  const q = await quote(p.to, p.usdg);
  const txs = q.steps.flatMap((s) => s.items.map((i) => i.data));
  const value = txs.reduce((s, t) => s + BigInt(t.value ?? "0"), 0n);
  totalIn += value;
  quotes.push({ p, q });
  console.log(`  ${p.name.padEnd(10)} ${q.details.currencyIn.amountFormatted} ETH ($${q.details.currencyIn.amountUsd}) → ${q.details.currencyOut.amountFormatted} USDG · impact ${q.details.totalImpact.percent}% · ${txs.length} tx → ${p.to}`);
}
const left = eth - totalIn;
console.log(`total ${formatEther(totalIn)} ETH, relayer keeps ${formatEther(left)} ETH (min ${formatEther(minEth)})`);
if (left < minEth) {
  console.error("that would leave the relayer short of gas — lower the amounts or pass --min-eth");
  process.exit(1);
}
if (!yes) {
  console.log("\nquote only. Re-run with --yes to send.");
  process.exit(0);
}

for (const { p, q } of quotes) {
  for (const step of q.steps) {
    for (const item of step.items) {
      const t = item.data;
      if (t.chainId !== env.chainId) throw new Error(`step ${step.id} is for chain ${t.chainId}`);
      const hash = await walletClient.sendTransaction({ account: relayer, chain: null, to: t.to, data: t.data, value: BigInt(t.value ?? "0") });
      const rcpt = await publicClient.waitForTransactionReceipt({ hash });
      if (rcpt.status !== "success") throw new Error(`${step.id} for ${p.name} reverted (${hash})`);
      console.log(`  ${p.name.padEnd(10)} ${step.id}: ${hash}`);
    }
  }
}
await Bun.sleep(3000);
for (const p of plan) console.log(`  ${p.name.padEnd(10)} balance ${formatUnits(await usdgBalance(p.to), 6)} USDG`);
console.log(`relayer left: ${formatEther(await publicClient.getBalance({ address: relayer.address }))} ETH`);
