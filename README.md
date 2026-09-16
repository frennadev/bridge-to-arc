# Bridge to Arc

A static dapp that bridges native USDC to **Arc mainnet** over **Circle's CCTP v2**,
using the Forwarding Service so **the recipient needs no gas on Arc**. Non-custodial —
the user's wallet signs everything and funds never touch an intermediary address except
the platform fee.

## Deploy to Vercel

```bash
vercel deploy --prod
```

Zero config: no build step, no `package.json`, no dependencies. Vercel serves the root as
static files and turns `api/rpc.mjs` into a serverless function at `/api/rpc`.

### One environment variable

In **Project -> Settings -> Environment Variables**, or via CLI:

```bash
vercel env add ARC_RPC_URL production
# paste your Alchemy Arc URL when prompted
```

`ARC_RPC_URL` is read only by `api/rpc.mjs`, on the server. It is never bundled, never
sent to a browser, and never appears in a network response. See `.env.example`.

If the variable is unset the proxy falls back to Arc's public endpoint, so the site still
works — just without your dedicated throughput.

### Before the first deploy, edit `config.js`

```js
window.CONFIG = {
  TREASURY: "0xYourFeeWallet",   // REQUIRED — app refuses to run while unset
  FEE_BPS: 100,                  // 100 = 1%
  ARC_RPC: "https://rpc.mainnet.arc.io",  // public fallback only
  BRAND: "Bridge to Arc",
};
```

`config.js` ships to every visitor. Nothing secret goes in it.

## Keeping the RPC key private

The browser never sees the upstream URL. It calls `/api/rpc` on your own domain, and the
function forwards to `ARC_RPC_URL`.

`/api/rpc` is still a public endpoint, so it is deliberately narrow:

| Guard | Behaviour |
|---|---|
| Method allowlist | Only 7 read-only methods. `eth_sendRawTransaction`, `debug_*`, `trace_*` all rejected |
| Origin check | Same-origin and localhost only, unless `ALLOWED_ORIGINS` is set |
| Batch limit | 10 calls per request |
| Body limit | 128 KB |
| Verb | POST only |

Wallets broadcast their own transactions directly and never route through this proxy,
which is why no write method needs to be allowed.

This protects the key and stops casual abuse. It does **not** stop a determined caller
from spending your quota — the endpoint is discoverable by anyone who opens devtools.
**Set a spend cap in the Alchemy dashboard.**

## Local development

```bash
node server.mjs   # http://127.0.0.1:5173
```

`server.mjs` mirrors the `/api/rpc` route so local behaviour matches production. It reads
`ARC_RPC_URL` from `.env.local`. It is excluded from the deploy.

## How a bridge works

Everything is deducted from what the user sends, so the wallet debit equals the number
they typed.

| Step | Transaction | Purpose |
|---|---|---|
| 1 | `approve(TokenMessengerV2, burnAmount)` | skipped if allowance already covers it |
| 2 | `transfer(TREASURY, 1%)` | your fee, on the source chain |
| 3 | `depositForBurnWithHook(burnAmount, 26, …, hookData)` | the bridge |
| 4 | *(none — Circle mints)* | forwarder pays the Arc gas |

```
platform = amount x 1%
burn     = amount - platform
maxFee   = burn x cctpBps + forwardFee
received = burn - maxFee
```

`cctpBps` and `forwardFee` are quoted live from
`GET /v2/burn/USDC/fees/{src}/26?forward=true&includeRecipientSetup=true`.

### The forwarding hook

```
0x636374702d666f72776172640000000000000000000000000000000000000000
   "cctp-forward"  +  20 zero bytes   =  exactly 32 bytes
```

Verified byte-identical across 18 live Arc mints. This is what makes the cold start work:
Circle submits `receiveMessage` on Arc and takes its fee from the minted amount, so a
brand-new Arc address can receive without ever holding gas.

**Do not pad `maxFee`.** Across 25 live forwarded burns, `feeExecuted == maxFee` exactly —
the service consumes whatever you authorise, so padding is pure overpayment.

## Small transfers

The forwarder fee is a flat ~0.02 USDC regardless of size, so it dominates small amounts:
sending 0.05 USDC loses ~41% to fees, almost none of it yours. The UI warns whenever total
fees exceed 5% of the amount and blocks transfers where fees would exceed the principal.

## If the forwarder stalls

Stuck transfers should not happen: Circle's forwarder submits the mint and pays the Arc
gas, so there is no step that depends on the recipient having a balance.

The one residual risk is the fee quote. `forwardFee` is dynamic — it moved
`21433 -> 20243 -> 20605` (about 6%) over a single session of testing. The app quotes the
`high` tier for headroom, and per Circle's docs an under-covered `maxFee` demotes the
transfer to Standard speed rather than failing it. So the realistic worst case is slow,
not lost.

If Circle has not minted after 15 minutes the transfer card says so and offers two
fallbacks, which appear nowhere in the normal flow:

- **Claim it myself** — submits `receiveMessage` from the connected wallet
- **Download claim data** — a JSON file any funded account can submit later

The burn is attested and the USDC stays claimable indefinitely either way, and
`destinationCaller` is `0x0`, so whoever submits it the funds still go to the recipient
encoded in the message. The submitter cannot redirect them.

## Supported sources

Ethereum, Base, Arbitrum, OP Mainnet, Polygon, Avalanche — native USDC only.
Fast Transfer is unavailable from Polygon and Avalanche; the toggle disables itself.

## Before taking real fees

Charging a fee to move other people's money is a regulated activity in many
jurisdictions. Worth a lawyer's opinion on money-transmission licensing before you
promote this publicly.
