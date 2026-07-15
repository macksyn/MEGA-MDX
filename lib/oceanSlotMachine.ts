// @ts-nocheck
/***
 * lib/oceanSlotMachine.ts
 *
 * "Ocean Hunt" slot machine engine + the shared jackpot pool.
 * Pure game logic based on the verified Jungle Hunt engine.
 *
 * Payout is fully tier-driven: resolveSpinOutcome() is the single source of
 * truth for what a spin wins. spinGridForTier() then draws a grid that
 * matches that result. All symbols are marine life; the payline signature
 * escalates by how many 🐋/🦈 appear:
 *
 *   lose       — no whale, no shark
 *   recover30  — 1 shark
 *   recover70  — 1 whale
 *   double     — 1 whale + 1 shark
 *   triple     — 2 sharks
 *   big        — 1 whale + 2 sharks
 *   mega       — 2 whales + 1 shark  (pays a bounded SHARE of the ocean jackpot pool)
 *   superMega  — 3 whales            (pays the ENTIRE ocean jackpot pool)
 *
 * Newbie grace period boosts chances at stakes strictly under 20 coins,
 * scaling down linearly to 0.0 at stakes of 20 or more.
 */

import { createStore } from './pluginStore.js';

const store      = createStore('slotmachine');
const jackpotTbl = store.table('jackpot'); // single key 'ocean_pool' -> number

const JACKPOT_SEED               = 500;   // pool never drops below this
const JACKPOT_CONTRIBUTION_RATE  = 0.05;  // 5% of every gambling bet feeds the pool
const JACKPOT_MEGA_SHARE         = 0.25;  // mega tier (2 whale + 1 shark) wins 25% of the current pool
const JACKPOT_MEGA_FLOOR         = 100;   // ...but never less than this many coins

export async function getJackpotPool(): Promise<number> {
  const val = await jackpotTbl.get('ocean_pool');
  return typeof val === 'number' ? val : JACKPOT_SEED;
}

/** Called on every gambling bet — grows the shared ocean pool. */
export async function contributeToJackpot(bet: number): Promise<number> {
  const contribution = Math.max(1, Math.round(bet * JACKPOT_CONTRIBUTION_RATE));
  const pool = await getJackpotPool();
  const newPool = pool + contribution;
  await jackpotTbl.set('ocean_pool', newPool);
  return newPool;
}

/** Mega tier win (2 whale + 1 shark): takes a bounded slice of the pool. */
export async function awardJackpotShare(): Promise<number> {
  const pool = await getJackpotPool();
  const amount = Math.max(JACKPOT_MEGA_FLOOR, Math.round(pool * JACKPOT_MEGA_SHARE));
  const newPool = Math.max(JACKPOT_SEED, pool - amount);
  await jackpotTbl.set('ocean_pool', newPool);
  return Math.min(amount, pool); // never pay out more than the pool actually had
}

/** Super mega tier win (3 whale): takes the ENTIRE pool, resetting it to seed. */
export async function awardFullJackpot(): Promise<number> {
  const pool = await getJackpotPool();
  await jackpotTbl.set('ocean_pool', JACKPOT_SEED);
  return pool;
}

// ── Weighted payout engine for Ocean Hunt ───────────────────────────────────

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

/**
 * Calculates win probabilities based on stake size and historical games.
 * @param stake The amount wagered.
 * @param spinsPlayed Used to determine if the user is a "newbie". Defaults to 100 (normal odds).
 */
