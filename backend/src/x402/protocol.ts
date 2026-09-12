import type { Address, Hex } from "viem";

export const X402_VERSION = 1;
export const NETWORK = "robinhood";

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: Address;
  maxTimeoutSeconds: number;
  asset: Address;
  extra: {
    name: string;
    version: string;
    chainId: number;
    appId: Hex;
    app: string;
    price: string;
    fee: string;
    feeBps: number;
    authorizationType: "ReceiveWithAuthorization";
    settlement: "SherwoodRouter.settle";
  };
}

export interface PaymentRequiredBody {
  x402Version: number;
  error: string;
  accepts: PaymentRequirements[];
}

export interface AuthorizationMessage {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

export interface PaymentPayload {
  x402Version: number;
  scheme: "exact";
  network: string;
  payload: { signature: Hex; authorization: AuthorizationMessage };
}

export interface PaymentResponse {
  success: boolean;
  transaction?: Hex;
  network: string;
  payer?: Address;
  receiptId?: Hex;
  receiptNo?: number;
  blockNumber?: number;
  amount?: string;
  fee?: string;
  errorReason?: string;
}

export const encodeHeader = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
export const decodeHeader = <T>(h: string): T => JSON.parse(Buffer.from(h, "base64").toString("utf8")) as T;

export const receiveWithAuthorizationTypes = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export const usdgDomain = (chainId: number, usdg: Address) => ({
  name: "Global Dollar",
  version: "1",
  chainId,
  verifyingContract: usdg,
});
