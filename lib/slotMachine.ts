// @ts-nocheck
/***
 * lib/slotMachine.ts
 *
 * "Jungle Hunt" slot machine engine + the shared jackpot pool that
 * coinflip/dice/slots all feed. Pure game logic — no WhatsApp/sock code
 * here, so plugins just call these and handle the messaging themselves.
 *
 * ── The pool is a real bank, not a side pot ─────────────────────────────
 * The jackpot pool IS the house's bankroll. Every stake a player loses
 * becomes real pool capital the moment it's wagered (contributeToJackpot).
 * Every coin paid out to a winner is drawn back out of that same pool
 * (settleWin + deductFromJackpot) — nothing is ever minted from nowhere.
 * JACKPOT_SEED is a protected floor: no payout, from any game or any
 * future feature (referrals, attendance bonuses, etc.), may push the pool
 * below it. If the pool can't afford a payout in full, the payout is
 * capped down to whatever it can actually afford — never paid anyway.
 *
 * getEconomyPressure() is the single source of truth for how generous or
 * strict the house is being right now. It combines two independent
 * factors: real bank solvency (protects the floor, never auto-loosens
 * just because the pool has grown large) and the house's shared "mood"
 * (a small, randomly-timed hot/cold swing that applies to everyone at
 * once, independent of any single player's own streak).
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
 *   mega       — 2 lion + 1 tiger   (pays stake multiplier 10-12, capped to what the pool can afford)
 *   superMega  — 3 lion             (pays stake multiplier 16-18, capped to what the pool can afford)
 */

import { createStore } from './pluginStore.js';

const store          = createStore('slotmachine');
const jackpotTbl     = store.table('jackpot'); // 'pool' -> number, 'houseMood' -> HouseMood
const playerStatsTbl = store.table('playerStats'); // tracks individual player spins
const houseStatsTbl  = store.table('houseStats'); // tracks daily bets/wins for profit calculation

const JACKPOT_SEED = 500; // protected floor — the bank can never be paid down below this, by anything

// ── RTP policy ───────────────────────────────────────────────────────────────
// Every game resolver enforces these regardless of how many boosts (beginner
// grace period, pity timer, house mood) are stacked at once:
//   TARGET_RTP             — the design-center return the base odds aim for
//                             over time. Not itself enforced as a clamp; it's
//                             the reference point the base probabilities were
//                             tuned against.
//   HARD_CEILING_RTP       — the absolute max expected return any single spin
//                             can carry under healthy solvency, however
//                             generous the stacked boosts get. This is what
//                             actually gets enforced.
//   EMERGENCY_CEILING_RTP  — a tighter ceiling that automatically replaces the
//                             hard ceiling the moment the bank enters a
//                             critical solvency state, so a thin bankroll
//                             recovers faster instead of getting boost-stacked
//                             further down.
export const TARGET_RTP            = 0.915;
export const HARD_CEILING_RTP      = 0.93;
export const EMERGENCY_CEILING_RTP = 0.90;

export async function getJackpotPool(): Promise<number> {
  const val = await jackpotTbl.get('pool');
  return typeof val === 'number' ? val : JACKPOT_SEED;
}

/**
 * Called on every gambling bet (slots, coinflip, dice) — the full stake becomes
 * real bank capital the instant it's wagered. If the player wins, settleWin() +
 * deductFromJackpot() pay their winnings back out of this same pool; if they
 * lose, the stake just stays banked.
 */
export async function contributeToJackpot(bet: number): Promise<number> {
  const pool = await getJackpotPool();
  const newPool = pool + bet;
  await jackpotTbl.set('pool', newPool);
  return newPool;
}

