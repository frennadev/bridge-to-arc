/* Bridge to Arc — CCTP v2 with Circle's forwarding service.
   Static: talks to the wallet, Circle's Iris API, and Arc's public RPC. No backend. */

const C = window.CONFIG || {};
const FEE_BPS = BigInt(C.FEE_BPS ?? 100);
const IRIS = "https://iris-api.circle.com";

const ARC = {
  name: "Arc", chainId: 5042, hex: "0x13b2", domain: 26,
  rpc: C.ARC_RPC || "https://rpc.mainnet.arc.io",
  explorer: "https://explorer.arc.io",
  usdc: "0x3600000000000000000000000000000000000000",
  transmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
};
const TOKEN_MESSENGER = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d"; // same on every chain below

const SOURCES = [
  { key:"base",     name:"Base",      domain:6, chainId:8453,  hex:"0x2105", usdc:"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", explorer:"https://basescan.org",  rpc:"https://mainnet.base.org",             sym:"ETH",  fast:true,  note:"cheapest gas" },
  { key:"arbitrum", name:"Arbitrum",  domain:3, chainId:42161, hex:"0xa4b1", usdc:"0xaf88d065e77c8cC2239327C5EDb3A432268e5831", explorer:"https://arbiscan.io",   rpc:"https://arb1.arbitrum.io/rpc",         sym:"ETH",  fast:true },
  { key:"optimism", name:"OP Mainnet",domain:2, chainId:10,    hex:"0xa",    usdc:"0x0b2C639c533813f8Aa73DaC3A0d51fF37b6E5159", explorer:"https://optimistic.etherscan.io", rpc:"https://mainnet.optimism.io", sym:"ETH",  fast:true },
  { key:"ethereum", name:"Ethereum",  domain:0, chainId:1,     hex:"0x1",    usdc:"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", explorer:"https://etherscan.io",  rpc:"https://eth.llamarpc.com",             sym:"ETH",  fast:true },
  { key:"polygon",  name:"Polygon",   domain:7, chainId:137,   hex:"0x89",   usdc:"0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", explorer:"https://polygonscan.com", rpc:"https://polygon-rpc.com",            sym:"POL",  fast:false },
  { key:"avalanche",name:"Avalanche", domain:1, chainId:43114, hex:"0xa86a", usdc:"0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", explorer:"https://snowtrace.io", rpc:"https://api.avax.network/ext/bc/C/rpc", sym:"AVAX", fast:false },
];

// "cctp-forward" + 20 zero bytes. Tells Circle to pay the Arc-side gas and mint for the
// recipient, which is why nobody needs USDC on Arc before they arrive.
const FORWARD_HOOK = "0x636374702d666f72776172640000000000000000000000000000000000000000";

const erc20 = new ethers.Interface([
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
]);
const messenger = new ethers.Interface([
  "function depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)",
]);
const transmitter = new ethers.Interface(["function receiveMessage(bytes,bytes)"]);

