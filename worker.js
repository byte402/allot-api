// Allot sample x402 API (Cloudflare Worker).
// Paid endpoints, all real data read live from Robinhood Chain mainnet and KyberSwap:
//   GET /v1/price?symbol=NVDA                    one market price                    0.01 USDG
//   GET /v1/prices                               every market in one call            0.02 USDG
//   GET /v1/quote?from=USDG&to=NVDA&amount=100   a swap quote with route and gas     0.01 USDG
//   GET /v1/wallet?address=0x…                   ETH, USDG and market token balances 0.01 USDG
//   GET /v1/chain                                block, gas, block time, USDG supply 0.005 USDG
// x402 v2 "exact" on USDG with payer settlement: the payer settles its own EIP-3009 authorization on chain and
// sends the transaction hash. This server holds no private key and no funds: it only reads the receipt from
// Robinhood Chain and checks the exact transfer before it serves the data.
// env: PAY_TO (address that receives payments), CHALLENGE_SECRET (any long random string, used to sign nonces)
const RPC = "https://rpc.mainnet.chain.robinhood.com", KYBER = "https://aggregator-api.kyberswap.com/robinhood/api/v1";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const UA = "allot-api/0.2 (+https://allot.dev)";
const T_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const T_AUTH_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
const MARKETS = { ETH: ["0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", 18], BTC: ["0xcec185eb182c47d1ba1efc84e6959e18cd620be4", 8], NVDA: ["0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", 18], TSLA: ["0x322f0929c4625ed5bad873c95208d54e1c003b2d", 18], AAPL: ["0xaf3d76f1834a1d425780943c99ea8a608f8a93f9", 18], AMZN: ["0x12f190a9f9d7d37a250758b26824b97ce941bf54", 18], GOOGL: ["0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3", 18], META: ["0xc0d6457c16cc70d6790dd43521c899c87ce02f35", 18], MSFT: ["0xe93237c50d904957cf27e7b1133b510c669c2e74", 18], SPY: ["0x117cc2133c37b721f49de2a7a74833232b3b4c0c", 18], QQQ: ["0xd5f3879160bc7c32ebb4dc785f8a4f505888de68", 18], GLD: ["0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e", 18], COIN: ["0x6330d8c3178a418788df01a47479c0ce7ccf450b", 18], MSTR: ["0xec262a75e413fafd0df80480274532c79d42da09", 18] };
const json = (o, status = 200, h = {}) => new Response(JSON.stringify(o, null, 2), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-expose-headers": "payment-required, payment-response", ...h } });
const b64 = (o) => btoa(JSON.stringify(o)), unb64 = (s) => JSON.parse(atob(s));
const lower = (a) => String(a || "").toLowerCase(), topicAddr = (a) => "0x" + lower(a).replace(/^0x/, "").padStart(64, "0");
// Robinhood Chain RPC, with retries: Cloudflare egress IPs are shared and the RPC can answer 429 for a moment
async function rpc(method, params) {
  let last;
  for (let k = 0; k < 6; k++) {
    try { const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json", "user-agent": UA }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (r.status === 429 || r.status >= 500) throw new Error(r.status === 429 ? "Too Many Requests" : `RPC ${r.status}`);
      const j = await r.json(); if (j.error) { if (j.error.code === 429 || /rate|too many/i.test(j.error.message)) throw new Error("Too Many Requests"); return Promise.reject(Object.assign(new Error(j.error.message), { final: true })); } return j.result;
    } catch (e) { if (e.final) throw e; last = e; await new Promise((res) => setTimeout(res, 700 * (k + 1))); }
  }
  throw Object.assign(last || new Error("RPC unavailable"), { retry: true });
}
// a just-mined receipt can lag on a public RPC node: wait a little before calling it missing
async function getReceiptPatiently(h) { for (let k = 0; k < 6; k++) { const rc = await rpc("eth_getTransactionReceipt", [h]); if (rc) return rc; await new Promise((res) => setTimeout(res, 1500)); } return null; }
async function hmacHex(secret, msg) { const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)); return "0x" + [...new Uint8Array(s)].map((b) => b.toString(16).padStart(2, "0")).join(""); }

