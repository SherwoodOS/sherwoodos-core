import { getAddress, toHex, type Address } from "viem";
import type { HDAccount } from "viem/accounts";
import { env } from "../env.ts";
import {
  decodeHeader,
  encodeHeader,
  receiveWithAuthorizationTypes,
  usdgDomain,
  X402_VERSION,
  type PaymentPayload,
  type PaymentRequiredBody,
  type PaymentRequirements,
  type PaymentResponse,
} from "./protocol.ts";

export interface PayFetchResult<T = unknown> {
  status: number;
  data: T;
  requirements?: PaymentRequirements;
  payment?: PaymentResponse;
  ms: number;
}

export interface PayFetchHooks {
  onRequirements?: (req: PaymentRequirements) => void | Promise<void>;
  onSigned?: (auth: PaymentPayload["payload"]["authorization"]) => void | Promise<void>;
}

export class PaymentRefused extends Error {
  constructor(
    public reason: string,
    public requirements?: PaymentRequirements,
  ) {
    super(reason);
  }
}

export async function payFetch<T = unknown>(
  account: HDAccount,
  url: string,
  init: RequestInit & { taskId?: string } = {},
  hooks: PayFetchHooks = {},
): Promise<PayFetchResult<T>> {
  const started = Date.now();
  const baseHeaders: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
    "X-Agent": account.address,
    ...(init.taskId ? { "X-Task": init.taskId } : {}),
  };
  const first = await fetch(url, { ...init, headers: baseHeaders });
  if (first.status !== 402) {
    return { status: first.status, data: (await first.json()) as T, ms: Date.now() - started };
  }
  const body = (await first.json()) as PaymentRequiredBody;
  const req = body.accepts?.[0];
  if (!req) throw new PaymentRefused("402 without requirements");
  await hooks.onRequirements?.(req);

  const nowSec = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address as Address,
    to: getAddress(req.payTo),
    value: req.maxAmountRequired,
    validAfter: "0",
    validBefore: String(nowSec + req.maxTimeoutSeconds),
    nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  const signature = await account.signTypedData({
    domain: usdgDomain(req.extra.chainId ?? env.chainId, getAddress(req.asset)),
    types: receiveWithAuthorizationTypes,
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: 0n,
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  await hooks.onSigned?.(authorization);

  const payload: PaymentPayload = {
    x402Version: X402_VERSION,
    scheme: "exact",
    network: req.network,
    payload: { signature, authorization },
  };
  const second = await fetch(url, { ...init, headers: { ...baseHeaders, "X-PAYMENT": encodeHeader(payload) } });
  const prHeader = second.headers.get("X-PAYMENT-RESPONSE");
  const payment = prHeader ? decodeHeader<PaymentResponse>(prHeader) : undefined;
  const data = (await second.json()) as T;
  if (second.status === 402) {
    throw new PaymentRefused(payment?.errorReason ?? (data as any)?.error ?? "payment refused", req);
  }
  return { status: second.status, data, requirements: req, payment, ms: Date.now() - started };
}
