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

const store          = createStore('slotmachine');
const jackpotTbl     = store.table('jackpot'); // single key 'ocean_pool' -> number
const playerStatsTbl = store.table('playerStats'); // tracks individual player spins
const houseStatsTbl  = store.table('houseStats'); // tracks daily bets/wins for profit calculation

const JACKPOT_SEED               = 500;   // pool never drops below this
const JACKPOT_CONTRIBUTION_RATE  = 0.05;  // 5% of every gambling bet feeds the pool

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

/** Deducts a high-tier payout from the ocean jackpot pool, respecting the floor seed. */
export async function deductFromJackpot(amount: number): Promise<number> {
  const pool = await getJackpotPool();
  const newPool = Math.max(JACKPOT_SEED, pool - amount);
  await jackpotTbl.set('ocean_pool', newPool);
  return newPool;
}

/** Track how many spins a user has made to calculate their grace period */
export async function incrementAndGetSpins(userId: string): Promise<number> {
  const current = (await playerStatsTbl.get(userId)) || 0;
  const updated = (current as number) + 1;
  await playerStatsTbl.set(userId, updated);
  return updated;
}

/** Track consecutive losses for the pity timer */
export async function getConsecutiveLosses(userId: string): Promise<number> {
  return ((await playerStatsTbl.get(`${userId}_streak`)) as number) || 0;
}

export async function incrementConsecutiveLosses(userId: string): Promise<number> {
  const current = await getConsecutiveLosses(userId);
  const updated = current + 1;
  await playerStatsTbl.set(`${userId}_streak`, updated);
  return updated;
}

export async function resetConsecutiveLosses(userId: string): Promise<void> {
  await playerStatsTbl.set(`${userId}_streak`, 0);
}

/** Track consecutive wins to potentially detect hot streaks or limit payouts */
export async function getConsecutiveWins(userId: string): Promise<number> {
  return ((await playerStatsTbl.get(`${userId}_winStreak`)) as number) || 0;
}

export async function incrementConsecutiveWins(userId: string): Promise<number> {
  const current = await getConsecutiveWins(userId);
  const updated = current + 1;
  await playerStatsTbl.set(`${userId}_winStreak`, updated);
  return updated;
}

export async function resetConsecutiveWins(userId: string): Promise<void> {
  await playerStatsTbl.set(`${userId}_winStreak`, 0);
}

/** Record lifetime betting and payout totals for a specific player */
export async function recordPlayerActivity(userId: string, bet: number, payout: number): Promise<void> {
  const currentBet = ((await playerStatsTbl.get(`${userId}_totalBet`)) as number) || 0;
  const currentWon = ((await playerStatsTbl.get(`${userId}_totalWon`)) as number) || 0;

  await playerStatsTbl.set(`${userId}_totalBet`, currentBet + bet);
  await playerStatsTbl.set(`${userId}_totalWon`, currentWon + payout);
}

/** Record the exact timestamp of a player's last major jackpot/super-mega win */
export async function recordPlayerJackpot(userId: string): Promise<void> {
  await playerStatsTbl.set(`${userId}_lastJackpot`, new Date().toISOString());
}

/** 
 * Compiles a full player profile including calculated metrics like RTP 
 * (Return To Player) and Average Stake.
 */
export async function getPlayerProfile(userId: string) {
  const spins = ((await playerStatsTbl.get(userId)) as number) || 0;
  const totalBet = ((await playerStatsTbl.get(`${userId}_totalBet`)) as number) || 0;
  const totalWon = ((await playerStatsTbl.get(`${userId}_totalWon`)) as number) || 0;
  const lastJackpot = ((await playerStatsTbl.get(`${userId}_lastJackpot`)) as string) || null;
  const winStreak = await getConsecutiveWins(userId);
  const lossStreak = await getConsecutiveLosses(userId);

  const rtp = totalBet > 0 ? (totalWon / totalBet) : 0;
  const averageStake = spins > 0 ? (totalBet / spins) : 0;

  return {
    spins,
    totalBet,
    totalWon,
    rtp,
    averageStake,
    lastJackpot,
    winStreak,
    lossStreak
  };
}