const $ = (id) => document.getElementById(id);
const fmt = (v) => ethers.formatUnits(v, 6);
const short = (h) => h.slice(0, 8) + "…" + h.slice(-6);
const link = (u, t) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`;
const alertIn = (id, kind, html) => { $(id).innerHTML = html ? `<div class="alert ${kind}">${html}</div>` : ""; };

function fatal(msg) {
  const el = $("fatal");
  if (el) { el.hidden = false; el.textContent = String(msg); }
  console.error(msg);
}
window.addEventListener("error", (e) => fatal(`Error: ${e.message} (${(e.filename||"").split("/").pop()}:${e.lineno})`));
window.addEventListener("unhandledrejection", (e) => fatal(`Unhandled: ${e.reason?.message || e.reason}`));

// A deploy with no treasury would take fees to the burn address. Refuse instead.
const TREASURY = (() => {
  try {
    const t = ethers.getAddress(C.TREASURY || "");
    return t === ethers.ZeroAddress ? null : t;
  } catch { return null; }
})();

/* ---------- rpc helpers (no backend) ---------- */
// Prefer the serverless proxy (/api/rpc) so the upstream RPC URL stays server-side.
// If it isn't deployed — local dev, or a static host without functions — fall back to
// the public endpoint. A JSON-RPC *error* is a real answer and propagates; only a
// transport or HTTP failure disables the proxy.
let useProxy = true;
const publicRpcFor = (chain) =>
  chain === "arc" ? ARC.rpc : SOURCES.find((c) => c.key === chain)?.rpc;

// Reads for any supported chain go through /api/rpc, which keeps the upstream key
// server-side. Falls back to the public endpoint when the function isn't deployed
// (local static serving) or the upstream is failing. A JSON-RPC error is a real
// answer and propagates rather than triggering fallback.
async function rpc(chain, method, params) {
  const headers = { "content-type": "application/json" };
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

  if (useProxy) {
    try {
      const r = await fetch(`/api/rpc?chain=${encodeURIComponent(chain)}`, { method: "POST", headers, body });
      if (r.ok) {
        const j = await r.json();
        if (j.error) throw new Error(j.error.message);
        return j.result;
      }
      // 404/405 means there is no function here at all; anything else is a
      // per-request upstream problem, so only give up on the proxy for the former.
      if (r.status === 404 || r.status === 405) useProxy = false;
    } catch (e) {
      if (e instanceof TypeError) useProxy = false; else throw e;
    }
  }

  const url = publicRpcFor(chain);
  if (!url) throw new Error(`no endpoint for chain ${chain}`);
  const r = await fetch(url, { method: "POST", headers, body });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

const arcRpc = (method, params) => rpc("arc", method, params);
async function iris(path) {
  const r = await fetch(IRIS + path, { headers: { accept: "application/json" } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/* ---------- wallet (EIP-6963) ---------- */
const WKEY = "arcbridge.wallet";
const wallets = new Map();
let wallet = null, account = null, chainIdNow = null;
const eth = () => wallet?.provider;
const provider = () => new ethers.BrowserProvider(eth());

window.addEventListener("eip6963:announceProvider", (e) => {
  const d = e.detail;
  if (d?.info?.rdns) { wallets.set(d.info.rdns, d); if (!$("walletModal").hidden) paintPicker(); }
});
const askWallets = () => window.dispatchEvent(new Event("eip6963:requestProvider"));
askWallets();
[100, 300, 800, 1500].forEach((t) => setTimeout(askWallets, t));

function candidates() {
  const list = [...wallets.values()];
  const seen = new Set(list.map((w) => w.provider));
  const inj = window.ethereum;
  if (!inj) return list;
  const raw = Array.isArray(inj.providers) && inj.providers.length ? inj.providers : [inj];
  for (const p of raw) {
    if (seen.has(p)) continue;
    const name = p.isMetaMask ? "MetaMask" : p.isCoinbaseWallet ? "Coinbase Wallet"
               : p.isRabby ? "Rabby" : p.isRainbow ? "Rainbow" : "Injected wallet";
    list.push({ info: { rdns: "injected:" + name.toLowerCase().replace(/ /g, "-"), name, icon: null }, provider: p });
    seen.add(p);
  }
  return list;
}

let pickerResolve = null;
function openPicker() {
  askWallets(); paintPicker();
  $("walletModal").hidden = false;
  setTimeout(() => { if (!$("walletModal").hidden) paintPicker(); }, 400);
  return new Promise((r) => (pickerResolve = r));
}
function closePicker(ok) {
  $("walletModal").hidden = true;
  const r = pickerResolve; pickerResolve = null; if (r) r(ok);
}
function paintPicker() {
  const list = candidates();
  $("walletEmpty").hidden = list.length > 0;
  $("walletList").innerHTML = list.map((w, i) =>
    `<button class="wrow" data-i="${i}">` +
      (w.info.icon ? `<img src="${w.info.icon}" alt="" />`
                   : `<span class="ph">${w.info.name.slice(0,2).toUpperCase()}</span>`) +
      `<span>${w.info.name}<small>${w.info.rdns}</small></span>` +
      (wallet?.info.rdns === w.info.rdns && account ? `<span class="tag">connected</span>` : "") +
    `</button>`).join("") +
    (account ? `<button class="wrow dc" data-dc="1">Disconnect</button>` : "");
  $("walletList").querySelectorAll("button").forEach((b) => {
    b.onclick = async () => {
      if (b.dataset.dc) { disconnect(); closePicker(false); return; }
      $("walletList").querySelectorAll("button").forEach((x) => (x.disabled = true));
      try { await select(candidates()[Number(b.dataset.i)]); closePicker(true); }
      catch (e) { paintPicker(); alertIn("routeAlert", "bad", errMsg(e)); }
    };
  });
}

let onAcct = null, onChain = null;
async function select(w) {
  if (wallet?.provider && onAcct) {
    wallet.provider.removeListener?.("accountsChanged", onAcct);
    wallet.provider.removeListener?.("chainChanged", onChain);
  }
  wallet = w;
  onAcct = (a) => { account = a[0] ? ethers.getAddress(a[0]) : null; if (!account) wallet = null; paintNet(); refresh(); };
  onChain = (h) => { chainIdNow = Number(h); paintNet(); refresh(); };
  w.provider.on?.("accountsChanged", onAcct);
  w.provider.on?.("chainChanged", onChain);
  localStorage.setItem(WKEY, w.info.rdns);
  const accts = await eth().request({ method: "eth_requestAccounts" });
  if (!accts?.length) throw new Error("Wallet returned no accounts.");
  account = ethers.getAddress(accts[0]);
  chainIdNow = Number(await eth().request({ method: "eth_chainId" }));
  if (!$("rcpIn").value) $("rcpIn").value = account;
  paintNet(); refresh();
}
function disconnect() {
  if (wallet?.provider && onAcct) {
    wallet.provider.removeListener?.("accountsChanged", onAcct);
    wallet.provider.removeListener?.("chainChanged", onChain);
  }
  wallet = null; account = null; chainIdNow = null;
  localStorage.removeItem(WKEY); paintNet(); refresh();
}
async function connect({ force = false } = {}) {
  if (wallet && account && !force) return true;
  return await openPicker();
}
async function bootWallet() {
  const saved = localStorage.getItem(WKEY);
  if (!saved) return;
  for (let i = 0; i < 12 && !wallets.has(saved); i++) await new Promise((r) => setTimeout(r, 80));
  const w = wallets.get(saved) || candidates().find((c) => c.info.rdns === saved);
  if (!w) return;
  try { const a = await w.provider.request({ method: "eth_accounts" }); if (a?.length) await select(w); } catch {}
}

async function switchChain(hex, add) {
  try { await eth().request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] }); }
  catch (e) {
    if ((e.code === 4902 || e?.data?.originalError?.code === 4902) && add)
      await eth().request({ method: "wallet_addEthereumChain", params: [add] });
    else throw e;
  }
  chainIdNow = Number(await eth().request({ method: "eth_chainId" }));
  paintNet();
}
const ARC_ADD = { chainId: ARC.hex, chainName: "Arc", rpcUrls: [ARC.rpc],
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, blockExplorerUrls: [ARC.explorer] };
const addFor = (c) => ({ chainId: c.hex, chainName: c.name, rpcUrls: [c.rpc],
  nativeCurrency: { name: c.sym, symbol: c.sym, decimals: 18 }, blockExplorerUrls: [c.explorer] });

function paintNet() {
  const p = $("netPill");
  if (!account) { p.textContent = "not connected"; p.className = "pill"; $("connectBtn").textContent = "Connect wallet"; return; }
  const known = [...SOURCES, ARC].find((c) => c.chainId === chainIdNow);
  p.textContent = `${account.slice(0,6)}…${account.slice(-4)} · ${known ? known.name : "chain " + chainIdNow}`;
  p.className = "pill live";
  $("connectBtn").textContent = "Change";
}

function errMsg(e) {
  const m = e?.shortMessage || e?.info?.error?.message || e?.message || String(e);
  if (/user rejected|ACTION_REJECTED/i.test(m)) return "You rejected the request in your wallet.";
  return m;
}

/* ---------- quote ---------- */
const src = () => SOURCES.find((c) => c.key === $("srcSel").value);
const threshold = () => Number(document.querySelector("#speedSeg button.on").dataset.th);
const BPS_SCALE = 1000000n;
let cctpBps = null, forwardFee = null;

async function loadFee() {
  cctpBps = forwardFee = null;
  try {
    const { body } = await iris(`/v2/burn/USDC/fees/${src().domain}/${ARC.domain}?forward=true&includeRecipientSetup=true`);
    if (Array.isArray(body)) {
      const hit = body.find((f) => Number(f.finalityThreshold) === threshold()) || body[0];
      if (hit) {
        cctpBps = Number(hit.minimumFee);
        if (hit.forwardFee) forwardFee = BigInt(hit.forwardFee.high ?? hit.forwardFee.med);
      }
    }
  } catch {}
  paintQuote(); refresh();
}

function parseAmt() {
  const raw = $("amtIn").value.trim();
  if (!raw) return null;
  try { const v = ethers.parseUnits(raw, 6); return v > 0n ? v : null; } catch { return null; }
}

// Everything is deducted from what the user sends, so the wallet debit equals the
// number they typed. Platform fee first, then Circle's cut on what actually burns.
function quote(amount) {
  const platform = (amount * FEE_BPS) / 10000n;
  const burn = amount - platform;
  const bps = cctpBps == null ? (threshold() === 1000 ? 1 : 0) : cctpBps;
  const cctp = (burn * BigInt(Math.ceil(bps * Number(BPS_SCALE)))) / (10000n * BPS_SCALE);
  const fwd = forwardFee ?? 25000n;
  const maxFee = cctp + fwd;
  return { platform, burn, cctp, fwd, maxFee, received: burn - maxFee };
}

function paintQuote() {
  const a = parseAmt(), q = $("quote");
  if (!a) { q.innerHTML = `<div class="qrow"><span>Enter an amount</span><span>—</span></div>`; return; }
  const v = quote(a);
  q.innerHTML =
    `<div class="qrow"><span>You send</span><span>${fmt(a)} USDC</span></div>` +
    `<div class="qrow tot"><span>You receive on Arc</span><span>${fmt(v.received)} USDC</span></div>`;
}

/* ---------- validation ---------- */
let srcBal = null, allowance = null, running = false;

async function srcRead(fn, args, to, chainKey) {
  const res = await rpc(chainKey, "eth_call", [{ to, data: erc20.encodeFunctionData(fn, args) }, "latest"]);
  return erc20.decodeFunctionResult(fn, res)[0];
}

async function refresh() {
  const c = src(), amt = parseAmt();
  const fastBtn = document.querySelector('#speedSeg button[data-th="1000"]');
  fastBtn.disabled = !c.fast;
  fastBtn.title = c.fast ? "" : `${c.name} does not support Fast Transfer`;
  if (!c.fast && fastBtn.classList.contains("on")) return selectSpeed(document.querySelector('#speedSeg button[data-th="2000"]'));

  const rv = $("rcpIn").value.trim();
  let rcp = null; try { rcp = ethers.getAddress(rv); } catch {}
  $("rcpIn").classList.toggle("bad", rv.length > 0 && !rcp);
  $("rcpHint").textContent = rcp ? "Receives on Arc · no gas needed there" : "Where the USDC lands on Arc.";

  // Read balances on the selected chain regardless of which network the wallet is on,
  // so switching chains in the dropdown shows a balance immediately.
  srcBal = allowance = null;
  if (account) {
    try {
      srcBal = await srcRead("balanceOf", [account], c.usdc, c.key);
      allowance = await srcRead("allowance", [account, TOKEN_MESSENGER], c.usdc, c.key);
    } catch {}
  }
  $("balLbl").textContent = srcBal == null ? "" : `balance ${fmt(srcBal)}`;
  $("maxBtn").hidden = srcBal == null || srcBal === 0n;

  const h = $("amtHint");
  const v = amt ? quote(amt) : null;
  if ($("amtIn").value.trim() && !amt) { h.textContent = "Enter a positive amount (max 6 decimals)."; h.className = "hint bad"; }
  else if (srcBal === 0n) {
    h.textContent = `No USDC on ${c.name}. Swap to native USDC there first, or choose a different chain.`;
    h.className = "hint bad";
  }
  else if (amt && srcBal != null && amt > srcBal) { h.textContent = `You only have ${fmt(srcBal)} USDC on ${c.name}.`; h.className = "hint bad"; }
  else if (v && v.received <= 0n) { h.textContent = "Too small — fees exceed the amount."; h.className = "hint bad"; }
  else if (v) {
    // Circle's forwarder fee is a flat ~0.02 USDC, so small transfers lose a big share.
    // Say so plainly rather than letting someone send 0.05 and lose 40% of it.
    const take = Number(amt - v.received) / Number(amt) * 100;
    if (take > 5) { h.textContent = `You'd receive only ${fmt(v.received)} of ${fmt(amt)}. Small amounts are inefficient to bridge — send more.`; h.className = "hint warn"; }
    else { h.textContent = ""; h.className = "hint"; }
  }
  else { h.textContent = ""; h.className = "hint"; }

  paintQuote();

  const ok = TREASURY && account && amt && rcp && (srcBal == null || amt <= srcBal) && v.received > 0n;
  const b = $("startBtn");
  b.disabled = !ok || running;
  b.textContent = !TREASURY ? "Not configured"
    : !account ? "Connect wallet"
    : chainIdNow !== c.chainId ? `Switch to ${c.name}`
    : srcBal === 0n ? `No USDC on ${c.name}`
    : amt ? `Bridge ${fmt(amt)} USDC` : "Bridge";
}

