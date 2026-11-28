# allot-api

The Allot sample **x402** API, a Cloudflare Worker. It sells live data from Robinhood Chain mainnet, paid per call in **USDG**.

Try it: https://allot-api.polished-dream-0948.workers.dev/v1/price?symbol=NVDA (answers `402 Payment Required`)

## Endpoints

| Path | Price | Returns |
| --- | --- | --- |
| `/` | free | info, symbols, payee |
| `/health` | free | whether the price source and the chain answer |
| `/version` | free | version, source repo and the commit this deployment says it runs |
| `/v1/price?symbol=NVDA` | 0.01 USDG | one market price, from a live quote of 1,000 USDG via KyberSwap |
| `/v1/prices` | 0.02 USDG | every market price in one call |
| `/v1/quote?from=USDG&to=NVDA&amount=100` | 0.01 USDG | a swap quote: amount out, rate, USD values, gas and venues. A quote only, nothing is swapped |
| `/v1/wallet?address=0x…` | 0.01 USDG | ETH, USDG and market token balances of an address (non-zero only) |
| `/v1/chain` | 0.005 USDG | latest block, average block time, gas price, base fee and USDG total supply |

Markets: ETH, BTC, NVDA, TSLA, AAPL, AMZN, GOOGL, META, MSFT, SPY, QQQ, GLD, COIN, MSTR. `/v1/quote` also takes USDG.

Every answer is read live from Robinhood Chain mainnet or KyberSwap at request time. The paid resource is canonical (symbols upper case, addresses lower case), so a payment buys exactly the request it was offered for.

## Payer settlement: no key, no funds on the server

x402 v2 `exact` on USDG with `extra.settlement: "payer"`:

1. Without payment the API answers 402 with an offer and a one-time nonce: an HMAC of the resource and an expiry, so no storage is needed.
2. The payer settles its own EIP-3009 authorization on chain and sends the transaction hash in `PAYMENT-SIGNATURE`.
3. The API reads the receipt from Robinhood Chain and checks: the transaction succeeded, a USDG transfer of at least that endpoint's price reached the payee, and `AuthorizationUsed` carries the nonce this API issued.
4. One transaction, one answer. A replayed transaction is refused. Settled transactions are remembered in Cloudflare's cache, which is kept per data center: for strict one-time use everywhere, store them in Workers KV or a Durable Object.

The server never holds a private key or funds.

## Deploy

1. Create a Cloudflare Worker and paste `worker.js`.
2. Set `PAY_TO` (the address that receives payments) and the secret `CHALLENGE_SECRET` (32+ random characters).
   Optional: set `GIT_COMMIT` to the commit of this repo you copied `worker.js` from. `/version` shows it with a link to that exact file.
3. Pay it with [allot-connector](https://github.com/byte402/allot-connector):

```
npx -y github:byte402/allot-connector pay https://your-worker.workers.dev/v1/price?symbol=NVDA --confirm 0.01
npx -y github:byte402/allot-connector pay https://your-worker.workers.dev/v1/prices --confirm 0.02
```

## Add your own endpoint

Every paid route is one entry in `ROUTES` in `worker.js`: a price in USDG base units (6 decimals, `10000n` = 0.01 USDG), a canonical query, and the data to return. The free index at `/` lists every route and its price automatically.

```js
// inside const ROUTES = { … }
"/v1/gas": { price: 1000n, parse: () => ({ query: "", run: async () => ({
  gasPriceGwei: Number(BigInt(await rpc("eth_gasPrice", []))) / 1e9,
  at: new Date().toISOString(),
}) }) },
```

For a route that takes parameters, read them in `parse(q)`, reject bad input by throwing `{ error: "…" }` (answered as 400 before any payment), and return the canonical query so a payment buys exactly that request. See `/v1/quote` and `/v1/wallet` in `worker.js`.

Check it: `curl -i https://your-worker.workers.dev/v1/gas` must answer 402 with the offer. Buyers add your `PAY_TO` to their AI's approved payees, then pay with the connector.

Guide: https://allot.dev/build

## What runs where

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the vault contracts, the connector, this API and the site, and what each one can and cannot do.

## License

MIT