/** Retrieves today's net profit (bets - payouts) */
export async function getTodayProfit(): Promise<number> {
  const todayStr = new Date().toISOString().split('T')[0];
  const betKey = `${todayStr}_ocean_bet`;
  const wonKey = `${todayStr}_ocean_won`;

  const todayBet = ((await houseStatsTbl.get(betKey)) as number) || 0;
  const todayWon = ((await houseStatsTbl.get(wonKey)) as number) || 0;

  return todayBet - todayWon;
}

/** Records house activity for a specific spin or game */
export async function recordHouseActivity(bet: number, payout: number): Promise<void> {
  const todayStr = new Date().toISOString().split('T')[0];
  const betKey = `${todayStr}_ocean_bet`;
  const wonKey = `${todayStr}_ocean_won`;

  const currentBet = ((await houseStatsTbl.get(betKey)) as number) || 0;
  const currentWon = ((await houseStatsTbl.get(wonKey)) as number) || 0;

  await houseStatsTbl.set(betKey, currentBet + bet);
  await houseStatsTbl.set(wonKey, currentWon + payout);
}

/**
 * Calculates a dynamic economy pressure multiplier based on house profits and jackpot reserves.
 * Plugin wrappers should call this and pass the result to the game resolvers.
 * < 1.0 = Loose/Generous (House is rich, give back to players)
 * > 1.0 = Tight/Strict (House is losing money, protect the bank)
 */
