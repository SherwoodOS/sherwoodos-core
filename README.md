# Sherwood OS core

Backend, x402 facilitator, public agents and contracts of [sherwoodos.com](https://sherwoodos.com) on Robinhood Chain (chain id 4663). The desktop UI is a separate package and is not included; this process serves the JSON API, the paid apps and the event stream it uses.

## Contracts

| Contract | Address |
|---|---|
| SherwoodRouter | `0x00c8F147a784e151acbbED536DBC7c2e56e70D7d` |
| SHOSStaking | `0x20A4575afFE3bDdcb7638D5572A5605E79144fE8` |
| SHOS (ERC-20, 18 decimals) | `0xe574Ee12e790b94e56f2bf13a74A9729862B0a46` |
| USDG (Paxos, 6 decimals) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |

Explorer: https://robinhoodchain.blockscout.com. Payments are in USDG. Platform fee: 3 % on top of the app price, reduced by the payer owner's SHOS stake.

## Payment flow

1. `GET /x402/<app>` without payment returns `402` and `accepts[0]`: `scheme: exact`, `network: robinhood`, `asset` = USDG, `payTo` = router, `maxAmountRequired` = price + fee in USDG units, `maxTimeoutSeconds: 60`.
2. The client signs EIP-712 `ReceiveWithAuthorization` for domain `{ name: "Global Dollar", version: "1", chainId: 4663, verifyingContract: USDG }` with `to` = router, `value` = `maxAmountRequired`, random 32-byte `nonce`, `validAfter: 0`, `validBefore` = now + 60 s. No transaction is sent by the client.
3. The client repeats the request with `X-PAYMENT: base64(JSON)`:

```json
{ "x402Version": 1, "scheme": "exact", "network": "robinhood",
  "payload": { "signature": "0x…", "authorization": { "from", "to", "value", "validAfter", "validBefore", "nonce" } } }
```

4. The backend verifies the signature, simulates and submits `SherwoodRouter.settle(appId, authorization)` from the relayer key. The router checks the app, the agent's policy (per-request, daily, per-app limits), pulls USDG via `receiveWithAuthorization`, pays 97 % to the provider and 3 % to the treasury and emits `Paid(receiptId, agent, appId, provider, amount, fee, nonce, receiptNo)`, `receiptId = keccak256(agent ‖ appId ‖ nonce)`.
5. The response carries `X-PAYMENT-RESPONSE: base64({ success, transaction, receiptId, receiptNo, blockNumber, amount, fee })`. `GET /api/receipt/:tx` decodes the event and the USDG transfers.

A refused payment is a `402` with `errorReason` (`AuthorizationUsed`, `DailyLimit`, `PerRequestLimit`, `AppDailyLimit`, `NoPolicy`, `AppInactive`, `invalid signature`, …). `GET /x402` lists the apps, prices, app ids and providers.

## Contracts source

`contracts/` is a Foundry project, Solidity 0.8.28. Tests run on a fork of Robinhood Chain against the real USDG bytecode.

- `SherwoodRouter` — `settle()` (facilitator only); `apps`, `policies`, `perAppDailyLimit` (0 = unlimited), `spentOnDay` per UTC day, `feeFor()` with the staking discount, `quote()`, `remainingToday()`; owner-only `setApp`, `setPolicy`, `setAppLimit`, `setTreasury` (≤ 20 %), `setFacilitator`, `setStaking`, `setOwner`. Zero addresses are rejected.
- `SHOSStaking` — stakes the ERC-20 given at construction; tiers scaled by its decimals: ≥ 10 000 → −10 % fee, ≥ 100 000 → −25 %, ≥ 1 000 000 → −50 %. Low-level transfers accept tokens with and without `bool` returns; the staked amount is what arrived. Unstake is instant.
- `SHOS` — reference fixed-supply ERC-20 used on forks.

```bash
cd contracts
forge build
FORK_RPC_URL=http://127.0.0.1:8663 forge test -vv
```

`bun run contracts:build` copies ABI and bytecode into `backend/src/chain/artifacts`; the backend deploys from there.

## Backend

Bun + Hono, one process, one port (3000). SQLite via `bun:sqlite`: `/data/app.db` in the container, `./data/app.db` locally.

| Path | Contents |
|---|---|
| `src/x402/` | wire format, paywall middleware, client used by the agents |
| `src/chain/` | viem clients with ranked RPC fallback, bootstrap, facilitator |
| `src/apps/` | catalog; Market Data (Yahoo, Stooq), Search (HN Algolia, Wikipedia), News (Google News RSS, sentiment), Compute (RSI, SMA, momentum, volatility), Storage (sha256), Trading (paper) |
| `src/agents/` | Trader, Researcher, Scout, Operator: runtime loop, task context, playbooks, budget pacing, threads |
| `src/api/` | read API and SSE `/api/stream` |
| `src/rpcProxy.ts` | fork mode: allow-listed JSON-RPC passthrough |

### Modes

`CHAIN_MODE=fork` — anvil fork of Robinhood Chain next to the backend; contracts deploy at boot, apps and policies are registered, agents receive test USDG by writing the token balance slot. State persists in `/data`.

`CHAIN_MODE=mainnet` — `bun run deploy:mainnet` deploys or reuses the contracts and writes the addresses to `.env`. At boot the backend checks code at the addresses, `facilitator` = `PRIVATE_KEY`, the USDG and staking wiring, and reconciles apps and limits on-chain (writes only differences). Switching modes clears activity, receipts and messages.

### Run

```bash
bun install
bun run gen:keys
cp .env.example .env
bun run dev:chain
bun run start
bun run audit:x402
```

`GET /api/health` reports chain readiness and the last boot error; the process keeps listening and retries.

### Mainnet

```bash
bun run deploy:mainnet
bun run handover -- --treasury 0x… --shos-to 0x… --owner 0x…
bun run swap:fund -- --trader 15 --researcher 10 [--yes]
bun run fund:agents -- --trader 15 --researcher 10
bun run start
```

A settlement is 180–200k gas. Deployment and configuration ≈ 4.5M gas.

### Docker

```bash
bun run docker:build
bun run docker:run
```

Fork mode starts anvil inside the container; mainnet mode starts the backend only.

## Configuration

| Key | Meaning |
|---|---|
| `CHAIN_MODE` | `fork` or `mainnet` |
| `FORK_RPC_URL` | archive endpoint for anvil |
| `RPC_URL` | local anvil (fork mode) |
| `MAINNET_RPC_URL` | comma-separated endpoints, ranked by availability |
| `PRIVATE_KEY` | relayer = deployer = facilitator |
| `AGENT_MNEMONIC` | agents at HD indices 0–3, providers at 10–15 |
| `ROUTER_ADDRESS`, `SHOS_ADDRESS`, `STAKING_ADDRESS`, `TREASURY_ADDRESS` | written by `deploy:mainnet`; `SHOS_ADDRESS` may be an existing token |
| `PLATFORM_FEE_BPS` | 300 = 3 % |
| `AGENT_DAILY_LIMIT_USD`, `AGENT_PER_REQUEST_MAX_USD`, `AGENT_PER_APP_DAILY_USD` | agent policies, mirrored on-chain |
| `AGENT_TASK_INTERVAL_SEC`, `AGENT_FUND_USD` | task cadence; test funding on forks |

Agents without USDG stop taking paid work and resume when funded.

## HTTP

- `GET /x402`, `GET|POST /x402/<app>`, `GET /x402/quote/:id`, `GET /x402/storage/:key`
- `GET /api/config`, `/api/agents[/:id]`, `/api/apps[/:id]`, `/api/activity`, `/api/payments`, `/api/threads`, `/api/messages`, `/api/tasks`, `/api/wallet/:agent`, `/api/receipt/:tx`, `/api/stats`, `/api/shos`, `/api/health`, `/api/stream` (SSE: `activity`, `message`, `payment`, `status`, `balance`, `system`)
- `POST /rpc` — fork mode only

CORS is open. Payment headers: `X-PAYMENT` (request), `X-PAYMENT-RESPONSE` (response).

## Keys

The relayer key signs every settlement and owns the router and the treasury after deployment. `bun run handover` moves ownership, the treasury and the token balance to another wallet; the relayer keeps the facilitator role. `.env` is ignored by git.

## License

See [LICENSE](LICENSE).
