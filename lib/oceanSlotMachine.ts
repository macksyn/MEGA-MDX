// @ts-nocheck
/***
 * lib/oceanSlotMachine.ts
 * Ocean Hunt – Expedition Engine (v2)
 *
 * Integrates: Ocean states, volatility, dynamic fish, equipment, quality,
 * pity timer, world events, rich narration, secure RNG.
 *
 * ── RTP policy (aligned with Jungle Hunt) ───────────────────────────────
 * Ocean Hunt now shares the same design language as slotMachine.ts:
 *   TARGET RTP     — risk-scaled by stake, NOT itself enforced as a clamp.
 *                     It's the reference the base category weights were
 *                     tuned against (0.93 at bet 5, down to 0.90 at bet 100 —
 *                     the same curve Jungle Hunt uses).
 *   HARD_CEILING_RTP / EMERGENCY_CEILING_RTP — the actual enforced ceiling.
 *     Whatever strategy pick, ocean state, equipment, event, or pity-timer
 *     boost stacks up, the expedition's expected payout can never cross this
 *     ceiling. Winning-category weights are scaled down proportionally
 *     (preserving their relative shape) and the reclaimed probability mass
 *     is added back to 'empty' — never any single category punished alone.
 *     Automatically tightens to EMERGENCY_CEILING_RTP the moment the bank
 *     enters a critical solvency state.
 *
 * Unlike v1, payout MULTIPLIERS are now fixed per fish tier (like Jungle
 * Hunt's AVG_TIER_MULTIPLIER table) — the RTP lever is entirely on the
 * PROBABILITY side. That means a Mega Catch always actually pays like a
 * Mega Catch; the house never quietly shrinks win amounts behind the scenes.
 *
 * ── The pool is a real bank ──────────────────────────────────────────────
 * Same invariant as Jungle Hunt: every coin lost by a player (including the
 * extra bite taken by a predator attack) becomes real pool capital the
 * instant it's lost. Every coin paid out is drawn back out of that same
 * pool. JACKPOT_SEED is a protected floor nothing can breach.
 *
 * ── Catch tiers (the "how big is the fish" ladder) ───────────────────────
 *   empty              — no catch
 *   predator           — you get bitten, lose extra coins (feeds the pool)
 *   common / uncommon  — small catch, modest return
 *   rare               — 🎉 BIG CATCH
 *   legendary / special— 🔥 MEGA CATCH
 *   mythic             — 💥 SUPER MEGA CATCH
 *   treasure           — 💰 Treasure Haul (its own bonus lane, not a fish)
 *   jackpot            — 🌊 LEVIATHAN JACKPOT (the rarest, biggest payout)
 */

import crypto from 'crypto';
import { createStore } from './pluginStore.js';
import {
  getCurrentOceanState,
  getOceanState,
  getVolatilityFactor,
  getFishAvailabilityWithEvents,
  getEventModifiers,
  getActiveEvents,
  FishSpecies,
} from './oceanEcosystem.js';
import { getEquipment, EQUIPMENT_DEFS, formatNumber } from './economy.js';

const store = createStore('slotmachine');
const jackpotTbl = store.table('jackpot');
const playerStatsTbl = store.table('playerStats');
const houseStatsTbl = store.table('houseStats');

export const JACKPOT_SEED = 500;

// ── RTP policy ──────────────────────────────────────────────────────────
// Same numbers as Jungle Hunt (lib/slotMachine.ts) so both games are
// financially consistent with each other.
const MIN_STAKE_BASE_RTP = 0.93; // at bet 5  (normalized = 0)
const MAX_STAKE_BASE_RTP = 0.90; // at bet 100 (normalized = 1)
export const HARD_CEILING_RTP = 0.93;
export const EMERGENCY_CEILING_RTP = 0.90;

const MIN_BET = 5;
const MAX_BET = 100;

/** Risk-scaled design-center RTP for this stake — a reference point, not a clamp. */
export function getTargetRTP(stake: number): number {
  const clamped = Math.max(MIN_BET, Math.min(MAX_BET, stake));
  const normalized = (clamped - MIN_BET) / (MAX_BET - MIN_BET);
  return MIN_STAKE_BASE_RTP + (MAX_STAKE_BASE_RTP - MIN_STAKE_BASE_RTP) * normalized;
}

// ── Pool functions ────────────────────────────────────────────────────

export async function getJackpotPool(): Promise<number> {
  const val = await jackpotTbl.get('pool');
  return typeof val === 'number' ? val : JACKPOT_SEED;
}

/** Every coin a player loses — bet or predator bite — becomes real bank capital. */
export async function contributeToJackpot(amount: number): Promise<number> {
  const pool = await getJackpotPool();
  const newPool = pool + amount;
  await jackpotTbl.set('pool', newPool);
  return newPool;
}

export async function deductFromJackpot(amount: number): Promise<number> {
  const pool = await getJackpotPool();
  const newPool = Math.max(JACKPOT_SEED, pool - amount);
  await jackpotTbl.set('pool', newPool);
  return newPool;
}

export function settleWin(rawWin: number, pool: number): { payout: number; capped: boolean } {
  const availableSurplus = Math.max(0, pool - JACKPOT_SEED);
  if (rawWin <= availableSurplus) {
    return { payout: rawWin, capped: false };
  }
  return { payout: availableSurplus, capped: true };
}

