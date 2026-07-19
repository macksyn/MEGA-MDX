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
 *   mega       — 2 lion + 1 tiger   (pays stake multiplier 10-12 based on pool/profits)
 *   superMega  — 3 lion             (pays stake multiplier 16-18 based on pool/profits)
 */

import { createStore } from './pluginStore.js';

const store          = createStore('slotmachine');
const jackpotTbl     = store.table('jackpot'); // single key 'pool' -> number
const playerStatsTbl = store.table('playerStats'); // tracks individual player spins
const houseStatsTbl  = store.table('houseStats'); // tracks daily bets/wins for profit calculation

const JACKPOT_SEED               = 500;   // pool never drops below this
const JACKPOT_CONTRIBUTION_RATE  = 0.05;  // 5% of every gambling bet feeds the pool

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

/** Deducts a high-tier payout from the jackpot pool, respecting the floor seed. */
export async function deductFromJackpot(amount: number): Promise<number> {
  const pool = await getJackpotPool();
  const newPool = Math.max(JACKPOT_SEED, pool - amount);
  await jackpotTbl.set('pool', newPool);
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
  const betKey = `${todayStr}_bet`;
  const wonKey = `${todayStr}_won`;

  const todayBet = ((await houseStatsTbl.get(betKey)) as number) || 0;
  const todayWon = ((await houseStatsTbl.get(wonKey)) as number) || 0;

  return todayBet - todayWon;
}

/** Records house activity for a specific spin or game */
export async function recordHouseActivity(bet: number, payout: number): Promise<void> {
  const todayStr = new Date().toISOString().split('T')[0];
  const betKey = `${todayStr}_bet`;
  const wonKey = `${todayStr}_won`;

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
    // E.g., 2000 profit -> reduces pressure by 0.04 (caps at 0.15)
    pressure -= Math.min(0.15, (todayProfit / 1000) * 0.02);
  } else {
    // E.g., -1000 loss -> increases pressure by 0.05 (caps at 0.20)
    pressure += Math.min(0.20, (Math.abs(todayProfit) / 1000) * 0.05);
  }

  // 2. Jackpot Pool Factor
  const pool = await getJackpotPool();
  const poolBaseline = 1500;
  
  if (pool > poolBaseline) {
    // Abundant pool -> looser economy (caps at 0.1 reduction)
    pressure -= Math.min(0.1, ((pool - poolBaseline) / 1000) * 0.02);
  } else {
    // Starved pool -> tighter economy (caps at 0.1 increase)
    pressure += Math.min(0.1, ((poolBaseline - pool) / 1000) * 0.04);
  }

  // Clamp between 0.75 (very generous) and 1.25 (very strict)
  return Math.max(0.75, Math.min(1.25, pressure));
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

/**
 * Calculates win probabilities based on stake size and historical games.
 * Allowed stakes (5, 20, 50, 100) are mapped smoothly onto a 0.2 to 1.0 risk profile.
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

function rollFillerSymbol(): string {
  let symbol = rollSymbol();
  while (symbol === LION || symbol === TIGER) symbol = rollSymbol();
  return symbol;
}

const ROWS = 3;
const COLS = 4;
export const PAYLINE_INDEX = 1; 

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
  recover30: [TIGER],
  recover70: [LION],
  double:    [LION, TIGER],
  triple:    [TIGER, TIGER],
  big:       [LION, TIGER, TIGER],
  mega:      [LION, LION, TIGER],
  superMega: [LION, LION, LION],
};

export function spinGridForTier(tier: SpinOutcome['tier']): string[][] {
  const grid = spinGrid();
  const payline = grid[PAYLINE_INDEX];
  const fixed = TIER_PAYLINE[tier];

  for (let c = 0; c < COLS; c++) {
    payline[c] = c < fixed.length ? fixed[c] : rollFillerSymbol();
  }

  return grid;
}

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

export function renderGrid(grid: string[][]): string {
  return grid
    .map((row, i) => {
      const line = row.join('│');
      return i === PAYLINE_INDEX ? `${line} ` : ` ${line} `;
    })
    .join('\n');
}