export async function getEconomyPressure(): Promise<number> {
  let pressure = 1.0;

  // 1. House Profit Factor
  const todayProfit = await getTodayProfit();

  // If house is in profit, loosen the economy. If in loss, tighten it.
  if (todayProfit > 0) {
    pressure -= Math.min(0.15, (todayProfit / 1000) * 0.02);
  } else {
    pressure += Math.min(0.20, (Math.abs(todayProfit) / 1000) * 0.05);
  }

  // 2. Jackpot Pool Factor
  const pool = await getJackpotPool();
  const poolBaseline = 1500;

  if (pool > poolBaseline) {
    pressure -= Math.min(0.1, ((pool - poolBaseline) / 1000) * 0.02);
  } else {
    pressure += Math.min(0.1, ((poolBaseline - pool) / 1000) * 0.04);
  }

  return Math.max(0.75, Math.min(1.25, pressure));
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
 */
export function getStakeProfile(stake: number, spinsPlayed: number = 100, consecutiveLosses: number = 0): StakeProfile {
  const minBet = 5;
  const maxBet = 100;

  const clampedStake = Math.max(minBet, Math.min(maxBet, stake));
  // Maps 5 -> 0.2 (low-stake retention heaven) and 100 -> 1.0 (strict house-defending risk)
  const normalized = 0.2 + 0.8 * ((clampedStake - minBet) / (maxBet - minBet));

  // Base probabilities scale dynamically against the normalized value
  let bigWinChance = Math.max(0.012, 0.03 - 0.018 * normalized);
  let megaWinChance = Math.max(0.003, 0.008 - 0.005 * normalized);
  let superMegaWinChance = Math.max(0.0006, 0.002 - 0.0014 * normalized);
  let loseChance = Math.max(0.42, 0.44 + 0.12 * normalized);
  let recover30Chance = Math.max(0.12, 0.17 - 0.05 * normalized);
  let recover70Chance = Math.max(0.08, 0.14 - 0.06 * normalized);
  let doubleChance = Math.max(0.08, 0.12 - 0.04 * normalized);
  let tripleChance = Math.max(0.03, 0.07 - 0.04 * normalized);

  // --- BEGINNER GRACE PERIOD (Soft Landing & High-Tier Hooking) ---
  const gracePhase = Math.max(0, 1 - (spinsPlayed / 25));

  if (gracePhase > 0) {
    // 1. HIGH TIER ACCESSIBILITY (The Bait)
    // Only boost low stakes (threshold is strictly under 20)
    const lowStakeFactor = Math.max(0, 1 - ((clampedStake - 5) / 15));
    const newbieHighTierBoost = gracePhase * lowStakeFactor;

    if (newbieHighTierBoost > 0) {
      const baseBig = bigWinChance;
      const baseMega = megaWinChance;
      const baseSuper = superMegaWinChance;

      bigWinChance       *= (1 + 1.8 * newbieHighTierBoost);
      megaWinChance      *= (1 + 2.5 * newbieHighTierBoost);
      superMegaWinChance *= (1 + 3.0 * newbieHighTierBoost);

      const totalAddedHighTier = (bigWinChance - baseBig) + (megaWinChance - baseMega) + (superMegaWinChance - baseSuper);
      loseChance = Math.max(0.20, loseChance - totalAddedHighTier);
    }

    // 2. SOFT LANDING COMPENSATION (Retention)
    const loseReduction = loseChance * 0.3 * gracePhase;
    loseChance -= loseReduction;

    recover70Chance += loseReduction * 0.4;
    doubleChance    += loseReduction * 0.3;
    tripleChance    += loseReduction * 0.3;
  }

  // --- DRY STREAK BREAKER (Pity Timer) ---
  // Secretly improves odds after 5 consecutive losses to prevent player churn
  if (consecutiveLosses >= 5) {
    // Caps out at 14 consecutive losses (max multiplier 10)
    const streakFactor = Math.min(10, consecutiveLosses - 4); 
    // Reduces the chance to lose by up to 40% based on the streak severity
    const lossReduction = loseChance * (0.04 * streakFactor); 

    loseChance -= lossReduction;
    // Distribute the improved odds heavily towards a satisfying recovery and exciting wins
    recover70Chance += lossReduction * 0.50; 
    doubleChance    += lossReduction * 0.30; 
    bigWinChance    += lossReduction * 0.20; 
  }

  return {
    stake, bigWinChance, megaWinChance, superMegaWinChance,
    loseChance, recover30Chance, recover70Chance, doubleChance, tripleChance,
  };
}

export function resolveSpinOutcome(
  stake: number, 
  economyPressure = 1, 
  spinsPlayed = 100,
  todayProfit = 0,
  pool = 500,
  consecutiveLosses = 0
): SpinOutcome {
  const profile = getStakeProfile(stake, spinsPlayed, consecutiveLosses);
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

      // Calculate dynamic profit metrics on the fly to protect house balance
      let healthScore = 0.5; // neutral starting state

      if (todayProfit > 0) healthScore += 0.25; // house is in profit today
      else if (todayProfit < 0) healthScore -= 0.25; // house is down today

      if (pool > 2000) healthScore += 0.25; // robust reserve
      else if (pool < 800) healthScore -= 0.25; // critical reserve level

      healthScore = Math.max(0, Math.min(1, healthScore));

      let resolvedMultiplier = 0;

      // Handle default low-tier multipliers
      if (entry.tier === 'lose') resolvedMultiplier = 0;
      // Randomize recovery values to prevent predictability 
      else if (entry.tier === 'recover30') resolvedMultiplier = [0.2, 0.3, 0.4][Math.floor(Math.random() * 3)];
      else if (entry.tier === 'recover70') resolvedMultiplier = [0.6, 0.7, 0.8][Math.floor(Math.random() * 3)];
      else if (entry.tier === 'double') resolvedMultiplier = 2;
      else if (entry.tier === 'triple') resolvedMultiplier = 3;

      // Dynamic High-Tiers: Higher house health increases odds of top-tier multipliers
      else if (entry.tier === 'big') {
        if (healthScore > 0.7) resolvedMultiplier = 6;
        else if (healthScore < 0.3) resolvedMultiplier = 4;
        else resolvedMultiplier = [4, 5, 6][Math.floor(Math.random() * 3)];
      } 
      else if (entry.tier === 'mega') {
        if (healthScore > 0.7) resolvedMultiplier = 12;
        else if (healthScore < 0.3) resolvedMultiplier = 10;
        else resolvedMultiplier = [10, 11, 12][Math.floor(Math.random() * 3)];
      } 
      else if (entry.tier === 'superMega') {
        if (healthScore > 0.7) resolvedMultiplier = 18;
        else if (healthScore < 0.3) resolvedMultiplier = 16;
        else resolvedMultiplier = [16, 17, 18][Math.floor(Math.random() * 3)];
      }

      return {
        tier: entry.tier,
        multiplier: resolvedMultiplier,
        label: entry.tier === 'lose' ? 'No win'
          : entry.tier === 'recover30' ? 'Recovery'
          : entry.tier === 'recover70' ? 'Recovery'
          : entry.tier === 'double' ? 'Double'
          : entry.tier === 'triple' ? 'Triple'
          : entry.tier === 'big' ? 'Big win'
          : entry.tier === 'mega' ? 'Mega win'
          : 'Super mega win',
      };
    }
  }

  return { tier: 'lose', multiplier: 0, label: 'No win' };
}