// one-time challenge: the EIP-3009 nonce the payer must use, bound to this resource and an expiry, no storage needed
async function offer(env, resource, price) {
  const expires = Math.floor(Date.now() / 1000) + 300, nonce = await hmacHex(env.CHALLENGE_SECRET, `${resource}|${expires}`);
  return { scheme: "exact", network: "eip155:4663", amount: price.toString(), asset: USDG, payTo: env.PAY_TO, maxTimeoutSeconds: 300, resource,
    extra: { name: "Global Dollar", version: "1", settlement: "payer", nonce, expires } };
}

// verify a settled payment from its receipt logs. Exported for tests.
export async function verifyPayment(env, resource, header, getReceipt, price = 10000n) {
  const p = unb64(header), acc = p.accepted || {}, a = p.payload?.authorization || {}, tx = p.payload?.settlementTx;
  if (!tx || !/^0x[0-9a-fA-F]{64}$/.test(tx)) return "missing settlement transaction";
  if (acc.resource !== resource) return "payment is for another resource";
  if (Number(acc.extra?.expires) < Math.floor(Date.now() / 1000) - 600) return "offer expired";
  if (lower(a.nonce) !== lower(await hmacHex(env.CHALLENGE_SECRET, `${resource}|${acc.extra?.expires}`))) return "nonce is not one this API issued";
  if (lower(a.to) !== lower(env.PAY_TO) || BigInt(a.value || 0) < price) return "wrong payee or amount";
  const rc = await getReceipt(tx);
  if (!rc || rc.status !== "0x1") return "settlement transaction not found or failed";
  const logs = rc.logs.filter((l) => lower(l.address) === USDG);
  const paid = logs.some((l) => l.topics[0] === T_TRANSFER && lower(l.topics[1]) === topicAddr(a.from) && lower(l.topics[2]) === topicAddr(env.PAY_TO) && BigInt(l.data) >= price);
  const used = logs.some((l) => l.topics[0] === T_AUTH_USED && lower(l.topics[1]) === topicAddr(a.from) && lower(l.topics[2]) === lower(a.nonce));
  if (!paid) return "no USDG transfer to this API in that transaction";
  if (!used) return "that transaction did not use this API's nonce";
  return null;
}

async function livePrice(symbol) {
  const [addr, dec] = MARKETS[symbol];
  // KyberSwap refuses requests without a User-Agent (403 HTML), so send one
  const res = await fetch(`${KYBER}/routes?tokenIn=${USDG}&tokenOut=${addr}&amountIn=1000000000`, { headers: { "x-client-id": "allot", "user-agent": UA, accept: "application/json" } });
  let r; try { r = await res.json(); } catch { throw new Error(`price source answered ${res.status}, no quote right now`); }
  if (r.code !== 0) throw new Error("no quote right now");
  const out = Number(BigInt(r.data.routeSummary.amountOut)) / 10 ** dec;
  return { symbol, priceUsdg: +(1000 / out).toPrecision(8), quotedWith: "1,000 USDG via KyberSwap on Robinhood Chain", at: new Date().toISOString() };
}

// JSON-RPC batches of a few calls each; the public node rate-limits big batches, so a refused chunk falls back to single calls
async function rpcBatch(calls, size = 4) {
  const out = [];
  for (let i = 0; i < calls.length; i += size) {
    const part = calls.slice(i, i + size); let got = null;
    for (let k = 0; k < 2 && !got; k++) {
      try { const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json", "user-agent": UA }, body: JSON.stringify(part.map(([method, params], id) => ({ jsonrpc: "2.0", id, method, params }))) });
        if (r.status !== 200) throw new Error("RPC " + r.status); const j = await r.json(); if (!Array.isArray(j) || j.some((x) => x.error)) throw new Error("RPC batch refused");
        got = []; for (const x of j) got[x.id] = x.result;
      } catch { await new Promise((res) => setTimeout(res, 600 * (k + 1))); }
    }
    if (!got) { got = []; for (const [method, params] of part) got.push(await rpc(method, params)); }
    out.push(...got);
  }
  return out;
}
const fmtUnits = (v, dec) => { const s = BigInt(v).toString().padStart(dec + 1, "0"), i = s.slice(0, -dec) || "0", f = s.slice(-dec).replace(/0+$/, ""); return f ? `${i}.${f}` : i; };
const toUnits = (s, dec) => { if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("amount must be a plain number, like 100 or 0.5"); const [i, f = ""] = s.split("."); if (f.length > dec) throw new Error(`amount has more than ${dec} decimals`); return BigInt(i + f.padEnd(dec, "0")); };
const TOKENS = { USDG: [USDG, 6], ...MARKETS };

