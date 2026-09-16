/* ---------------------------------------------------------------
   Edit this file, then redeploy. Nothing secret belongs in here —
   it ships to every visitor's browser.
   --------------------------------------------------------------- */
window.CONFIG = {
  // Where your 1% lands. MUST be set — the app refuses to run otherwise,
  // so a misconfigured deploy can never silently burn fees to nowhere.
  TREASURY: "0xaa56B5cceBe97F0F3cbC885490f737F94CcB949c",

  // Your cut, in basis points. 100 = 1%.
  FEE_BPS: 100,

  // Public fallback only, used if /api/rpc is unavailable.
  // The real endpoint lives in the ARC_RPC_URL environment variable on Vercel and is
  // served through /api/rpc, so it never reaches a browser. Never paste a keyed URL
  // here — this file ships to every visitor.
  ARC_RPC: "https://rpc.mainnet.arc.io",

  BRAND: "Bridge to Arc",
};
