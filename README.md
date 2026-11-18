[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/kyamano/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/kyamano/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Token Radar — a peer-anchored token launch radar (token-radar-01 entry)

A program plus the dashboard it writes. `main.ts` (Node 22, standard library
only) reads the sealed DefiLlama snapshot, ranks every protocol that records no
token yet by an implied launch value, and writes a static dashboard a farmer
can act on: what to farm next, what it would be worth, and the exact steps,
costs and holding time for each protocol.

## The model — radar-3, peer-anchored and bias-corrected

    implied = TVL × peer multiple × growth × maturity × breadth

- **Peer multiple** — the median market-cap / TVL of the live tokens in the
  protocol's own category, read from the same snapshot, shrunk toward the
  global median when a category has few peers. Live tokens are never ranked;
  they are the measuring stick.
- **Bias correction** — each category's multiple is divided by the median
  error the raw multiple makes on that category's own live tokens, each priced
  leave-one-out. A category the market systematically pays less for than its
  peer median suggests is priced down before it reaches the board.
- **Growth** — the 7-day TVL change, clamped to −50%…+100%, weighted 0.55.
- **Maturity** — years tracked with no token, up to five.
- **Breadth** — +2.5% per extra chain, up to eight.

No protocol name is special-cased anywhere: run the program on a fresher
snapshot and protocols that do not exist yet are priced by the same function.

## The model, checked against the market

The dashboard's Model check view prices every live-token protocol in the
snapshot (104 of them) with the board's own formula, each with its own
figures left out of the evidence. Median predicted / actual market cap:
1.09× — calibrated at the median. Individual protocols still disperse widely
around their category's price (typical miss ≈ ×4.4), which is why the board
prices by category and every farm plan sizes its position small enough to
lose. The closest calls and the widest misses are both shown, by category.

## The board

198 rows on the sealed snapshot: all 40 watchlist protocols (the floor) plus
158 early finds below the $50M floor that pass the watchlist's own product
rules — no versioned pools, no wrapped / staked / bridged products of tokens
that already trade, no exchange venues. Every row carries a 7-step farm plan
built from its own record (category playbook, primary-chain fees, TVL-sized
capital, age-sized hold), each step with a cost and a time, plus the plan's
totals — capital, estimated gas, hold length — and its main risk, stated per
category.

## Run it

    mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>

Writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and
`dossier.json` (via the kit's vendored `vendor/makefun-board.ts`) to the
output directory. The dashboard is a static page — sortable, filterable, with
a detail view per protocol, a separate Live anchors view and the Model check
view — and renders with no network.