function selectSpeed(btn) {
  document.querySelectorAll("#speedSeg button").forEach((x) => x.classList.remove("on"));
  btn.classList.add("on");
  loadFee();
}

/* ---------- transfer ---------- */
const TKEY = "arcbridge.tx";
let tx = (() => { try { return JSON.parse(localStorage.getItem(TKEY)); } catch { return null; } })();
const saveTx = () => tx ? localStorage.setItem(TKEY, JSON.stringify(tx)) : localStorage.removeItem(TKEY);

const STEPS = ["Approve USDC", "Bridge fee", "Bridge to Arc", "Circle mints on Arc"];
function paintSteps() {
  if (!tx) { $("progCard").hidden = true; return; }
  $("progCard").hidden = false;
  $("steps").innerHTML = STEPS.map((t, i) => {
    const s = tx.steps[i] || {}, cls = s.state || "pend";
    return `<li class="${cls}"><div class="dot">${
      cls === "done" ? "✓" : cls === "err" ? "!" : cls === "act" ? '<span class="spin"></span>' : i + 1
    }</div><div><div class="stitle">${t}</div>${s.meta ? `<div class="smeta">${s.meta}</div>` : ""}</div></li>`;
  }).join("");
}
function step(i, state, meta) {
  tx.steps[i] = { state, meta: meta ?? tx.steps[i]?.meta };
  saveTx(); paintSteps();
}

