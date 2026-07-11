// @ts-nocheck
/***
 * lib/slotMachine.ts
 *
 * "Jungle Hunt" slot machine engine + the shared jackpot pool that
 * coinflip/dice/slots all feed. Pure game logic — no WhatsApp/sock code
 * here, so plugins just call these and handle the messaging themselves.
 *
 * Payout is fully tier-driven: resolveSpinOutcome() is the single source of
 * truth for what a spin wins. spinGridForTier() then draws a grid that
 * matches that result — it never decides the outcome itself. All symbols
 * are animals; the payline signature escalates by how many 🦁/🐯 appear:
 *
 *   lose       — no lion, no tiger
 *   recover30  — 1 tiger
 *   recover70  — 1 lion
 *   double     — 1 lion + 1 tiger
 *   triple     — 2 tiger
 *   big        — 1 lion + 2 tiger
 *   mega       — 2 lion + 1 tiger   (pays a bounded SHARE of the jackpot pool)
 *   superMega  — 3 lion             (pays the ENTIRE jackpot pool)
 *
 * The jackpot pool is only ever funded by a small cut of bets, and the
 * mega-tier payout takes a bounded share (not a fixed jump), so the house
 * is never on the hook for more than what's actually in the pool.
 *
 * Re-run the Monte Carlo sim (tune2.mjs) whenever SYMBOL_WEIGHTS, the
 * StakeProfile chances, or the JACKPOT_* constants change — mega/superMega
 * payouts now float with pool size instead of a fixed multiplier, so RTP
 * needs to be re-measured, not assumed from prior sim runs.
 */

import { createStore } from './pluginStore.js';

const store      = createStore('slotmachine');
const jackpotTbl = store.table('jackpot'); // single key 'pool' -> number

const JACKPOT_SEED               = 500;   // pool never drops below this
const JACKPOT_CONTRIBUTION_RATE  = 0.05;  // 5% of every gambling bet feeds the pool
const JACKPOT_MEGA_SHARE         = 0.25;  // mega tier (2 lion + 1 tiger) wins 25% of the current pool
const JACKPOT_MEGA_FLOOR         = 100;   // ...but never less than this many coins

export async function getJackpotPool(): Promise<number> {
  const val = await jackpotTbl.get('pool');
  return typeof val === 'number' ? val : JACKPOT_SEED;
}

/** Called on every gambling bet (slots, coinflip, dice) — grows the shared pool. */
export async function contributeToJackpot(bet: number): Promise<number> {
  const contribution = Math.max(1, Math.round(bet * JACKPOT_CONTRIBUTION_RATE));
  const pool = await getJackpotPool();
  const newPool = pool + contribution;
  await jackpotTbl.set('pool', newPool);
  return newPool;
}

/** Mega tier win (2 lion + 1 tiger): takes a bounded slice of the pool, pool keeps the rest. */
export async function awardJackpotShare(): Promise<number> {
  const pool = await getJackpotPool();
  const amount = Math.max(JACKPOT_MEGA_FLOOR, Math.round(pool * JACKPOT_MEGA_SHARE));
  const newPool = Math.max(JACKPOT_SEED, pool - amount);
  await jackpotTbl.set('pool', newPool);
  return Math.min(amount, pool); // never pay out more than the pool actually had
}

/** Super mega tier win (3 lion): takes the ENTIRE pool, which resets back to the seed. */
export async function awardFullJackpot(): Promise<number> {
  const pool = await getJackpotPool();
  await jackpotTbl.set('pool', JACKPOT_SEED);
  return pool;
}

// ── Weighted payout engine for Jungle Hunt ───────────────────────────────────

export interface StakeProfile {
  stake: number;
  bigWinChance: number;
  megaWinChance: number;
  superMegaWinChance: number;
  loseChance: number;
  recover30Chance: number;
  recover70Chance: number;
  doubleChance: number;
  tripleChance: number;
}

export interface SpinOutcome {
  tier: 'lose' | 'recover30' | 'recover70' | 'double' | 'triple' | 'big' | 'mega' | 'superMega';
  multiplier: number;
  label: string;
}

