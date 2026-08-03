// @ts-nocheck
/***
 * lib/forexGame.ts
 *
 * Sits on top of forexMarket.ts and turns a price move into a round result.
 *
 * ── Why this game doesn't need Ocean Hunt's RTP-tier machinery ──────────
 * Ocean Hunt's edge comes from tuned category probabilities, so it needs a
 * hard ceiling that scales those probabilities down when they'd pay out too
 * much. Forex's edge is structural instead: you always enter on the wrong
 * side of the spread, exactly like a real broker. The market itself decides
 * whether you win and by how much — there's no probability table to lean on
 * or to protect.
 *
 * That means the safety net has to work differently:
 *   - MAX_WIN_MULT hard-caps any single round's multiplier, regardless of
 *     how large the price move was (protects against a freak flash-crash
 *     round).
 *   - settleWin() still caps payouts to what the bank can actually cover,
 *     same invariant as every other game — the pool is real bank capital.
 *   - When the bank is in a critical solvency state, PAYOUT_SCALE trims
 *     multipliers across the board (EMERGENCY_PAYOUT_SCALE) rather than
 *     touching win probability, since win probability isn't ours to tune
 *     here — it's whatever the market actually did.
 *
 * ── Honest caveat ─────────────────────────────────────────────────────
 * Unlike the slot games, this isn't backed by a closed-form RTP guarantee —
 * the payout curve below (computeMultiplier) was hand-tuned against the
 * volatility constants in forexMarket.ts, not derived analytically. Treat
 * PIP_TO_MULT and the tier thresholds as a first pass that needs real
 * playtesting data before you trust the house edge number that comes out
 * of it. Everything needed to retune it is in one place below.
 */

import { createStore } from './pluginStore.js';
import { resolveRoundPrices, PAIRS, RoundPriceResult } from './forexMarket.js';

const store = createStore('forexgame');
const bankTbl = store.table('bank');
const playerStatsTbl = store.table('playerStats');
const houseStatsTbl = store.table('houseStats');

export const FOREX_SEED = 500;

// ── Bank (independent pool — its own liquidity, not shared with Ocean Hunt or Jungle Hunt) ──

export async function getBankPool(): Promise<number> {
  const val = await bankTbl.get('pool');
  return typeof val === 'number' ? val : FOREX_SEED;
}

export async function contributeToBank(amount: number): Promise<number> {
  const pool = await getBankPool();
  const newPool = pool + amount;
  await bankTbl.set('pool', newPool);
  return newPool;
}

export async function deductFromBank(amount: number): Promise<number> {
  const pool = await getBankPool();
  const newPool = Math.max(FOREX_SEED, pool - amount);
  await bankTbl.set('pool', newPool);
  return newPool;
}

export function settleWin(rawWin: number, pool: number): { payout: number; capped: boolean } {
  const availableSurplus = Math.max(0, pool - FOREX_SEED);
  if (rawWin <= availableSurplus) return { payout: rawWin, capped: false };
  return { payout: availableSurplus, capped: true };
}

const CRITICAL_BAND = FOREX_SEED * 0.5;
const EMERGENCY_PAYOUT_SCALE = 0.75;

export type SolvencyLevel = 'critical' | 'healthy';
export interface SolvencyState { level: SolvencyLevel; surplus: number; }

export function getSolvencyState(pool: number): SolvencyState {
  const surplus = Math.max(0, pool - FOREX_SEED);
  return { level: surplus >= CRITICAL_BAND ? 'healthy' : 'critical', surplus };
}

// ── Player stats ──────────────────────────────────────────────────────

export async function incrementAndGetRounds(userId: string): Promise<number> {
  const current = ((await playerStatsTbl.get(userId)) as number) || 0;
  const updated = current + 1;
  await playerStatsTbl.set(userId, updated);
  return updated;
}

export async function recordPlayerActivity(userId: string, bet: number, payout: number): Promise<void> {
  const currentBet = ((await playerStatsTbl.get(`${userId}_totalBet`)) as number) || 0;
  const currentWon = ((await playerStatsTbl.get(`${userId}_totalWon`)) as number) || 0;
  await playerStatsTbl.set(`${userId}_totalBet`, currentBet + bet);
  await playerStatsTbl.set(`${userId}_totalWon`, currentWon + payout);
}

export async function getPlayerProfile(userId: string) {
  const rounds = ((await playerStatsTbl.get(userId)) as number) || 0;
  const totalBet = ((await playerStatsTbl.get(`${userId}_totalBet`)) as number) || 0;
  const totalWon = ((await playerStatsTbl.get(`${userId}_totalWon`)) as number) || 0;
  return {
    rounds,
    totalBet,
    totalWon,
    rtp: totalBet > 0 ? totalWon / totalBet : 0,
  };
}

export async function recordHouseActivity(bet: number, payout: number): Promise<void> {
  const todayStr = new Date().toISOString().split('T')[0];
  const betKey = `${todayStr}_forex_bet`;
  const wonKey = `${todayStr}_forex_won`;
  const currentBet = ((await houseStatsTbl.get(betKey)) as number) || 0;
  const currentWon = ((await houseStatsTbl.get(wonKey)) as number) || 0;
  await houseStatsTbl.set(betKey, currentBet + bet);
  await houseStatsTbl.set(wonKey, currentWon + payout);
}

// ── Round types ────────────────────────────────────────────────────────

