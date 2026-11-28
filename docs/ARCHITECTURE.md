# Allot architecture

Allot lets an AI agent pay for x402 APIs in USDG on Robinhood Chain (chain id 4663) without ever holding the owner's funds or keys. This page lists every moving part, where it runs, and what it can and cannot do.

## The four parts

| Part | Where it runs | Holds keys? | Holds funds? |
| --- | --- | --- | --- |
| **AllotVault + AllotFactory** | Robinhood Chain mainnet | no | yes, the owner's USDG, under the vault rules |
| **allot-connector** | the user's own machine (MCP server or terminal) | the AI's agent key only | no |
| **allot-api** (this repo) | a Netlify Function deployed from this repo (or a Cloudflare Worker) | no | no, payments go straight to `PAY_TO` |
| **allot.dev** | GitHub Pages, static files | no | no |

```
 owner wallet ──(sign: create vault, set rules)──▶ AllotVault ◀── reads ── allot.dev (Ledger, app)
                                                     ▲
 AI agent ── allot-connector ──(agent key: pay / authorize)──┘
                │
                └──▶ x402 API (e.g. allot-api) ── reads the receipt ──▶ Robinhood Chain
```

## 1. Vault contracts (on chain)

- Factory: `0xc2623e62d5fae1eeebc2990a9d51f9e69a8a9092`, source verified on Sourcify (exact match), [view](https://sourcify.dev/server/v2/contract/4663/0xc2623e62d5fae1eeebc2990a9d51f9e69a8a9092).
- `create()` deploys one vault per call; the caller is its owner. `vaultsOf(owner)` lists them.
- The owner sets each agent with `setAgent(agent, perPayment, perDay, expiry, active)` and approves payees with `setPayee`. `revoke`, `setFrozen` and `withdraw` are owner only.
- An agent can only `pay` or `authorize` an approved payee, within its per-payment cap, its daily limit and before its expiry, and never while the vault is frozen.
- x402 payments are EIP-3009 authorizations on USDG signed by the vault itself through ERC-1271 (`isValidSignature`). `release` cancels an authorization that was not settled.
- There is no admin besides the owner and no upgrade path.

Events (`AgentSet`, `PayeeSet`, `Paid`, `Authorized`, `Released`, `Frozen`, `Withdrawn`) are the public record. The Ledger on allot.dev is built only from these logs.

## 2. allot-connector (user's machine)

- An MCP server (`allot_status`, `allot_find`, `allot_pay_x402`, `allot_pay`) and a terminal command, from [byte402/allot-connector](https://github.com/byte402/allot-connector).
- It holds only the agent key, read from the user's local config. A leaked agent key is still bound by the vault rules above.
- Every transaction is simulated on mainnet with `eth_simulateV1` before it is sent. In the terminal nothing is sent until the user repeats the command with `--confirm <max amount>`.

## 3. allot-api (Netlify Function or Cloudflare Worker)

- A sample x402 seller. Paid routes answer `402` with an offer and a one-time nonce (an HMAC of the resource and an expiry, so no storage).
- Payer settlement: the buyer settles its own authorization and sends the transaction hash. The worker reads the receipt from Robinhood Chain and checks the transfer to `PAY_TO`, the price and the `AuthorizationUsed` nonce before it answers.
- One transaction buys one answer. On Netlify settled transactions are kept in Netlify Blobs with strong consistency, so a replay is refused everywhere. On Cloudflare they sit in the cache for a day, per data center. Hashes are compared in lower case, so a replay in another letter case is refused too.
- `/version` reports the version, this repo and the commit. On Netlify the build writes the commit it deploys; on Cloudflare the deployer sets `GIT_COMMIT`.

**What `/version` does not prove.** A server cannot prove which code it runs. On Netlify the commit comes from the build that deployed this repo, which is as close as hosting gets, but it is still reported by the server itself. What anyone can check is behaviour: the worker never asks for a key, every payment it accepts is a real on-chain transfer to the published `PAY_TO`, and the source here is short enough to read in one sitting.

## 4. allot.dev (static site)

- Plain HTML and JavaScript on GitHub Pages, no backend and no database.
- Writes (create vault, add agent, set payee, freeze, withdraw) are prepared in the page, simulated, then signed in the user's own wallet.
- The Ledger reads vault events straight from the public RPC. In our use the RPC refused long-range `eth_getLogs` filters with several addresses in one position, while single-address filters passed, so the Ledger asks for each vault's logs separately over its full history.

## Trust summary

- Your funds sit in a contract only you control, with limits your agent cannot exceed.
- No Allot server holds a private key or user funds.
- Everything on chain is verifiable: contract source on Sourcify, every payment as an event.