/** Pays a payout out of the jackpot pool, respecting the protected floor seed. */
export async function deductFromJackpot(amount: number): Promise<number> {
  const pool = await getJackpotPool();
  const newPool = Math.max(JACKPOT_SEED, pool - amount);
  await jackpotTbl.set('pool', newPool);
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

export interface DailyStats {
  bet: number;
  won: number;
  net: number;
}

/** Retrieves today's full activity breakdown: total wagered, total paid out, and net. */
export async function getTodayStats(): Promise<DailyStats> {
  const todayStr = new Date().toISOString().split('T')[0];
  const betKey = `${todayStr}_bet`;
  const wonKey = `${todayStr}_won`;

  const bet = ((await houseStatsTbl.get(betKey)) as number) || 0;
  const won = ((await houseStatsTbl.get(wonKey)) as number) || 0;

  return { bet, won, net: bet - won };
}

/** Retrieves today's net profit (bets - payouts) */
export async function getTodayProfit(): Promise<number> {
  return (await getTodayStats()).net;
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

// ── Bank solvency & house mood ──────────────────────────────────────────────
//
// getEconomyPressure() is the single source of truth for how generous or
// strict the house is right now. It's the product of two independent signals:
//
//   1. Solvency  — grounded in the REAL surplus above the protected floor.
//      Tightens smoothly as the pool nears the floor. Once healthy, stays
//      perfectly neutral no matter how large the pool grows — the house
//      never auto-loosens odds just because it's sitting on a lot of capital.
//      This always has final say: mood can never override it into paying out
//      money the bank doesn't have.
//
//   2. House mood — a small, randomly-timed hot/cold/neutral swing shared by
//      every player at once (independent of any individual's own win/loss
//      streak). Rerolls itself on a random schedule so it can't be timed.
//
// < 1.0 = Loose/Generous · > 1.0 = Tight/Strict (same convention as before)

const CRITICAL_BAND            = JACKPOT_SEED * 0.5; // surplus below this = critical zone
const MAX_CRITICAL_TIGHTENING  = 0.35;                // extra pressure added right at the floor

export type SolvencyLevel = 'critical' | 'healthy';

export interface SolvencyState {
  level: SolvencyLevel;
  surplus: number;
  pressure: number;
}

/**
 * Reads the bank's actual health from its real surplus above the protected floor.
 * This is deliberately asymmetric: it only ever tightens (protecting the floor),
 * never loosens on its own just because the pool has grown large — growth is
 * capital the community can spend deliberately elsewhere, not an auto-giveback.
 */
export function getSolvencyState(pool: number): SolvencyState {
  const surplus = Math.max(0, pool - JACKPOT_SEED);

  if (surplus >= CRITICAL_BAND) {
    return { level: 'healthy', surplus, pressure: 1.0 };
  }

  const severity = 1 - (surplus / CRITICAL_BAND); // 0 at the edge of the band, 1 right at the floor
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
    multiplier = 1.2;
  } else {
    mood = 'neutral';
    multiplier = 1.0;
  }

  const duration = MOOD_MIN_DURATION_MS + Math.random() * (MOOD_MAX_DURATION_MS - MOOD_MIN_DURATION_MS);
  return { mood, multiplier, expiresAt: Date.now() + duration };
}

/**
 * The house's current shared mood. Applies to every player at once and rerolls
 * itself on a random schedule once its window expires — not on a fixed timer,
 * so it can't be gamed by watching the clock.
 */
export async function getHouseMood(): Promise<HouseMood> {
  const stored = (await jackpotTbl.get('houseMood')) as HouseMood | undefined;

  if (stored && typeof stored === 'object' && stored.expiresAt > Date.now()) {
    return stored;
  }

  const fresh = rollHouseMood();
  await jackpotTbl.set('houseMood', fresh);
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

// Average payout each tier represents, for RTP math (recover/big/mega/superMega
// each roll a small random range at resolution time — these are that range's mean).
const AVG_TIER_MULTIPLIER: Record<SpinOutcome['tier'], number> = {
  lose: 0, recover30: 0.3, recover70: 0.7, double: 2, triple: 3, big: 5, mega: 11, superMega: 17,
};

// Risk-scaled design-center RTP: the baseline (no grace period, no pity timer,
// neutral pressure) odds are tuned to land here — a bit more generous at the
// lowest stake, a bit tighter at the highest, instead of the old baseline's
// unexplained ~50%-to-96% swing across stakes.
const MIN_STAKE_BASE_RTP = 0.93; // at stake 5  (normalized = 0.2)
const MAX_STAKE_BASE_RTP = 0.90; // at stake 100 (normalized = 1.0)

function targetBaseRTP(normalized: number): number {
  const t = (normalized - 0.2) / 0.8; // 0 at the lowest stake, 1 at the highest
  return MIN_STAKE_BASE_RTP + (MAX_STAKE_BASE_RTP - MIN_STAKE_BASE_RTP) * t;
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
  let bigWinChance = Math.max(0.015, 0.045 - 0.025 * normalized);
  let megaWinChance = Math.max(0.005, 0.015 - 0.009 * normalized);
  let superMegaWinChance = Math.max(0.0015, 0.004 - 0.0028 * normalized);
  let loseChance = Math.max(0.42, 0.44 + 0.12 * normalized);
  let recover30Chance = Math.max(0.12, 0.17 - 0.05 * normalized);
  let recover70Chance = Math.max(0.08, 0.14 - 0.06 * normalized);
  let doubleChance = Math.max(0.08, 0.12 - 0.04 * normalized);
  let tripleChance = Math.max(0.03, 0.07 - 0.04 * normalized);

  // --- BASE RTP RECALIBRATION ---
  // The raw curve above wasn't tuned to any RTP target and swings wildly by stake
  // (was ~50% house edge at max stake, ~4-24% at min stake — no real reason for the
  // gap). Scale the winning-tier chances so the neutral, unboosted RTP for THIS
  // stake lands on the risk-scaled target, before grace period / pity timer boosts
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

      bigWinChance       *= (1 + 2.5 * newbieHighTierBoost);
      megaWinChance      *= (1 + 3.5 * newbieHighTierBoost);
      superMegaWinChance *= (1 + 4.5 * newbieHighTierBoost);

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

// ── Number guess (2–12) resolver ────────────────────────────────────────────

export function resolveNumberGuessOutcome(
  stake: number,
  guess: number,
  economyPressure: number,
  spinsPlayed: number,
  consecutiveLosses: number,
  pool: number
): {
  outcome: 'win' | 'tie' | 'lose';
  resultNumber: number;
  multiplier: number;
} {
  // clamp guess to valid range
  guess = Math.max(2, Math.min(12, Math.round(guess)));

  const pressureFactor = Math.max(0.8, Math.min(1.2, economyPressure));

  // Base probabilities – tuned to reach ~0.92 RTP after boosts
  let baseWinProb = 0.10;
  let baseTieProb = 0.22;
  let baseLossProb = 1 - baseWinProb - baseTieProb;

  // Apply pressure: win/tie decrease when pressure > 1
  let winProb = baseWinProb / pressureFactor;
  let tieProb = baseTieProb / pressureFactor;
  let lossProb = 1 - winProb - tieProb;

  // clamp and re-normalise
  winProb = Math.max(0.01, Math.min(0.6, winProb));
  tieProb = Math.max(0.01, Math.min(0.5, tieProb));
  lossProb = Math.max(0.05, Math.min(0.9, lossProb));
  const total = winProb + tieProb + lossProb;
  winProb /= total;
  tieProb /= total;
  lossProb /= total;

  // Beginner grace period (first 25 spins, low stakes)
  const gracePhase = Math.max(0, 1 - spinsPlayed / 25);
  const lowStakeFactor = Math.max(0, 1 - ((Math.max(5, stake) - 5) / 15));
  if (gracePhase > 0 && lowStakeFactor > 0) {
    const boost = 0.15 * gracePhase * lowStakeFactor; // up to +15% win chance
    winProb = Math.min(0.8, winProb + boost);
    lossProb = 1 - winProb - tieProb;
    if (lossProb < 0) {
      tieProb += lossProb;
      lossProb = 0.05;
      const scale = (1 - lossProb) / (winProb + tieProb);
      winProb *= scale;
      tieProb *= scale;
    }
  }

  // Pity timer – after 5 losses, increase win & tie chances
  if (consecutiveLosses >= 5) {
    const streakFactor = Math.min(10, consecutiveLosses - 4);
    const boost = 0.02 * streakFactor; // up to +20% win
    winProb = Math.min(0.8, winProb + boost);
    tieProb = Math.min(0.5, tieProb + 0.01 * streakFactor);
    lossProb = 1 - winProb - tieProb;
    if (lossProb < 0.05) {
      lossProb = 0.05;
      const scale = (1 - lossProb) / (winProb + tieProb);
      winProb *= scale;
      tieProb *= scale;
    }
  }

  // Hard RTP ceiling (critical bank → tighter)
  const rtpCeiling =
    getSolvencyState(pool).level === 'critical'
      ? EMERGENCY_CEILING_RTP
      : HARD_CEILING_RTP;

  let expectedRTP = winProb * 6 + tieProb * 1;
  if (expectedRTP > rtpCeiling) {
    const scale = rtpCeiling / expectedRTP;
    winProb *= scale;
    tieProb *= scale;
    lossProb = 1 - winProb - tieProb;
    if (lossProb < 0) {
      lossProb = 0;
      const total2 = winProb + tieProb;
      winProb /= total2;
      tieProb /= total2;
    }
  }

  // Roll outcome
  const roll = Math.random();
  let outcome: 'win' | 'tie' | 'lose';
  if (roll < winProb) outcome = 'win';
  else if (roll < winProb + tieProb) outcome = 'tie';
  else outcome = 'lose';

  // Generate a result number that matches the outcome
  let resultNumber: number;
  if (outcome === 'win') {
    resultNumber = guess;
  } else if (outcome === 'tie') {
    const candidates: number[] = [];
    if (guess - 1 >= 2) candidates.push(guess - 1);
    if (guess + 1 <= 12) candidates.push(guess + 1);
    if (candidates.length === 0) {
      // fallback (should never happen)
      resultNumber = guess;
      outcome = 'win'; // treat as win
    } else {
      resultNumber = candidates[Math.floor(Math.random() * candidates.length)];
    }
  } else {
    // lose – pick a number not equal and not adjacent
    const candidates: number[] = [];
    for (let n = 2; n <= 12; n++) {
      if (Math.abs(n - guess) > 1) candidates.push(n);
    }
    if (candidates.length === 0) {
      resultNumber = guess === 2 ? 12 : 2;
    } else {
      resultNumber = candidates[Math.floor(Math.random() * candidates.length)];
    }
  }

  const multiplier = outcome === 'win' ? 6 : outcome === 'tie' ? 1 : 0;
  return { outcome, resultNumber, multiplier };
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