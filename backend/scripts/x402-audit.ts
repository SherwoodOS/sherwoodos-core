import { createPublicClient, getAddress, http, keccak256, toHex, parseSignature, encodeAbiParameters, encodeFunctionData, decodeFunctionResult, type Address, type Hex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

const BASE = process.argv[2] ?? "http://127.0.0.1:3000";
const RPC = process.env.RPC ?? "http://127.0.0.1:8663";
const MNEMONIC = (process.env.AGENT_MNEMONIC ?? "").replace(/^"|"$/g, "");
if (MNEMONIC.split(/\s+/).length < 12) {
  console.error("AGENT_MNEMONIC must be set (the audit pays from the agents' wallets)");
  process.exit(1);
}
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const dec = (s: string) => JSON.parse(Buffer.from(s, "base64").toString());
let failures = 0;
const ok = (name: string, cond: boolean, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!cond) failures++; };

const cfg = (await (await fetch(`${BASE}/api/config`)).json()) as any;
const pub = createPublicClient({ transport: http(RPC) });
console.log(`mode=${cfg.chainMode} router=${cfg.addresses.router} usdg=${cfg.addresses.usdg}`);

const types = { ReceiveWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" } ] } as const;
const domain = { name: "Global Dollar", version: "1", chainId: cfg.chainId, verifyingContract: cfg.addresses.usdg as Address };

async function pay(account: any, path: string, opts: { value?: string; validBefore?: number; validAfter?: number; to?: Address; nonce?: Hex; method?: string; body?: unknown; raw?: string; sigTamper?: boolean } = {}) {
  const url = `${BASE}/x402${path}`;
  const init: RequestInit = { method: opts.method ?? "GET", headers: { "X-Agent": account.address, ...(opts.body ? { "content-type": "application/json" } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined };
  const first = await fetch(url, init);
  if (first.status !== 402) return { first, status: first.status, data: (await first.json()) as any };
  const req = ((await first.json()) as any).accepts[0];
  const nowSec = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address, to: opts.to ?? getAddress(req.payTo), value: opts.value ?? req.maxAmountRequired,
    validAfter: String(opts.validAfter ?? 0), validBefore: String(opts.validBefore ?? nowSec + req.maxTimeoutSeconds),
    nonce: opts.nonce ?? toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  let signature: Hex = await account.signTypedData({ domain, types, primaryType: "ReceiveWithAuthorization", message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) } });
  if (opts.sigTamper) signature = (signature.slice(0, 10) + (signature[10] === "a" ? "b" : "a") + signature.slice(11)) as Hex;
  const header = opts.raw ?? enc({ x402Version: 1, scheme: "exact", network: req.network, payload: { signature, authorization } });
  const second = await fetch(url, { ...init, headers: { ...(init.headers as any), "X-PAYMENT": header } });
  const pr = second.headers.get("x-payment-response");
  return { first, req, authorization, status: second.status, data: (await second.json().catch(() => null)) as any, payment: pr ? dec(pr) : undefined };
}

const trader = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
const scout = mnemonicToAccount(MNEMONIC, { addressIndex: 2 });
const stranger = privateKeyToAccount(keccak256(toHex("sherwood-audit-stranger")));

const disc = (await (await fetch(`${BASE}/x402`)).json()) as any;
ok("discovery lists 6 paid resources", disc.resources?.length === 6 && disc.payTo === cfg.addresses.router);
const quote = (await (await fetch(`${BASE}/x402/quote/market-data`)).json()) as any;
ok("quote: 10000 + 3% fee = 10300", quote.maxAmountRequired === "10300" && quote.extra.fee === "300", JSON.stringify(quote.resource));
const slash = await fetch(`${BASE}/x402/`);
ok("discovery with trailing slash", slash.status === 200, `status ${slash.status}`);

const r1 = await pay(trader, "/market-data?symbol=NVDA");
ok("trader pays market-data → 200", r1.status === 200 && r1.payment?.success === true, `status ${r1.status} ${r1.payment?.errorReason ?? ""}`);
ok("response carries data", r1.data?.ok === true && typeof r1.data?.price === "number", JSON.stringify(r1.data).slice(0, 120));
const tx1 = r1.payment?.transaction as Hex;
if (tx1) {
  const rc = await pub.getTransactionReceipt({ hash: tx1 });
  ok("settle tx mined, status success", rc.status === "success" && rc.to?.toLowerCase() === cfg.addresses.router.toLowerCase());
  const rec = (await (await fetch(`${BASE}/api/receipt/${tx1}`)).json()) as any;
  ok("receipt API decodes Paid + 3 USDG transfers", rec.onchain?.paid?.length === 1 && rec.onchain?.transfers?.length === 3 && rec.onchain.paid[0].amount === "10300" && rec.onchain.paid[0].fee === "300", JSON.stringify(rec.onchain?.transfers));
  ok("receipt row stored", rec.payment?.tx_hash === tx1 && rec.payment?.agent_id === "trader");
  ok("USDG really moved: authorizationState(nonce)=true", await pub.readContract({ address: cfg.addresses.usdg, abi: [{ type: "function", name: "authorizationState", stateMutability: "view", inputs: [{ type: "address" }, { type: "bytes32" }], outputs: [{ type: "bool" }] }], functionName: "authorizationState", args: [trader.address, r1.authorization!.nonce] }) === true);
}

const r2 = await pay(trader, "/compute", { method: "POST", body: { series: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], indicators: ["rsi", "sma", "momentum", "volatility"] } });
ok("compute POST paid → 200", r2.status === 200 && r2.payment?.success === true, `status ${r2.status} ${r2.payment?.errorReason ?? ""} ${JSON.stringify(r2.data).slice(0, 100)}`);
const r3 = await pay(scout, "/storage", { method: "POST", body: { key: "audit/doc1", content: { hello: "world" } } });
ok("storage POST paid → 200", r3.status === 200 && r3.payment?.success === true, `status ${r3.status} ${r3.payment?.errorReason ?? ""}`);
if (r3.status === 200) {
  const g = (await (await fetch(`${BASE}/x402/storage/${encodeURIComponent(r3.data.key)}`)).json()) as any;
  ok("storage read is free and returns the doc", g.ok === true && g.content?.hello === "world", JSON.stringify(g).slice(0, 100));
}
const r4 = await pay(scout, "/trading", { method: "POST", body: { symbol: "NVDA", side: "buy", qty: 1, reason: "audit" } });
ok("trading POST paid → 200", r4.status === 200 && r4.payment?.success === true, `status ${r4.status} ${r4.payment?.errorReason ?? ""} ${JSON.stringify(r4.data).slice(0, 100)}`);
const r5 = await pay(scout, "/news?q=NVDA");
ok("news paid → 200", r5.status === 200 && r5.payment?.success === true, `status ${r5.status}`);
const r6 = await pay(scout, "/search?q=robinhood%20chain");
ok("search paid → 200", r6.status === 200 && r6.payment?.success === true, `status ${r6.status}`);

