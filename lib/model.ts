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
export const MODEL_VERSION = 'radar-3';

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
  /** The category bias divisor learned from live peers' pricing errors (1 = none). */
  bias_factor: number;
}

/** A farm step: the action itself, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One plan's totals: the capital it ties up, its gas bill, its length, its main risk. */
export interface PlanSummary {
  capital_usd: number;
  est_gas_usd: number;
  hold_days: number;
  weeks: number;
  risk: string;
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
    bias_factor: number;
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
  bias_factor: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  farm_steps: string[];
  plan: PlanSummary;
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

/** One validation case: what the model predicted for a live token, and what the market says. */
export interface ValidationCase {
  name: string;
  category: string | null;
  predicted_usd: number;
  actual_usd: number;
  ratio: number;
}

/** One category's validation line: how the model did on that kind of protocol. */
export interface ValidationCategory {
  category: string;
  n: number;
  median_ratio: number;
  within_2x_pct: number;
}

/**
 * The model checked against the market: every live-token protocol in the snapshot
 * priced by the same model with its own ratio left out of its peer anchor, then
 * compared with the market cap the snapshot records for it.
 */
export interface ValidationData {
  n: number;
  median_ratio: number;
  median_abs_log_error: number;
  within_2x_pct: number;
  within_3x_pct: number;
  categories: ValidationCategory[];
  closest: ValidationCase[];
  furthest: ValidationCase[];
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
  validation: ValidationData;
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
/** Every live peer's market-cap-to-TVL ratio, by category and overall, inside the model's sanity band. */
function ratioIndex(snapshot: Snapshot): { byCategory: Map<string, number[]>; all: number[] } {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p) || p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (ratio < MODEL.peer_ratio_low || ratio > MODEL.peer_ratio_high) continue;
    all.push(ratio);
    const key = p.category ?? 'Uncategorised';
    const list = byCategory.get(key) ?? [];
    list.push(ratio);
    byCategory.set(key, list);
  }
  return { byCategory, all };
}

export function peerAnchors(snapshot: Snapshot): { global: number; byCategory: Map<string, PeerAnchor> } {
  const { byCategory: ratiosByCategory, all } = ratioIndex(snapshot);
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
    byCategory.set(category, { category, peers: ratios.length, median_ratio: round4(med), multiple: round4(multiple), bias_factor: 1 });
  }
  return { global: round4(global), byCategory };
}

