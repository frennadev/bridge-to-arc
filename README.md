# Bridge to Arc

A static dapp that bridges native USDC to **Arc mainnet** over **Circle's CCTP v2**,
using the Forwarding Service so **the recipient needs no gas on Arc**. Non-custodial —
the user's wallet signs everything and funds never touch an intermediary address except
the platform fee.

## Deploy to Vercel

```bash
vercel deploy --prod
```

Static, no build step, no `package.json` needed. `vercel.json` sets the security headers
and caches `/vendor/*` immutably.

**Before the first deploy, edit `config.js`:**

```js
window.CONFIG = {
  TREASURY: "0xYourFeeWallet",   // REQUIRED — app refuses to run while unset
  FEE_BPS: 100,                  // 100 = 1%
  ARC_RPC: "https://rpc.mainnet.arc.io",
  BRAND: "Bridge to Arc",
};
```

`config.js` ships to every visitor. Nothing secret goes in it. `.vercelignore` keeps
`.env.local`, `server.mjs` and `bridge.mjs` out of the deployment.

If `TREASURY` is the zero address the app disables bridging and shows a banner, so a
misconfigured deploy can never silently send fees to the burn address.

## No backend

The page talks only to the user's wallet, Circle's Iris API, and Arc's public RPC — all of
which allow cross-origin browser calls. There is no proxy and no API key anywhere in the
deployment.

`server.mjs` is a local dev convenience only (`node server.mjs` → localhost:5173).
It is excluded from the deploy.

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