async function allPrices() {
  const rows = await Promise.allSettled(Object.keys(MARKETS).map((s) => livePrice(s)));
  const prices = {}, missing = [];
  rows.forEach((r, i) => { const s = Object.keys(MARKETS)[i]; if (r.status === "fulfilled") prices[s] = r.value.priceUsdg; else missing.push(s); });
  if (!Object.keys(prices).length) throw new Error("no quotes right now");
  return { prices, unit: "USDG per 1 token", missing, quotedWith: "1,000 USDG per market via KyberSwap on Robinhood Chain", at: new Date().toISOString() };
}

async function swapQuote(from, to, amount) {
  const [ai, di] = TOKENS[from], [ao, dout] = TOKENS[to], amountIn = toUnits(amount, di);
  if (amountIn <= 0n) throw Object.assign(new Error("amount must be more than 0"), { bad: true });
  const res = await fetch(`${KYBER}/routes?tokenIn=${ai}&tokenOut=${ao}&amountIn=${amountIn}`, { headers: { "x-client-id": "allot", "user-agent": UA, accept: "application/json" } });
  let r; try { r = await res.json(); } catch { throw new Error(`quote source answered ${res.status}, no quote right now`); }
  if (r.code !== 0) throw new Error("no route for that pair or amount right now");
  const q = r.data.routeSummary, out = fmtUnits(q.amountOut, dout);
  return { from, to, amountIn: amount, amountOut: out, rate: +(Number(out) / Number(amount)).toPrecision(8), amountInUsd: +(+q.amountInUsd).toFixed(4), amountOutUsd: +(+q.amountOutUsd).toFixed(4),
    gasUsd: +(+q.gasUsd).toFixed(6), venues: [...new Set(q.route.flat().map((h) => h.exchange))], source: "KyberSwap on Robinhood Chain", note: "a quote, not an order: nothing is swapped", at: new Date().toISOString() };
}

async function walletBalances(address) {
  const syms = Object.keys(TOKENS).filter((s) => s !== "ETH");
  const calls = [["eth_getBalance", [address, "latest"]], ["eth_blockNumber", []], ...syms.map((s) => ["eth_call", [{ to: TOKENS[s][0], data: "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0") }, "latest"]])];
  const r = await rpcBatch(calls), balances = { ETH: fmtUnits(r[0], 18) };
  syms.forEach((s, i) => { const v = r[i + 2]; if (v && v !== "0x" && BigInt(v) > 0n) balances[s] = fmtUnits(v, TOKENS[s][1]); });
  return { address, balances, onlyNonZero: true, block: parseInt(r[1], 16), network: "Robinhood Chain mainnet (4663)", at: new Date().toISOString() };
}

async function chainStats() {
  const head = await rpc("eth_getBlockByNumber", ["latest", false]), n = parseInt(head.number, 16);
  const [old, gasPrice, supply] = await rpcBatch([["eth_getBlockByNumber", ["0x" + (n - 1000).toString(16), false]], ["eth_gasPrice", []], ["eth_call", [{ to: USDG, data: "0x18160ddd" }, "latest"]]]);
  const secs = parseInt(head.timestamp, 16) - parseInt(old.timestamp, 16);
  return { block: n, blockTime: new Date(parseInt(head.timestamp, 16) * 1000).toISOString(), avgBlockSeconds: +(secs / 1000).toFixed(3),
    gasPriceGwei: +(Number(BigInt(gasPrice)) / 1e9).toPrecision(6), baseFeeGwei: head.baseFeePerGas ? +(Number(BigInt(head.baseFeePerGas)) / 1e9).toPrecision(6) : null,
    usdgTotalSupply: fmtUnits(supply, 6), network: "Robinhood Chain mainnet (4663)", at: new Date().toISOString() };
}

