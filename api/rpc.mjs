/**
 * Arc RPC proxy.
 *
 * The browser calls /api/rpc; this function forwards to the endpoint in the
 * ARC_RPC_URL environment variable. The URL — and any key in it — stays on the
 * server and is never sent to a client.
 *
 * This endpoint is reachable by anyone who inspects the site, so it is locked
 * down to read-only methods, small batches, and requests originating from this
 * deployment. That protects the key and limits casual abuse; it cannot stop a
 * determined caller from spending quota. Set a spend cap in Alchemy too.
 */

const UPSTREAM = process.env.ARC_RPC_URL || "https://rpc.mainnet.arc.io";

// Only what the dapp actually needs, all read-only. No eth_sendRawTransaction:
// the wallet broadcasts its own transactions and never routes through here.
const ALLOWED = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBalance",
  "eth_call",
  "eth_estimateGas",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
]);

const MAX_BATCH = 10;
const MAX_BODY = 128 * 1024; // 128 KB

function originAllowed(req) {
  // ALLOWED_ORIGINS is optional; unset means "same-origin only", enforced below.
  const extra = (process.env.ALLOWED_ORIGINS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  const origin = req.headers.origin;
  const host = req.headers.host;

  // No Origin header: a same-origin POST from our own page, or a non-browser
  // client. Allow it — the method allowlist is what actually limits damage.
  if (!origin) return true;

  try {
    const o = new URL(origin);
    if (o.host === host) return true;                       // our own deployment
    if (/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(o.host)) return true; // local dev
    return extra.includes(origin);
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "POST");
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }
  if (!originAllowed(req)) {
    return res.status(403).json({ error: "forbidden origin" });
  }

  let body = req.body;
  if (typeof body === "string") {
    if (body.length > MAX_BODY) return res.status(413).json({ error: "body too large" });
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "invalid JSON" }); }
  }
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "invalid JSON-RPC body" });
  }

  const calls = Array.isArray(body) ? body : [body];
  if (calls.length > MAX_BATCH) {
    return res.status(413).json({ error: `batch limit is ${MAX_BATCH}` });
  }
  for (const c of calls) {
    if (!c || typeof c.method !== "string" || !ALLOWED.has(c.method)) {
      return res.status(403).json({ error: `method not allowed: ${c?.method ?? "(none)"}` });
    }
  }

  try {
    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await upstream.text();
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    return res.status(upstream.status).send(text);
  } catch (e) {
    return res.status(502).json({ error: "upstream unreachable" });
  }
}