// ── Bank solvency & tide pressure ────────────────────────────────────────
// Mirrors Jungle Hunt's getEconomyPressure(), but instead of an independent
// house-mood roll, Ocean Hunt folds in `luckyTide` — a variable that already
// exists in the living-ocean simulation. This makes the "tide feels lucky"
// flavor text mechanically true instead of decorative, and avoids running
// two parallel mood systems for the same game.
//
// < 1.0 = Loose/Generous · > 1.0 = Tight/Strict (same convention as Jungle Hunt)

const CRITICAL_BAND = JACKPOT_SEED * 0.5;
const MAX_CRITICAL_TIGHTENING = 0.35;

export type SolvencyLevel = 'critical' | 'healthy';
export interface SolvencyState { level: SolvencyLevel; surplus: number; pressure: number; }

export function getSolvencyState(pool: number): SolvencyState {
  const surplus = Math.max(0, pool - JACKPOT_SEED);
  if (surplus >= CRITICAL_BAND) {
    return { level: 'healthy', surplus, pressure: 1.0 };
  }
  const severity = 1 - (surplus / CRITICAL_BAND);
  const pressure = 1.0 + severity * MAX_CRITICAL_TIGHTENING;
  return { level: 'critical', surplus, pressure };
}

/** luckyTide baseline is 0.15; higher = looser, lower = tighter. Soft nudge only. */
function tideMultiplier(luckyTide: number): number {
  const delta = (luckyTide - 0.15) * 0.6;
  return Math.max(0.85, Math.min(1.15, 1 - delta));
}

export async function getEconomyPressure(pool: number): Promise<number> {
  const solvency = getSolvencyState(pool);
  const { variables } = await getOceanState();
  const tideMult = tideMultiplier(variables.luckyTide);

  let pressure = solvency.pressure;
  pressure *= solvency.level === 'critical' ? Math.max(1, tideMult) : tideMult;

  return Math.max(0.75, Math.min(1.35, pressure));
}

// ── Player stats ──────────────────────────────────────────────────────

export async function incrementAndGetSpins(userId: string): Promise<number> {
  const current = (await playerStatsTbl.get(userId)) || 0;
  const updated = (current as number) + 1;
  await playerStatsTbl.set(userId, updated);
  return updated;
}

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

export async function recordPlayerActivity(userId: string, bet: number, payout: number): Promise<void> {
  const currentBet = ((await playerStatsTbl.get(`${userId}_totalBet`)) as number) || 0;
  const currentWon = ((await playerStatsTbl.get(`${userId}_totalWon`)) as number) || 0;
  await playerStatsTbl.set(`${userId}_totalBet`, currentBet + bet);
  await playerStatsTbl.set(`${userId}_totalWon`, currentWon + payout);
}
export async function recordPlayerJackpot(userId: string): Promise<void> {
  await playerStatsTbl.set(`${userId}_lastJackpot`, new Date().toISOString());
}

/** Player profile with lifetime RTP — parity with Jungle Hunt's getPlayerProfile(). */
export async function getPlayerProfile(userId: string) {
  const spins = ((await playerStatsTbl.get(userId)) as number) || 0;
  const totalBet = ((await playerStatsTbl.get(`${userId}_totalBet`)) as number) || 0;
  const totalWon = ((await playerStatsTbl.get(`${userId}_totalWon`)) as number) || 0;
  const lastJackpot = ((await playerStatsTbl.get(`${userId}_lastJackpot`)) as string) || null;
  const lossStreak = await getConsecutiveLosses(userId);

  return {
    spins,
    totalBet,
    totalWon,
    rtp: totalBet > 0 ? totalWon / totalBet : 0,
    averageStake: spins > 0 ? totalBet / spins : 0,
    lastJackpot,
    lossStreak,
  };
}

// ── House daily stats ────────────────────────────────────────────────

export async function getTodayProfit(): Promise<number> {
  const todayStr = new Date().toISOString().split('T')[0];
  const betKey = `${todayStr}_ocean_bet`;
  const wonKey = `${todayStr}_ocean_won`;
  const todayBet = ((await houseStatsTbl.get(betKey)) as number) || 0;
  const todayWon = ((await houseStatsTbl.get(wonKey)) as number) || 0;
  return todayBet - todayWon;
}

export async function recordHouseActivity(bet: number, payout: number): Promise<void> {
  const todayStr = new Date().toISOString().split('T')[0];
  const betKey = `${todayStr}_ocean_bet`;
  const wonKey = `${todayStr}_ocean_won`;
  const currentBet = ((await houseStatsTbl.get(betKey)) as number) || 0;
  const currentWon = ((await houseStatsTbl.get(wonKey)) as number) || 0;
  await houseStatsTbl.set(betKey, currentBet + bet);
  await houseStatsTbl.set(wonKey, currentWon + payout);
}

// ── Expedition types ──────────────────────────────────────────────────

export type Strategy = 'shallow' | 'deep' | 'reef';
export type Quality = 'damaged' | 'common' | 'healthy' | 'premium' | 'legendary';
export type WinTier = 'none' | 'catch' | 'bigCatch' | 'megaCatch' | 'superMegaCatch';

export interface ExpeditionOutcome {
  type: 'empty' | 'fish' | 'treasure' | 'jackpot' | 'predator';
  outcomeLabel: string;
  emoji: string;
  narration: string;
  winAmount: number;
  fishRarity?: 'common' | 'uncommon' | 'rare' | 'legendary' | 'mythic';
  quality?: Quality;
  qualityMultiplier?: number;
  multiplier?: number;
  capped: boolean;
  fishSpecies?: FishSpecies;
  predatorSubType?: 'attack' | 'boatDamage' | 'netDamage';
  /** Extra coins a predator bites off beyond the bet — the handler must both
   *  deduct this from the player's wallet AND feed it back into the pool
   *  via contributeToJackpot(), same as the original bet. */
  predatorExtraLoss?: number;
  /** Drives the banner the handler shows above the result line. */
  winTier: WinTier;
  bannerText?: string;
}

