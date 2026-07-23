// @ts-nocheck
/***
 * lib/oceanSlotMachine.ts
 *
 * "Ocean Hunt" slot machine engine + its own independent jackpot pool.
 * Pure game logic based on the verified Jungle Hunt engine.
 *
 * ── The pool is a real bank, not a side pot ─────────────────────────────
 * Same model as Jungle Hunt, but kept fully independent — its own pool
 * ('ocean_pool'), its own house mood ('ocean_houseMood'), separate from
 * Jungle Hunt's. Every stake a player loses becomes real pool capital the
 * moment it's wagered (contributeToJackpot). Every coin paid out to a
 * winner is drawn back out of that same pool (settleWin + deductFromJackpot)
 * — nothing is ever minted from nowhere. JACKPOT_SEED is a protected floor
 * no payout may push the pool below.
 *
 * getEconomyPressure() combines real bank solvency (protects the floor,
 * never auto-loosens just because the pool has grown large) with the
 * house's shared "mood" (a small, randomly-timed hot/cold swing).
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
 *   mega       — 2 whales + 1 shark  (pays stake multiplier 10-12, capped to what the pool can afford)
 *   superMega  — 3 whales            (pays stake multiplier 16-18, capped to what the pool can afford)
 *
 * Newbie grace period boosts chances at stakes strictly under 20 coins,
 * scaling down linearly to 0.0 at stakes of 20 or more.
 */

import { createStore } from './pluginStore.js';

const store          = createStore('slotmachine');
const jackpotTbl     = store.table('jackpot'); // 'ocean_pool' -> number, 'ocean_houseMood' -> HouseMood
const playerStatsTbl = store.table('playerStats'); // tracks individual player spins
const houseStatsTbl  = store.table('houseStats'); // tracks daily bets/wins for profit calculation

const JACKPOT_SEED = 500; // protected floor — the bank can never be paid down below this, by anything

// ── RTP policy ───────────────────────────────────────────────────────────────
// Same three-tier policy as Jungle Hunt — see lib/slotMachine.ts for the full
// rationale. Kept as its own copy here rather than a shared import so Ocean
// Hunt's tuning can diverge independently later if needed.
export const TARGET_RTP            = 0.915;
export const HARD_CEILING_RTP      = 0.93;
export const EMERGENCY_CEILING_RTP = 0.90;

export async function getJackpotPool(): Promise<number> {
  const val = await jackpotTbl.get('ocean_pool');
  return typeof val === 'number' ? val : JACKPOT_SEED;
}

/**
 * Called on every gambling bet — the full stake becomes real bank capital the
 * instant it's wagered. If the player wins, settleWin() + deductFromJackpot()
 * pay their winnings back out of this same pool; if they lose, the stake just
 * stays banked.
 */
export async function contributeToJackpot(bet: number): Promise<number> {
  const pool = await getJackpotPool();
  const newPool = pool + bet;
  await jackpotTbl.set('ocean_pool', newPool);
  return newPool;
}

/** Pays a payout out of the ocean jackpot pool, respecting the protected floor seed. */
export async function deductFromJackpot(amount: number): Promise<number> {
  const pool = await getJackpotPool();
  const newPool = Math.max(JACKPOT_SEED, pool - amount);
  await jackpotTbl.set('ocean_pool', newPool);
  return newPool;
}

export interface SettledPayout {
  payout: number;
  capped: boolean; // true if the bank couldn't afford the full rolled payout and this was capped down
}

/**
 * Every winning payout — from every game, every tier — is settled through here
 * before it's paid. The bank never pays more than it actually has above its
 * protected floor; if a payout would breach that floor, it's capped down to
 * whatever the bank can currently afford instead of being paid in full anyway.
 */
