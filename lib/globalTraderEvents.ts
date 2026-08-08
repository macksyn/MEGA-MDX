// @ts-nocheck
/***
 * lib/globalTraderEvents.ts
 *
 * Nigerian market conditions for Global Trader — this was missing entirely
 * from the last build. Two kinds of events:
 *  - SEASONAL: date-gated against the calendar (Christmas Rush, Black
 *    Friday, School Resumption) — always active during their window, no
 *    storage needed.
 *  - RANDOM: rolled probabilistically with a weight + duration, stored
 *    with an expiry (Fuel Scarcity, Election Season, Dollar Scarcity,
 *    Flood, Sallah, Port Strike, New Customs Tariff).
 *
 * globalTraderEconomy.ts asks this module "what's active right now" and
 * folds the effects into its own price/duty/risk/timing math. This module
 * never touches wallets or shipments directly.
 */

import moment from 'moment-timezone';
import { createStore } from './pluginStore.js';
import config from '../config.js';

const store = createStore('globaltrader');
const eventsTbl = store.table('activeEvents'); // 'current' -> ActiveEvent[]

const TZ = config.timeZone || 'Africa/Lagos';

export interface EventEffects {
  priceMultiplier?: number;
  affectedGoods?: string[];   // goodKeys
  affectedHubs?: string[];    // hub keys
  goodsCostMultiplier?: number;
  freightCostMultiplier?: number;
  dutyRateDeltaPct?: number;
  courierRiskDelta?: number;
  clearanceDelayHrs?: number;
}

export interface NigeriaEventDef {
  key: string;
  label: string;
  emoji: string;
  description: string;
  weight: number;
  durationHrsRange: [number, number];
  effects: EventEffects;
}

export const RANDOM_EVENTS: NigeriaEventDef[] = [
  {
    key: 'fuel_scarcity', label: 'Fuel Scarcity', emoji: '⛽',
    description: 'Petrol queues nationwide — moving goods inland just got harder.',
    weight: 3, durationHrsRange: [24, 72],
    effects: { courierRiskDelta: 0.15, affectedHubs: ['onitsha', 'aba', 'kano', 'sokoto', 'ph'] },
  },
  {
    key: 'election_season', label: 'Election Season', emoji: '🗳️',
    description: 'Tighter checkpoints and cautious spending on non-essentials.',
    weight: 2, durationHrsRange: [48, 120],
    effects: { dutyRateDeltaPct: 4, courierRiskDelta: 0.08, priceMultiplier: 0.9, affectedGoods: ['perfume_cosmetics', 'gold_perfume', 'luxury_goods'] },
  },
  {
    key: 'dollar_scarcity', label: 'Dollar Scarcity', emoji: '💵',
    description: 'Naira slides against the dollar — imports cost more, and so does everything on the shelf.',
    weight: 3, durationHrsRange: [72, 168],
    effects: { goodsCostMultiplier: 1.15, freightCostMultiplier: 1.10, priceMultiplier: 1.12 },
  },
  {
    key: 'flood', label: 'Flooding', emoji: '🌊',
    description: 'Flooded routes cut off supply to inland markets — what gets through sells at a premium.',
    weight: 2, durationHrsRange: [24, 96],
    effects: { courierRiskDelta: 0.25, priceMultiplier: 1.20, affectedHubs: ['onitsha', 'aba', 'ph'] },
  },
  {
    key: 'sallah', label: 'Sallah Celebration', emoji: '🕌',
    description: 'Sallah demand spike in the north — textiles and dates are moving fast.',
    weight: 2, durationHrsRange: [48, 96],
    effects: { priceMultiplier: 1.30, affectedGoods: ['dates_textiles', 'textiles'], affectedHubs: ['kano', 'sokoto'] },
  },
  {
    key: 'port_strike', label: 'Port Strike', emoji: '⚓',
    description: 'Dockworkers are on strike — customs is backed up and clearance is slower and pricier.',
    weight: 1, durationHrsRange: [24, 72],
    effects: { dutyRateDeltaPct: 6, clearanceDelayHrs: 12 },
  },
  {
    key: 'new_customs_tariff', label: 'New Customs Tariff', emoji: '📈',
    description: 'A new import tariff just kicked in — duty is up across the board.',
    weight: 2, durationHrsRange: [72, 168],
    effects: { dutyRateDeltaPct: 8 },
  },
];

function inDateWindow(month: number, dayStart: number, dayEnd: number, todayMonth: number, todayDay: number): boolean {
  if (todayMonth !== month) return false;
  return todayDay >= dayStart && todayDay <= dayEnd;
}

