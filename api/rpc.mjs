/**
 * Multi-chain RPC proxy.
 *
 * The browser calls /api/rpc?chain=<key>; this function forwards to Alchemy using the
 * key embedded in ARC_RPC_URL. That URL stays on the server and is never sent to a client.
 *
 * Alchemy apps are per-network: a key only works on networks enabled for that app. If a
 * network is not enabled (403) we fall back to a public endpoint automatically, so the
 * dapp keeps working while you enable it in the Alchemy dashboard.
 *
 * This endpoint is public, so it is limited to read-only methods, small batches, and
 * requests from this deployment. Set a spend cap in Alchemy as well.
 */

const ARC_RPC_URL = process.env.ARC_RPC_URL || "";
const KEY = ARC_RPC_URL.includes("/v2/") ? ARC_RPC_URL.split("/v2/")[1].trim() : "";

const ALCHEMY_SUBDOMAIN = {
  ethereum: "eth-mainnet",
  base: "base-mainnet",
  arbitrum: "arb-mainnet",
  optimism: "opt-mainnet",
  polygon: "polygon-mainnet",
  avalanche: "avax-mainnet",
  arc: "arc-mainnet",
};

const PUBLIC_FALLBACK = {
  ethereum: "https://ethereum-rpc.publicnode.com",
  base: "https://mainnet.base.org",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  optimism: "https://optimism-rpc.publicnode.com",
  polygon: "https://polygon-bor-rpc.publicnode.com",
  avalanche: "https://avalanche-c-chain-rpc.publicnode.com",
  arc: "https://rpc.mainnet.arc.io",
};

// Networks the key turned out not to cover. Serverless instances are reused, so this
// stops us re-attempting a known-403 upstream on every request.
const notEnabled = new Set();

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
const MAX_BODY = 128 * 1024;

function originAllowed(req) {
  const extra = (process.env.ALLOWED_ORIGINS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin POST from our page, or a non-browser client
  try {
    const o = new URL(origin);
    if (o.host === req.headers.host) return true;
    if (/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(o.host)) return true;
    return extra.includes(origin);
  } catch { return false; }
}

function upstreamsFor(chain) {
  const out = [];
  if (chain === "arc" && ARC_RPC_URL && !KEY) out.push(ARC_RPC_URL);
  const sub = ALCHEMY_SUBDOMAIN[chain];
  if (KEY && sub && !notEnabled.has(chain)) out.push(`https://${sub}.g.alchemy.com/v2/${KEY}`);
  if (PUBLIC_FALLBACK[chain]) out.push(PUBLIC_FALLBACK[chain]);
  return out;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") { res.setHeader("Allow", "POST"); return res.status(204).end(); }
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!originAllowed(req)) return res.status(403).json({ error: "forbidden origin" });

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const chain = (url.searchParams.get("chain") || "arc").toLowerCase();
  if (!PUBLIC_FALLBACK[chain]) return res.status(400).json({ error: `unknown chain: ${chain}` });

  let body = req.body;
  if (typeof body === "string") {
    if (body.length > MAX_BODY) return res.status(413).json({ error: "body too large" });
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "invalid JSON" }); }
  }
  if (!body || typeof body !== "object") return res.status(400).json({ error: "invalid JSON-RPC body" });

  const calls = Array.isArray(body) ? body : [body];
  if (calls.length > MAX_BATCH) return res.status(413).json({ error: `batch limit is ${MAX_BATCH}` });
  for (const c of calls) {
    if (!c || typeof c.method !== "string" || !ALLOWED.has(c.method))
      return res.status(403).json({ error: `method not allowed: ${c?.method ?? "(none)"}` });
  }

  const payload = JSON.stringify(body);
  let lastErr = "no upstream reachable";

  for (const target of upstreamsFor(chain)) {
    try {
      const r = await fetch(target, {
        method: "POST", headers: { "content-type": "application/json" }, body: payload,
      });
      const text = await r.text();

      if (r.status === 403 && target.includes("alchemy")) {
        // Key does not cover this network — remember and try the public endpoint.
        notEnabled.add(chain);
        lastErr = "network not enabled on the RPC key";
        continue;
      }
      if (!r.ok) { lastErr = `upstream ${r.status}`; continue; }

      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      return res.status(200).send(text);
    } catch (e) {
      lastErr = "upstream unreachable";
    }
  }
  return res.status(502).json({ error: lastErr });
}