// ── Constants ─────────────────────────────────────────────────────────
// Fixed per-tier multipliers — the RTP lever lives entirely on the
// probability side now (see resolveExpedition step 11), so these numbers
// mean what they say: a Mega Catch always pays like a Mega Catch.
const FISH_MULTIPLIERS = {
  common: 1.2,     // small catch
  uncommon: 2,      // catch
  rare: 4,          // 🎉 BIG CATCH
  legendary: 8,     // 🔥 MEGA CATCH
  mythic: 15,       // 💥 SUPER MEGA CATCH
};

const WIN_TIER_BY_RARITY: Record<keyof typeof FISH_MULTIPLIERS, WinTier> = {
  common: 'catch',
  uncommon: 'catch',
  rare: 'bigCatch',
  legendary: 'megaCatch',
  mythic: 'superMegaCatch',
};

const BANNER_TEXT: Record<WinTier, string | undefined> = {
  none: undefined,
  catch: undefined,
  bigCatch: '🎉 BIG CATCH!',
  megaCatch: '🔥 MEGA CATCH!',
  superMegaCatch: '💥 SUPER MEGA CATCH!',
};

const TREASURE_MIN = 3;
const TREASURE_MAX = 6;
const TREASURE_AVG = (TREASURE_MIN + TREASURE_MAX) / 2;
const JACKPOT_MIN_MULT = 12;
const JACKPOT_MAX_MULT = 22;
const JACKPOT_AVG_MULT = (JACKPOT_MIN_MULT + JACKPOT_MAX_MULT) / 2;
const PREDATOR_LOSS_FRACTION = 0.5;

const QUALITY_MULTIPLIERS: Record<Quality, number> = {
  damaged: 0.6,
  common: 1.0,
  healthy: 1.3,
  premium: 1.8,
  legendary: 3.0,
};

const QUALITY_BASE_PROB: Record<Quality, number> = {
  damaged: 0.10,
  common: 0.40,
  healthy: 0.30,
  premium: 0.15,
  legendary: 0.05,
};

const VOLATILITY_SENSITIVITY: Record<string, number> = {
  empty: 0.3,
  common: -0.2,
  uncommon: -0.3,
  rare: -0.1,
  legendary: 0.25,
  mythic: 0.35,
  treasure: -0.1,
  jackpot: 0.4,
  predator: 0.2,
};

// ── Secure RNG ────────────────────────────────────────────────────────

function secureRandom(): number {
  const buffer = crypto.randomBytes(4);
  return buffer.readUInt32BE(0) / 0xFFFFFFFF;
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(secureRandom() * arr.length)];
}

// ── Pity timer ────────────────────────────────────────────────────────
// Same category of mechanic as Jungle Hunt's "dry streak breaker": after a
// run of bad luck, empty-net and predator odds ease off a little to keep a
// losing streak from feeling like a wall. Capped modestly (max -10%) and
// clamped by the RTP ceiling below like everything else — it can soften a
// streak, it can't blow past the bank's guardrails.
function getPityFactor(consecutiveLosses: number): number {
  const maxReduction = 0.10;
  const rate = 0.12;
  const fraction = 1 - Math.exp(-consecutiveLosses * rate);
  return 1 - maxReduction * fraction;
}

// ── Scene setters ─────────────────────────────────────────────────────

function getSceneIntro(): string {
  const intros = [
    "The morning mist lifts over the water as",
    "Under a blazing afternoon sun,",
    "As dusk paints the sky orange,",
    "In the dead of night, under a crescent moon,",
    "A gentle breeze carries the scent of salt as",
    "The wind howls across the deck while",
    "Your crew works in silence as",
    "A rainbow arcs over the horizon as",
    "The waves crash against the hull as",
    "The ocean whispers secrets to you as",
  ];
  return pickRandom(intros);
}

// ── Narration templates ──────────────────────────────────────────────

