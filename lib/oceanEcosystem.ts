// @ts-nocheck
/***
 * lib/oceanEcosystem.ts
 *
 * The Living Ocean – slowly evolving world simulation.
 * Provides ocean states, volatility, fish availability with migration,
 * and world events.
 */

import { createStore } from './pluginStore.js';

const store = createStore('oceanEcosystem');
const stateTbl = store.table('worldState');
const eventStore = createStore('worldEvents');
const activeEventsTbl = eventStore.table('active');
const lastGenTbl = eventStore.table('meta');

// ── Constants ──────────────────────────────────────────────────────────

const TICK_MINUTES = 12;
const MIN_EVENT_INTERVAL_MS = 2 * 60 * 60 * 1000;
const MAX_EVENT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_ACTIVE_EVENTS = 2;

// ── Variable config ───────────────────────────────────────────────────

interface VariableConfig {
  baseline: number;
  volatility: number;
  reversion: number;
}

const VARIABLES: Record<string, VariableConfig> = {
  temperature:    { baseline: 0.50, volatility: 0.05, reversion: 0.08 },
  fishPopulation: { baseline: 0.55, volatility: 0.04, reversion: 0.06 },
  predatorActivity: { baseline: 0.40, volatility: 0.06, reversion: 0.10 },
  current:        { baseline: 0.50, volatility: 0.07, reversion: 0.12 },
  stormIntensity: { baseline: 0.20, volatility: 0.09, reversion: 0.15 },
  treasureDensity:{ baseline: 0.35, volatility: 0.05, reversion: 0.07 },
  coralHealth:    { baseline: 0.60, volatility: 0.02, reversion: 0.03 },
  migrationRoute: { baseline: 0.50, volatility: 0.06, reversion: 0.09 },
  luckyTide:      { baseline: 0.15, volatility: 0.12, reversion: 0.20 },
  oceanVolatility:{ baseline: 0.45, volatility: 0.08, reversion: 0.10 },
};

export type OceanVariables = Record<keyof typeof VARIABLES, number>;

interface OceanState {
  variables: OceanVariables;
  lastTick: number;
}

