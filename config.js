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

  // Public Arc endpoint. Supports CORS from any origin, so no proxy is needed.
  // Swap for a private RPC only if you put it behind your own serverless route —
  // never paste a keyed URL here, it would be public.
  ARC_RPC: "https://rpc.mainnet.arc.io",

  BRAND: "Bridge to Arc",
};