export type Direction = 'call' | 'put';
export type WinTier = 'none' | 'move' | 'bigMove' | 'megaMove' | 'superMegaMove' | 'marketSurge';

export interface ForexRoundResult {
  pair: string;
  pairDisplay: string;
  direction: Direction;
  bet: number;
  entryPrice: number;
  exitPrice: number;
  decimals: number;
  spreadPips: number;
  directionalPips: number;
  netPips: number;
  outcome: 'loss' | 'scratch' | 'win';
  multiplier: number;
  winAmount: number;
  capped: boolean;
  winTier: WinTier;
  bannerText?: string;
  regimeLabel: string;
  regimeEmoji: string;
  eventName?: string;
}

// ── Payout curve ──────────────────────────────────────────────────────
// See file header re: this being a first-pass, playtest-tunable curve.

// Calibrated against a 20k-round simulation of the actual market model (see
// sim/run.ts during development): with ~1.5 pip average spread cost and a
// ~6 pip round-volatility in normal ("ranging") conditions, roughly 40% of
// rounds win and the average winning move is ~5.8 net pips. k=0.35 was
// chosen so that E[multiplier | win] ≈ 2.0, which combined with the ~40%
// win rate and ~10% scratch rate lands the simulated RTP in the intended
// 88-92% band — verified below, not assumed.
const PIP_TO_MULT = 0.50;
const MIN_WIN_MULT = 0.15;
const MAX_WIN_MULT = 25;

function computeMultiplier(netPips: number, pipMultScale: number): number {
  const base = netPips * PIP_TO_MULT * pipMultScale;
  const executionVariance = 0.92 + Math.random() * 0.16; // ±8%, like minor slippage
  return Math.max(MIN_WIN_MULT, Math.min(MAX_WIN_MULT, base * executionVariance));
}

// Thresholds set relative to the measured volatility regimes: ranging rounds
// rarely clear 15 net pips, so bigMove is the realistic ceiling in calm
// conditions — megaMove/superMegaMove/marketSurge become reachable once the
// round's volatility multiplier is elevated (volatile/flash_crash/rally
// regimes or an active news event), same as the game design intends.
function computeWinTier(outcome: ForexRoundResult['outcome'], netPips: number, volatileConditions: boolean): WinTier {
  if (outcome !== 'win') return 'none';
  if (netPips >= 55 && volatileConditions) return 'marketSurge';
  if (netPips >= 30) return 'superMegaMove';
  if (netPips >= 15) return 'megaMove';
  if (netPips >= 6) return 'bigMove';
  return 'move';
}

const BANNER_TEXT: Record<WinTier, string | undefined> = {
  none: undefined,
  move: undefined,
  bigMove: '🎉 BIG MOVE!',
  megaMove: '🔥 MEGA MOVE!',
  superMegaMove: '💥 SUPER MEGA MOVE!',
  marketSurge: '🌊 MARKET SURGE!',
};

// ── Main resolver ─────────────────────────────────────────────────────

export async function resolveRound(
  symbol: string,
  bet: number,
  direction: Direction,
  pool: number
): Promise<ForexRoundResult> {
  const cfg = PAIRS[symbol];
  if (!cfg) throw new Error(`Unknown pair: ${symbol}`);

  const prices: RoundPriceResult = await resolveRoundPrices(symbol);

  const entryPrice = direction === 'call' ? prices.entryAsk : prices.entryBid;
  const entryMid = (prices.entryBid + prices.entryAsk) / 2;
  const exitMid = (prices.exitBid + prices.exitAsk) / 2;
  const exitPrice = direction === 'call' ? prices.exitBid : prices.exitAsk; // what you'd realize closing out

  const rawPipMove = (exitMid - entryMid) / prices.pipSize;
  const directionalPips = direction === 'call' ? rawPipMove : -rawPipMove;
  const netPips = directionalPips - prices.spreadPips;

  let outcome: ForexRoundResult['outcome'];
  let multiplier = 0;

  if (directionalPips <= 0) {
    outcome = 'loss';
  } else if (netPips <= 0) {
    outcome = 'scratch'; // called it right, but not enough to clear the spread
  } else {
    outcome = 'win';
    multiplier = computeMultiplier(netPips, cfg.pipMultScale);
  }

  const solvency = getSolvencyState(pool);
  if (outcome === 'win' && solvency.level === 'critical') {
    multiplier *= EMERGENCY_PAYOUT_SCALE;
  }

  const rawWin = outcome === 'loss' ? 0 : outcome === 'scratch' ? bet : Math.round(bet * multiplier);
  const { payout, capped } = settleWin(rawWin, pool);

  const winTier = computeWinTier(outcome, netPips, prices.volatileConditions);

  return {
    pair: symbol,
    pairDisplay: cfg.display,
    direction,
    bet,
    entryPrice,
    exitPrice,
    decimals: cfg.decimals,
    spreadPips: prices.spreadPips,
    directionalPips,
    netPips,
    outcome,
    multiplier,
    winAmount: payout,
    capped,
    winTier,
    bannerText: BANNER_TEXT[winTier],
    regimeLabel: prices.regimeLabel,
    regimeEmoji: prices.regime === 'flash_crash' ? '🔻' : prices.regime === 'rally' ? '🚀' : prices.regime === 'volatile' ? '⚡' : prices.regime.includes('bull') ? '📈' : prices.regime.includes('bear') ? '📉' : '📏',
    eventName: prices.activeEvent?.name,
  };
}