const replay = await (async () => {
  const url = `${BASE}/x402/market-data?symbol=NVDA`;
  const req = ((await (await fetch(url, { headers: { "X-Agent": trader.address } })).json()) as any).accepts[0];
  const nowSec = Math.floor(Date.now() / 1000);
  const authorization = { from: trader.address, to: getAddress(req.payTo), value: req.maxAmountRequired, validAfter: "0", validBefore: String(nowSec + 60), nonce: toHex(crypto.getRandomValues(new Uint8Array(32))) };
  const signature = await trader.signTypedData({ domain, types, primaryType: "ReceiveWithAuthorization", message: { ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore) } });
  const header = enc({ x402Version: 1, scheme: "exact", network: req.network, payload: { signature, authorization } });
  const a = await fetch(url, { headers: { "X-Agent": trader.address, "X-PAYMENT": header } });
  const b = await fetch(url, { headers: { "X-Agent": trader.address, "X-PAYMENT": header } });
  return { a: a.status, b: b.status, br: dec(b.headers.get("x-payment-response") ?? "e30=") };
})();
ok("replayed X-PAYMENT → 402 AuthorizationUsed", replay.a === 200 && replay.b === 402 && replay.br.errorReason === "AuthorizationUsed", JSON.stringify(replay));

const bad1 = await pay(trader, "/market-data", { value: "10000" });
ok("wrong amount → 402", bad1.status === 402, `status ${bad1.status} ${bad1.data?.error}`);
const bad2 = await pay(trader, "/market-data", { validBefore: Math.floor(Date.now() / 1000) - 5 });
ok("expired → 402", bad2.status === 402, `status ${bad2.status} ${bad2.data?.error}`);
const bad3 = await pay(trader, "/market-data", { validAfter: Math.floor(Date.now() / 1000) + 3600 });
ok("not yet valid → 402", bad3.status === 402, `status ${bad3.status} ${bad3.data?.error}`);
const bad4 = await pay(trader, "/market-data", { to: trader.address });
ok("authorization.to ≠ router → 402", bad4.status === 402, `status ${bad4.status} ${bad4.data?.error}`);
const bad5 = await pay(trader, "/market-data", { sigTamper: true });
ok("tampered signature → 402", bad5.status === 402, `status ${bad5.status} ${bad5.data?.error}`);
const bad6 = await pay(stranger, "/market-data");
ok("stranger without policy → 402 NoPolicy", bad6.status === 402 && bad6.payment?.errorReason === "NoPolicy", `status ${bad6.status} ${bad6.payment?.errorReason} ${bad6.data?.error}`);
const bad7 = await pay(trader, "/market-data", { raw: "not-base64!!" });
ok("garbage X-PAYMENT → 402 (not 500)", bad7.status === 402, `status ${bad7.status}`);
const bad8 = await pay(trader, "/market-data", { raw: enc({ x402Version: 1, scheme: "exact", network: "robinhood", payload: { signature: "0x12", authorization: { from: "nope" } } }) });
ok("malformed authorization → 402 (not 500)", bad8.status === 402, `status ${bad8.status}`);
const bad9 = await pay(trader, "/market-data", { raw: enc({ x402Version: 1, scheme: "exact", network: "robinhood" }) });
ok("missing payload → 402 (not 500)", bad9.status === 402, `status ${bad9.status}`);
const bad10 = await pay(trader, "/market-data", { raw: enc({ x402Version: 1, scheme: "exact", network: "robinhood", payload: { signature: "0xzz", authorization: { from: trader.address, to: cfg.addresses.router, value: "abc", validAfter: "0", validBefore: "1", nonce: "0x01" } } }) });
ok("non-numeric value → 402 (not 500)", bad10.status === 402, `status ${bad10.status}`);

