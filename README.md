# allot-api

The Allot sample **x402** API, a Cloudflare Worker. It sells a live price of a Robinhood Chain market for **0.01 USDG**.

Try it: https://allot-api.polished-dream-0948.workers.dev/v1/price?symbol=NVDA (answers `402 Payment Required`)

## Endpoints

| Path | Price | Returns |
| --- | --- | --- |
| `/` | free | info, symbols, payee |
| `/health` | free | whether the price source answers |
| `/v1/price?symbol=NVDA` | 0.01 USDG | a live quote of 1,000 USDG via KyberSwap on Robinhood Chain |

Symbols: ETH, BTC, NVDA, TSLA, AAPL, AMZN, GOOGL, META, MSFT, SPY, QQQ, GLD, COIN, MSTR.

## Payer settlement: no key, no funds on the server

x402 v2 `exact` on USDG with `extra.settlement: "payer"`:

1. Without payment the API answers 402 with an offer and a one-time nonce: an HMAC of the resource and an expiry, so no storage is needed.
2. The payer settles its own EIP-3009 authorization on chain and sends the transaction hash in `PAYMENT-SIGNATURE`.
3. The API reads the receipt from Robinhood Chain and checks: the transaction succeeded, a USDG transfer of at least the price reached the payee, and `AuthorizationUsed` carries the nonce this API issued.
4. One transaction, one answer. A replayed transaction is refused.

The server never holds a private key or funds.

## Deploy

1. Create a Cloudflare Worker and paste `worker.js`.
2. Set `PAY_TO` (the address that receives payments) and the secret `CHALLENGE_SECRET` (32+ random characters).
3. Pay it with [allot-connector](https://github.com/byte402/allot-connector):

```
npx -y github:byte402/allot-connector pay https://your-worker.workers.dev/v1/price?symbol=NVDA --confirm 0.01
```

## License

MIT
