import type { Context, MiddlewareHandler } from "hono";
import { getAddress, isAddress, isAddressEqual, parseSignature, verifyTypedData, type Address, type Hex } from "viem";
import { env } from "../env.ts";
import { addresses, publicClient, routerAbi } from "../chain/client.ts";
import { settle, type Settlement } from "../chain/facilitator.ts";
import { appKey, type AppDef } from "../apps/registry.ts";
import { db, now } from "../db.ts";
import { bus } from "../bus.ts";
import { agentByAddress } from "../agents/identities.ts";
import { currentEpoch } from "../chain/bootstrap.ts";
import {
  decodeHeader,
  encodeHeader,
  NETWORK,
  receiveWithAuthorizationTypes,
  usdgDomain,
  X402_VERSION,
  type PaymentPayload,
  type PaymentRequiredBody,
  type PaymentRequirements,
  type PaymentResponse,
} from "./protocol.ts";

export type PaywallVars = { payment: Settlement & { payer: Address; appId: string; taskId?: string } };

async function quoteFor(app: AppDef, agent?: Address) {
  const router = addresses.router!;
  const who = agent ?? "0x0000000000000000000000000000000000000000";
  const [price, fee, total] = (await publicClient.readContract({
    address: router,
    abi: routerAbi,
    functionName: "quote",
    args: [appKey(app.id), who],
  })) as [bigint, bigint, bigint];
  return { price, fee, total };
}

export function requirementsFor(app: AppDef, resource: string, q: { price: bigint; fee: bigint; total: bigint }): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    maxAmountRequired: q.total.toString(),
    resource,
    description: `${app.name}: ${app.tagline}`,
    mimeType: "application/json",
    payTo: addresses.router!,
    maxTimeoutSeconds: 60,
    asset: addresses.usdg,
    extra: {
      name: "Global Dollar",
      version: "1",
      chainId: env.chainId,
      appId: appKey(app.id),
      app: app.id,
      price: q.price.toString(),
      fee: q.fee.toString(),
      feeBps: env.feeBps,
      authorizationType: "ReceiveWithAuthorization",
      settlement: "SherwoodRouter.settle",
    },
  };
}

function publicUrl(c: Context) {
  const u = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto");
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
  if (proto) u.protocol = `${proto}:`;
  if (host) u.host = host;
  return u.toString();
}

function paymentRequired(c: Context, app: AppDef, q: { price: bigint; fee: bigint; total: bigint }, error: string) {
  const body: PaymentRequiredBody = {
    x402Version: X402_VERSION,
    error,
    accepts: [requirementsFor(app, publicUrl(c), q)],
  };
  return c.json(body, 402);
}