export function settleWin(rawWin: number, pool: number): SettledPayout {
  const availableSurplus = Math.max(0, pool - JACKPOT_SEED);
  if (rawWin <= availableSurplus) {
    return { payout: rawWin, capped: false };
  }
  return { payout: availableSurplus, capped: true };
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

// ── Bank solvency & house mood ──────────────────────────────────────────────
//
// getEconomyPressure() is the single source of truth for how generous or
// strict the house is right now. Same two-factor model as Jungle Hunt:
// real solvency (protects the floor, never auto-loosens on a large pool)
// combined with an independent, randomly-timed house mood.
//
// < 1.0 = Loose/Generous · > 1.0 = Tight/Strict

const CRITICAL_BAND            = JACKPOT_SEED * 0.5; // surplus below this = critical zone
const MAX_CRITICAL_TIGHTENING  = 0.35;                // extra pressure added right at the floor

export type SolvencyLevel = 'critical' | 'healthy';

export interface SolvencyState {
  level: SolvencyLevel;
  surplus: number;
  pressure: number;
}

/** Reads the ocean bank's actual health from its real surplus above the protected floor. */
export function getSolvencyState(pool: number): SolvencyState {
  const surplus = Math.max(0, pool - JACKPOT_SEED);

  if (surplus >= CRITICAL_BAND) {
    return { level: 'healthy', surplus, pressure: 1.0 };
  }

  const severity = 1 - (surplus / CRITICAL_BAND);
  const pressure = 1.0 + severity * MAX_CRITICAL_TIGHTENING;
  return { level: 'critical', surplus, pressure };
}

const MOOD_MIN_DURATION_MS = 20 * 60 * 1000;  // 20 minutes
const MOOD_MAX_DURATION_MS = 120 * 60 * 1000; // 2 hours

export type HouseMoodName = 'hot' | 'neutral' | 'cold';

export interface HouseMood {
  mood: HouseMoodName;
  multiplier: number; // <1 loosens, >1 tightens
  expiresAt: number;
}

function rollHouseMood(): HouseMood {
  const r = Math.random();
  let mood: HouseMoodName;
  let multiplier: number;

  if (r < 0.15) {
    mood = 'hot';
    multiplier = 0.9;
  } else if (r < 0.30) {
    mood = 'cold';
    multiplier = 1.1;
  } else {
    mood = 'neutral';
    multiplier = 1.0;
  }

  const duration = MOOD_MIN_DURATION_MS + Math.random() * (MOOD_MAX_DURATION_MS - MOOD_MIN_DURATION_MS);
  return { mood, multiplier, expiresAt: Date.now() + duration };
}

/**
 * Ocean Hunt's own house mood — kept under a distinct storage key so it swings
 * independently of Jungle Hunt's, even though both live in the same store.
 */
export async function getHouseMood(): Promise<HouseMood> {
  const stored = (await jackpotTbl.get('ocean_houseMood')) as HouseMood | undefined;

  if (stored && typeof stored === 'object' && stored.expiresAt > Date.now()) {
    return stored;
  }

  const fresh = rollHouseMood();
  await jackpotTbl.set('ocean_houseMood', fresh);
  return fresh;
}

/**
 * Combines solvency and house mood into the single pressure value every game
 * resolver uses. Solvency always has final say: in a critical state, mood can
 * only add extra caution on top, never loosen odds below what solvency allows.
 */
export async function getEconomyPressure(pool: number): Promise<number> {
  const solvency = getSolvencyState(pool);
  const mood = await getHouseMood();

  let pressure = solvency.pressure;
  pressure *= solvency.level === 'critical' ? Math.max(1, mood.multiplier) : mood.multiplier;

  return Math.max(0.75, Math.min(1.35, pressure));
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

// Average payout each tier represents, for RTP math (recover/big/mega/superMega
// each roll a small random range at resolution time — these are that range's mean).
const AVG_TIER_MULTIPLIER: Record<SpinOutcome['tier'], number> = {
  lose: 0, recover30: 0.3, recover70: 0.7, double: 2, triple: 3, big: 5, mega: 11, superMega: 17,
};

// Risk-scaled design-center RTP: the baseline (no grace period, no pity timer,
// neutral pressure) odds are tuned to land here — a bit more generous at the
// lowest stake, a bit tighter at the highest.
const MIN_STAKE_BASE_RTP = 0.93; // at stake 5  (normalized = 0.2)
const MAX_STAKE_BASE_RTP = 0.90; // at stake 100 (normalized = 1.0)

function targetBaseRTP(normalized: number): number {
  const t = (normalized - 0.2) / 0.8; // 0 at the lowest stake, 1 at the highest
  return MIN_STAKE_BASE_RTP + (MAX_STAKE_BASE_RTP - MIN_STAKE_BASE_RTP) * t;
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

  // --- BASE RTP RECALIBRATION ---
  // Scale the winning-tier chances so the neutral, unboosted RTP for THIS stake
  // lands on the risk-scaled target, before grace period / pity timer boosts
  // (which are intentional, temporary generosity) get layered on top of it.
  {
    const rawWinTotal = recover30Chance + recover70Chance + doubleChance + tripleChance + bigWinChance + megaWinChance + superMegaWinChance;
    const rawWinRTP = (
      recover30Chance * AVG_TIER_MULTIPLIER.recover30 +
      recover70Chance * AVG_TIER_MULTIPLIER.recover70 +
      doubleChance * AVG_TIER_MULTIPLIER.double +
      tripleChance * AVG_TIER_MULTIPLIER.triple +
      bigWinChance * AVG_TIER_MULTIPLIER.big +
      megaWinChance * AVG_TIER_MULTIPLIER.mega +
      superMegaWinChance * AVG_TIER_MULTIPLIER.superMega
    ) / (rawWinTotal + loseChance);

    const target = targetBaseRTP(normalized);
    const scale = rawWinRTP > 0 ? target / rawWinRTP : 1;

    recover30Chance *= scale;
    recover70Chance *= scale;
    doubleChance    *= scale;
    tripleChance    *= scale;
    bigWinChance    *= scale;
    megaWinChance   *= scale;
    superMegaWinChance *= scale;

    // Whatever probability mass shifted moves out of (or back into) 'lose', so the
    // relative shape between winning tiers is preserved — only the overall win/lose
    // balance changes.
    const newWinTotal = recover30Chance + recover70Chance + doubleChance + tripleChance + bigWinChance + megaWinChance + superMegaWinChance;
    loseChance = Math.max(0.05, loseChance - (newWinTotal - rawWinTotal));
  }

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

  // Hard RTP ceiling: whatever the beginner grace period, pity timer, and pressure
  // factor stacked up to, the expected payout of this spin can never cross the
  // ceiling. Winning-tier weights are scaled down proportionally (preserving their
  // relative shape) and the reclaimed probability mass is added back to 'lose' —
  // rather than capping any single tier, which would distort the odds shape.
  const expectedRTP = normalized.reduce((sum, entry) => sum + entry.weight * AVG_TIER_MULTIPLIER[entry.tier], 0);
  const rtpCeiling = getSolvencyState(pool).level === 'critical' ? EMERGENCY_CEILING_RTP : HARD_CEILING_RTP;

  if (expectedRTP > rtpCeiling) {
    const scaleDown = rtpCeiling / expectedRTP;
    const loseEntry = normalized.find(entry => entry.tier === 'lose')!;
    let reclaimed = 0;
    for (const entry of normalized) {
      if (entry.tier === 'lose') continue;
      const removed = entry.weight * (1 - scaleDown);
      entry.weight -= removed;
      reclaimed += removed;
    }
    loseEntry.weight += reclaimed;
  }

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

export function resolveCoinflipOutcome(stake: number, economyPressure = 1, spinsPlayed = 100, consecutiveLosses = 0, pool = JACKPOT_SEED) {
  const pressureFactor = Math.max(0.85, Math.min(1.15, economyPressure));
  const riskFactor = (Math.max(5, Math.min(100, stake)) - 5) / 95; 
  const baseChance = Math.max(0.34, 0.48 - (riskFactor * 0.10));
  
  const gracePhase = Math.max(0, 1 - (spinsPlayed / 25));
  const lowStakeFactor = Math.max(0, 1 - ((Math.max(5, stake) - 5) / 15));
  const beginnerBoost = 0.20 * gracePhase * lowStakeFactor; 

  // Dry streak breaker: up to 25% extra win chance after severe losing streaks
  const pityBoost = consecutiveLosses >= 4 ? Math.min(0.25, (consecutiveLosses - 3) * 0.05) : 0;

  let winChance = Math.min(0.85, Math.max(0.28, baseChance / pressureFactor) + beginnerBoost + pityBoost);

  // Hard RTP ceiling: no matter how much beginner boost + pity + loose mood stack,
  // the house can never be pushed past this expected payout ratio. Automatically
  // tightens further if the bank is in a critical solvency state.
  const COINFLIP_MULTIPLIER = 2;
  const rtpCeiling = getSolvencyState(pool).level === 'critical' ? EMERGENCY_CEILING_RTP : HARD_CEILING_RTP;
  winChance = Math.min(winChance, rtpCeiling / COINFLIP_MULTIPLIER);

  return Math.random() <= winChance
    ? { multiplier: COINFLIP_MULTIPLIER, label: 'You won', win: true }
    : { multiplier: 0, label: 'You lost', win: false };
}

export function resolveDiceOutcome(stake: number, economyPressure = 1, spinsPlayed = 100, consecutiveLosses = 0, pool = JACKPOT_SEED) {
  const pressureFactor = Math.max(0.85, Math.min(1.15, economyPressure));
  const riskFactor = (Math.max(5, Math.min(100, stake)) - 5) / 95;
  const baseWinChance = Math.max(0.28, 0.42 - (riskFactor * 0.10));
  
  const gracePhase = Math.max(0, 1 - (spinsPlayed / 25));
  const lowStakeFactor = Math.max(0, 1 - ((Math.max(5, stake) - 5) / 15));
  const beginnerBoost = 0.18 * gracePhase * lowStakeFactor;

  // Dry streak breaker
  const pityBoost = consecutiveLosses >= 4 ? Math.min(0.25, (consecutiveLosses - 3) * 0.05) : 0;

  let winChance = Math.min(0.75, Math.max(0.2, baseWinChance / pressureFactor) + beginnerBoost + pityBoost);
  const tieChance = Math.max(0.08, Math.min(0.2, 0.16 / pressureFactor)); 

  // Hard RTP ceiling — same principle as coinflip, but the tie's 1x refund also
  // counts toward RTP, so it has to be netted out before capping the win chance.
  const DICE_WIN_MULTIPLIER = 1.9;
  const rtpCeiling = getSolvencyState(pool).level === 'critical' ? EMERGENCY_CEILING_RTP : HARD_CEILING_RTP;
  const maxWinChance = Math.max(0, (rtpCeiling - tieChance) / DICE_WIN_MULTIPLIER);
  winChance = Math.min(winChance, maxWinChance);

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