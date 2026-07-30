// @ts-nocheck
/***
 * lib/oceanSlotMachine.ts
 * Ocean Hunt – Expedition Engine
 * Integrates: Ocean states, volatility, dynamic fish, equipment, quality,
 * adaptive variance, world events, rich narration, secure RNG.
 */

import crypto from 'crypto';
import { createStore } from './pluginStore.js';
import {
  getCurrentOceanState,
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
export const TARGET_RTP = 0.92;
export const HARD_CEILING_RTP = 0.94;
export const EMERGENCY_CEILING_RTP = 0.90;

// ── Pool functions ────────────────────────────────────────────────────

export async function getJackpotPool(): Promise<number> {
  const val = await jackpotTbl.get('pool');
  return typeof val === 'number' ? val : JACKPOT_SEED;
}

export async function contributeToJackpot(bet: number): Promise<number> {
  const pool = await getJackpotPool();
  const newPool = pool + bet;
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
}

// ── Constants ─────────────────────────────────────────────────────────

const FISH_MULTIPLIERS = {
  common: 1.5,
  uncommon: 2.5,
  rare: 4,
  legendary: 7,
  mythic: 12,
};

const TREASURE_MIN = 2;
const TREASURE_MAX = 5;
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

// ── Adaptive variance ────────────────────────────────────────────────

function getAdaptiveFactor(consecutiveLosses: number): number {
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
  // 1. Ocean state & volatility
  const { name } = await getCurrentOceanState();
  const modifiers = getModifiersForState(name);
  const volFactor = await getVolatilityFactor();

  // 2. Base probabilities
  let { fishWeights, emptyChance, treasureChance, predatorChance, jackpotChance, rtpScale } = modifiers;

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

  // 4. Strategy adjustments
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
  for (const rarity of ['common','uncommon','rare','legendary','mythic']) {
    adjFishProbs[rarity] = adjusted.find(c => c.category === rarity)?.prob || 0;
  }

  // 6. Fish availability (with events)
  const fishAvail = await getFishAvailabilityWithEvents();

  // 7. Special fish probability
  const SPECIAL_CHANCE = 0.20;
  let specialProb = 0;
  if (fishAvail.specials.length > 0) {
    const totalFishProb = Object.values(adjFishProbs).reduce((a,b) => a+b, 0);
    specialProb = totalFishProb * SPECIAL_CHANCE;
    for (const rarity of ['common','uncommon','rare','legendary','mythic']) {
      adjFishProbs[rarity] *= (1 - SPECIAL_CHANCE);
    }
  }

  // 8. Event modifiers
  const eventMods = await getEventModifiers();
  adjEmptyV *= eventMods.emptyMod;
  adjPredatorV *= eventMods.predatorMod;
  adjTreasureV *= eventMods.treasureMod;
  adjJackpotV *= eventMods.jackpotMod;
  // Event rarity shift
  if (eventMods.rarityShift !== 0) {
    const shift = eventMods.rarityShift;
    const common = adjFishProbs.common;
    const moved = common * shift;
    adjFishProbs.common -= moved;
    const others = ['uncommon','rare','legendary','mythic'] as const;
    const totalOthers = others.reduce((s, r) => s + adjFishProbs[r], 0);
    if (totalOthers > 0) {
      for (const r of others) {
        adjFishProbs[r] += moved * (adjFishProbs[r] / totalOthers);
      }
    } else {
      adjFishProbs.uncommon += moved;
    }
  }
  // Event quality boost
  const eventQualityBoost = eventMods.qualityBoost || 0;

  // 9. Adaptive variance (hidden)
  const adaptiveFactor = getAdaptiveFactor(consecutiveLosses);
  adjEmptyV *= adaptiveFactor;
  adjPredatorV *= adaptiveFactor;

  // Re-normalize all probabilities
  const allProbs = {
    empty: adjEmptyV,
    predator: adjPredatorV,
    ...adjFishProbs,
    treasure: adjTreasureV,
    jackpot: adjJackpotV,
  };
  const totalProb = Object.values(allProbs).reduce((s, p) => s + p, 0);
  for (const key of Object.keys(allProbs)) {
    allProbs[key] /= totalProb;
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

  // 10. Quality probabilities (bait + event)
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

  // 11. EV scaling
  const fishMult = FISH_MULTIPLIERS;
  const treasureAvg = (TREASURE_MIN + TREASURE_MAX) / 2;
  const jackpotAvg = 12.5;
  const predatorLossMult = PREDATOR_LOSS_FRACTION;

  let origPositiveEV = 0;
  for (const [rarity, prob] of Object.entries(adjFishProbs)) {
    const baseMult = fishMult[rarity as keyof typeof fishMult];
    origPositiveEV += prob * baseMult * expectedQualityMult;
  }
  if (specialProb > 0 && fishAvail.specials.length > 0) {
    const avgSpecialMult = fishAvail.specials.reduce((sum, s) => {
      const m = s.multiplier || (s.rarity === 'legendary' ? 7 : 12);
      return sum + m;
    }, 0) / fishAvail.specials.length;
    origPositiveEV += specialProb * avgSpecialMult * expectedQualityMult;
  }
  origPositiveEV += adjTreasureV * treasureAvg;
  origPositiveEV += adjJackpotV * jackpotAvg;

  const origPredatorLoss = adjPredatorV * predatorLossMult;

  let evScale = (TARGET_RTP + origPredatorLoss) / (origPositiveEV || 0.01);
  evScale = Math.max(0.6, Math.min(1.4, evScale));
  const totalScale = rtpScale * evScale;

  // 12. Build roll categories
  const rollCategories: Array<{ category: string; prob: number }> = [
    { category: 'empty', prob: adjEmptyV },
    { category: 'predator', prob: adjPredatorV },
    { category: 'treasure', prob: adjTreasureV },
    { category: 'jackpot', prob: adjJackpotV },
  ];
  if (specialProb > 0) {
    rollCategories.push({ category: 'special', prob: specialProb });
  }
  for (const rarity of ['common','uncommon','rare','legendary','mythic']) {
    rollCategories.push({ category: rarity, prob: adjFishProbs[rarity] });
  }

  const totalCatProb = rollCategories.reduce((s, c) => s + c.prob, 0);
  for (const c of rollCategories) c.prob /= totalCatProb;

  // 13. Roll outcome
  const roll = secureRandom();
  let cum = 0;
  let selected = 'empty';
  for (const c of rollCategories) {
    cum += c.prob;
    if (roll <= cum) { selected = c.category; break; }
  }

  // Get active events for narration
  const activeEvents = await getActiveEvents();
  const eventNames = activeEvents.map(e => e.name).join(' + ');
  const eventName = eventNames || undefined;

  // 14. Handle outcomes
  if (selected === 'predator') {
    const subTypes = ['attack', 'boatDamage', 'netDamage'] as const;
    const subType = subTypes[Math.floor(secureRandom() * subTypes.length)];
    const loss = Math.min(bet, Math.round(bet * PREDATOR_LOSS_FRACTION));
    const templateList = NARRATIONS.predator[subType];
    const narration = buildNarration(
      templateList,
      undefined, undefined, loss, eventName, equip
    );
    const label = subType === 'attack' ? 'Predator Attack' : subType === 'boatDamage' ? 'Boat Damage' : 'Net Damage';
    const emoji = subType === 'attack' ? '🦈' : subType === 'boatDamage' ? '🚢' : '🧵';
    return {
      type: 'predator',
      outcomeLabel: label,
      emoji,
      narration,
      winAmount: -loss,
      capped: false,
      predatorSubType: subType,
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
    };
  }

  if (selected === 'treasure') {
    const mult = TREASURE_MIN + secureRandom() * (TREASURE_MAX - TREASURE_MIN);
    const rawWin = Math.round(bet * mult * totalScale);
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
    };
  }

  if (selected === 'jackpot') {
    const rawMult = 10 + Math.floor(secureRandom() * 6);
    const rawWin = Math.round(bet * rawMult * totalScale);
    const { payout, capped } = settleWin(rawWin, pool);
    const narration = buildNarration(NARRATIONS.jackpot, undefined, undefined, payout, eventName, equip);
    return {
      type: 'jackpot',
      outcomeLabel: 'Jackpot!',
      emoji: '🐋',
      narration,
      winAmount: payout,
      multiplier: payout / bet,
      capped,
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
      // Fallback
      const fallbackNarration = buildNarration(['No fish of that rarity around.'], undefined, undefined, undefined, eventName, equip);
      return {
        type: 'empty',
        outcomeLabel: 'Empty Net',
        emoji: '🌊',
        narration: fallbackNarration,
        winAmount: 0,
        capped: false,
      };
    }
    species = list[Math.floor(secureRandom() * list.length)];
  }

  // Roll quality
  const qualityRoll = secureRandom();
  let quality: Quality = 'common';
  let qcum = 0;
  for (const q of ['damaged','common','healthy','premium','legendary'] as Quality[]) {
    qcum += qualityProbs[q];
    if (qualityRoll <= qcum) { quality = q; break; }
  }
  const qualityMult = QUALITY_MULTIPLIERS[quality];
  const baseMult = species.multiplier || FISH_MULTIPLIERS[rarity] || 1.5;
  const finalMult = baseMult * qualityMult;
  const rawWin = Math.round(bet * finalMult * totalScale);
  const { payout, capped } = settleWin(rawWin, pool);

  // Build narration
  const templateList = isSpecial ? NARRATIONS.special : (NARRATIONS.fish[rarity] || NARRATIONS.fish.common);
  const narration = buildNarration(templateList, species, quality, payout, eventName, equip);

  const qualityLabel = quality.charAt(0).toUpperCase() + quality.slice(1);
  const rarityLabel = isSpecial ? 'Special' : rarity.charAt(0).toUpperCase() + rarity.slice(1);
  const outcomeLabel = isSpecial ? `Special ${species.name}` : `${qualityLabel} ${rarityLabel}`;

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
  };
}