const NARRATIONS = {
  empty: [
    "{intro} your net comes up empty. The fish are elusive today.",
    "{intro} nothing but water. Better luck next time.",
    "{intro} the ocean is quiet. No fish around.",
    "{intro} you cast your line, but the sea gives nothing.",
    "{intro} a ghost net drifts by – but it's empty, too.",
  ],
  fish: {
    common: [
      "{intro} you reel in a {quality} {species}. A modest start.",
      "{intro} a {quality} {species} wriggles in your net.",
      "{intro} tiny but tasty! A {quality} {species}.",
      "{intro} the {quality} {species} is small, but it's a catch.",
      "{intro} your line tugs – a {quality} {species} bites.",
    ],
    uncommon: [
      "{intro} a decent {quality} {species}! Your net feels heavier.",
      "{intro} you land a nice {quality} {species}.",
      "{intro} not bad at all – a {quality} {species}.",
      "{intro} the {quality} {species} puts up a fight, but you win.",
      "{intro} a flash of silver – it's a {quality} {species}!",
    ],
    rare: [
      "{intro} a beautiful {quality} {species}! You're getting good at this.",
      "{intro} the {quality} {species} is a prize catch!",
      "{intro} lucky day – you landed a {quality} {species}!",
      "{intro} your skill is paying off – a {quality} {species} in your hold.",
      "{intro} the crew cheers as a {quality} {species} breaks the surface.",
    ],
    legendary: [
      "{intro} a legendary {quality} {species}! The crew cheers!",
      "{intro} you've done it – a {quality} {species} of legend!",
      "{intro} the {quality} {species} is magnificent! A story to tell.",
      "{intro} rare and mighty – you caught a {quality} {species}!",
      "{intro} the sea parts, revealing a {quality} {species} of myth.",
    ],
    mythic: [
      "{intro} a MYTHIC {quality} {species}! The ocean trembles!",
      "{intro} unbelievable – a {quality} {species} of myth!",
      "{intro} the {quality} {species} is a true monster!",
      "{intro} legends speak of the {quality} {species}, and you've caught it!",
      "{intro} the water erupts – a {quality} {species} of unimaginable size!",
    ],
  },
  special: [
    "{intro} a {species} appears! This is a special catch!",
    "{intro} the ocean reveals a rare {species}!",
    "{intro} your instincts pay off – a {species}!",
    "{intro} a shimmer of gold – it's a {species}!",
  ],
  treasure: [
    "{intro} you spot a sunken chest! {coins} coins inside!",
    "{intro} your net snags on something heavy – a treasure chest! {coins} coins!",
    "{intro} you dive and find a chest with {coins} coins!",
    "{intro} treasure glints in the sand – {coins} coins!",
    "{intro} a wave washes a chest onto your deck – {coins} coins!",
  ],
  jackpot: [
    "{intro} you've hit the JACKPOT! A colossal beast and {coins} coins!",
    "{intro} the sea erupts – you've struck gold! {coins} coins!",
    "{intro} a once‑in‑a‑lifetime catch! {coins} coins reward your bravery.",
    "{intro} your crew goes wild – {coins} coins from the deep!",
    "{intro} the ocean rewards your persistence with {coins} coins!",
  ],
  predator: {
    attack: [
      "{intro} a shark attacks! You lose {coins} coins.",
      "{intro} a massive predator strikes! -{coins} coins.",
      "{intro} you escape a sea monster, but lose {coins} coins.",
      "{intro} jaws clamp down – you lose {coins} coins.",
      "{intro} a shadow beneath – you're robbed of {coins} coins.",
    ],
    boatDamage: [
      "{intro} a rogue wave damages your {boat}! Repair costs {coins} coins.",
      "{intro} your {boat} takes a hit – {coins} coins gone.",
      "{intro} rough seas cause damage to your {boat}: -{coins} coins.",
      "{intro} your {boat} collides with debris – {coins} coins to fix.",
      "{intro} the storm batters your {boat}, costing {coins} coins.",
    ],
    netDamage: [
      "{intro} your {net} snags on a rock and tears! -{coins} coins.",
      "{intro} a sharp reef ruins your {net}. Loss: {coins} coins.",
      "{intro} the {net} is shredded. You lose {coins} coins.",
      "{intro} your {net} catches a hidden wreck – {coins} coins to repair.",
      "{intro} the {net} fails under pressure – {coins} coins lost.",
    ],
  },
};

function buildNarration(
  templates: string[],
  species?: FishSpecies,
  quality?: Quality,
  coins?: number,
  eventName?: string,
  equipment?: any
): string {
  const template = pickRandom(templates);
  const intro = getSceneIntro();
  let result = template
    .replace(/\{intro\}/g, intro)
    .replace(/\{species\}/g, species?.name || 'fish')
    .replace(/\{quality\}/g, quality ? quality.charAt(0).toUpperCase() + quality.slice(1) : '')
    .replace(/\{coins\}/g, coins !== undefined ? formatNumber(coins) : '')
    .replace(/\{boat\}/g, equipment?.boat ? EQUIPMENT_DEFS[equipment.boat].displayName : 'boat')
    .replace(/\{net\}/g, equipment?.net ? EQUIPMENT_DEFS[equipment.net].displayName : 'net')
    .replace(/\{bait\}/g, equipment?.bait ? EQUIPMENT_DEFS[equipment.bait].displayName : 'bait');
  if (eventName) {
    result = `[${eventName}] ${result}`;
  }
  return result;
}

// ── Main resolver ─────────────────────────────────────────────────────