export function getStakeProfile(stake: number, spinsPlayed: number = 100): StakeProfile {
  const normalized = Math.min(1, Math.max(0.2, stake / 1000));
  
  // Base probabilities
  let bigWinChance = Math.max(0.012, 0.03 - 0.018 * normalized);
  let megaWinChance = Math.max(0.003, 0.008 - 0.005 * normalized);
  let superMegaWinChance = Math.max(0.0006, 0.002 - 0.0014 * normalized);
  let loseChance = Math.max(0.42, 0.44 + 0.12 * normalized);
  let recover30Chance = Math.max(0.12, 0.17 - 0.05 * normalized);
  let recover70Chance = Math.max(0.08, 0.14 - 0.06 * normalized);
  let doubleChance = Math.max(0.08, 0.12 - 0.04 * normalized);
  let tripleChance = Math.max(0.03, 0.07 - 0.04 * normalized);

  // --- BEGINNER GRACE PERIOD (Soft Landing & High-Tier Hooking) ---
  // Tapers off smoothly over the first 25 spins.
  // 0 spins = 1.0 (max boost), 25+ spins = 0.0 (normal house odds).
  const gracePhase = Math.max(0, 1 - (spinsPlayed / 25));

  if (gracePhase > 0) {
    // 1. HIGH TIER ACCESSIBILITY (Big / Mega / Super Mega)
    // Boosted only when stake is strictly under 20. At 20+, boost is exactly 0.
    const lowStakeFactor = Math.max(0, 1 - (stake / 20));
    const newbieHighTierBoost = gracePhase * lowStakeFactor;

    if (newbieHighTierBoost > 0) {
      const baseBig = bigWinChance;
      const baseMega = megaWinChance;
      const baseSuper = superMegaWinChance;

      // Multiply the chances safely based on the newbie/stake matrix
      bigWinChance       *= (1 + 1.8 * newbieHighTierBoost); // Up to +180%
      megaWinChance      *= (1 + 2.5 * newbieHighTierBoost); // Up to +250%
      superMegaWinChance *= (1 + 3.0 * newbieHighTierBoost); // Up to +300%

      // Subtract the added probability from lose chance to maintain structural math integrity
      const totalAddedHighTier = (bigWinChance - baseBig) + (megaWinChance - baseMega) + (superMegaWinChance - baseSuper);
      loseChance = Math.max(0.20, loseChance - totalAddedHighTier);
    }

    // 2. SOFT LANDING COMPENSATION (Recoveries & Minor wins)
    // Reduce remaining loss chance by up to 30% for high player retention.
    const loseReduction = loseChance * 0.3 * gracePhase;
    loseChance -= loseReduction;

    // Distribute this remainder into standard recoveries and doubles
    recover70Chance += loseReduction * 0.4; // 40% to standard recovery
    doubleChance    += loseReduction * 0.3; // 30% to double
    tripleChance    += loseReduction * 0.3; // 30% to triple
  }

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

export function resolveSpinOutcome(stake: number, economyPressure = 1, spinsPlayed = 100): SpinOutcome {
  const profile = getStakeProfile(stake, spinsPlayed);
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

export function resolveCoinflipOutcome(stake: number, economyPressure = 1, spinsPlayed = 100) {
  const pressureFactor = Math.max(0.85, Math.min(1.15, economyPressure));
  const baseChance = Math.max(0.34, 0.48 - (stake > 100 ? 0.02 : 0));
  
  // Newbie grace period: up to +20% flat win probability for low bets under 20 coins
  const gracePhase = Math.max(0, 1 - (spinsPlayed / 25));
  const lowStakeFactor = Math.max(0, 1 - (stake / 20));
  const beginnerBoost = 0.20 * gracePhase * lowStakeFactor; 

  const winChance = Math.min(0.85, Math.max(0.28, baseChance / pressureFactor) + beginnerBoost);
  
  return Math.random() <= winChance
    ? { multiplier: 2, label: 'You won', win: true }
    : { multiplier: 0, label: 'You lost', win: false };
}

export function resolveDiceOutcome(stake: number, economyPressure = 1, spinsPlayed = 100) {
  const pressureFactor = Math.max(0.85, Math.min(1.15, economyPressure));
  const baseWinChance = Math.max(0.28, 0.42 - (stake > 100 ? 0.015 : 0));
  
  // Newbie grace period: up to +18% flat win probability for low bets under 20 coins
  const gracePhase = Math.max(0, 1 - (spinsPlayed / 25));
  const lowStakeFactor = Math.max(0, 1 - (stake / 20));
  const beginnerBoost = 0.18 * gracePhase * lowStakeFactor;

  const winChance = Math.min(0.75, Math.max(0.2, baseWinChance / pressureFactor) + beginnerBoost);
  const tieChance = Math.max(0.08, Math.min(0.2, 0.16 / pressureFactor));

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

export const WHALE = '🐋';
export const SHARK = '🦈';

const SYMBOL_WEIGHTS: Array<{ symbol: string; weight: number }> = [
  { symbol: '🐠',  weight: 0.30 }, // Clownfish
  { symbol: '🐙',  weight: 0.22 }, // Octopus
  { symbol: '🦀',  weight: 0.16 }, // Crab
  { symbol: '🐢',  weight: 0.14 }, // Sea Turtle
  { symbol: WHALE,  weight: 0.10 }, // Blue Whale (Special)
  { symbol: SHARK, weight: 0.08 }, // Great White Shark (Special)
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

/** A filler ocean animal that is never Whale or Shark — used to pad non-payout lines. */
function rollFillerSymbol(): string {
  let symbol = rollSymbol();
  while (symbol === WHALE || symbol === SHARK) symbol = rollSymbol();
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

const TIER_PAYLINE: Record<SpinOutcome['tier'], string[]> = {
  lose:      [],
  recover30: [SHARK],
  recover70: [WHALE],
  double:    [WHALE, SHARK],
  triple:    [SHARK, SHARK],
  big:       [WHALE, SHARK, SHARK],
  mega:      [WHALE, WHALE, SHARK],
  superMega: [WHALE, WHALE, WHALE],
};

/**
 * Tier-aware grid matching: populates the main payline according to the resolved outcome.
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

const PAYTABLE: Record<string, { 3?: number; 4?: number }> = {
  '🐠':  { 3: 2.5, 4: 5 },
  '🐙':  { 3: 4,   4: 8 },
  '🦀':  { 3: 6,   4: 12 },
  '🐢':  { 3: 5,   4: 10 },
  [SHARK]: { 3: 8,  4: 16 },
  [WHALE]: { 3: 10, 4: 20 },
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