// ── Pool-gated jackpot payouts (mega / superMega) ──────────────────────────

/**
 * If the jackpot pool can't actually afford the multiplier resolveSpinOutcome()
 * rolled, these are the guaranteed smaller multipliers paid instead. These are
 * paid directly (not drawn from the pool) so a thin pool never blocks a win —
 * it just downgrades the size of it.
 */
export const MEGA_FALLBACK_RANGE = { min: 4, max: 6 } as const;       // matches 'big' tier payout
export const SUPERMEGA_FALLBACK_RANGE = { min: 10, max: 12 } as const; // matches 'mega' tier payout

export interface JackpotPayout {
  totalWin: number;
  multiplier: number;
  fromPool: boolean;   // true if this payout was actually drawn down from the jackpot pool
  downgraded: boolean; // true if the pool couldn't cover the rolled multiplier and we fell back
}

/**
 * Resolves the real payout for a mega/superMega spin, constrained by what the pool
 * can actually afford above its floor seed. Full multiplier wins are only paid out
 * (and only deducted from the pool) if the pool can cover them; otherwise the player
 * still gets a smaller guaranteed win, paid straight from the house.
 */
export function resolveJackpotPayout(
  tier: 'mega' | 'superMega',
  bet: number,
  multiplier: number,
  pool: number
): JackpotPayout {
  const availableSurplus = Math.max(0, pool - JACKPOT_SEED);
  const rawWin = Math.round(bet * multiplier);

  if (rawWin <= availableSurplus) {
    return { totalWin: rawWin, multiplier, fromPool: true, downgraded: false };
  }

  const fallbackRange = tier === 'superMega' ? SUPERMEGA_FALLBACK_RANGE : MEGA_FALLBACK_RANGE;
  const fallbackMultiplier = fallbackRange.min + Math.floor(Math.random() * (fallbackRange.max - fallbackRange.min + 1));
  const fallbackWin = Math.round(bet * fallbackMultiplier);

  return { totalWin: fallbackWin, multiplier: fallbackMultiplier, fromPool: false, downgraded: true };
}

export function resolveCoinflipOutcome(stake: number, economyPressure = 1, spinsPlayed = 100, consecutiveLosses = 0) {
  const pressureFactor = Math.max(0.85, Math.min(1.15, economyPressure));
  const riskFactor = (Math.max(5, Math.min(100, stake)) - 5) / 95; 
  const baseChance = Math.max(0.34, 0.48 - (riskFactor * 0.10));

  const gracePhase = Math.max(0, 1 - (spinsPlayed / 25));
  const lowStakeFactor = Math.max(0, 1 - ((Math.max(5, stake) - 5) / 15));
  const beginnerBoost = 0.20 * gracePhase * lowStakeFactor; 

  // Dry streak breaker: up to 25% extra win chance after severe losing streaks
  const pityBoost = consecutiveLosses >= 4 ? Math.min(0.25, (consecutiveLosses - 3) * 0.05) : 0;

  const winChance = Math.min(0.85, Math.max(0.28, baseChance / pressureFactor) + beginnerBoost + pityBoost);

  return Math.random() <= winChance
    ? { multiplier: 2, label: 'You won', win: true }
    : { multiplier: 0, label: 'You lost', win: false };
}

export function resolveDiceOutcome(stake: number, economyPressure = 1, spinsPlayed = 100, consecutiveLosses = 0) {
  const pressureFactor = Math.max(0.85, Math.min(1.15, economyPressure));
  const riskFactor = (Math.max(5, Math.min(100, stake)) - 5) / 95;
  const baseWinChance = Math.max(0.28, 0.42 - (riskFactor * 0.10));

  const gracePhase = Math.max(0, 1 - (spinsPlayed / 25));
  const lowStakeFactor = Math.max(0, 1 - ((Math.max(5, stake) - 5) / 15));
  const beginnerBoost = 0.18 * gracePhase * lowStakeFactor;

  // Dry streak breaker
  const pityBoost = consecutiveLosses >= 4 ? Math.min(0.25, (consecutiveLosses - 3) * 0.05) : 0;

  const winChance = Math.min(0.75, Math.max(0.2, baseWinChance / pressureFactor) + beginnerBoost + pityBoost);
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