export async function resolveExpedition(
  userId: string,
  bet: number,
  strategy: Strategy,
  pool: number,
  consecutiveLosses: number,
  spinsPlayed: number
): Promise<ExpeditionOutcome> {
  // 1. Ocean state & volatility — this IS Ocean Hunt's "mood" layer.
  const { name } = await getCurrentOceanState();
  const modifiers = getModifiersForState(name);
  const volFactor = await getVolatilityFactor();

  // 2. Base probabilities
  let { fishWeights, emptyChance, treasureChance, predatorChance, jackpotChance } = modifiers;

  // 3. Equipment
  const equip = await getEquipment(userId);
  const boatDef = EQUIPMENT_DEFS[equip.boat];
  const netDef = EQUIPMENT_DEFS[equip.net];
  const baitDef = EQUIPMENT_DEFS[equip.bait];

  emptyChance *= (boatDef.modifiers.emptyMod || 1.0);
  predatorChance *= (boatDef.modifiers.predatorMod || 1.0);

  const rarityShift = netDef.modifiers.rarityShift || 0;
  if (rarityShift > 0) {
    const common = fishWeights.common;
    const shift = common * rarityShift;
    fishWeights.common -= shift;
    const others = ['uncommon', 'rare', 'legendary', 'mythic'] as const;
    const totalOthers = others.reduce((s, r) => s + fishWeights[r], 0);
    if (totalOthers > 0) {
      for (const r of others) {
        fishWeights[r] += shift * (fishWeights[r] / totalOthers);
      }
    } else {
      fishWeights.uncommon += shift;
    }
  }

  treasureChance *= (baitDef.modifiers.treasureMod || 1.0);
  jackpotChance *= (baitDef.modifiers.jackpotMod || 1.0);
  const baitQualityBoost = baitDef.modifiers.qualityBoost || 0;

  // 4. Strategy adjustments — this is the player's "strategic thinking" lever:
  // shallow trades upside for safety, deep chases bigger fish at real risk.
  let adjEmpty = emptyChance;
  let adjTreasure = treasureChance;
  let adjPredator = predatorChance;
  let adjJackpot = jackpotChance;
  let fishWeightCopy = { ...fishWeights };

  switch (strategy) {
    case 'shallow':
      adjEmpty += 0.05;
      adjTreasure -= 0.04;
      adjPredator -= 0.06;
      adjJackpot -= 0.01;
      fishWeightCopy.common += 0.10;
      fishWeightCopy.uncommon += 0.05;
      fishWeightCopy.rare -= 0.08;
      fishWeightCopy.legendary -= 0.05;
      fishWeightCopy.mythic -= 0.02;
      break;
    case 'deep':
      adjEmpty -= 0.03;
      adjTreasure += 0.08;
      adjPredator += 0.10;
      adjJackpot += 0.02;
      fishWeightCopy.common -= 0.08;
      fishWeightCopy.uncommon -= 0.02;
      fishWeightCopy.rare += 0.05;
      fishWeightCopy.legendary += 0.03;
      fishWeightCopy.mythic += 0.02;
      break;
    case 'reef':
      break;
  }

  adjEmpty = Math.max(0.02, Math.min(0.50, adjEmpty));
  adjTreasure = Math.max(0.02, Math.min(0.40, adjTreasure));
  adjPredator = Math.max(0.01, Math.min(0.50, adjPredator));
  adjJackpot = Math.max(0.001, Math.min(0.08, adjJackpot));
  // Bug fix: clamp fish-rarity weights to zero so a future rebalance can't
  // silently push one negative and corrupt the roll distribution.
  for (const r of ['common', 'uncommon', 'rare', 'legendary', 'mythic'] as const) {
    fishWeightCopy[r] = Math.max(0, fishWeightCopy[r]);
  }

  const totalFishWeight = Object.values(fishWeightCopy).reduce((a, b) => a + b, 0);
  const fishProbs: Record<string, number> = {};
  for (const [key, val] of Object.entries(fishWeightCopy)) {
    fishProbs[key] = val / totalFishWeight;
  }

  // 5. Volatility shift
  const categories = [
    { category: 'empty', prob: adjEmpty },
    { category: 'predator', prob: adjPredator },
    ...Object.entries(fishProbs).map(([rarity, prob]) => ({ category: rarity, prob })),
    { category: 'treasure', prob: adjTreasure },
    { category: 'jackpot', prob: adjJackpot },
  ];

  const shifted = categories.map(c => {
    const sens = VOLATILITY_SENSITIVITY[c.category] || 0;
    const weight = Math.exp(sens * volFactor);
    return { ...c, weight };
  });
  const totalWeight = shifted.reduce((sum, c) => sum + c.prob * c.weight, 0);
  const adjusted = shifted.map(c => ({
    category: c.category,
    prob: c.prob * c.weight / totalWeight,
  }));

  let adjEmptyV = adjusted.find(c => c.category === 'empty')?.prob || 0;
  let adjPredatorV = adjusted.find(c => c.category === 'predator')?.prob || 0;
  let adjTreasureV = adjusted.find(c => c.category === 'treasure')?.prob || 0;
  let adjJackpotV = adjusted.find(c => c.category === 'jackpot')?.prob || 0;
  const adjFishProbs: Record<string, number> = {};
  for (const rarity of ['common', 'uncommon', 'rare', 'legendary', 'mythic']) {
    adjFishProbs[rarity] = adjusted.find(c => c.category === rarity)?.prob || 0;
  }

  // 6. Fish availability (with events — migrations etc. change WHAT can bite)
  const fishAvail = await getFishAvailabilityWithEvents();

  // 7. Special fish probability
  const SPECIAL_CHANCE = 0.20;
  let specialProb = 0;
  if (fishAvail.specials.length > 0) {
    const totalFishProb = Object.values(adjFishProbs).reduce((a, b) => a + b, 0);
    specialProb = totalFishProb * SPECIAL_CHANCE;
    for (const rarity of ['common', 'uncommon', 'rare', 'legendary', 'mythic']) {
      adjFishProbs[rarity] *= (1 - SPECIAL_CHANCE);
    }
  }

  // 8. Event modifiers (fish migrations, storms, etc. — the "moods" you built)
  const eventMods = await getEventModifiers();
  adjEmptyV *= eventMods.emptyMod;
  adjPredatorV *= eventMods.predatorMod;
  adjTreasureV *= eventMods.treasureMod;
  adjJackpotV *= eventMods.jackpotMod;
  if (eventMods.rarityShift !== 0) {
    const shift = eventMods.rarityShift;
    const common = adjFishProbs.common;
    const moved = common * shift;
    adjFishProbs.common -= moved;
    const others = ['uncommon', 'rare', 'legendary', 'mythic'] as const;
    const totalOthers = others.reduce((s, r) => s + adjFishProbs[r], 0);
    if (totalOthers > 0) {
      for (const r of others) {
        adjFishProbs[r] += moved * (adjFishProbs[r] / totalOthers);
      }
    } else {
      adjFishProbs.uncommon += moved;
    }
  }
  const eventQualityBoost = eventMods.qualityBoost || 0;

  // 9. Pity timer (see getPityFactor doc-comment above)
  const pityFactor = getPityFactor(consecutiveLosses);
  adjEmptyV *= pityFactor;
  adjPredatorV *= pityFactor;

  // 10. Stake risk-scaling — same directional logic as Jungle Hunt: bigger
  // bets pull disproportionately from the bank on a jackpot hit, so the
  // odds of the very top tier ease off slightly as stake grows. Reclaimed
  // mass goes to treasure, which stays a satisfying mid-size win instead.
  const stakeRisk = (Math.max(MIN_BET, Math.min(MAX_BET, bet)) - MIN_BET) / (MAX_BET - MIN_BET);
  const jackpotDamp = 1 - 0.25 * stakeRisk;
  const reclaimedFromJackpot = adjJackpotV * (1 - jackpotDamp);
  adjJackpotV *= jackpotDamp;
  adjTreasureV += reclaimedFromJackpot;

  // Re-normalize all category probabilities together
  const allProbs: Record<string, number> = {
    empty: adjEmptyV,
    predator: adjPredatorV,
    ...adjFishProbs,
    treasure: adjTreasureV,
    jackpot: adjJackpotV,
  };
  {
    const totalProb = Object.values(allProbs).reduce((s, p) => s + p, 0);
    for (const key of Object.keys(allProbs)) allProbs[key] /= totalProb;
  }
  adjEmptyV = allProbs.empty;
  adjPredatorV = allProbs.predator;
  adjFishProbs.common = allProbs.common;
  adjFishProbs.uncommon = allProbs.uncommon;
  adjFishProbs.rare = allProbs.rare;
  adjFishProbs.legendary = allProbs.legendary;
  adjFishProbs.mythic = allProbs.mythic;
  adjTreasureV = allProbs.treasure;
  adjJackpotV = allProbs.jackpot;

  // 11. Quality probabilities (bait + event)
  const totalQualityBoost = baitQualityBoost + eventQualityBoost;
  let qDamaged = QUALITY_BASE_PROB.damaged - totalQualityBoost * 0.5;
  let qCommon = QUALITY_BASE_PROB.common - totalQualityBoost * 0.5;
  let qHealthy = QUALITY_BASE_PROB.healthy;
  let qPremium = QUALITY_BASE_PROB.premium + totalQualityBoost * 0.5;
  let qLegendary = QUALITY_BASE_PROB.legendary + totalQualityBoost * 0.5;
  qDamaged = Math.max(0, qDamaged);
  qCommon = Math.max(0, qCommon);
  qHealthy = Math.max(0, qHealthy);
  qPremium = Math.max(0, qPremium);
  qLegendary = Math.max(0, qLegendary);
  const sumQ = qDamaged + qCommon + qHealthy + qPremium + qLegendary;
  const qualityProbs = {
    damaged: qDamaged / sumQ,
    common: qCommon / sumQ,
    healthy: qHealthy / sumQ,
    premium: qPremium / sumQ,
    legendary: qLegendary / sumQ,
  } as const;

  const expectedQualityMult =
    qualityProbs.damaged * QUALITY_MULTIPLIERS.damaged +
    qualityProbs.common * QUALITY_MULTIPLIERS.common +
    qualityProbs.healthy * QUALITY_MULTIPLIERS.healthy +
    qualityProbs.premium * QUALITY_MULTIPLIERS.premium +
    qualityProbs.legendary * QUALITY_MULTIPLIERS.legendary;

  // 12. Economy pressure (solvency + tide) applied to winning categories,
  // same convention as Jungle Hunt: <1 loosens, >1 tightens.
  const pressure = await getEconomyPressure(pool);
  for (const rarity of ['common', 'uncommon', 'rare', 'legendary', 'mythic'] as const) {
    adjFishProbs[rarity] /= pressure;
  }
  if (specialProb > 0) specialProb /= pressure;
  adjTreasureV /= pressure;
  adjJackpotV /= pressure;
  adjEmptyV *= (1 + 0.08 * (pressure - 1));

  // 13. Hard RTP ceiling — the actual enforced guardrail. Whatever strategy,
  // state, equipment, events, and pity timer stacked up to, the expedition's
  // expected payout can never cross this. Winning-category weights are
  // scaled down proportionally and the reclaimed mass goes back to 'empty' —
  // never a single category singled out, matching Jungle Hunt's approach.
  const avgSpecialMult = fishAvail.specials.length > 0
    ? fishAvail.specials.reduce((sum, s) => sum + (s.multiplier || FISH_MULTIPLIERS.legendary), 0) / fishAvail.specials.length
    : 0;

  let grossWinEV = 0;
  for (const rarity of ['common', 'uncommon', 'rare', 'legendary', 'mythic'] as const) {
    grossWinEV += adjFishProbs[rarity] * FISH_MULTIPLIERS[rarity] * expectedQualityMult;
  }
  if (specialProb > 0) grossWinEV += specialProb * avgSpecialMult * expectedQualityMult;
  grossWinEV += adjTreasureV * TREASURE_AVG;
  grossWinEV += adjJackpotV * JACKPOT_AVG_MULT;

  const predatorLossEV = adjPredatorV * PREDATOR_LOSS_FRACTION;
  const netExpectedRTP = grossWinEV - predatorLossEV;

  const rtpCeiling = getSolvencyState(pool).level === 'critical' ? EMERGENCY_CEILING_RTP : HARD_CEILING_RTP;

  if (netExpectedRTP > rtpCeiling && grossWinEV > 0) {
    const scaleDown = Math.max(0, (rtpCeiling + predatorLossEV) / grossWinEV);
    let reclaimed = 0;
    for (const rarity of ['common', 'uncommon', 'rare', 'legendary', 'mythic'] as const) {
      const before = adjFishProbs[rarity];
      adjFishProbs[rarity] = before * scaleDown;
      reclaimed += before - adjFishProbs[rarity];
    }
    if (specialProb > 0) {
      const before = specialProb;
      specialProb *= scaleDown;
      reclaimed += before - specialProb;
    }
    const beforeT = adjTreasureV;
    adjTreasureV *= scaleDown;
    reclaimed += beforeT - adjTreasureV;
    const beforeJ = adjJackpotV;
    adjJackpotV *= scaleDown;
    reclaimed += beforeJ - adjJackpotV;
    adjEmptyV += reclaimed;
  }

  // 14. Build roll categories
  const rollCategories: Array<{ category: string; prob: number }> = [
    { category: 'empty', prob: adjEmptyV },
    { category: 'predator', prob: adjPredatorV },
    { category: 'treasure', prob: adjTreasureV },
    { category: 'jackpot', prob: adjJackpotV },
  ];
  if (specialProb > 0) {
    rollCategories.push({ category: 'special', prob: specialProb });
  }
  for (const rarity of ['common', 'uncommon', 'rare', 'legendary', 'mythic']) {
    rollCategories.push({ category: rarity, prob: adjFishProbs[rarity] });
  }

  const totalCatProb = rollCategories.reduce((s, c) => s + c.prob, 0);
  for (const c of rollCategories) c.prob /= totalCatProb;

  // 15. Roll outcome
  const roll = secureRandom();
  let cum = 0;
  let selected = 'empty';
  for (const c of rollCategories) {
    cum += c.prob;
    if (roll <= cum) { selected = c.category; break; }
  }

  const activeEvents = await getActiveEvents();
  const eventNames = activeEvents.map(e => e.name).join(' + ');
  const eventName = eventNames || undefined;

  // 16. Handle outcomes
  if (selected === 'predator') {
    const subTypes = ['attack', 'boatDamage', 'netDamage'] as const;
    const subType = subTypes[Math.floor(secureRandom() * subTypes.length)];
    const loss = Math.min(bet, Math.round(bet * PREDATOR_LOSS_FRACTION));
    const templateList = NARRATIONS.predator[subType];
    const narration = buildNarration(templateList, undefined, undefined, loss, eventName, equip);
    const label = subType === 'attack' ? 'Predator Attack' : subType === 'boatDamage' ? 'Boat Damage' : 'Net Damage';
    const emoji = subType === 'attack' ? '🦈' : subType === 'boatDamage' ? '🚢' : '🧵';
    return {
      type: 'predator',
      outcomeLabel: label,
      emoji,
      narration,
      winAmount: -loss,
      predatorExtraLoss: loss,
      capped: false,
      predatorSubType: subType,
      winTier: 'none',
    };
  }

  if (selected === 'empty') {
    const narration = buildNarration(NARRATIONS.empty, undefined, undefined, undefined, eventName, equip);
    return {
      type: 'empty',
      outcomeLabel: 'Empty Net',
      emoji: '🌊',
      narration,
      winAmount: 0,
      capped: false,
      winTier: 'none',
    };
  }

  if (selected === 'treasure') {
    const mult = TREASURE_MIN + secureRandom() * (TREASURE_MAX - TREASURE_MIN);
    const rawWin = Math.round(bet * mult);
    const { payout, capped } = settleWin(rawWin, pool);
    const narration = buildNarration(NARRATIONS.treasure, undefined, undefined, payout, eventName, equip);
    return {
      type: 'treasure',
      outcomeLabel: 'Treasure Chest',
      emoji: '💎',
      narration,
      winAmount: payout,
      multiplier: payout / bet,
      capped,
      winTier: 'bigCatch',
      bannerText: '💰 TREASURE HAUL!',
    };
  }

  if (selected === 'jackpot') {
    const rawMult = JACKPOT_MIN_MULT + secureRandom() * (JACKPOT_MAX_MULT - JACKPOT_MIN_MULT);
    const rawWin = Math.round(bet * rawMult);
    const { payout, capped } = settleWin(rawWin, pool);
    const narration = buildNarration(NARRATIONS.jackpot, undefined, undefined, payout, eventName, equip);
    return {
      type: 'jackpot',
      outcomeLabel: 'Leviathan Jackpot',
      emoji: '🐋',
      narration,
      winAmount: payout,
      multiplier: payout / bet,
      capped,
      winTier: 'superMegaCatch',
      bannerText: '🌊 LEVIATHAN JACKPOT!',
    };
  }

  // Fish (normal or special)
  let species: FishSpecies;
  let rarity: 'common' | 'uncommon' | 'rare' | 'legendary' | 'mythic';
  let isSpecial = false;

  if (selected === 'special') {
    isSpecial = true;
    species = fishAvail.specials[Math.floor(secureRandom() * fishAvail.specials.length)];
    rarity = species.rarity as any;
  } else {
    rarity = selected as 'common' | 'uncommon' | 'rare' | 'legendary' | 'mythic';
    const list = fishAvail[rarity];
    if (list.length === 0) {
      const fallbackNarration = buildNarration(['No fish of that rarity around.'], undefined, undefined, undefined, eventName, equip);
      return {
        type: 'empty',
        outcomeLabel: 'Empty Net',
        emoji: '🌊',
        narration: fallbackNarration,
        winAmount: 0,
        capped: false,
        winTier: 'none',
      };
    }
    species = list[Math.floor(secureRandom() * list.length)];
  }

  // Roll quality
  const qualityRoll = secureRandom();
  let quality: Quality = 'common';
  let qcum = 0;
  for (const q of ['damaged', 'common', 'healthy', 'premium', 'legendary'] as Quality[]) {
    qcum += qualityProbs[q];
    if (qualityRoll <= qcum) { quality = q; break; }
  }
  const qualityMult = QUALITY_MULTIPLIERS[quality];
  const baseMult = species.multiplier || FISH_MULTIPLIERS[rarity] || FISH_MULTIPLIERS.common;
  const finalMult = baseMult * qualityMult;
  const rawWin = Math.round(bet * finalMult);
  const { payout, capped } = settleWin(rawWin, pool);

  const templateList = isSpecial ? NARRATIONS.special : (NARRATIONS.fish[rarity] || NARRATIONS.fish.common);
  const narration = buildNarration(templateList, species, quality, payout, eventName, equip);

  const qualityLabel = quality.charAt(0).toUpperCase() + quality.slice(1);
  const rarityLabel = isSpecial ? 'Special' : rarity.charAt(0).toUpperCase() + rarity.slice(1);
  // Avoid "Legendary Legendary" when a legendary-quality roll lands on a
  // legendary-rarity fish — only show the quality prefix when it differs.
  const outcomeLabel = isSpecial
    ? `Special ${species.name}`
    : qualityLabel.toLowerCase() === rarityLabel.toLowerCase()
      ? rarityLabel
      : `${qualityLabel} ${rarityLabel}`;

  const winTier: WinTier = isSpecial ? 'megaCatch' : WIN_TIER_BY_RARITY[rarity];

  return {
    type: 'fish',
    outcomeLabel,
    emoji: species.emoji,
    narration,
    winAmount: payout,
    fishRarity: rarity,
    quality,
    qualityMultiplier: qualityMult,
    multiplier: payout / bet,
    capped,
    fishSpecies: species,
    winTier,
    bannerText: BANNER_TEXT[winTier],
  };
}

