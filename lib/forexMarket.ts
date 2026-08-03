// @ts-nocheck
/***
 * lib/forexMarket.ts
 *
 * Ocean Hunt has a living ocean. Forex needs a living market instead — and
 * a real forex market isn't several independent random numbers, it's a
 * handful of currencies moving relative to each other. This engine models
 * that directly instead of copying the single-pair-per-slot approach.
 *
 * ── Model ────────────────────────────────────────────────────────────────
 * 1. usdStrength — one shared macro factor (mean-reverting, like a slow
 *    tide). Every pair reacts to it with its own beta, so EUR/USD, GBP/USD
 *    and AUD/USD move together when the dollar swings, while USD/JPY moves
 *    the opposite way — the way real majors actually correlate.
 * 2. Each pair also has its own trendCenter, which usdStrength nudges
 *    around the pair's anchor, and its own midPrice, which wobbles around
 *    trendCenter. Two layers of mean reversion = realistic "wanders, but
 *    doesn't run away forever" behavior without needing per-pair states.
 * 3. Regimes (ranging / trending / volatile / flash_crash / rally) bias the
 *    macro factor's drift and scale volatility for everyone at once —
 *    genuinely market-wide conditions, not per-pair flavor.
 * 4. News events layer on top: a temporary volatility spike plus an
 *    immediate directional gap, affecting one or all pairs for a window.
 *
 * ── Two different "speeds" of movement ──────────────────────────────────
 * - Ambient ticks: slow background drift over real wall-clock time, used
 *   whenever someone just checks the board (`.forex market`).
 * - Round ticks: a burst of compressed movement injected specifically while
 *   a round is open (see resolveRoundPrices), representing the few minutes
 *   of "market activity" a round represents. This is deliberately a
 *   separate, larger volatility parameter from the ambient one — trying to
 *   tune a single number to feel right for both "watching the board idly"
 *   and "a fast betting round" was fighting itself.
 */

import crypto from 'crypto';
import { createStore } from './pluginStore.js';

const store = createStore('forexmarket');
const stateTbl = store.table('state');

// ── RNG ──────────────────────────────────────────────────────────────
function secureRandom(): number {
  const buffer = crypto.randomBytes(4);
  return buffer.readUInt32BE(0) / 0xFFFFFFFF;
}

/** Standard-normal shock via Box-Muller, scaled by stdev. */
function gaussianShock(stdev: number): number {
  const u1 = Math.max(secureRandom(), 1e-9);
  const u2 = secureRandom();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return z * stdev;
}