export function getStakeProfile(stake: number): StakeProfile {
  const normalized = Math.min(1, Math.max(0.2, stake / 1000));
  const bigWinChance = Math.max(0.012, 0.03 - 0.018 * normalized);
  const megaWinChance = Math.max(0.003, 0.008 - 0.005 * normalized);
  const superMegaWinChance = Math.max(0.0006, 0.002 - 0.0014 * normalized);
  const loseChance = Math.max(0.42, 0.44 + 0.12 * normalized);
  const recover30Chance = Math.max(0.12, 0.17 - 0.05 * normalized);
  const recover70Chance = Math.max(0.08, 0.14 - 0.06 * normalized);
  const doubleChance = Math.max(0.08, 0.12 - 0.04 * normalized);
  const tripleChance = Math.max(0.03, 0.07 - 0.04 * normalized);

  return {
    stake,
    bigWinChance,
    megaWinChance,
    superMegaWinChance,
    loseChance,
    recover30Chance,
    recover70Chance,
    doubleChance,
    tripleChance,
  };
}

export function resolveSpinOutcome(stake: number, economyPressure = 1): SpinOutcome {
  const profile = getStakeProfile(stake);
  const pressureFactor = Math.max(0.8, Math.min(1.2, economyPressure));

  const weights = [
    { tier: 'lose' as const, weight: profile.loseChance * (1 + 0.08 * (pressureFactor - 1)) },
    { tier: 'recover30' as const, weight: profile.recover30Chance / pressureFactor },
    { tier: 'recover70' as const, weight: profile.recover70Chance / pressureFactor },
    { tier: 'double' as const, weight: profile.doubleChance / pressureFactor },
    { tier: 'triple' as const, weight: profile.tripleChance / pressureFactor },
    { tier: 'big' as const, weight: profile.bigWinChance / pressureFactor },
    { tier: 'mega' as const, weight: profile.megaWinChance / pressureFactor },
    { tier: 'superMega' as const, weight: profile.superMegaWinChance / pressureFactor },
  ];

  const total = weights.reduce((sum, entry) => sum + entry.weight, 0);
  const normalized = weights.map(entry => ({ ...entry, weight: entry.weight / total }));

  const roll = Math.random();
  let cumulative = 0;
  for (const entry of normalized) {
    cumulative += entry.weight;
    if (roll <= cumulative) {
      const tierMap: Record<SpinOutcome['tier'], number> = {
        lose: 0,
        recover30: 0.3,
        recover70: 0.7,
        double: 2,
        triple: 3,
        big: 5,
        mega: 8,
        superMega: 15,
      };

      return {
        tier: entry.tier,
        multiplier: tierMap[entry.tier],
        label: entry.tier === 'lose'
          ? 'No win'
          : entry.tier === 'recover30'
            ? 'Recovery'
            : entry.tier === 'recover70'
              ? 'Recovery'
              : entry.tier === 'double'
                ? 'Double'
                : entry.tier === 'triple'
                  ? 'Triple'
                  : entry.tier === 'big'
                    ? 'Big win'
                    : entry.tier === 'mega'
                      ? 'Mega win'
                      : 'Super mega win',
      };
    }
  }

  return { tier: 'lose', multiplier: 0, label: 'No win' };
}

export function resolveCoinflipOutcome(stake: number, economyPressure = 1) {
  const pressureFactor = Math.max(0.85, Math.min(1.15, economyPressure));
  const baseChance = Math.max(0.34, 0.48 - (stake > 100 ? 0.02 : 0));
  const winChance = Math.min(0.7, Math.max(0.28, baseChance / pressureFactor));
  const loseChance = 1 - winChance;

  return Math.random() <= winChance
    ? { multiplier: 2, label: 'You won', win: true }
    : { multiplier: 0, label: 'You lost', win: false };
}

export function resolveDiceOutcome(stake: number, economyPressure = 1) {
  const pressureFactor = Math.max(0.85, Math.min(1.15, economyPressure));
  const baseWinChance = Math.max(0.28, 0.42 - (stake > 100 ? 0.015 : 0));
  const winChance = Math.min(0.64, Math.max(0.2, baseWinChance / pressureFactor));
  const tieChance = Math.max(0.08, Math.min(0.2, 0.16 / pressureFactor));
  const loseChance = 1 - winChance - tieChance;

  const roll = Math.random();
  if (roll <= tieChance) {
    return { multiplier: 1, label: 'Tie', win: false, tie: true };
  }
  if (roll <= tieChance + winChance) {
    return { multiplier: 1.9, label: 'You win', win: true };
  }
  return { multiplier: 0, label: 'You lost', win: false };
}