const w = (await (await fetch(`${BASE}/api/wallet/trader`)).json()) as any;
ok("wallet API: spentToday reflects router counter", Number(w.spentToday) >= 10300 * 2, `spentToday=${w.spentToday}`);

const p1 = await fetch(`${BASE}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
const p1j = (await p1.json().catch(() => ({}))) as any;
const p2 = await fetch(`${BASE}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [trader.address, "0x1"] }) });
const p3 = await fetch(`${BASE}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }, { jsonrpc: "2.0", id: 2, method: "eth_accounts", params: [] }]) });
if (cfg.chainMode === "fork") {
  ok("rpc proxy: eth_chainId ok", p1.status === 200 && p1j.result === "0x1237", JSON.stringify(p1j));
  ok("rpc proxy: anvil_* blocked", p2.status === 403);
  ok("rpc proxy: batch with eth_accounts blocked", p3.status === 403);
} else {
  ok("rpc proxy absent in mainnet mode", p1.status === 404, `status ${p1.status}`);
}

for (const path of ["/api/health", "/api/agents", "/api/agents/trader", "/api/apps", "/api/apps/market-data", "/api/activity", "/api/payments", "/api/threads", "/api/messages", "/api/tasks", "/api/stats", "/api/shos", "/api/wallet/scout"]) {
  const r = await fetch(`${BASE}${path}`);
  const j = (await r.json().catch(() => null)) as any;
  ok(`GET ${path}`, r.status === 200 && j !== null && !(j as any).error, `status ${r.status} ${(j as any)?.error ?? ""}`);
}
const shos = (await (await fetch(`${BASE}/api/shos`)).json()) as any;
ok("/api/shos reads router+staking", shos.router?.receipts >= 6 && shos.tiers?.length === 3, JSON.stringify(shos).slice(0, 200));
const nf = await fetch(`${BASE}/api/receipt/0x${"11".repeat(32)}`);
const nfj = (await nf.json()) as any;
ok("unknown receipt → 200 with error field", nf.status === 200 && !!nfj.error);
const spa = await fetch(`${BASE}/agents/trader`);
const spaText = await spa.text();
if (spaText.includes("Frontend not built")) console.log("skip  desktop UI is not part of this build");
else ok("SPA fallback serves index.html", spa.status === 200 && spaText.includes("<title>"));
console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
