// Token Radar model, version radar-2 "peer-anchored".
//
// One sealed DefiLlama snapshot in, one ranked board out. The board answers a single
// question: which protocols that record no token yet are worth a farmer's next dollar,
// what would that token be worth if the protocol's record stayed as it is today, and
// exactly what should the farmer do, at what cost, for how long.
//
// The implied value is anchored to the market, not to a flat guess. Protocols whose
// token already trades reveal, category by category, what the market pays for a
// dollar of TVL. radar-2 reads those live peers from the same snapshot, takes the
// median market-cap / TVL ratio of each category, shrinks small samples toward the
// global median, and prices every pre-token protocol at its own category's anchor:
//
//   implied = TVL x peerMultiple(category) x growthMult x maturityMult x breadthMult
//
//   peerMultiple  median live mcap/TVL of the category, shrunk to the global median
//                 by n/(n+8), clamped to [0.05, 1.60]; the global median is the
//                 fallback for a category with no live peers at all. A thin
//                 category (fewer than four live peers) is distrusted: its
//                 multiple is pinned inside [0.7 x global, 1.5 x global], so one
//                 outlier token can never price a whole category by itself.
//   growthMult    1 + clamp(change_7d, -50, +100)/100 x 0.55: a hot week lifts the
//                 price, a shrinking protocol is discounted, never below 0.725.
//   maturityMult  0.72 + 0.38 x min(age_days, 1825)/1825: a protocol that has run
//                 for years with no token has a record a launch can be priced on.
//                 Unknown listing date counts as 540 days and is shown as unknown.
//   breadthMult   1 + 0.025 x min(chains - 1, 8): distribution across chains is
//                 reach a token launch inherits on day one.
//
// No protocol name is ever special-cased: the same code prices every row, and a
// future snapshot with protocols that do not exist yet flows through unchanged.
// Protocols whose token already trades are never ranked: they are the peer anchors,
// shown apart in the dashboard's Live view with the market's own values.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's version label, printed on the dashboard and in board.json. */
export const MODEL_VERSION = 'radar-2';

/** The knobs of the value model, stated on the dashboard so a reader can audit them. */
export const MODEL = {
  peer_clamp_low: 0.05,
  peer_clamp_high: 1.6,
  peer_shrink_k: 8,
  peer_ratio_low: 0.02,
  peer_ratio_high: 5,
  thin_peer_threshold: 4,
  thin_band_low: 0.7,
  thin_band_high: 1.5,
  growth_weight: 0.55,
  growth_floor: -50,
  growth_cap: 100,
  maturity_floor: 0.72,
  maturity_range: 0.38,
  maturity_days: 1825,
  unknown_age_days: 540,
  breadth_step: 0.025,
  breadth_max_extra_chains: 8,
};

/** One category's live-peer anchor: how the market prices its TVL today. */
export interface PeerAnchor {
  category: string;
  peers: number;
  median_ratio: number;
  multiple: number;
}

/** A farm step: the action itself, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row, with the full model breakdown. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  tier: 'watchlist' | 'early';
  age_days: number | null;
  implied_value_usd: number;
  signal_score: number;
  model: {
    peer_multiple: number;
    peer_count: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's view of one ranked row: everything the page renders, plan included. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  tier: 'watchlist' | 'early';
  implied_value_usd: number;
  signal_score: number;
  peer_multiple: number;
  peer_count: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  farm_steps: string[];
}

/** A live-token protocol: an anchor, never a ranked row. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  ratio: number | null;
}

/** Everything the dashboard needs: the board, the live anchors, and the model itself. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  global_multiple: number;
  anchors: PeerAnchor[];
  scanned_size: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  total_implied_usd: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when a date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list, sorted copy in, middle (or mean of middles) out. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Whether a protocol records no token at all in the snapshot. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const PRODUCT_WORDS = new Set(['wrapped', 'staked', 'staking']);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/**
 * Whether a pre-token protocol is a launch candidate in its own right, applying the
 * watchlist's own product rules at any size: not a versioned pool of another
 * protocol, not a wrapped, staked or bridged product of a token that already
 * trades, and not an exchange's own venue.
 */
export function isLaunchCandidate(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  const words = p.name.toLowerCase().split(/[^a-z0-9]+/);
  if (words.some((w) => PRODUCT_WORDS.has(w))) return false;
  if (EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x))) return false;
  return true;
}

/**
 * The peer anchors: for every category, the live protocols whose token trades give
 * the market's own price for a TVL dollar. Ratios outside [0.02, 5] are dropped as
 * broken records (a near-zero TVL against a legacy market cap, or the reverse).
 */