/** The anchor a protocol is priced with: its category's, or the global median. */
function anchorFor(p: SnapshotProtocol, anchors: Map<string, PeerAnchor>, global: number): PeerAnchor {
  return anchors.get(p.category ?? 'Uncategorised') ?? { category: p.category ?? 'Uncategorised', peers: 0, median_ratio: global, multiple: global, bias_factor: 1 };
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

/** One live protocol's raw peer multiple with its own ratio left out of the evidence. */
function looRawMultiple(p: SnapshotProtocol, idx: { byCategory: Map<string, number[]>; all: number[] }): { multiple: number; peers: number } {
  const own = p.mcap_usd !== null && p.tvl_usd > 0 ? p.mcap_usd / p.tvl_usd : Number.NaN;
  const contributed = own >= MODEL.peer_ratio_low && own <= MODEL.peer_ratio_high;
  const globalLoo = contributed ? medianWithout(idx.all, own) : median(idx.all);
  const key = p.category ?? 'Uncategorised';
  const catList = idx.byCategory.get(key) ?? [];
  if (catList.length === 0) return { multiple: globalLoo, peers: 0 };
  const looList = contributed ? catList.filter((_, i) => i !== catList.indexOf(own)) : catList;
  const peers = looList.length;
  const med = peers > 0 ? median(looList) : globalLoo;
  return { multiple: shrunkMultiple(med, peers, globalLoo), peers };
}

/** How far to trust a category's measured bias: full weight only with many peers. */
function biasAdjustment(peers: number, medianError: number): number {
  const w = peers / (peers + 6);
  return Math.exp(w * Math.log(clamp(medianError, 0.25, 4)));
}

/**
 * The anchors the board is actually priced with: the raw peer multiples, each
 * divided by the bias the raw model shows on that category's live tokens. The
 * bias is the median leave-one-out pricing error on the category's own live
 * protocols, so a category the raw multiple systematically overprices (or
 * underprices) is pulled back toward what the market actually pays - learned
 * from the snapshot itself, with no protocol named and no knob fitted by hand.
 */
export function pricingAnchors(snapshot: Snapshot): { global: number; byCategory: Map<string, PeerAnchor> } {
  const raw = peerAnchors(snapshot);
  const idx = ratioIndex(snapshot);
  const errorsByCategory = new Map<string, number[]>();
  const allErrors: number[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p) || p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const own = p.mcap_usd / p.tvl_usd;
    if (own < MODEL.peer_ratio_low || own > MODEL.peer_ratio_high) continue;
    const { multiple } = looRawMultiple(p, idx);
    const anchor: PeerAnchor = { category: p.category ?? 'Uncategorised', peers: 0, median_ratio: multiple, multiple, bias_factor: 1 };
    const err = impliedValue(p, snapshot.as_of, anchor).implied / p.mcap_usd;
    if (!Number.isFinite(err) || err <= 0) continue;
    allErrors.push(err);
    const key = p.category ?? 'Uncategorised';
    const list = errorsByCategory.get(key) ?? [];
    list.push(err);
    errorsByCategory.set(key, list);
  }
  const globalBias = allErrors.length > 0 ? median(allErrors) : 1;
  const byCategory = new Map<string, PeerAnchor>();
  for (const [category, anchor] of raw.byCategory) {
    const errs = errorsByCategory.get(category) ?? [];
    const adj = errs.length > 0 ? biasAdjustment(errs.length, median(errs)) : biasAdjustment(8, globalBias);
    byCategory.set(category, {
      ...anchor,
      multiple: round4(clamp(anchor.multiple / adj, MODEL.peer_clamp_low, MODEL.peer_clamp_high)),
      bias_factor: round4(adj),
    });
  }
  return { global: raw.global, byCategory };
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

/** The main way one category's plan loses money, stated beside its totals. */
function riskFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return 'Main risk: liquidation if the collateral falls in value. Keep loan-to-value under 40% and check the health factor at the weekly check-in.';
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options'))
    return 'Main risk: funding costs and liquidation on the hedged legs. Keep free margin above three times the maintenance level for the whole hold.';
  if (c.includes('bridge'))
    return 'Main risk: bridge and wrapped-asset risk on the far side. Never hold more across the bridge than the plan needs, and bridge back at the first exit step.';
  if (c.includes('liquid staking') || c.includes('restaking') || c.includes('staking'))
    return 'Main risk: depeg and unbonding delays. The exit can take days after the request, so start the unwind before the hold ends, not after.';
  if (c.includes('dex') || c.includes('swap'))
    return 'Main risk: impermanent loss if the paired asset moves hard against the pool. The two-tranche exit limits slippage on the way out.';
  if (c.includes('yield') || c.includes('vault') || c.includes('aggregator'))
    return "Main risk: the vault's underlying strategies. A yield that jumps suddenly usually means new risk arrived, not free money; re-check before topping up.";
  return 'Main risk: smart-contract risk, and the chance no token ever launches. The capital is sized so that losing all of it is survivable.';
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time, plus
 * the plan's totals. The plan is built from the protocol's own record - category
 * playbook, primary chain fees, TVL-sized capital, age-sized hold - so two
 * protocols rarely share a plan, and no plan names a protocol the model has not read.
 */
export function farmPlan(p: SnapshotProtocol, age: number | null): { steps: FarmStep[]; summary: PlanSummary } {
  const chain = chainOf(p);
  const gas = gasFor(chain);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const weeks = Math.max(4, Math.round(hold / 7));
  const play = playFor(p, capital, chain);
  const variant = slugHash(p.slug) % 2;
  const gasBudget = Math.round(gas * 6 * 10) / 10;
  const summary: PlanSummary = {
    capital_usd: capital,
    est_gas_usd: Math.round(gas * (8 + weeks) * 10) / 10,
    hold_days: hold,
    weeks,
    risk: riskFor(p),
  };
  const steps: FarmStep[] = [
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
  return { steps, summary };
}

/** Just the steps of a protocol's farm plan, as the board records them. */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  return farmPlan(p, age).steps;
}

/** The protocols the board ranks: the whole watchlist, plus every other launch candidate. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const { global, byCategory } = pricingAnchors(snapshot);
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
      bias_factor: s.anchor.bias_factor,
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

/** The median of a list with one occurrence of a value removed (leave-one-out). */
function medianWithout(values: number[], value: number): number {
  const at = values.indexOf(value);
  if (at < 0) return median(values);
  return median([...values.slice(0, at), ...values.slice(at + 1)]);
}

/** A multiple from a peer list and a global median, with the model's shrinkage and guards. */
function shrunkMultiple(med: number, peers: number, global: number): number {
  const w = peers / (peers + MODEL.peer_shrink_k);
  let multiple = clamp(w * med + (1 - w) * global, MODEL.peer_clamp_low, MODEL.peer_clamp_high);
  if (peers < MODEL.thin_peer_threshold) {
    multiple = clamp(multiple, global * MODEL.thin_band_low, global * MODEL.thin_band_high);
  }
  return multiple;
}

/**
 * The model turned on the protocols that already have tokens: each live protocol
 * is priced by the same formula, with its own market-cap-to-TVL ratio left out of
 * its category anchor and the global median, and the prediction is compared with
 * the market cap the snapshot records. Nothing is fitted to the answers - the
 * knobs are the board's own - so the spread below is the model's honest error.
 */
export function validation(snapshot: Snapshot): ValidationData {
  const idx = ratioIndex(snapshot);
  // First pass: the raw model's leave-one-out errors on every live protocol.
  const raw: { p: SnapshotProtocol; multiple: number; err: number }[] = [];
  const errorsByCategory = new Map<string, number[]>();
  const allErrors: number[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p) || p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const own = p.mcap_usd / p.tvl_usd;
    if (own < MODEL.peer_ratio_low || own > MODEL.peer_ratio_high) continue;
    const { multiple } = looRawMultiple(p, idx);
    const anchor: PeerAnchor = { category: p.category ?? 'Uncategorised', peers: 0, median_ratio: multiple, multiple, bias_factor: 1 };
    const err = impliedValue(p, snapshot.as_of, anchor).implied / p.mcap_usd;
    if (!Number.isFinite(err) || err <= 0) continue;
    raw.push({ p, multiple, err });
    allErrors.push(err);
    const key = p.category ?? 'Uncategorised';
    const list = errorsByCategory.get(key) ?? [];
    list.push(err);
    errorsByCategory.set(key, list);
  }
  // Second pass: the board's own pricing - bias-corrected multiples, with the
  // target's own error left out of the bias it is corrected by.
  const cases: (ValidationCase & { slug: string; absLog: number })[] = [];
  for (const { p, multiple, err } of raw) {
    const key = p.category ?? 'Uncategorised';
    const catErrs = errorsByCategory.get(key) ?? [];
    const adj =
      catErrs.length > 1
        ? biasAdjustment(catErrs.length - 1, medianWithout(catErrs, err))
        : biasAdjustment(Math.max(allErrors.length - 1, 0), medianWithout(allErrors, err));
    const corrected = clamp(multiple / adj, MODEL.peer_clamp_low, MODEL.peer_clamp_high);
    const anchor: PeerAnchor = { category: key, peers: 0, median_ratio: multiple, multiple: corrected, bias_factor: round4(adj) };
    const v = impliedValue(p, snapshot.as_of, anchor);
    const ratio = v.implied / p.mcap_usd!;
    cases.push({
      slug: p.slug,
      name: p.name,
      category: p.category,
      predicted_usd: v.implied,
      actual_usd: p.mcap_usd!,
      ratio: round4(ratio),
      absLog: Math.abs(Math.log(ratio)),
    });
  }
  const ratios = cases.map((c) => c.ratio);
  const byCategory = new Map<string, (ValidationCase & { absLog: number })[]>();
  for (const c of cases) {
    const key = c.category ?? 'Uncategorised';
    const list = byCategory.get(key) ?? [];
    list.push(c);
    byCategory.set(key, list);
  }
  const categories: ValidationCategory[] = [...byCategory.entries()]
    .filter(([, list]) => list.length >= 4)
    .map(([category, list]) => ({
      category,
      n: list.length,
      median_ratio: round4(median(list.map((c) => c.ratio))),
      within_2x_pct: Math.round((100 * list.filter((c) => c.ratio >= 0.5 && c.ratio <= 2).length) / list.length),
    }))
    .sort((a, b) => b.n - a.n || (a.category < b.category ? -1 : 1))
    .slice(0, 14);
  const byError = [...cases].sort((a, b) => a.absLog - b.absLog || (a.slug < b.slug ? -1 : 1));
  const strip = (c: (typeof cases)[number]): ValidationCase => ({
    name: c.name,
    category: c.category,
    predicted_usd: c.predicted_usd,
    actual_usd: c.actual_usd,
    ratio: c.ratio,
  });
  return {
    n: cases.length,
    median_ratio: round4(median(ratios)),
    median_abs_log_error: round4(median(cases.map((c) => c.absLog))),
    within_2x_pct: Math.round((100 * cases.filter((c) => c.ratio >= 0.5 && c.ratio <= 2).length) / cases.length),
    within_3x_pct: Math.round((100 * cases.filter((c) => c.ratio >= 1 / 3 && c.ratio <= 3).length) / cases.length),
    categories,
    closest: byError.slice(0, 6).map(strip),
    furthest: byError.slice(-6).reverse().map(strip),
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const live = liveRows(snapshot);
  const { global, byCategory } = pricingAnchors(snapshot);
  const anchors = [...byCategory.values()].sort((a, b) => b.peers - a.peers || (a.category < b.category ? -1 : 1)).slice(0, 14);
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
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
    validation: validation(snapshot),
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
      bias_factor: r.model.bias_factor,
      growth_multiplier: r.model.growth_multiplier,
      maturity_multiplier: r.model.maturity_multiplier,
      breadth_multiplier: r.model.breadth_multiplier,
      farm_steps: r.farm_steps,
      plan: farmPlan(bySlug.get(r.slug)!, r.age_days).summary,
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