// ── State modifiers ──────────────────────────────────────────────────

type OceanStateName =
  | 'calm' | 'rich' | 'storm' | 'deep_current' | 'migration' | 'treasure_tide' | 'dangerous' | 'breeding';

interface StateModifiers {
  fishWeights: { common: number; uncommon: number; rare: number; legendary: number; mythic: number };
  emptyChance: number;
  treasureChance: number;
  predatorChance: number;
  jackpotChance: number;
  rtpScale: number;
}

function getModifiersForState(name: OceanStateName): StateModifiers {
  const base: Omit<StateModifiers, 'rtpScale'> = {
    calm: {
      fishWeights: { common: 0.40, uncommon: 0.30, rare: 0.15, legendary: 0.10, mythic: 0.05 },
      emptyChance: 0.20,
      treasureChance: 0.10,
      predatorChance: 0.10,
      jackpotChance: 0.02,
    },
    rich: {
      fishWeights: { common: 0.30, uncommon: 0.30, rare: 0.20, legendary: 0.15, mythic: 0.05 },
      emptyChance: 0.10,
      treasureChance: 0.10,
      predatorChance: 0.05,
      jackpotChance: 0.03,
    },
    storm: {
      fishWeights: { common: 0.35, uncommon: 0.25, rare: 0.15, legendary: 0.15, mythic: 0.10 },
      emptyChance: 0.25,
      treasureChance: 0.20,
      predatorChance: 0.25,
      jackpotChance: 0.02,
    },
    deep_current: {
      fishWeights: { common: 0.25, uncommon: 0.25, rare: 0.20, legendary: 0.20, mythic: 0.10 },
      emptyChance: 0.15,
      treasureChance: 0.25,
      predatorChance: 0.20,
      jackpotChance: 0.03,
    },
    migration: {
      fishWeights: { common: 0.30, uncommon: 0.25, rare: 0.20, legendary: 0.18, mythic: 0.07 },
      emptyChance: 0.12,
      treasureChance: 0.15,
      predatorChance: 0.08,
      jackpotChance: 0.03,
    },
    treasure_tide: {
      fishWeights: { common: 0.35, uncommon: 0.25, rare: 0.15, legendary: 0.15, mythic: 0.10 },
      emptyChance: 0.18,
      treasureChance: 0.35,
      predatorChance: 0.10,
      jackpotChance: 0.02,
    },
    dangerous: {
      fishWeights: { common: 0.20, uncommon: 0.20, rare: 0.25, legendary: 0.25, mythic: 0.10 },
      emptyChance: 0.15,
      treasureChance: 0.10,
      predatorChance: 0.40,
      jackpotChance: 0.04,
    },
    breeding: {
      fishWeights: { common: 0.40, uncommon: 0.30, rare: 0.15, legendary: 0.10, mythic: 0.05 },
      emptyChance: 0.08,
      treasureChance: 0.08,
      predatorChance: 0.05,
      jackpotChance: 0.01,
    },
  }[name];

  const rtpScaleMap: Record<OceanStateName, number> = {
    calm: 1.00,
    rich: 0.98,
    storm: 1.02,
    deep_current: 1.01,
    migration: 0.99,
    treasure_tide: 1.03,
    dangerous: 1.04,
    breeding: 0.97,
  };

  return { ...base, rtpScale: rtpScaleMap[name] };
}