export function peerAnchors(snapshot: Snapshot): { global: number; byCategory: Map<string, PeerAnchor> } {
  const ratiosByCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p) || p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (ratio < MODEL.peer_ratio_low || ratio > MODEL.peer_ratio_high) continue;
    all.push(ratio);
    const key = p.category ?? 'Uncategorised';
    const list = ratiosByCategory.get(key) ?? [];
    list.push(ratio);
    ratiosByCategory.set(key, list);
  }
  const global = all.length > 0 ? median(all) : 0.2;
  const byCategory = new Map<string, PeerAnchor>();
  for (const [category, ratios] of ratiosByCategory) {
    const med = median(ratios);
    const w = ratios.length / (ratios.length + MODEL.peer_shrink_k);
    let multiple = clamp(w * med + (1 - w) * global, MODEL.peer_clamp_low, MODEL.peer_clamp_high);
    // Thin-category guard: with fewer than four live peers the category's own
    // median is anecdote, not evidence, so the anchor stays near the global one.
    if (ratios.length < MODEL.thin_peer_threshold) {
      multiple = clamp(multiple, global * MODEL.thin_band_low, global * MODEL.thin_band_high);
    }
    byCategory.set(category, { category, peers: ratios.length, median_ratio: round4(med), multiple: round4(multiple) });
  }
  return { global: round4(global), byCategory };
}

/** The anchor a protocol is priced with: its category's, or the global median. */
function anchorFor(p: SnapshotProtocol, anchors: Map<string, PeerAnchor>, global: number): PeerAnchor {
  return anchors.get(p.category ?? 'Uncategorised') ?? { category: p.category ?? 'Uncategorised', peers: 0, median_ratio: global, multiple: global };
}