// ── Symbols & weighted RNG ────────────────────────────────────────────────────

export const LION  = '🦁';
export const TIGER = '🐯';

const SYMBOL_WEIGHTS: Array<{ symbol: string; weight: number }> = [
  { symbol: '🐍',  weight: 0.30 },
  { symbol: '🦏',  weight: 0.22 },
  { symbol: '🐘',  weight: 0.16 },
  { symbol: '🐒',  weight: 0.14 },
  { symbol: LION,  weight: 0.10 },
  { symbol: TIGER, weight: 0.08 },
];

function rollSymbol(): string {
  const r = Math.random();
  let cumulative = 0;
  for (const { symbol, weight } of SYMBOL_WEIGHTS) {
    cumulative += weight;
    if (r <= cumulative) return symbol;
  }
  return SYMBOL_WEIGHTS[0].symbol;
}

/** A filler animal that's never lion or tiger — used to pad tier paylines and non-payline rows. */
function rollFillerSymbol(): string {
  let symbol = rollSymbol();
  while (symbol === LION || symbol === TIGER) symbol = rollSymbol();
  return symbol;
}

const ROWS = 3;
const COLS = 4;
export const PAYLINE_INDEX = 1; // middle row, 0-indexed

export function spinGrid(): string[][] {
  const grid: string[][] = [];
  for (let r = 0; r < ROWS; r++) {
    const row: string[] = [];
    for (let c = 0; c < COLS; c++) row.push(rollSymbol());
    grid.push(row);
  }
  return grid;
}

/**
 * Fixed lion/tiger prefix for each tier's payline, left to right. Columns
 * beyond the prefix are filled with a random non-special animal. Because
 * fillers can never roll lion or tiger, every tier's signature is exact —
 * no tier can ever accidentally display another tier's pattern.
 */
const TIER_PAYLINE: Record<SpinOutcome['tier'], string[]> = {
  lose:      [],
  recover30: [TIGER],
  recover70: [LION],
  double:    [LION, TIGER],
  triple:    [TIGER, TIGER],
  big:       [LION, TIGER, TIGER],
  mega:      [LION, LION, TIGER],
  superMega: [LION, LION, LION],
};

/**
 * Tier-aware grid: resolveSpinOutcome() is the single source of truth for
 * whether the player wins, so the grid is generated to match it rather than
 * decide it independently. The other two rows are pure decoration.
 */
export function spinGridForTier(tier: SpinOutcome['tier']): string[][] {
  const grid = spinGrid();
  const payline = grid[PAYLINE_INDEX];
  const fixed = TIER_PAYLINE[tier];

  for (let c = 0; c < COLS; c++) {
    payline[c] = c < fixed.length ? fixed[c] : rollFillerSymbol();
  }

  return grid;
}

/** Scores a row: how many symbols match consecutively from the left. */
export function scorePayline(row: string[]): { symbol: string; count: number } {
  const target = row[0];
  let count = 0;
  for (const s of row) {
    if (s === target) count++;
    else break;
  }
  return { symbol: target, count };
}

// Multiplier paytable for same-symbol paylines (currently unused by payout —
// payout is fully tier-driven — kept for a possible future non-tier win path).
const PAYTABLE: Record<string, { 3?: number; 4?: number }> = {
  '🐍':  { 3: 2.5, 4: 5 },
  '🦏':  { 3: 4,   4: 8 },
  '🐘':  { 3: 6,   4: 12 },
  '🐒':  { 3: 5,   4: 10 },
  [TIGER]: { 3: 8,  4: 16 },
  [LION]:  { 3: 10, 4: 20 },
};

export function getMultiplier(symbol: string, count: number): number {
  if (count < 3) return 0;
  const entry = PAYTABLE[symbol] as any;
  return entry?.[count] || 0;
}

/** Renders the grid as a text block, with the payline row visually marked. */
export function renderGrid(grid: string[][]): string {
  return grid
    .map((row, i) => {
      const line = row.join('│');
      return i === PAYLINE_INDEX ? `${line} ` : ` ${line} `;
    })
    .join('\n');
}