export function paywall(app: AppDef): MiddlewareHandler<{ Variables: PaywallVars }> {
  return async (c, next) => {
    if (!addresses.router) return c.json({ error: "router not ready" }, 503);
    const header = c.req.header("X-PAYMENT") ?? c.req.header("x-payment");
    const agentHeader = c.req.header("X-Agent");
    const agentAddr = agentHeader && /^0x[0-9a-fA-F]{40}$/.test(agentHeader) ? getAddress(agentHeader) : undefined;

    let payload: PaymentPayload | undefined;
    let shapeError: string | undefined;
    if (header) {
      try {
        payload = decodeHeader<PaymentPayload>(header);
      } catch {
        payload = undefined;
        shapeError = "X-PAYMENT is not base64 JSON";
      }
      if (payload) {
        shapeError = validatePayload(payload);
        if (shapeError) payload = undefined;
      }
    }
    const payer = payload ? getAddress(payload.payload.authorization.from) : agentAddr;
    const q = await quoteFor(app, payer);

    if (!payload) return paymentRequired(c, app, q, shapeError ?? "X-PAYMENT header is required");

    const a = payload.payload.authorization;
    const from = getAddress(a.from);
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    if (payload.scheme !== "exact" || payload.network !== NETWORK) return paymentRequired(c, app, q, "unsupported scheme/network");
    if (!isAddressEqual(getAddress(a.to), addresses.router)) return paymentRequired(c, app, q, "authorization.to must be the router");
    if (BigInt(a.value) !== q.total) return paymentRequired(c, app, q, `amount must be ${q.total.toString()}`);
    if (BigInt(a.validBefore) <= nowSec + 3n) return paymentRequired(c, app, q, "authorization expired");
    if (BigInt(a.validAfter) > nowSec) return paymentRequired(c, app, q, "authorization not yet valid");

    let ok = false;
    try {
      ok = await verifyTypedData({
        address: from,
        domain: usdgDomain(env.chainId, addresses.usdg),
        types: receiveWithAuthorizationTypes,
        primaryType: "ReceiveWithAuthorization",
        message: {
          from,
          to: addresses.router,
          value: BigInt(a.value),
          validAfter: BigInt(a.validAfter),
          validBefore: BigInt(a.validBefore),
          nonce: a.nonce,
        },
        signature: payload.payload.signature,
      });
    } catch {
      ok = false;
    }
    if (!ok) return paymentRequired(c, app, q, "invalid signature");

    const sig = parseSignature(payload.payload.signature);
    let settlement: Settlement;
    try {
      settlement = await settle(
        appKey(app.id),
        {
          from,
          to: addresses.router,
          value: BigInt(a.value),
          validAfter: BigInt(a.validAfter),
          validBefore: BigInt(a.validBefore),
          nonce: a.nonce as Hex,
        },
        { v: Number(sig.v ?? (sig.yParity === 1 ? 28 : 27)), r: sig.r, s: sig.s },
      );
    } catch (e) {
      const reason = settlementError(e);
      const res: PaymentResponse = { success: false, network: NETWORK, payer: from, errorReason: reason };
      c.header("X-PAYMENT-RESPONSE", encodeHeader(res));
      return paymentRequired(c, app, q, `settlement failed: ${reason}`);
    }

    const agent = agentByAddress(from);
    const taskId = c.req.header("X-Task") ?? null;
    const url = new URL(c.req.url);
    const row = db
      .query(
        `INSERT INTO payments(ts, agent_id, task_id, app_id, amount, fee, provider, payer, nonce, tx_hash, receipt_id, receipt_no, block_number, resource, epoch)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        now(),
        agent?.id ?? "external",
        taskId,
        app.id,
        Number(settlement.amount),
        Number(settlement.fee),
        settlement.provider,
        from,
        a.nonce,
        settlement.txHash,
        settlement.receiptId,
        settlement.receiptNo,
        settlement.blockNumber,
        url.pathname + url.search,
        currentEpoch(),
      ) as any;
    bus.emit({ type: "payment", data: row });

    const res: PaymentResponse = {
      success: true,
      transaction: settlement.txHash,
      network: NETWORK,
      payer: from,
      receiptId: settlement.receiptId,
      receiptNo: settlement.receiptNo,
      blockNumber: settlement.blockNumber,
      amount: settlement.amount.toString(),
      fee: settlement.fee.toString(),
    };
    c.header("X-PAYMENT-RESPONSE", encodeHeader(res));
    c.set("payment", { ...settlement, payer: from, appId: app.id, taskId: taskId ?? undefined });
    await next();
  };
}

const ROUTER_ERRORS = ["DailyLimit", "AppDailyLimit", "PerRequestLimit", "NoPolicy", "AppInactive", "BadAmount", "NotFacilitator"];

const USDG_ERRORS: Record<string, string> = {
  "0x356680b7": "AuthorizationUsed", // replayed / cancelled nonce
  "0x8baa579f": "InvalidSignature",
  "0x0f05f5bf": "AuthorizationExpired",
  "0xdf8e4372": "AuthorizationNotYetValid",
  "0x5454b17d": "CallerMustBePayee",
};

export function settlementError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  for (const name of ROUTER_ERRORS) if (msg.includes(name)) return name;
  const selector = msg.match(/0x[0-9a-fA-F]{8}\b/)?.[0]?.toLowerCase();
  if (selector && USDG_ERRORS[selector]) return USDG_ERRORS[selector];
  if (msg.includes("authorization is used") || msg.includes("AuthorizationUsed")) return "AuthorizationUsed";
  if (msg.includes("insufficient") || msg.includes("Insufficient")) return "InsufficientFunds";
  return msg.split("\n")[0].slice(0, 160);
}

const DEC = /^[0-9]{1,40}$/;
const HEX = (bytes: number) => new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`);

function validatePayload(p: PaymentPayload): string | undefined {
  if (!p || typeof p !== "object") return "payload must be an object";
  if (p.x402Version !== X402_VERSION) return `x402Version must be ${X402_VERSION}`;
  const inner = p.payload;
  if (!inner || typeof inner !== "object") return "payload.payload missing";
  if (typeof inner.signature !== "string" || !HEX(65).test(inner.signature)) return "signature must be 65 bytes hex";
  const a = inner.authorization;
  if (!a || typeof a !== "object") return "authorization missing";
  if (typeof a.from !== "string" || !isAddress(a.from)) return "authorization.from is not an address";
  if (typeof a.to !== "string" || !isAddress(a.to)) return "authorization.to is not an address";
  for (const k of ["value", "validAfter", "validBefore"] as const) {
    if (typeof a[k] !== "string" || !DEC.test(a[k])) return `authorization.${k} must be a decimal string`;
  }
  if (typeof a.nonce !== "string" || !HEX(32).test(a.nonce)) return "authorization.nonce must be 32 bytes hex";
  return undefined;
}