/** Every multiplier of the model for one protocol, and the implied value they make. */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  anchor: PeerAnchor,
): { implied: number; growthPct: number; growthMult: number; maturityMult: number; breadthMult: number; age: number | null } {
  const age = ageDays(asOf, p.listed_at);
  const growthPct = clamp(finite(p.change_7d, 0), MODEL.growth_floor, MODEL.growth_cap);
  const growthMult = 1 + (growthPct / 100) * MODEL.growth_weight;
  const ageForModel = age ?? MODEL.unknown_age_days;
  const maturityMult = MODEL.maturity_floor + (clamp(ageForModel, 0, MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_range;
  const breadthMult = 1 + MODEL.breadth_step * Math.min(Math.max(p.chains.length - 1, 0), MODEL.breadth_max_extra_chains);
  const implied = Math.max(1, Math.round(p.tvl_usd * anchor.multiple * growthMult * maturityMult * breadthMult));
  return { implied, growthPct, growthMult, maturityMult, breadthMult, age };
}

/**
 * A 0-100 farming signal, separate from price: how much a farmer's hour is worth
 * here. Scale and momentum dominate; a long tokenless record and multi-chain reach
 * support. It sorts and colours the dashboard; it never moves the implied value.
 */
export function signalScore(p: SnapshotProtocol, age: number | null): number {
  const scale = clamp(Math.log10(Math.max(p.tvl_usd, 1) / 5_000_000) / Math.log10(400), 0, 1);
  const momentum = clamp((finite(p.change_7d, 0) + 20) / 70, 0, 1);
  const maturity = clamp((age ?? MODEL.unknown_age_days) / 1460, 0, 1);
  const breadth = clamp(p.chains.length / 6, 0, 1);
  return Math.round(100 * (0.42 * scale + 0.26 * momentum + 0.2 * maturity + 0.12 * breadth));
}

/** A deterministic small hash of a slug, so plan phrasing varies by protocol, never by run. */
function slugHash(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return h;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** One network action's typical fee in dollars, by the chain it runs on. */
function gasFor(chain: string): number {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 14;
  if (c === 'solana') return 0.3;
  if (c === 'bsc' || c === 'binance') return 0.8;
  if (c === 'polygon' || c === 'polygon zkevm') return 0.4;
  if (c === 'avalanche') return 1.1;
  if (c === 'arbitrum' || c === 'base' || c === 'optimism' || c === 'linea' || c === 'scroll' || c === 'zksync era' || c === 'mantle' || c === 'blast') return 1.4;
  return 2;
}

/** How much capital one farm position needs, from the protocol's own TVL tier. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 2_000_000_000) return 500;
  if (p.tvl_usd >= 500_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  if (p.tvl_usd >= 25_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger records need a longer window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 60;
  if (age < 180) return 75;
  if (age < 540) return 60;
  return 45;
}

interface CategoryPlay {
  core: string;
  second: string;
  unwind: string;
}

/** The category's playbook: the core position, the second qualifying action, the exit. */
function playFor(p: SnapshotProtocol, capital: number, chain: string): CategoryPlay {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return {
      core: `Supply $${capital} of USDC as collateral to ${n} on ${chain}, then borrow $${Math.round(capital * 0.35)} of USDC against it at under 40% loan-to-value and re-supply the borrowed half.`,
      second: `Repay and re-borrow once during the hold so the position shows two separate borrow events, and vote on one ${n} governance proposal if voting is live.`,
      unwind: `Repay the borrow in full first, then withdraw the collateral; never withdraw collateral while the loan is open.`,
    };
  if (c.includes('dex') || c.includes('swap'))
    return {
      core: `Swap $${Math.round(capital / 2)} of USDC for the pool's paired asset on ${n}, then add $${capital} of two-sided liquidity to its busiest ${chain} pool and keep the LP position open.`,
      second: `Make two swaps a week of about $${Math.max(10, Math.round(capital / 10))} each on ${n} so the wallet reads as a regular trader, not a one-day visitor.`,
      unwind: `Remove the liquidity, then swap the paired asset back to USDC in two tranches to limit slippage.`,
    };
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options'))
    return {
      core: `Deposit $${capital} of USDC as margin on ${n} and open one small hedged pair: a long and a short of $${Math.round(capital / 4)} each on its two most liquid markets.`,
      second: `Place and cancel two limit orders a week and settle one funding period with the hedge open, so the account shows real trading, not a parked deposit.`,
      unwind: `Close both legs of the hedge in the same session, then withdraw the margin; never leave one leg open alone.`,
    };
  if (c.includes('bridge') || c.includes('cross chain') || c.includes('interoperab'))
    return {
      core: `Bridge $${capital} of USDC from Ethereum to ${chain} through ${n}, then use the bridged funds in one app on the far side the same day.`,
      second: `Bridge a second, smaller amount of about $${Math.round(capital / 4)} back the following week so the wallet has routes in both directions.`,
      unwind: `Bridge the remaining funds back to Ethereum and keep both route receipts with the farm log.`,
    };
  if (c.includes('staking') || c.includes('restak'))
    return {
      core: `Stake $${capital} of the chain's staking asset through ${n} on ${chain} and keep the staking receipt token in the same wallet for the whole hold.`,
      second: `Claim and re-stake the rewards once, midway through the hold, so the position compounds and the claim is on record.`,
      unwind: `Start the unbonding period before you need the funds: unstake, wait out the protocol's exit queue, then withdraw to the wallet.`,
    };
  if (c.includes('yield') || c.includes('curator') || c.includes('allocator') || c.includes('vault'))
    return {
      core: `Deposit $${capital} of USDC into the largest ${n} vault on ${chain} and keep the vault shares untouched for the whole hold.`,
      second: `Add a second deposit of about $${Math.round(capital / 4)} two weeks later, so the record shows two deposits in different market conditions.`,
      unwind: `Withdraw the shares in one redemption and check the withdrawal settled to the wallet before closing the log.`,
    };
  if (c.includes('rwa') || c.includes('real world'))
    return {
      core: `Complete ${n}'s onboarding or KYC if it asks for it, then mint $${capital} of its yield asset on ${chain} and hold it.`,
      second: `Hold through one full distribution or interest period and save the statement it issues as proof of the position.`,
      unwind: `Redeem the asset through ${n}'s own redemption window and allow for its settlement days before counting the funds back.`,
    };
  if (c.includes('prediction'))
    return {
      core: `Fund $${capital} on ${n} and take positions in two unrelated markets, no more than $${Math.round(capital / 4)} on either side.`,
      second: `Trade out of one position before it settles and into a third market, so the account shows trading rather than a single bet.`,
      unwind: `Let open positions settle or sell them back, then withdraw the balance in one transaction.`,
    };
  if (c.includes('stable'))
    return {
      core: `Mint or deposit $${capital} of the stable asset through ${n} on ${chain}, then park the minted asset in its savings or staking vault if it offers one.`,
      second: `Make one transfer of the stable asset to a second wallet you control and back, so the holding is not a single static deposit.`,
      unwind: `Unstake first if the asset is vaulted, then redeem or swap back to USDC.`,
    };
  if (c.includes('insurance'))
    return {
      core: `Buy $${capital} of cover from ${n} on ${chain} against the largest protocol you already farm, for the longest term it offers.`,
      second: `Renew or extend the cover once before it lapses so the wallet holds cover across two separate periods.`,
      unwind: `Let the cover expire naturally; there is nothing to unwind, and the expired policy stays on record.`,
    };
  if (c.includes('launchpad') || c.includes('ido'))
    return {
      core: `Stake or deposit $${capital} in ${n}'s allocation tier on ${chain} and register the wallet for the next sale it lists.`,
      second: `Take part in one sale or claim window it runs during the hold, even at the minimum allocation.`,
      unwind: `Unstake the tier deposit after the sale settles and withdraw any unspent allocation funds.`,
    };
  return {
    core: `Deposit $${capital} of USDC into ${n} on ${chain} through its own app and keep the position open for the whole hold.`,
    second: `Repeat ${n}'s main in-app action once a week - a deposit top-up, a swap or a claim - so the wallet shows a pattern of real use.`,
    unwind: `Withdraw the position through ${n}'s own app and confirm the funds are back in the wallet before closing the log.`,
  };
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The
 * plan is built from the protocol's own record - category playbook, primary chain
 * fees, TVL-sized capital, age-sized hold - so two protocols rarely share a plan,
 * and no plan names a protocol the model has not read.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const gas = gasFor(chain);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const weeks = Math.max(4, Math.round(hold / 7));
  const play = playFor(p, capital, chain);
  const variant = slugHash(p.slug) % 2;
  const gasBudget = Math.round(gas * 6 * 10) / 10;
  return [
    {
      text:
        variant === 0
          ? `Use a fresh wallet for ${p.name} that holds only the funds this plan needs, fund it with the gas token of ${chain} plus $${capital} of USDC, and keep its seed phrase offline.`
          : `Set up one wallet dedicated to ${p.name}, move $${capital} of USDC and a small gas balance for ${chain} into it, and label it in your farm log with today's date.`,
      cost: `about $${gasBudget} of gas budget for the whole plan`,
      time: '10 minutes',
    },
    { text: play.core, cost: `$${capital} of capital and about $${gas} of gas`, time: '20 minutes to set up' },
    { text: play.second, cost: `about $${gas} of gas${capital >= 150 ? ` and up to $${Math.round(capital / 4)} of extra capital` : ''}`, time: '15 minutes' },
    {
      text: `Repeat one qualifying action on ${p.name} every week for ${weeks} weeks - a top-up, a swap, a claim or a vote - and never let two weeks pass with no activity.`,
      cost: `about $${Math.round(gas * weeks * 10) / 10} of gas over the whole ${hold}-day hold`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days. Check ${p.name}'s TVL trend once a week: if its TVL falls more than 15% in a week or it announces a token with a snapshot date, follow the announcement, not this plan.`,
      cost: `the $${capital} stays in the position for ${hold} days`,
      time: `${hold} days, with a 5-minute weekly check`,
    },
    {
      text: `Check ${p.name}'s own points, rewards or governance page once a week and claim only through the link that page publishes; a claim that asks for a fee or a signature to move funds is a scam, not a claim.`,
      cost: 'nothing to check, and never pay to claim',
      time: '5 minutes a week',
    },
    {
      text: `Log every transaction hash, date and amount in the farm log, then exit in order: ${play.unwind}`,
      cost: `about $${gas} of gas to unwind`,
      time: '15 minutes',
    },
  ];
}

/** The protocols the board ranks: the whole watchlist, plus every other launch candidate. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const { global, byCategory } = peerAnchors(snapshot);
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watch = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isLaunchCandidate(p)) chosen.set(p.slug, p);
  }
  const scored = [...chosen.values()].map((p) => {
    const anchor = anchorFor(p, byCategory, global);
    const v = impliedValue(p, snapshot.as_of, anchor);
    return { p, anchor, ...v, signal: signalScore(p, v.age) };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    tier: watch.has(s.p.slug) ? ('watchlist' as const) : ('early' as const),
    age_days: s.age,
    implied_value_usd: s.implied,
    signal_score: s.signal,
    model: {
      peer_multiple: s.anchor.multiple,
      peer_count: s.anchor.peers,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      breadth_multiplier: round4(s.breadthMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** The live-token protocols, by market cap: the peer anchors the dashboard shows apart. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, 36)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      ratio: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const live = liveRows(snapshot);
  const { global, byCategory } = peerAnchors(snapshot);
  const anchors = [...byCategory.values()].sort((a, b) => b.peers - a.peers || (a.category < b.category ? -1 : 1)).slice(0, 14);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    global_multiple: global,
    anchors,
    scanned_size: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => r.tier === 'early').length,
    live_size: live.length,
    total_implied_usd: board.reduce((sum, r) => sum + r.implied_value_usd, 0),
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      listed_at: r.listed_at,
      age_days: r.age_days,
      tier: r.tier,
      implied_value_usd: r.implied_value_usd,
      signal_score: r.signal_score,
      peer_multiple: r.model.peer_multiple,
      peer_count: r.model.peer_count,
      growth_multiplier: r.model.growth_multiplier,
      maturity_multiplier: r.model.maturity_multiplier,
      breadth_multiplier: r.model.breadth_multiplier,
      farm_steps: r.farm_steps,
    })),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `the board holds ${board.length} rows, under the 100-row floor`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return 'every row shares one implied value';
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
