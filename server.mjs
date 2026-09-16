// Local-only bridge UI server.
// Holds the Alchemy key server-side so the browser never sees it.
// Binds to 127.0.0.1 only.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));

const env = Object.fromEntries(
  (await readFile(join(ROOT, ".env.local"), "utf8").catch(() => ""))
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const ARC_RPC_URL = env.ARC_RPC_URL || "https://rpc.mainnet.arc.io";
const KEY = ARC_RPC_URL.includes("/v2/") ? ARC_RPC_URL.split("/v2/")[1].trim() : "";
const SUB = { ethereum:"eth-mainnet", base:"base-mainnet", arbitrum:"arb-mainnet",
              optimism:"opt-mainnet", polygon:"polygon-mainnet", avalanche:"avax-mainnet", arc:"arc-mainnet" };
const PUB = { ethereum:"https://ethereum-rpc.publicnode.com", base:"https://mainnet.base.org",
              arbitrum:"https://arb1.arbitrum.io/rpc", optimism:"https://optimism-rpc.publicnode.com",
              polygon:"https://polygon-bor-rpc.publicnode.com",
              avalanche:"https://avalanche-c-chain-rpc.publicnode.com", arc:"https://rpc.mainnet.arc.io" };
const IRIS = "https://iris-api.circle.com";
const PORT = Number(env.PORT || 5173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

// The proxy carries the Alchemy key, so "*" would let any site you happen to be browsing
// spend your quota while this is running. Allow wallet extensions and this app only.
function corsFor(origin) {
  if (!origin) return null;
  const ok = /^(chrome|moz|safari-web)-extension:\/\//.test(origin) ||
             /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
  return ok ? origin : null;
}

function send(res, code, body, type = "application/json", origin = null) {
  const h = { "content-type": type, "cache-control": "no-store" };
  const allow = corsFor(origin);
  if (allow) {
    h["access-control-allow-origin"] = allow;
    h["access-control-allow-methods"] = "GET, POST, OPTIONS";
    h["access-control-allow-headers"] = "content-type";
    h["access-control-max-age"] = "3600";
    h["vary"] = "Origin";
  }
  res.writeHead(code, h);
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const origin = req.headers.origin || null;

  // MetaMask preflights every RPC call (application/json is not a "simple" content type).
  if (req.method === "OPTIONS") return send(res, 204, "", "text/plain", origin);

  try {
    // JSON-RPC proxy for Arc. Key stays here.
    // /api/rpc mirrors the Vercel serverless route so local dev matches production.
    if ((url.pathname === "/rpc/arc" || url.pathname === "/api/rpc") && req.method === "POST") {
      const body = await readBody(req);
      const chain = (url.searchParams.get("chain") || "arc").toLowerCase();
      const targets = [];
      if (KEY && SUB[chain]) targets.push(`https://${SUB[chain]}.g.alchemy.com/v2/${KEY}`);
      if (PUB[chain]) targets.push(PUB[chain]);
      for (const t of targets) {
        try {
          const r = await fetch(t, { method: "POST", headers: { "content-type": "application/json" }, body });
          if (r.status === 403 && t.includes("alchemy")) continue; // network not on the key
          if (!r.ok) continue;
          return send(res, 200, await r.text(), "application/json", origin);
        } catch {}
      }
      return send(res, 502, JSON.stringify({ error: "no upstream reachable" }), "application/json", origin);
    }

    // Circle Iris proxy (sidesteps any CORS surprises).
    if (url.pathname.startsWith("/iris/")) {
      const target = IRIS + url.pathname.slice("/iris".length) + url.search;
      const r = await fetch(target, { headers: { accept: "application/json" } });
      return send(res, r.status, await r.text(), "application/json", origin);
    }

    // Static files.
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    if (path.includes("..")) return send(res, 400, "bad path", "text/plain");
    const ext = path.slice(path.lastIndexOf("."));
    const file = await readFile(join(ROOT, path));
    return send(res, 200, file, MIME[ext] || "application/octet-stream", origin);
  } catch (e) {
    if (e.code === "ENOENT") return send(res, 404, "not found", "text/plain", origin);
    return send(res, 502, JSON.stringify({ error: String(e) }), "application/json", origin);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const masked = ARC_RPC_URL.replace(/\/v2\/.*$/, "/v2/***");
  console.log(`\n  Bridge to Arc  →  http://127.0.0.1:${PORT}`);
  console.log(`  Arc RPC (server-side only): ${masked}\n`);
});