// ── State modifiers ──────────────────────────────────────────────────
// This is the "mood" layer you were after — each ocean state shifts what
// you're likely to catch and how risky it is, same spirit as Jungle Hunt's
// hot/cold house mood, but grounded in your own ecosystem simulation
// instead of a bolted-on random roll. RTP itself is no longer scaled here
// (see step 12/13 above) — states only shape the SHAPE of the odds, not
// the house edge, so a "dangerous" state feels different without secretly
// being a worse bet than a "calm" one.

type OceanStateName =
  | 'calm' | 'rich' | 'storm' | 'deep_current' | 'migration' | 'treasure_tide' | 'dangerous' | 'breeding';

interface StateModifiers {
  fishWeights: { common: number; uncommon: number; rare: number; legendary: number; mythic: number };
  emptyChance: number;
  treasureChance: number;
  predatorChance: number;
  jackpotChance: number;
}

function getModifiersForState(name: OceanStateName): StateModifiers {
  const table: Record<OceanStateName, StateModifiers> = {
    calm: {
      fishWeights: { common: 0.40, uncommon: 0.30, rare: 0.15, legendary: 0.10, mythic: 0.05 },
      emptyChance: 0.20, treasureChance: 0.10, predatorChance: 0.10, jackpotChance: 0.02,
    },
    rich: {
      fishWeights: { common: 0.30, uncommon: 0.30, rare: 0.20, legendary: 0.15, mythic: 0.05 },
      emptyChance: 0.10, treasureChance: 0.10, predatorChance: 0.05, jackpotChance: 0.03,
    },
    storm: {
      fishWeights: { common: 0.35, uncommon: 0.25, rare: 0.15, legendary: 0.15, mythic: 0.10 },
      emptyChance: 0.25, treasureChance: 0.20, predatorChance: 0.25, jackpotChance: 0.02,
    },
    deep_current: {
      fishWeights: { common: 0.25, uncommon: 0.25, rare: 0.20, legendary: 0.20, mythic: 0.10 },
      emptyChance: 0.15, treasureChance: 0.25, predatorChance: 0.20, jackpotChance: 0.03,
    },
    migration: {
      fishWeights: { common: 0.30, uncommon: 0.25, rare: 0.20, legendary: 0.18, mythic: 0.07 },
      emptyChance: 0.12, treasureChance: 0.15, predatorChance: 0.08, jackpotChance: 0.03,
    },
    treasure_tide: {
      fishWeights: { common: 0.35, uncommon: 0.25, rare: 0.15, legendary: 0.15, mythic: 0.10 },
      emptyChance: 0.18, treasureChance: 0.35, predatorChance: 0.10, jackpotChance: 0.02,
    },
    dangerous: {
      fishWeights: { common: 0.20, uncommon: 0.20, rare: 0.25, legendary: 0.25, mythic: 0.10 },
      emptyChance: 0.15, treasureChance: 0.10, predatorChance: 0.40, jackpotChance: 0.04,
    },
    breeding: {
      fishWeights: { common: 0.40, uncommon: 0.30, rare: 0.15, legendary: 0.10, mythic: 0.05 },
      emptyChance: 0.08, treasureChance: 0.08, predatorChance: 0.05, jackpotChance: 0.01,
    },
  };

  // Return a deep-enough copy so callers can safely mutate fishWeights.
  const base = table[name];
  return {
    fishWeights: { ...base.fishWeights },
    emptyChance: base.emptyChance,
    treasureChance: base.treasureChance,
    predatorChance: base.predatorChance,
    jackpotChance: base.jackpotChance,
  };
}