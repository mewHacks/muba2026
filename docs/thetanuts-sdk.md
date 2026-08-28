# Thetanuts SDK Guide (for Track 01 & 02)

Chain: **Base mainnet, chainId 8453**. Same live protocol for both tracks; only difference is what you point the SDK at.

## Tools
| Tool | Install | Use |
|---|---|---|
| SDK | `npm i @thetanuts-finance/thetanuts-client ethers` | TypeScript client — orders, RFQs, fills, positions, pricing. Takes any ethers provider. |
| CLI | `npm i -g @thetanuts-finance/cli` (binary: `thetanuts`) | Wallets/quotes/fills from terminal. `--dry-run` on every command. |
| MCP | `npx -y @thetanuts-finance/mcp` | Gives your coding agent full SDK context via `get_sdk_context`. |
| Docs | docs.thetanuts.finance/for-builders/sdk | Source of truth if slides/repo disagree. Feed agents `llms-full.txt`. |
| Tools page | app.thetanuts.finance/tools | All of the above in one place. |
| Repo | github.com/Thetanuts-Finance/thetanuts-sdk | |
| Live reference (not a template) | odette.fi | Daily options platform built on Thetanuts infra. |

## Setup
1. **Get a free RPC key** (Alchemy or Infura, Base Mainnet) — the public endpoint breaks under polling/backfills.
   ```
   export THETANUTS_RPC_URL="https://base-mainnet.g.alchemy.com/v2/YOUR_KEY"
   ```
   SDK takes any ethers provider; CLI reads `THETANUTS_RPC_URL` or `--rpc-url`.

2. **30-second connectivity check** (no wallet/signer/approvals needed):
   ```js
   const client = new ThetanutsClient({
     chainId: 8453,
     provider: new ethers.JsonRpcProvider(process.env.THETANUTS_RPC_URL),
   });
   console.log((await client.api.fetchOrders()).length, 'live orders');
   console.log(await client.api.getMarketData());
   ```
   If this prints live prices, you're connected. Filling, RFQs, positions, pricing are in the docs/repo README.

## Mainnet trading — real funds, read before you trade
- **Trade small.** 1–3 USDC is enough; a 1 USDC fill scores exactly the same as 100.
- **Use a fresh/burner wallet.** Never point an agent at a wallet holding anything you'd miss. Keep a bit of ETH for gas.
- **Never commit a key.** Use `THETANUTS_PRIVATE_KEY` or `.env`, and check git history before submitting.
- **Dry-run first.** `--dry-run` is global on every CLI command. Approve the exact amount needed, never `MaxUint256`.

## Getting a quote: OptionBook vs RFQ
Both produce identical positions on the same cash-settled contracts.
- **OptionBook** — fill signed orders already sitting live on the book.
- **RFQ** — request a quote for a strike/expiry not on the book, priced in real time.

## Track 01 checklist (best product on SDK)
- Real, working product (not a mockup/README).
- Options usage must be meaningful — fails if it'd work identically with Thetanuts calls stubbed out.
- Directions: structured products, vaults, consumer trading apps, options-powered lending, analytics, or novel ideas.

## Track 02 checklist (AI × Options)
- Agent must place **at least one real trade** against live pricing on Base mainnet via OptionBook or OptionFactory — no paper trading, no testnet.
- Directions: natural-language trading ("hedge my ETH into Friday" → signed fill), strategy/risk copilot (reads book, explains trade-off, executes), autonomous hedging (watches a position, rolls protection).
- Start with `npx -y @thetanuts-finance/mcp` for agent context, sanity-check with the CLI (`npm i -g @thetanuts-finance/cli`) before wiring up.

## Judging (both tracks)
1. Does it work — a real running product, live demo.
2. Would anyone actually use it — who it's for, why they'd pick it, does it scale.
If you plan to keep building post-hackathon, tell the judges — Thetanuts supports serious builders after the event.

## Pre-hackathon checklist
1. Get a free RPC key
2. Run the 30-second connectivity check
3. Install the MCP server
4. Fund a burner wallet on Base (small amount)
5. Pick your track