function weightedPick<T extends { weight: number }>(items: T[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let roll = secureRandom() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return items[items.length - 1];
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// ── Pair configuration ────────────────────────────────────────────────

export interface PairConfig {
  symbol: string;
  display: string;
  anchor: number;
  pipSize: number;
  decimals: number;
  /** Sensitivity to the shared usdStrength factor. Positive = pair rises
   *  when the dollar strengthens (USD is the base currency); negative =
   *  pair falls when the dollar strengthens (USD is the quote currency). */
  usdBeta: number;
  /** How many pips the macro factor can pull the trend center, at |usdStrength|=1. */
  macroSensitivityPips: number;
  tickVolPips: number;   // ambient, real-time wobble
  roundVolPips: number;  // compressed, in-round wobble
  baseSpreadPips: number;
  /** Per-pair payout curve scale — see forexGame.ts computeMultiplier().
   *  Different vol/spread ratios per pair produce different RTP under one
   *  shared curve (measured via simulation, not assumed); this corrects it
   *  so every pair lands in the same target band instead of only the
   *  "average" pair being calibrated correctly. */
  pipMultScale: number;
}

export const PAIRS: Record<string, PairConfig> = {
  EURUSD: { symbol: 'EURUSD', display: 'EUR/USD', anchor: 1.0800, pipSize: 0.0001, decimals: 4, usdBeta: -1.0, macroSensitivityPips: 120, tickVolPips: 0.35, roundVolPips: 3.0, baseSpreadPips: 1.2, pipMultScale: 1.00 },
  GBPUSD: { symbol: 'GBPUSD', display: 'GBP/USD', anchor: 1.2700, pipSize: 0.0001, decimals: 4, usdBeta: -1.0, macroSensitivityPips: 150, tickVolPips: 0.42, roundVolPips: 3.6, baseSpreadPips: 1.8, pipMultScale: 0.90 },
  USDJPY: { symbol: 'USDJPY', display: 'USD/JPY', anchor: 155.00, pipSize: 0.01, decimals: 2, usdBeta: 1.0, macroSensitivityPips: 130, tickVolPips: 0.38, roundVolPips: 3.2, baseSpreadPips: 1.5, pipMultScale: 0.98 },
  AUDUSD: { symbol: 'AUDUSD', display: 'AUD/USD', anchor: 0.6600, pipSize: 0.0001, decimals: 4, usdBeta: -0.8, macroSensitivityPips: 110, tickVolPips: 0.40, roundVolPips: 3.3, baseSpreadPips: 1.6, pipMultScale: 0.96 },
};

// ── Regimes ──────────────────────────────────────────────────────────

export type Regime = 'ranging' | 'trending_bull' | 'trending_bear' | 'volatile' | 'flash_crash' | 'rally';

interface RegimeConfig {
  label: string;
  emoji: string;
  macroDriftBias: number; // added to macro factor's drift each ambient tick
  volMultiplier: number;
  minDurationMs: number;
  maxDurationMs: number;
  weight: number;
}

// "bull" = broad risk-on = dollar softens = majors (quoted against USD) drift up.
// "bear" = dollar firms = majors drift down. USD/JPY moves opposite since USD is the base there.
const REGIME_TABLE: Record<Regime, RegimeConfig> = {
  ranging:       { label: 'Ranging Market',   emoji: '📏', macroDriftBias: 0,     volMultiplier: 1.0, minDurationMs: 60 * 60_000, maxDurationMs: 4 * 60 * 60_000, weight: 35 },
  trending_bull: { label: 'Risk-On Rally',    emoji: '📈', macroDriftBias: -0.02, volMultiplier: 1.1, minDurationMs: 60 * 60_000, maxDurationMs: 3 * 60 * 60_000, weight: 20 },
  trending_bear: { label: 'Dollar Strength',  emoji: '📉', macroDriftBias: 0.02,  volMultiplier: 1.1, minDurationMs: 60 * 60_000, maxDurationMs: 3 * 60 * 60_000, weight: 20 },
  volatile:      { label: 'Choppy & Volatile', emoji: '⚡', macroDriftBias: 0,     volMultiplier: 2.2, minDurationMs: 20 * 60_000, maxDurationMs: 90 * 60_000, weight: 15 },
  flash_crash:   { label: 'Flash Crash',      emoji: '🔻', macroDriftBias: 0.15,  volMultiplier: 3.0, minDurationMs: 5 * 60_000,  maxDurationMs: 20 * 60_000, weight: 5 },
  rally:         { label: 'Short Squeeze',    emoji: '🚀', macroDriftBias: -0.15, volMultiplier: 2.8, minDurationMs: 5 * 60_000,  maxDurationMs: 20 * 60_000, weight: 5 },
};

// ── News events ────────────────────────────────────────────────────────

interface NewsEventTemplate {
  id: string;
  name: string;
  emoji: string;
  description: string;
  volMultiplier: number;
  gapPipsRange: [number, number];
  pairs: 'all' | string[];
  durationMsRange: [number, number];
}

const NEWS_EVENTS: NewsEventTemplate[] = [
  { id: 'nfp', name: 'NFP Release', emoji: '📊', description: 'Non-farm payrolls just dropped.', volMultiplier: 2.5, gapPipsRange: [5, 25], pairs: 'all', durationMsRange: [15 * 60_000, 45 * 60_000] },
  { id: 'rate_decision', name: 'Rate Decision', emoji: '🏦', description: 'Central bank rate decision.', volMultiplier: 3.0, gapPipsRange: [10, 40], pairs: 'all', durationMsRange: [20 * 60_000, 60 * 60_000] },
  { id: 'cpi', name: 'CPI Print', emoji: '📈', description: 'Inflation data just landed.', volMultiplier: 2.0, gapPipsRange: [5, 20], pairs: 'all', durationMsRange: [15 * 60_000, 40 * 60_000] },
  { id: 'geo_shock', name: 'Geopolitical Shock', emoji: '🌍', description: 'Breaking geopolitical headlines.', volMultiplier: 3.5, gapPipsRange: [15, 50], pairs: 'all', durationMsRange: [10 * 60_000, 30 * 60_000] },
];

const MIN_EVENT_INTERVAL_MS = 45 * 60_000;
const MAX_EVENT_INTERVAL_MS = 3 * 60 * 60_000;

export interface ActiveEvent {
  id: string;
  name: string;
  emoji: string;
  description: string;
  volMultiplier: number;
  pairs: 'all' | string[];
  expiresAt: number;
}

// ── State shape ──────────────────────────────────────────────────────

interface PairState {
  mid: number;
  trendCenter: number;
}

interface MarketState {
  lastTick: number;
  regime: Regime;
  regimeExpiresAt: number;
  usdStrength: number;
  nextEventAt: number;
  activeEvent: ActiveEvent | null;
  pairs: Record<string, PairState>;
}

const TICK_MS = 5 * 60_000; // ambient tick cadence
const MAX_CATCHUP_STEPS = 50;

const MACRO_BASELINE = 0;
const MACRO_REVERSION = 0.05;
const MACRO_VOL = 0.08;
const MACRO_CLAMP = 1.5;

const TREND_REVERSION = 0.05;
const MID_REVERSION = 0.30;

function freshState(): MarketState {
  const now = Date.now();
  const pairs: Record<string, PairState> = {};
  for (const cfg of Object.values(PAIRS)) {
    pairs[cfg.symbol] = { mid: cfg.anchor, trendCenter: cfg.anchor };
  }
  return {
    lastTick: now,
    regime: 'ranging',
    regimeExpiresAt: now + 90 * 60_000,
    usdStrength: 0,
    nextEventAt: now + MIN_EVENT_INTERVAL_MS + secureRandom() * (MAX_EVENT_INTERVAL_MS - MIN_EVENT_INTERVAL_MS),
    activeEvent: null,
    pairs,
  };
}

async function loadState(): Promise<MarketState> {
  const raw = await stateTbl.get('market');
  return raw || freshState();
}

async function saveState(state: MarketState): Promise<void> {
  await stateTbl.set('market', state);
}

function rollRegime(): Regime {
  const options = (Object.keys(REGIME_TABLE) as Regime[]).map(r => ({ key: r, weight: REGIME_TABLE[r].weight }));
  const picked = weightedPick(options as any);
  return (picked as any).key;
}

function eventAffectsPair(event: ActiveEvent, symbol: string): boolean {
  return event.pairs === 'all' || event.pairs.includes(symbol);
}

/** One ambient tick: regime transitions, macro factor step, event roll/expiry, per-pair trend + mid step. */
function ambientStep(state: MarketState, now: number): void {
  // Regime transition
  if (now >= state.regimeExpiresAt) {
    state.regime = rollRegime();
    const cfg = REGIME_TABLE[state.regime];
    state.regimeExpiresAt = now + cfg.minDurationMs + secureRandom() * (cfg.maxDurationMs - cfg.minDurationMs);
  }
  const regimeCfg = REGIME_TABLE[state.regime];

  // News event expiry / trigger
  if (state.activeEvent && now >= state.activeEvent.expiresAt) {
    state.activeEvent = null;
  }
  if (!state.activeEvent && now >= state.nextEventAt) {
    const template = NEWS_EVENTS[Math.floor(secureRandom() * NEWS_EVENTS.length)];
    const duration = template.durationMsRange[0] + secureRandom() * (template.durationMsRange[1] - template.durationMsRange[0]);
    state.activeEvent = {
      id: template.id,
      name: template.name,
      emoji: template.emoji,
      description: template.description,
      volMultiplier: template.volMultiplier,
      pairs: template.pairs,
      expiresAt: now + duration,
    };
    // Immediate directional gap on affected pairs' trend centers
    for (const cfg of Object.values(PAIRS)) {
      if (!eventAffectsPair(state.activeEvent, cfg.symbol)) continue;
      const magnitude = template.gapPipsRange[0] + secureRandom() * (template.gapPipsRange[1] - template.gapPipsRange[0]);
      const sign = secureRandom() < 0.5 ? -1 : 1;
      state.pairs[cfg.symbol].trendCenter += sign * magnitude * cfg.pipSize;
    }
    state.nextEventAt = now + MIN_EVENT_INTERVAL_MS + secureRandom() * (MAX_EVENT_INTERVAL_MS - MIN_EVENT_INTERVAL_MS);
  }

  // Macro factor
  const macroPull = (MACRO_BASELINE - state.usdStrength) * MACRO_REVERSION;
  const macroShock = gaussianShock(MACRO_VOL * regimeCfg.volMultiplier);
  state.usdStrength = clamp(state.usdStrength + macroPull + regimeCfg.macroDriftBias + macroShock, -MACRO_CLAMP, MACRO_CLAMP);

  // Per-pair trend + mid
  for (const cfg of Object.values(PAIRS)) {
    const eventVolMult = state.activeEvent && eventAffectsPair(state.activeEvent, cfg.symbol) ? state.activeEvent.volMultiplier : 1.0;
    const totalVolMult = regimeCfg.volMultiplier * eventVolMult;
    const ps = state.pairs[cfg.symbol];

    const macroTarget = cfg.anchor + state.usdStrength * cfg.usdBeta * cfg.macroSensitivityPips * cfg.pipSize;
    const trendPull = (macroTarget - ps.trendCenter) * TREND_REVERSION;
    const trendShock = gaussianShock(cfg.tickVolPips * 0.4 * totalVolMult * cfg.pipSize);
    ps.trendCenter += trendPull + trendShock;

    const midPull = (ps.trendCenter - ps.mid) * MID_REVERSION;
    const midShock = gaussianShock(cfg.tickVolPips * totalVolMult * cfg.pipSize);
    ps.mid += midPull + midShock;
  }
}

async function catchUp(): Promise<MarketState> {
  const state = await loadState();
  const now = Date.now();
  const elapsed = now - state.lastTick;
  const steps = Math.min(MAX_CATCHUP_STEPS, Math.floor(elapsed / TICK_MS));
  for (let i = 0; i < steps; i++) {
    ambientStep(state, state.lastTick + (i + 1) * TICK_MS);
  }
  if (steps > 0) state.lastTick += steps * TICK_MS;
  return state;
}

function effectiveSpread(cfg: PairConfig, volMult: number): number {
  return cfg.baseSpreadPips * (1 + 0.35 * Math.max(0, volMult - 1));
}

function currentVolMultiplier(state: MarketState, symbol: string): number {
  const regimeCfg = REGIME_TABLE[state.regime];
  const eventVolMult = state.activeEvent && eventAffectsPair(state.activeEvent, symbol) ? state.activeEvent.volMultiplier : 1.0;
  return regimeCfg.volMultiplier * eventVolMult;
}

// ── Public API ──────────────────────────────────────────────────────

export interface PairQuote {
  symbol: string;
  display: string;
  bid: number;
  ask: number;
  mid: number;
  spreadPips: number;
  decimals: number;
}

function quoteFor(state: MarketState, symbol: string): PairQuote {
  const cfg = PAIRS[symbol];
  const ps = state.pairs[symbol];
  const volMult = currentVolMultiplier(state, symbol);
  const spreadPips = effectiveSpread(cfg, volMult);
  const halfSpread = (spreadPips / 2) * cfg.pipSize;
  return {
    symbol,
    display: cfg.display,
    bid: ps.mid - halfSpread,
    ask: ps.mid + halfSpread,
    mid: ps.mid,
    spreadPips,
    decimals: cfg.decimals,
  };
}

export interface MarketSnapshot {
  regime: Regime;
  regimeLabel: string;
  regimeEmoji: string;
  activeEvent: ActiveEvent | null;
  quotes: PairQuote[];
}

/** Board view — real-time catch-up only, no round-forcing. For `.forex market` / `.forex prices`. */
export async function getMarketSnapshot(): Promise<MarketSnapshot> {
  const state = await catchUp();
  await saveState(state);
  const regimeCfg = REGIME_TABLE[state.regime];
  return {
    regime: state.regime,
    regimeLabel: regimeCfg.label,
    regimeEmoji: regimeCfg.emoji,
    activeEvent: state.activeEvent,
    quotes: Object.keys(PAIRS).map(symbol => quoteFor(state, symbol)),
  };
}

export async function getPairQuote(symbol: string): Promise<PairQuote> {
  const state = await catchUp();
  await saveState(state);
  return quoteFor(state, symbol);
}

export interface RoundPriceResult {
  symbol: string;
  entryBid: number;
  entryAsk: number;
  exitBid: number;
  exitAsk: number;
  pipSize: number;
  decimals: number;
  spreadPips: number;
  regime: Regime;
  regimeLabel: string;
  volatileConditions: boolean;
  activeEvent: ActiveEvent | null;
}

/**
 * Resolves a round: takes an entry quote, then injects ROUND_STEPS worth of
 * compressed "market activity" volatility (see file header) into that one
 * pair only, and returns an exit quote. Regime/event conditions are read
 * once at round start and held fixed for the round — regimes last at least
 * 5 minutes, so a 5-step round can't outlive the conditions it started in.
 */
const ROUND_STEPS = 5;

export async function resolveRoundPrices(symbol: string): Promise<RoundPriceResult> {
  const cfg = PAIRS[symbol];
  if (!cfg) throw new Error(`Unknown pair: ${symbol}`);

  const state = await catchUp();
  const regimeCfg = REGIME_TABLE[state.regime];
  const volMult = currentVolMultiplier(state, symbol);
  const spreadPips = effectiveSpread(cfg, volMult);

  const entryQuote = quoteFor(state, symbol);

  const ps = state.pairs[symbol];
  for (let i = 0; i < ROUND_STEPS; i++) {
    const midPull = (ps.trendCenter - ps.mid) * MID_REVERSION;
    const midShock = gaussianShock(cfg.roundVolPips * volMult * cfg.pipSize);
    ps.mid += midPull + midShock;
  }
  await saveState(state);

  const exitQuote = quoteFor(state, symbol);

  const volatileConditions =
    state.regime === 'volatile' || state.regime === 'flash_crash' || state.regime === 'rally' ||
    (state.activeEvent !== null && eventAffectsPair(state.activeEvent, symbol));

  return {
    symbol,
    entryBid: entryQuote.bid,
    entryAsk: entryQuote.ask,
    exitBid: exitQuote.bid,
    exitAsk: exitQuote.ask,
    pipSize: cfg.pipSize,
    decimals: cfg.decimals,
    spreadPips,
    regime: state.regime,
    regimeLabel: regimeCfg.label,
    volatileConditions,
    activeEvent: state.activeEvent,
  };
}