// every paid route: its price in USDG base units, how to read and canonicalise its query, and how to fetch the data
const ROUTES = {
  "/v1/price": { price: 10000n, parse: (q) => { const symbol = String(q.get("symbol") || "NVDA").toUpperCase(); if (!MARKETS[symbol]) throw { error: "unknown symbol", symbols: Object.keys(MARKETS) }; return { query: `symbol=${symbol}`, run: () => livePrice(symbol) }; } },
  "/v1/prices": { price: 20000n, parse: () => ({ query: "", run: allPrices }) },
  "/v1/quote": { price: 10000n, parse: (q) => { const from = String(q.get("from") || "USDG").toUpperCase(), to = String(q.get("to") || "").toUpperCase(), amount = String(q.get("amount") || "");
    if (!TOKENS[from] || !TOKENS[to] || from === to) throw { error: "from and to must be two different tokens", tokens: Object.keys(TOKENS) };
    let units; try { units = toUnits(amount, TOKENS[from][1]); } catch (e) { throw { error: e.message }; }
    if (units <= 0n) throw { error: "amount must be more than 0" };
    return { query: `from=${from}&to=${to}&amount=${amount}`, run: () => swapQuote(from, to, amount) }; } },
  "/v1/wallet": { price: 10000n, parse: (q) => { const address = String(q.get("address") || "").toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(address)) throw { error: "address must be a 0x address" }; return { query: `address=${address}`, run: () => walletBalances(address) }; } },
  "/v1/chain": { price: 5000n, parse: () => ({ query: "", run: chainStats }) },
};
const usdg = (p) => fmtUnits(p, 6) + " USDG";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "payment-signature, content-type" } });
    if (url.pathname === "/") return json({ name: "Allot sample x402 API", endpoints: { "/v1/price?symbol=NVDA": usdg(ROUTES["/v1/price"].price), "/v1/prices": usdg(ROUTES["/v1/prices"].price), "/v1/quote?from=USDG&to=NVDA&amount=100": usdg(ROUTES["/v1/quote"].price), "/v1/wallet?address=0x…": usdg(ROUTES["/v1/wallet"].price), "/v1/chain": usdg(ROUTES["/v1/chain"].price) }, symbols: Object.keys(MARKETS), tokens: Object.keys(TOKENS), network: "eip155:4663", asset: USDG, payTo: env.PAY_TO });
    // free check, no data: are the sources reachable from here? Lets anyone test before paying
    if (url.pathname === "/health") { let priceSource, chain; try { await livePrice("NVDA"); priceSource = "ok"; } catch (e) { priceSource = e.message; } try { await rpc("eth_blockNumber", []); chain = "ok"; } catch (e) { chain = e.message; } return json({ ok: priceSource === "ok" && chain === "ok", priceSource, chain, version: "4" }); }
    const route = ROUTES[url.pathname];
    if (!route) return json({ error: "not found", endpoints: Object.keys(ROUTES) }, 404);
    if (!/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO || "") || String(env.CHALLENGE_SECRET || "").length < 32) return json({ error: "API not configured yet: set PAY_TO (address) and CHALLENGE_SECRET (secret, 32+ characters) in Settings, Variables and Secrets" }, 503);
    let job; try { job = route.parse(url.searchParams); } catch (e) { return json(e.error ? e : { error: String(e.message || e) }, 400); }
    // the resource is canonical, so the nonce binds the payment to exactly this request
    const resource = `${url.origin}${url.pathname}${job.query ? "?" + job.query : ""}`, header = req.headers.get("payment-signature") || req.headers.get("x-payment");
    const ask = async (error) => { const o = await offer(env, resource, route.price); return json({ error, accepts: [o] }, 402, { "payment-required": b64({ x402Version: 2, resource: { url: resource }, accepts: [o] }) }); };
    if (!header) return ask("payment required");
    let why; try { why = await verifyPayment(env, resource, header, env.__getReceipt || getReceiptPatiently, route.price); }
    catch (e) { return json({ error: "could not read the payment right now (" + e.message + "). It is not used yet: send the same payment-signature header again" }, 503, { "retry-after": "5" }); }
    if (why) return ask(why);
    // one tx, one response: remember settled transactions for a day
    const tx = unb64(header).payload.settlementTx, key = new Request(`https://used.allot/${tx}`), cache = caches.default;
    if (await cache.match(key)) return json({ error: "this payment was already used" }, 402);
    let data; try { data = await job.run(); } catch (e) { return json({ error: e.message + ", your payment is not used yet: retry with the same header" }, e.bad ? 400 : 503); }
    await cache.put(key, new Response("1", { headers: { "cache-control": "max-age=86400" } })); // longer than any offer can stay valid
    return json(data, 200, { "payment-response": b64({ success: true, network: "eip155:4663", transaction: tx }) });
  },
};