function getSeasonalEvents(): NigeriaEventDef[] {
  const now = moment().tz(TZ);
  const month = now.month() + 1;
  const day = now.date();
  const active: NigeriaEventDef[] = [];

  if (month === 12) {
    active.push({
      key: 'christmas_rush', label: 'Christmas Rush', emoji: '🎄',
      description: 'Detty December is here — Lagos and Port Harcourt are buying big.',
      weight: 0, durationHrsRange: [0, 0],
      effects: { priceMultiplier: 1.35, affectedGoods: ['perfume_cosmetics', 'gold_perfume', 'luxury_goods', 'electronics'], affectedHubs: ['lagos', 'ph'] },
    });
  }

  if (inDateWindow(11, 24, 30, month, day)) {
    active.push({
      key: 'black_friday', label: 'Black Friday', emoji: '🛍️',
      description: 'Black Friday demand spike — everything is moving faster than usual.',
      weight: 0, durationHrsRange: [0, 0],
      effects: { priceMultiplier: 1.20 },
    });
  }

  if (inDateWindow(1, 1, 15, month, day) || inDateWindow(9, 1, 15, month, day)) {
    active.push({
      key: 'school_resumption', label: 'School Resumption', emoji: '🎒',
      description: 'Schools are resuming — steady demand for electronics and textiles.',
      weight: 0, durationHrsRange: [0, 0],
      effects: { priceMultiplier: 1.12, affectedGoods: ['electronics', 'textiles'] },
    });
  }

  return active;
}

interface ActiveEvent { key: string; activatedAt: number; expiresAt: number; }

const MAX_CONCURRENT_RANDOM = 2;
const ROLL_CHANCE_PER_CHECK = 0.04;

async function getStoredActiveEvents(): Promise<ActiveEvent[]> {
  const stored: ActiveEvent[] = (await eventsTbl.get('current')) || [];
  const now = Date.now();
  const stillActive = stored.filter(e => e.expiresAt > now);
  if (stillActive.length !== stored.length) await eventsTbl.set('current', stillActive);
  return stillActive;
}

function weightedPick(pool: NigeriaEventDef[]): NigeriaEventDef {
  const totalWeight = pool.reduce((sum, e) => sum + e.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const e of pool) {
    roll -= e.weight;
    if (roll <= 0) return e;
  }
  return pool[pool.length - 1];
}

async function maybeRollNewEvent(active: ActiveEvent[]): Promise<ActiveEvent[]> {
  if (active.length >= MAX_CONCURRENT_RANDOM) return active;
  if (Math.random() > ROLL_CHANCE_PER_CHECK) return active;

  const activeKeys = new Set(active.map(e => e.key));
  const eligible = RANDOM_EVENTS.filter(e => !activeKeys.has(e.key));
  if (!eligible.length) return active;

  const chosen = weightedPick(eligible);
  const [minHrs, maxHrs] = chosen.durationHrsRange;
  const durationMs = (minHrs + Math.random() * (maxHrs - minHrs)) * 3600000;
  const updated = [...active, { key: chosen.key, activatedAt: Date.now(), expiresAt: Date.now() + durationMs }];
  await eventsTbl.set('current', updated);
  return updated;
}

export async function getActiveEvents(): Promise<NigeriaEventDef[]> {
  let storedActive = await getStoredActiveEvents();
  storedActive = await maybeRollNewEvent(storedActive);
  const randomActive = storedActive.map(a => RANDOM_EVENTS.find(e => e.key === a.key)).filter(Boolean) as NigeriaEventDef[];
  return [...getSeasonalEvents(), ...randomActive];
}

function eventApplies(event: NigeriaEventDef, filter: { good?: string; hub?: string }): boolean {
  const { affectedGoods, affectedHubs } = event.effects;
  if (affectedGoods && filter.good && !affectedGoods.includes(filter.good)) return false;
  if (affectedHubs && filter.hub && !affectedHubs.includes(filter.hub)) return false;
  return true;
}

export async function getPriceMultiplier(goodKey: string, hub: string): Promise<number> {
  const events = await getActiveEvents();
  return events.reduce((mult, e) => (e.effects.priceMultiplier && eventApplies(e, { good: goodKey, hub }) ? mult * e.effects.priceMultiplier : mult), 1);
}

export async function getGoodsCostMultiplier(): Promise<number> {
  const events = await getActiveEvents();
  return events.reduce((mult, e) => mult * (e.effects.goodsCostMultiplier || 1), 1);
}

export async function getFreightCostMultiplier(): Promise<number> {
  // International freight only — deliberately not hub-scoped, since none of
  // the hub-restricted events (Fuel Scarcity, Flood) are meant to touch the
  // international leg, only the domestic courier leg.
  const events = await getActiveEvents();
  return events.reduce((mult, e) => (e.effects.freightCostMultiplier && !e.effects.affectedHubs ? mult * e.effects.freightCostMultiplier : mult), 1);
}

export async function getDutyRateDeltaPct(): Promise<number> {
  const events = await getActiveEvents();
  return events.reduce((sum, e) => sum + (e.effects.dutyRateDeltaPct || 0), 0);
}

export async function getCourierRiskDelta(hub: string): Promise<number> {
  const events = await getActiveEvents();
  return events.reduce((sum, e) => (e.effects.courierRiskDelta && eventApplies(e, { hub }) ? sum + e.effects.courierRiskDelta : sum), 0);
}

export async function getClearanceDelayMs(): Promise<number> {
  const events = await getActiveEvents();
  const maxDelayHrs = events.reduce((max, e) => Math.max(max, e.effects.clearanceDelayHrs || 0), 0);
  return maxDelayHrs * 3600000;
}

export async function getEventsStatusBlock(): Promise<string> {
  const events = await getActiveEvents();
  if (!events.length) return '';
  return `⚡ ${events.map(e => `${e.emoji} *${e.label}*`).join('   ')}`;
}
