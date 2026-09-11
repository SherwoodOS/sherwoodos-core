import { decodeEventLog, type Address, type Hex } from "viem";
import { relayer } from "../env.ts";
import { addresses, publicClient, requireRouter, routerAbi, walletClient } from "./client.ts";

export interface Authorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

export interface Settlement {
  txHash: Hex;
  receiptId: Hex;
  receiptNo: number;
  blockNumber: number;
  amount: bigint;
  fee: bigint;
  provider: Address;
}

let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

export function settle(appId: Hex, auth: Authorization, signature: { v: number; r: Hex; s: Hex }): Promise<Settlement> {
  return enqueue(async () => {
    const router = requireRouter();

    const { request } = await publicClient.simulateContract({
      address: router,
      abi: routerAbi,
      functionName: "settle",
      args: [
        appId,
        {
          from: auth.from,
          value: auth.value,
          validAfter: auth.validAfter,
          validBefore: auth.validBefore,
          nonce: auth.nonce,
          v: signature.v,
          r: signature.r,
          s: signature.s,
        },
      ],
      account: relayer,
    });
    const txHash = await walletClient.writeContract({ ...request, account: relayer, chain: null });
    const rcpt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (rcpt.status !== "success") throw new Error("settle reverted on-chain");
    for (const l of rcpt.logs) {
      if (l.address.toLowerCase() !== router.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: routerAbi, data: l.data, topics: l.topics });
        if (ev.eventName === "Paid") {
          const a = ev.args as unknown as {
            receiptId: Hex;
            agent: Address;
            appId: Hex;
            provider: Address;
            amount: bigint;
            fee: bigint;
            nonce: Hex;
            receiptNo: bigint;
          };
          return {
            txHash,
            receiptId: a.receiptId,
            receiptNo: Number(a.receiptNo),
            blockNumber: Number(rcpt.blockNumber),
            amount: a.amount,
            fee: a.fee,
            provider: a.provider,
          };
        }
      } catch {

      }
    }
    throw new Error("Paid event not found");
  });
}

export const facilitatorAddress = () => relayer.address;
export const routerAddress = () => addresses.router;