function freshState(): OceanState {
  const variables = {} as OceanVariables;
  for (const key of Object.keys(VARIABLES)) {
    variables[key as keyof OceanVariables] = VARIABLES[key].baseline;
  }
  return { variables, lastTick: Date.now() };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function gaussianShock(stddev: number): number {
  let sum = 0;
  for (let i = 0; i < 3; i++) sum += Math.random() - 0.5;
  return sum * stddev * 1.63;
}

function advance(variables: OceanVariables, steps: number): OceanVariables {
  const next = { ...variables };
  for (const [key, cfg] of Object.entries(VARIABLES)) {
    let v = next[key as keyof OceanVariables];
    for (let i = 0; i < steps; i++) {
      const pull = (cfg.baseline - v) * cfg.reversion;
      const shock = gaussianShock(cfg.volatility);
      v = clamp01(v + pull + shock);
    }
    next[key as keyof OceanVariables] = v;
  }
  return next;
}

export async function getOceanState(): Promise<OceanState> {
  const raw = (await stateTbl.get('state')) as OceanState | undefined;
  const state = raw && raw.variables ? raw : freshState();

  const elapsedMs = Date.now() - (state.lastTick || 0);
  const tickMs = TICK_MINUTES * 60 * 1000;
  let steps = Math.floor(elapsedMs / tickMs);
  if (steps <= 0) return state;

  steps = Math.min(steps, 20);
  const nextState: OceanState = {
    variables: advance(state.variables, steps),
    lastTick: Date.now(),
  };
  await stateTbl.set('state', nextState);
  return nextState;
}

// ── Ocean State Names ─────────────────────────────────────────────────

export type OceanStateName =
  | 'calm' | 'rich' | 'storm' | 'deep_current' | 'migration' | 'treasure_tide' | 'dangerous' | 'breeding';

export async function getCurrentOceanState(): Promise<{ name: OceanStateName }> {
  const { variables } = await getOceanState();
  const { fishPopulation, predatorActivity, stormIntensity, treasureDensity, migrationRoute, coralHealth } = variables;

  if (stormIntensity > 0.65) return { name: 'storm' };
  if (predatorActivity > 0.70) return { name: 'dangerous' };
  if (treasureDensity > 0.70) return { name: 'treasure_tide' };
  if (fishPopulation > 0.70 && coralHealth > 0.60) return { name: 'breeding' };
  if (migrationRoute > 0.60) return { name: 'migration' };
  if (fishPopulation > 0.60 && predatorActivity < 0.40) return { name: 'rich' };
  if (stormIntensity > 0.40 && treasureDensity > 0.50) return { name: 'deep_current' };
  return { name: 'calm' };
}

export async function getVolatilityFactor(): Promise<number> {
  const { variables } = await getOceanState();
  const v = variables.oceanVolatility ?? 0.45;
  return Math.max(0, Math.min(1, v));
}

export async function getVolatilityLevel(): Promise<'low' | 'medium' | 'high'> {
  const factor = await getVolatilityFactor();
  if (factor < 0.35) return 'low';
  if (factor > 0.65) return 'high';
  return 'medium';
}

export async function getConditionSummary(): Promise<{ mood: string; volatility: string }> {
  const { variables } = await getOceanState();
  const { luckyTide, stormIntensity, fishPopulation, predatorActivity } = variables;
  let mood = '🌊 _Calm waters today._';
  if (luckyTide > 0.55) mood = '🍀 _The tide feels lucky today..._';
  else if (stormIntensity > 0.6) mood = '🌩️ _Rough seas out there today..._';
  else if (fishPopulation > 0.7 && predatorActivity < 0.3) mood = '🐟 _The waters are teeming with life..._';
  else if (predatorActivity < 0.25 && fishPopulation < 0.4) mood = '🌫️ _The ocean feels unusually still..._';
  const vol = await getVolatilityLevel();
  const volText = vol === 'low' ? '🐢 _Steady tides..._' :
                  vol === 'high' ? '🌪️ _Wild currents!_ ' :
                  '⚖️ _Balanced seas._';
  return { mood: `${mood} ${volText}`, volatility: vol };
}

// ── Fish availability ─────────────────────────────────────────────────

export interface FishSpecies {
  name: string;
  emoji: string;
  rarity: 'common' | 'uncommon' | 'rare' | 'legendary' | 'mythic';
  multiplier?: number;
}

export interface AvailableFish {
  common: FishSpecies[];
  uncommon: FishSpecies[];
  rare: FishSpecies[];
  legendary: FishSpecies[];
  mythic: FishSpecies[];
  specials: FishSpecies[];
}

const ALL_FISH: Record<string, FishSpecies> = {
  sardine:  { name: 'Sardine', emoji: '🐟', rarity: 'common' },
  tilapia:  { name: 'Tilapia', emoji: '🐠', rarity: 'common' },
  tuna:     { name: 'Tuna', emoji: '🐟', rarity: 'common' },
  snapper:  { name: 'Snapper', emoji: '🐠', rarity: 'uncommon' },
  mackerel: { name: 'Mackerel', emoji: '🐟', rarity: 'uncommon' },
  barracuda:{ name: 'Barracuda', emoji: '🐡', rarity: 'rare' },
  shark:    { name: 'Shark', emoji: '🦈', rarity: 'rare' },
  marlin:   { name: 'Marlin', emoji: '🐟', rarity: 'legendary' },
  swordfish:{ name: 'Swordfish', emoji: '🐟', rarity: 'legendary' },
  whale:    { name: 'Whale', emoji: '🐋', rarity: 'mythic' },
  octopus:  { name: 'Octopus', emoji: '🐙', rarity: 'common' },
  eel:      { name: 'Eel', emoji: '🐍', rarity: 'uncommon' },
  squid:    { name: 'Squid', emoji: '🦑', rarity: 'common' },
  golden_fish:   { name: 'Golden Fish', emoji: '🐠', rarity: 'legendary', multiplier: 10 },
  kraken:        { name: 'Kraken', emoji: '🐙', rarity: 'mythic', multiplier: 15 },
  ancient_turtle:{ name: 'Ancient Sea Turtle', emoji: '🐢', rarity: 'mythic', multiplier: 14 },
};

export async function getFishAvailability(): Promise<AvailableFish> {
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay();
  const isWeekend = (day === 0 || day === 6);

  let period: 'morning' | 'afternoon' | 'night';
  if (hour >= 6 && hour < 12) period = 'morning';
  else if (hour >= 12 && hour < 18) period = 'afternoon';
  else period = 'night';

  const avail: AvailableFish = {
    common: [],
    uncommon: [],
    rare: [],
    legendary: [],
    mythic: [],
    specials: [],
  };

  if (period === 'morning') {
    avail.common.push(ALL_FISH.sardine, ALL_FISH.tilapia);
    avail.uncommon.push(ALL_FISH.snapper);
    avail.rare.push(ALL_FISH.mackerel);
  } else if (period === 'afternoon') {
    avail.common.push(ALL_FISH.tuna, ALL_FISH.snapper);
    avail.uncommon.push(ALL_FISH.mackerel);
    avail.rare.push(ALL_FISH.barracuda);
    avail.legendary.push(ALL_FISH.marlin);
    if (isWeekend) avail.mythic.push(ALL_FISH.whale);
  } else {
    avail.common.push(ALL_FISH.squid, ALL_FISH.octopus);
    avail.uncommon.push(ALL_FISH.eel);
    avail.rare.push(ALL_FISH.shark);
    avail.legendary.push(ALL_FISH.swordfish);
  }

  if (isWeekend) {
    if (!avail.mythic.some(s => s.name === 'Whale')) {
      avail.mythic.push(ALL_FISH.whale);
    }
    if (!avail.legendary.some(s => s.name === 'Swordfish')) {
      avail.legendary.push(ALL_FISH.swordfish);
    }
  }

  const { variables } = await getOceanState();
  const { luckyTide, stormIntensity, coralHealth } = variables;

  if (luckyTide > 0.7) avail.specials.push(ALL_FISH.golden_fish);
  if (stormIntensity > 0.8) avail.specials.push(ALL_FISH.kraken);
  if (coralHealth > 0.8) avail.specials.push(ALL_FISH.ancient_turtle);

  return avail;
}

// ── World Events ──────────────────────────────────────────────────────

export interface EventTemplate {
  id: string;
  name: string;
  description: string;
  emoji: string;
  durationMs: number;
  weight: number;
  modifiers: {
    emptyMod?: number;
    predatorMod?: number;
    treasureMod?: number;
    jackpotMod?: number;
    rarityShift?: number;
    qualityBoost?: number;
  };
  specialSpecies?: FishSpecies[];
  schedule?: {
    dayOfWeek?: number;
    hourStart?: number;
    hourEnd?: number;
  };
}

const EVENT_TEMPLATES: EventTemplate[] = [
  {
    id: 'storm_warning',
    name: 'Storm Warning',
    description: 'Rough seas make fishing dangerous but treasure washes ashore.',
    emoji: '⛈️',
    durationMs: 2 * 60 * 60 * 1000,
    weight: 8,
    modifiers: { emptyMod: 1.2, predatorMod: 1.3, treasureMod: 1.6, jackpotMod: 1.2, rarityShift: 0.05 },
  },
  {
    id: 'tuna_migration',
    name: 'Tuna Migration',
    description: 'Schools of tuna pass through – excellent fishing!',
    emoji: '🐟',
    durationMs: 3 * 60 * 60 * 1000,
    weight: 10,
    modifiers: { emptyMod: 0.7, rarityShift: 0.10, qualityBoost: 0.10 },
    specialSpecies: [
      { name: 'Bluefin Tuna', emoji: '🐟', rarity: 'rare', multiplier: 4.5 },
      { name: 'Yellowfin Tuna', emoji: '🐟', rarity: 'uncommon', multiplier: 3.0 },
    ],
  },
  {
    id: 'pirate_activity',
    name: 'Pirate Activity',
    description: 'Pirates prowl – high risk, but they drop treasure.',
    emoji: '🏴‍☠️',
    durationMs: 1.5 * 60 * 60 * 1000,
    weight: 6,
    modifiers: { predatorMod: 1.8, treasureMod: 2.0, jackpotMod: 1.5, emptyMod: 1.1 },
  },
  {
    id: 'treasure_tide',
    name: 'Treasure Tide',
    description: 'The tide brings sunken riches!',
    emoji: '💎',
    durationMs: 2.5 * 60 * 60 * 1000,
    weight: 7,
    modifiers: { emptyMod: 0.9, treasureMod: 2.5, jackpotMod: 1.8, qualityBoost: 0.15 },
  },
  {
    id: 'oil_spill',
    name: 'Oil Spill',
    description: 'An oil spill hurts fishing, but cleanup rewards are high.',
    emoji: '🛢️',
    durationMs: 4 * 60 * 60 * 1000,
    weight: 4,
    modifiers: { emptyMod: 1.5, predatorMod: 1.2, treasureMod: 0.5, jackpotMod: 0.5, qualityBoost: -0.1, rarityShift: -0.05 },
    specialSpecies: [
      { name: 'Oil‑Resistant Fish', emoji: '🐠', rarity: 'common', multiplier: 1.0 },
    ],
  },
  {
    id: 'fishing_festival',
    name: 'Government Fishing Festival',
    description: 'The government boosts fishing yields!',
    emoji: '🎣',
    durationMs: 6 * 60 * 60 * 1000,
    weight: 12,
    schedule: { dayOfWeek: 6, hourStart: 8, hourEnd: 20 },
    modifiers: { emptyMod: 0.6, treasureMod: 1.3, jackpotMod: 1.2, rarityShift: 0.08, qualityBoost: 0.20 },
    specialSpecies: [
      { name: 'Festival Salmon', emoji: '🐟', rarity: 'rare', multiplier: 5.0 },
    ],
  },
  {
    id: 'coral_bloom',
    name: 'Coral Bloom',
    description: 'The reef blooms – fish are abundant and healthy.',
    emoji: '🌸',
    durationMs: 3 * 60 * 60 * 1000,
    weight: 9,
    modifiers: { emptyMod: 0.5, predatorMod: 0.6, qualityBoost: 0.25, rarityShift: 0.05 },
    specialSpecies: [
      { name: 'Coral Grouper', emoji: '🐠', rarity: 'uncommon', multiplier: 2.8 },
    ],
  },
];

export interface ActiveEvent {
  templateId: string;
  name: string;
  description: string;
  emoji: string;
  startTime: number;
  endTime: number;
  modifiers: EventTemplate['modifiers'];
  specialSpecies?: FishSpecies[];
}

export async function getActiveEvents(): Promise<ActiveEvent[]> {
  let active = (await activeEventsTbl.get('list')) as ActiveEvent[] || [];
  const now = Date.now();
  active = active.filter(e => e.endTime > now);
  await activeEventsTbl.set('list', active);

  let lastGen = (await lastGenTbl.get('lastGen')) as number || 0;
  if (now - lastGen > MIN_EVENT_INTERVAL_MS && active.length < MAX_ACTIVE_EVENTS) {
    const newEvents = generateEvents(now);
    if (newEvents.length) {
      active = [...active, ...newEvents];
      await activeEventsTbl.set('list', active);
    }
    await lastGenTbl.set('lastGen', now);
  }
  return active;
}

function generateEvents(now: number): ActiveEvent[] {
  const availableTemplates = EVENT_TEMPLATES.filter(t => {
    if (t.schedule) {
      const d = new Date(now);
      const day = d.getDay();
      const hour = d.getHours();
      return (t.schedule.dayOfWeek === undefined || t.schedule.dayOfWeek === day) &&
             (t.schedule.hourStart === undefined || hour >= t.schedule.hourStart) &&
             (t.schedule.hourEnd === undefined || hour < t.schedule.hourEnd);
    }
    return true;
  });
  if (!availableTemplates.length) return [];

  const totalWeight = availableTemplates.reduce((s, t) => s + t.weight, 0);
  let roll = Math.random() * totalWeight;
  let selected: EventTemplate | null = null;
  for (const t of availableTemplates) {
    roll -= t.weight;
    if (roll <= 0) { selected = t; break; }
  }
  if (!selected) return [];

  const durJitter = selected.durationMs * (0.8 + Math.random() * 0.4);
  const startTime = now;
  const endTime = startTime + durJitter;
  const event: ActiveEvent = {
    templateId: selected.id,
    name: selected.name,
    description: selected.description,
    emoji: selected.emoji,
    startTime,
    endTime,
    modifiers: selected.modifiers || {},
    specialSpecies: selected.specialSpecies ? [...selected.specialSpecies] : undefined,
  };

  const events: ActiveEvent[] = [event];
  if (Math.random() < 0.3 && availableTemplates.length > 1) {
    const remaining = availableTemplates.filter(t => t.id !== selected!.id);
    if (remaining.length) {
      const roll2 = Math.random() * remaining.reduce((s, t) => s + t.weight, 0);
      let sel2: EventTemplate | null = null;
      let cum = 0;
      for (const t of remaining) {
        cum += t.weight;
        if (roll2 <= cum) { sel2 = t; break; }
      }
      if (sel2) {
        const durJitter2 = sel2.durationMs * (0.8 + Math.random() * 0.4);
        const event2: ActiveEvent = {
          templateId: sel2.id,
          name: sel2.name,
          description: sel2.description,
          emoji: sel2.emoji,
          startTime: now + 15 * 60 * 1000,
          endTime: now + 15 * 60 * 1000 + durJitter2,
          modifiers: sel2.modifiers || {},
          specialSpecies: sel2.specialSpecies ? [...sel2.specialSpecies] : undefined,
        };
        events.push(event2);
      }
    }
  }
  return events;
}

export async function getFishAvailabilityWithEvents(): Promise<AvailableFish> {
  const base = await getFishAvailability();
  const events = await getActiveEvents();
  for (const ev of events) {
    if (ev.specialSpecies) {
      base.specials.push(...ev.specialSpecies);
    }
  }
  return base;
}

export async function getEventModifiers(): Promise<{
  emptyMod: number;
  predatorMod: number;
  treasureMod: number;
  jackpotMod: number;
  rarityShift: number;
  qualityBoost: number;
}> {
  const events = await getActiveEvents();
  const result = { emptyMod: 1, predatorMod: 1, treasureMod: 1, jackpotMod: 1, rarityShift: 0, qualityBoost: 0 };
  for (const ev of events) {
    const m = ev.modifiers;
    if (m.emptyMod !== undefined) result.emptyMod *= m.emptyMod;
    if (m.predatorMod !== undefined) result.predatorMod *= m.predatorMod;
    if (m.treasureMod !== undefined) result.treasureMod *= m.treasureMod;
    if (m.jackpotMod !== undefined) result.jackpotMod *= m.jackpotMod;
    if (m.rarityShift !== undefined) result.rarityShift += m.rarityShift;
    if (m.qualityBoost !== undefined) result.qualityBoost += m.qualityBoost;
  }
  return result;
}