async function start() {
  const c = src(), amount = parseAmt();
  const recipient = ethers.getAddress($("rcpIn").value.trim());
  const v = quote(amount);
  tx = { srcKey: c.key, amount: amount.toString(), recipient, threshold: threshold(),
         platform: v.platform.toString(), burn: v.burn.toString(), maxFee: v.maxFee.toString(),
         steps: [{}, {}, {}, {}], at: Date.now() };
  saveTx(); paintSteps();
  await run();
}

async function run() {
  running = true; refresh(); alertIn("progAlert", "", "");
  const c = SOURCES.find((x) => x.key === tx.srcKey);
  const burn = BigInt(tx.burn), platform = BigInt(tx.platform), maxFee = BigInt(tx.maxFee);

  try {
    if (!tx.burnHash) {
      if (chainIdNow !== c.chainId) { step(0, "act", `Switching to ${c.name}…`); await switchChain(c.hex, addFor(c)); }
      const signer = await provider().getSigner();
      const from = ethers.getAddress(await signer.getAddress());

      const have = await srcRead("allowance", [from, TOKEN_MESSENGER], c.usdc, c.key);
      if (have >= burn) step(0, "done", `Already approved`);
      else {
        step(0, "act", "Approve in your wallet…");
        const a = await signer.sendTransaction({ to: c.usdc,
          data: erc20.encodeFunctionData("approve", [TOKEN_MESSENGER, burn]) });
        step(0, "act", `${link(`${c.explorer}/tx/${a.hash}`, short(a.hash))} — confirming…`);
        await a.wait();
        step(0, "done", link(`${c.explorer}/tx/${a.hash}`, short(a.hash)));
      }

      if (!tx.feeHash && platform > 0n) {
        step(1, "act", `Confirm the ${fmt(platform)} USDC bridge fee…`);
        const f = await signer.sendTransaction({ to: c.usdc,
          data: erc20.encodeFunctionData("transfer", [TREASURY, platform]) });
        tx.feeHash = f.hash; saveTx();
        step(1, "act", `${link(`${c.explorer}/tx/${f.hash}`, short(f.hash))} — confirming…`);
        await f.wait();
      }
      step(1, platform > 0n ? "done" : "done", platform > 0n
        ? link(`${c.explorer}/tx/${tx.feeHash}`, short(tx.feeHash)) : "no fee configured");

      try {
        const pre = await arcRpc("eth_call", [{ to: ARC.usdc,
          data: erc20.encodeFunctionData("balanceOf", [tx.recipient]) }, "latest"]);
        tx.baseline = erc20.decodeFunctionResult("balanceOf", pre)[0].toString(); saveTx();
      } catch { tx.baseline = "0"; }

      step(2, "act", "Confirm the bridge in your wallet…");
      const b = await signer.sendTransaction({ to: TOKEN_MESSENGER,
        data: messenger.encodeFunctionData("depositForBurnWithHook", [
          burn, ARC.domain, ethers.zeroPadValue(tx.recipient, 32), c.usdc,
          ethers.ZeroHash, maxFee, tx.threshold, FORWARD_HOOK]) });
      tx.burnHash = b.hash; saveTx();
      vaultPut({ burnHash: b.hash, domain: c.domain, recipient: tx.recipient,
                 amount: burn.toString(), status: "burned, awaiting attestation" });
      step(2, "act", `${link(`${c.explorer}/tx/${b.hash}`, short(b.hash))} — confirming…`);
      await b.wait();
    }
    step(0, "done"); step(1, "done"); step(2, "done", link(`${c.explorer}/tx/${tx.burnHash}`, short(tx.burnHash)));

    if (!tx.attestation) {
      const t0 = Date.now();
      step(3, "act", "Waiting for Circle…");
      for (;;) {
        const { status, body } = await iris(`/v2/messages/${c.domain}?transactionHash=${tx.burnHash}`);
        const m = body?.messages?.[0];
        if (status === 200 && m?.status === "complete" && m.attestation?.startsWith("0x")) {
          tx.message = m.message; tx.attestation = m.attestation; saveTx();
          vaultPut({ burnHash: tx.burnHash, domain: c.domain, recipient: tx.recipient,
                     amount: tx.burn, message: m.message, attestation: m.attestation,
                     status: "attested — Circle minting" });
          break;
        }
        const s = Math.floor((Date.now() - t0) / 1000);
        step(3, "act", `${m?.status || "indexing"} · ${Math.floor(s/60)}m ${String(s%60).padStart(2,"0")}s`);
        if (s > 2700) throw new Error("Still pending after 45 minutes. Your funds are safe — reopen this page later and press Resume.");
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    await waitForMint();
  } catch (e) {
    const i = tx.steps.findIndex((s) => s.state === "act");
    if (i >= 0) step(i, "err", errMsg(e));
    alertIn("progAlert", "bad", `<b>Stopped.</b> ${errMsg(e)}`);
    paintActs();
  } finally { running = false; refresh(); }
}

async function waitForMint() {
  const base = BigInt(tx.baseline || "0"), t0 = Date.now();
  step(3, "act", "Circle is minting on Arc…");
  for (;;) {
    let bal = null;
    try {
      const res = await arcRpc("eth_call", [{ to: ARC.usdc,
        data: erc20.encodeFunctionData("balanceOf", [tx.recipient]) }, "latest"]);
      bal = erc20.decodeFunctionResult("balanceOf", res)[0];
    } catch {}
    if (bal !== null && bal > base) {
      tx.done = true; saveTx();
      vaultPut({ burnHash: tx.burnHash, status: "minted" });
      step(3, "done", `+${fmt(bal - base)} USDC on Arc`);
      alertIn("progAlert", "ok", `<b>Done.</b> ${fmt(bal - base)} USDC arrived at ${short(tx.recipient)} on Arc. ` +
        `That balance is also your gas there.`);
      paintActs(); return;
    }
    const s = Math.floor((Date.now() - t0) / 1000);
    step(3, "act", `waiting for the forwarder · ${Math.floor(s/60)}m ${String(s%60).padStart(2,"0")}s`);
    if (s > 900) {
      tx.stalled = true; saveTx();
      step(3, "err", "Forwarder hasn't minted yet");
      alertIn("progAlert", "warn", `<b>Taking longer than usual.</b> Nothing is lost — the burn is attested and ` +
        `the USDC stays claimable indefinitely. You can keep waiting, claim it yourself, or download the ` +
        `claim data and submit it from any account that holds gas on Arc.`);
      paintActs(); return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

function paintActs() {
  const el = $("progActs"); el.innerHTML = "";
  if (!tx) return;
  const add = (label, fn, ghost = true) => {
    const b = document.createElement("button");
    b.textContent = label; b.className = ghost ? "ghost" : ""; b.onclick = fn; el.appendChild(b);
  };
  if (!tx.done) add(tx.burnHash ? "Resume" : "Retry", () => run(), false);
  if (!tx.done && tx.attestation && tx.stalled) {
    add("Claim it myself", () => selfClaim());
    add("Download claim data", () => downloadClaim({
      burnHash: tx.burnHash, domain: SOURCES.find((c) => c.key === tx.srcKey)?.domain,
      recipient: tx.recipient, amount: tx.burn, message: tx.message, attestation: tx.attestation }));
  }
  add(tx.done ? "New transfer" : "Dismiss", () => {
    if (!tx.done && !confirm("Dismiss this transfer? The burn stays on-chain and remains claimable under Recover.")) return;
    tx = null; saveTx(); $("progCard").hidden = true; refresh();
  });
}

/* ---------- failure-path safety net ----------
   The forwarder makes stuck transfers very unlikely, so none of this is in the normal
   UI. It only surfaces if Circle hasn't minted after 15 minutes — at which point the
   user still needs a way to get their money, and the burn is already irreversible.
*/
const VKEY = "arcbridge.vault";
const vault = () => { try { return JSON.parse(localStorage.getItem(VKEY)) || []; } catch { return []; } };
function vaultPut(entry) {
  const all = vault();
  const i = all.findIndex((e) => entry.burnHash && e.burnHash?.toLowerCase() === entry.burnHash.toLowerCase());
  if (i >= 0) all[i] = { ...all[i], ...entry }; else all.push({ ...entry, saved: Date.now() });
  localStorage.setItem(VKEY, JSON.stringify(all));
}

function downloadClaim(e) {
  const blob = new Blob([JSON.stringify({
    note: "Arc CCTP claim. Call receiveMessage(message, attestation) on MessageTransmitterV2 " +
          "on Arc (chain 5042) from any account holding USDC gas. Funds go to the recipient " +
          "encoded in the message, never to the submitter.",
    messageTransmitter: ARC.transmitter, chainId: ARC.chainId, burnHash: e.burnHash,
    sourceDomain: e.domain, recipient: e.recipient, amount: e.amount,
    message: e.message, attestation: e.attestation }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `arc-claim-${(e.burnHash || "payload").slice(0, 10)}.json`;
  a.click(); URL.revokeObjectURL(a.href);
}

// Last resort: submit the mint yourself. Only reachable after the forwarder timeout.
async function selfClaim() {
  if (!tx?.message || !tx?.attestation) return;
  alertIn("progAlert", "warn", "Switching to Arc…");
  try {
    if (!account && !(await connect())) return;
    if (chainIdNow !== ARC.chainId) await switchChain(ARC.hex, ARC_ADD);
    const signer = await provider().getSigner();
    const who = ethers.getAddress(await signer.getAddress());
    const bal = BigInt(await arcRpc("eth_getBalance", [who, "latest"]));
    if (bal === 0n) return alertIn("progAlert", "warn",
      `<b>${short(who)} has no gas on Arc.</b> Download the claim data and submit it from any ` +
      `funded account — the USDC still goes to ${short(tx.recipient)}, never the submitter.`);
    alertIn("progAlert", "warn", "Confirm in your wallet…");
    const r = await signer.sendTransaction({ to: ARC.transmitter,
      data: transmitter.encodeFunctionData("receiveMessage", [tx.message, tx.attestation]) });
    await r.wait();
    tx.done = true; saveTx();
    step(3, "done", link(`${ARC.explorer}/tx/${r.hash}`, short(r.hash)));
    alertIn("progAlert", "ok", `Claimed. ${link(`${ARC.explorer}/tx/${r.hash}`, short(r.hash))}`);
    paintActs();
  } catch (e) { alertIn("progAlert", "bad", errMsg(e)); }
}

/* ---------- boot ---------- */
$("brand").textContent = C.BRAND || "Bridge to Arc";
$("srcSel").innerHTML = SOURCES.map((c) =>
  `<option value="${c.key}">${c.name}${c.note ? " · " + c.note : ""}${c.fast ? "" : " · standard only"}</option>`).join("");

$("connectBtn").onclick = () => connect({ force: true });
$("closePicker").onclick = () => closePicker(false);
$("walletModal").onclick = (e) => { if (e.target.id === "walletModal") closePicker(false); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("walletModal").hidden) closePicker(false); });
$("srcSel").onchange = async () => {
  loadFee();
  const c = src();
  if (!account || chainIdNow === c.chainId) return;
  try { await switchChain(c.hex, addFor(c)); }
  catch (e) {
    // A rejected switch is not an error worth shouting about — the Bridge button
    // still offers to switch when they are ready.
    if (!/user rejected|ACTION_REJECTED|4001/i.test(String(e?.message || e))) 
      alertIn("routeAlert", "warn", errMsg(e));
  }
  refresh();
};
$("amtIn").oninput = refresh;
$("rcpIn").oninput = refresh;
$("maxBtn").onclick = () => { if (srcBal != null) { $("amtIn").value = fmt(srcBal); refresh(); } };
document.querySelectorAll("#speedSeg button").forEach((b) => (b.onclick = () => selectSpeed(b)));
$("startBtn").onclick = () => start().catch((e) => alertIn("routeAlert", "bad", errMsg(e)));
$("addArcBtn").onclick = async () => {
  try { if (!account && !(await connect())) return;
    await eth().request({ method: "wallet_addEthereumChain", params: [ARC_ADD] });
    alertIn("routeAlert", "ok", "Arc added to your wallet."); }
  catch (e) { alertIn("routeAlert", "bad", errMsg(e)); }
};

if (!TREASURY) fatal("CONFIG.TREASURY is not set — edit config.js and redeploy. Bridging is disabled so fees can't be sent to the zero address.");

if (tx) {
  paintSteps(); paintActs();
  $("srcSel").value = tx.srcKey; $("amtIn").value = fmt(tx.amount); $("rcpIn").value = tx.recipient;
  if (!tx.done) alertIn("progAlert", "warn", "Unfinished transfer found. Press <b>Resume</b> to continue.");
}
bootWallet();
loadFee();
