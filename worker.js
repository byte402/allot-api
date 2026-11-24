// Allot sample x402 API (Cloudflare Worker).
// GET /v1/price?symbol=NVDA → live price of a Robinhood Chain market from a real KyberSwap quote, for 0.01 USDG.
// x402 v2 "exact" on USDG with payer settlement: the payer settles its own EIP-3009 authorization on chain and
// sends the transaction hash. This server holds no private key and no funds: it only reads the receipt from
// Robinhood Chain and checks the exact transfer before it serves the data.
// env: PAY_TO (address that receives payments), CHALLENGE_SECRET (any long random string, used to sign nonces)
const RPC = "https://rpc.mainnet.chain.robinhood.com", KYBER = "https://aggregator-api.kyberswap.com/robinhood/api/v1";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168", PRICE = 10000n; // 0.01 USDG
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
    try { const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json", "user-agent": "allot-api/0.1 (+https://allot.dev)" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
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
async function offer(env, resource) {
  const expires = Math.floor(Date.now() / 1000) + 300, nonce = await hmacHex(env.CHALLENGE_SECRET, `${resource}|${expires}`);
  return { scheme: "exact", network: "eip155:4663", amount: PRICE.toString(), asset: USDG, payTo: env.PAY_TO, maxTimeoutSeconds: 300, resource,
    extra: { name: "Global Dollar", version: "1", settlement: "payer", nonce, expires } };
}

// verify a settled payment from its receipt logs. Exported for tests.
export async function verifyPayment(env, resource, header, getReceipt) {
  const p = unb64(header), acc = p.accepted || {}, a = p.payload?.authorization || {}, tx = p.payload?.settlementTx;
  if (!tx || !/^0x[0-9a-fA-F]{64}$/.test(tx)) return "missing settlement transaction";
  if (acc.resource !== resource) return "payment is for another resource";
  if (Number(acc.extra?.expires) < Math.floor(Date.now() / 1000) - 600) return "offer expired";
  if (lower(a.nonce) !== lower(await hmacHex(env.CHALLENGE_SECRET, `${resource}|${acc.extra?.expires}`))) return "nonce is not one this API issued";
  if (lower(a.to) !== lower(env.PAY_TO) || BigInt(a.value || 0) < PRICE) return "wrong payee or amount";
  const rc = await getReceipt(tx);
  if (!rc || rc.status !== "0x1") return "settlement transaction not found or failed";
  const logs = rc.logs.filter((l) => lower(l.address) === USDG);
  const paid = logs.some((l) => l.topics[0] === T_TRANSFER && lower(l.topics[1]) === topicAddr(a.from) && lower(l.topics[2]) === topicAddr(env.PAY_TO) && BigInt(l.data) >= PRICE);
  const used = logs.some((l) => l.topics[0] === T_AUTH_USED && lower(l.topics[1]) === topicAddr(a.from) && lower(l.topics[2]) === lower(a.nonce));
  if (!paid) return "no USDG transfer to this API in that transaction";
  if (!used) return "that transaction did not use this API's nonce";
  return null;
}

async function livePrice(symbol) {
  const [addr, dec] = MARKETS[symbol];
  // KyberSwap refuses requests without a User-Agent (403 HTML), so send one
  const res = await fetch(`${KYBER}/routes?tokenIn=${USDG}&tokenOut=${addr}&amountIn=1000000000`, { headers: { "x-client-id": "allot", "user-agent": "allot-api/0.1 (+https://allot.dev)", accept: "application/json" } });
  let r; try { r = await res.json(); } catch { throw new Error(`price source answered ${res.status}, no quote right now`); }
  if (r.code !== 0) throw new Error("no quote right now");
  const out = Number(BigInt(r.data.routeSummary.amountOut)) / 10 ** dec;
  return { symbol, priceUsdg: +(1000 / out).toPrecision(8), quotedWith: "1,000 USDG via KyberSwap on Robinhood Chain", at: new Date().toISOString() };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "payment-signature, content-type" } });
    if (url.pathname === "/") return json({ name: "Allot sample x402 API", endpoints: { "/v1/price?symbol=NVDA": "0.01 USDG" }, symbols: Object.keys(MARKETS), network: "eip155:4663", asset: USDG, payTo: env.PAY_TO });
    // free check, no data: is the price source reachable from here? Lets anyone test before paying
    if (url.pathname === "/health") { let priceSource; try { await livePrice("NVDA"); priceSource = "ok"; } catch (e) { priceSource = e.message; } return json({ ok: priceSource === "ok", priceSource, version: "3" }); }
    if (url.pathname !== "/v1/price") return json({ error: "not found" }, 404);
    if (!/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO || "") || String(env.CHALLENGE_SECRET || "").length < 32) return json({ error: "API not configured yet: set PAY_TO (address) and CHALLENGE_SECRET (secret, 32+ characters) in Settings, Variables and Secrets" }, 503);
    const symbol = String(url.searchParams.get("symbol") || "NVDA").toUpperCase();
    if (!MARKETS[symbol]) return json({ error: "unknown symbol", symbols: Object.keys(MARKETS) }, 400);
    const resource = `${url.origin}/v1/price?symbol=${symbol}`, header = req.headers.get("payment-signature") || req.headers.get("x-payment");
    if (!header) { const o = await offer(env, resource); return json({ error: "payment required", accepts: [o] }, 402, { "payment-required": b64({ x402Version: 2, resource: { url: resource }, accepts: [o] }) }); }
    let why; try { why = await verifyPayment(env, resource, header, env.__getReceipt || getReceiptPatiently); }
    catch (e) { return json({ error: "could not read the payment right now (" + e.message + "). It is not used yet: send the same payment-signature header again" }, 503, { "retry-after": "5" }); }
    if (why) { const o = await offer(env, resource); return json({ error: why, accepts: [o] }, 402, { "payment-required": b64({ x402Version: 2, resource: { url: resource }, accepts: [o] }) }); }
    // one tx, one response: remember settled transactions for a day
    const tx = unb64(header).payload.settlementTx, key = new Request(`https://used.allot/${tx}`), cache = caches.default;
    if (await cache.match(key)) return json({ error: "this payment was already used" }, 402);
    let data; try { data = await livePrice(symbol); } catch (e) { return json({ error: e.message + ", your payment is not used yet: retry with the same header" }, 503); }
    await cache.put(key, new Response("1", { headers: { "cache-control": "max-age=86400" } })); // longer than any offer can stay valid
    return json(data, 200, { "payment-response": b64({ success: true, network: "eip155:4663", transaction: tx }) });
  },
};
