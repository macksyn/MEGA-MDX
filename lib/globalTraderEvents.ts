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
  label: string;      // short Title Case name — compact status line, menu labels
  headline: string;   // punchy ALL-CAPS line — leads the detail card
  emoji: string;
  description: string; // one/two-sentence narrative — why this is happening
  weight: number;
  durationHrsRange: [number, number];
  effects: EventEffects;
}

export const RANDOM_EVENTS: NigeriaEventDef[] = [
  {
    key: 'fuel_scarcity', label: 'Fuel Scarcity', headline: 'Fuel Scarcity Hits the Roads', emoji: '⛽',
    description: 'Petrol queues are snaking round the block nationwide. Truckers are rationing trips, and moving goods inland just got a lot harder.',
    weight: 3, durationHrsRange: [24, 72],
    effects: { courierRiskDelta: 0.15, affectedHubs: ['onitsha', 'aba', 'kano', 'sokoto', 'ph'] },
  },
  {
    key: 'election_season', label: 'Election Season', headline: 'Election Season Tightens the Roads', emoji: '🗳️',
    description: 'Checkpoints are up and wallets are closed for anything that isn\'t essential. Buyers are holding off on luxury spending until the votes are counted.',
    weight: 2, durationHrsRange: [48, 120],
    effects: { dutyRateDeltaPct: 4, courierRiskDelta: 0.08, priceMultiplier: 0.9, affectedGoods: ['perfume_cosmetics', 'gold_jewelry', 'diamond_jewelry', 'luxury_goods'] },
  },
  {
    key: 'dollar_scarcity', label: 'Dollar Scarcity', headline: 'Naira Under Pressure', emoji: '💵',
    description: 'The naira is weakening against major currencies. Importers are scrambling to restock before prices rise again.',
    weight: 3, durationHrsRange: [72, 168],
    effects: { goodsCostMultiplier: 1.15, freightCostMultiplier: 1.10, priceMultiplier: 1.12 },
  },
  {
    key: 'flood', label: 'Flooding', headline: 'Flooding Cuts Off Inland Routes', emoji: '🌊',
    description: 'Flooded roads have cut off supply to inland markets. Whatever still gets through is selling at a serious premium.',
    weight: 2, durationHrsRange: [24, 96],
    effects: { courierRiskDelta: 0.25, priceMultiplier: 1.20, affectedHubs: ['onitsha', 'aba', 'ph'] },
  },
  {
    key: 'sallah', label: 'Sallah Celebration', headline: 'Sallah Demand Spikes Up North', emoji: '🕌',
    description: 'Sallah is here and the north is buying. Textiles and dates are flying off shelves in Kano and Sokoto.',
    weight: 2, durationHrsRange: [48, 96],
    effects: { priceMultiplier: 1.30, affectedGoods: ['dates_textiles', 'textiles'], affectedHubs: ['kano', 'sokoto'] },
  },
  {
    key: 'port_strike', label: 'Port Strike', headline: 'Port Strike Backs Up Customs', emoji: '⚓',
    description: 'Dockworkers have walked off the job. Customs is backed up, and clearing a shipment is about to take longer — and cost more.',
    weight: 1, durationHrsRange: [24, 72],
    effects: { dutyRateDeltaPct: 6, clearanceDelayHrs: 12 },
  },
  {
    key: 'new_customs_tariff', label: 'New Customs Tariff', headline: 'New Customs Tariff Kicks In', emoji: '📈',
    description: 'A new import tariff just took effect. Duty is up across the board, no exceptions.',
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
      key: 'christmas_rush', label: 'Christmas Rush', headline: 'Detty December Is Here', emoji: '🎄',
      description: 'Detty December is in full swing. Lagos and Port Harcourt are buying big and paying whatever it takes.',
      weight: 0, durationHrsRange: [0, 0],
      effects: { priceMultiplier: 1.35, affectedGoods: ['perfume_cosmetics', 'gold_jewelry', 'diamond_jewelry', 'luxury_goods', 'electronics', 'iphones', 'tecno_infinix_phones'], affectedHubs: ['lagos', 'ph'] },
    });
  }

  if (inDateWindow(11, 24, 30, month, day)) {
    active.push({
      key: 'black_friday', label: 'Black Friday', headline: 'Black Friday Demand Spike', emoji: '🛍️',
      description: 'Black Friday shoppers are out in force — everything is moving faster than usual.',
      weight: 0, durationHrsRange: [0, 0],
      effects: { priceMultiplier: 1.20 },
    });
  }

  if (inDateWindow(1, 1, 15, month, day) || inDateWindow(9, 1, 15, month, day)) {
    active.push({
      key: 'school_resumption', label: 'School Resumption', headline: 'School Resumption Boosts Demand', emoji: '🎒',
      description: 'Schools are resuming and parents are stocking up — steady demand for electronics and textiles.',
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

// ── Detail view: narrative + line-item impact ─────────────────────────
//
// These are display-only label maps. They deliberately mirror (a subset
// of) the labels in globalTraderEconomy.ts rather than importing them —
// that module already imports FROM this file, so importing back would be
// circular. Keep in sync by hand if goodKeys/hubKeys change.

const GOOD_LABELS: Record<string, string> = {
  // Base goods
  electronics: 'Electronics',
  pharmaceuticals: 'Pharmaceuticals',
  rubber: 'Rubber & Auto Parts',
  textiles: 'Textiles',
  food: 'Food & Perishables',
  coffee_leather: 'Coffee & Leather',
  olive_wine: 'Olive Oil & Wine',
  dates_textiles: 'Dates & Textiles',
  perfume_cosmetics: 'Perfume & Cosmetics',
  gold_jewelry: 'Gold Jewelry',
  diamond_jewelry: 'Diamond Jewelry',
  machinery: 'Machinery',
  luxury_goods: 'Luxury Goods',
  rice: 'Rice',
  
  // Benin
  used_clothing: 'Used Clothing (Okrika)',
  frozen_poultry: 'Frozen Poultry',
  
  // India
  ayurvedic_cosmetics: 'Ayurvedic & Herbal Cosmetics',
  textile_machinery: 'Textile Machinery',
  keke_napep: 'Tricycles (Keke Napep)',
  
  // Thailand
  frozen_seafood: 'Frozen Seafood',
  thai_cosmetics: 'Thai Cosmetics & Skincare',
  
  // Turkey
  turkish_furniture: 'Furniture',
  ceramic_tiles_turkey: 'Ceramic Tiles',
  
  // China
  tecno_infinix_phones: 'Tecno & Infinix Phones',
  chinese_motorcycles: 'Motorcycles (Okada Bikes)',
  generators: 'Generators',
  solar_systems: 'Solar Panels & Inverters',
  
  // Brazil
  soybeans_meat: 'Soybeans & Frozen Meat',
  brazil_sugar: 'Raw Sugar',
  
  // Spain
  spanish_tiles: 'Ceramic Tiles & Marble',
  jamon_ham: 'Iberian Ham & Cheese',
  
  // Saudi Arabia
  petrochemical_plastics: 'Petrochemicals & Plastics',
  arabian_oud: 'Arabian Oud & Perfume Oils',
  silver_jewelry: 'Silver Jewelry',
  designer_perfumes: 'Designer Perfumes',
  
  // France
  wine_champagne: 'Wine & Champagne',
  designer_fashion_france: 'Designer Fashion',
  
  // UAE
  used_cars_uae: 'Used Luxury Cars',
  designer_watches: 'Designer Watches',
  samsung_phones: 'Samsung Phones',
  iphones: 'iPhones',
  
  // Germany
  german_auto_parts: 'BMW & Mercedes Auto Parts',
  industrial_equipment: 'Industrial Equipment',
  german_luxury_cars: 'BMW & Mercedes Tokunbo',
  
  // USA
  used_cars_usa: 'Used Cars (Tokunbo)',
  toyota_camry_corolla: 'Toyota Camry & Corolla',
  lexus_suvs: 'Lexus SUVs',
  apple_electronics: 'Apple Electronics',
  
  // Italy
  ferrari_lamborghini: 'Ferrari & Lamborghini',
  italian_leather_fashion: 'Italian Leather & Designer Fashion',
  vespa_scooters: 'Vespa Scooters',
};

const HUB_LABELS: Record<string, string> = {
  lagos: 'Lagos',
  onitsha: 'Onitsha',
  aba: 'Aba',
  kano: 'Kano',
  sokoto: 'Sokoto',
  ph: 'Port Harcourt',
};

interface ImpactLine {
  text: string;
  direction: 'up' | 'down';
}

function pctFromMultiplier(mult: number): { pct: number; direction: 'up' | 'down' } | null {
  const pct = Math.round((mult - 1) * 100);
  if (pct === 0) return null;
  return { pct: Math.abs(pct), direction: pct > 0 ? 'up' : 'down' };
}

function scopeLabel(keys: string[] | undefined, map: Record<string, string>, fallback: string | null): string | null {
  if (!keys || !keys.length) return fallback;
  const names = [...new Set(keys.map(k => map[k] || k))];
  return names.join(' & ');
}

/** Turns one event's raw effects into player-readable "what changed and why" lines. */
function buildImpactLines(event: NigeriaEventDef): ImpactLine[] {
  const { effects } = event;
  const lines: ImpactLine[] = [];

  if (effects.goodsCostMultiplier) {
    const delta = pctFromMultiplier(effects.goodsCostMultiplier);
    if (delta) {
      const scope = scopeLabel(effects.affectedGoods, GOOD_LABELS, 'Import');
      lines.push({ text: `${scope} cost ${delta.direction === 'up' ? '+' : '-'}${delta.pct}%`, direction: delta.direction });
    }
  }

  if (effects.freightCostMultiplier) {
    const delta = pctFromMultiplier(effects.freightCostMultiplier);
    if (delta) lines.push({ text: `Freight ${delta.direction === 'up' ? '+' : '-'}${delta.pct}%`, direction: delta.direction });
  }

  if (effects.priceMultiplier) {
    const delta = pctFromMultiplier(effects.priceMultiplier);
    if (delta) {
      const scope = scopeLabel(effects.affectedGoods, GOOD_LABELS, null) || scopeLabel(effects.affectedHubs, HUB_LABELS, null) || 'Nigerian market';
      lines.push({ text: `${scope} prices ${delta.direction === 'up' ? '+' : '-'}${delta.pct}%`, direction: delta.direction });
    }
  }

  if (effects.dutyRateDeltaPct) {
    const direction: 'up' | 'down' = effects.dutyRateDeltaPct > 0 ? 'up' : 'down';
    lines.push({ text: `Customs duty ${direction === 'up' ? '+' : ''}${effects.dutyRateDeltaPct}pp`, direction });
  }

  if (effects.courierRiskDelta) {
    const pts = Math.round(effects.courierRiskDelta * 100);
    const direction: 'up' | 'down' = pts > 0 ? 'up' : 'down';
    const scope = scopeLabel(effects.affectedHubs, HUB_LABELS, 'Courier');
    lines.push({ text: `${scope} risk ${direction === 'up' ? '+' : ''}${pts}pp`, direction });
  }

  if (effects.clearanceDelayHrs) {
    lines.push({ text: `Clearance delay +${effects.clearanceDelayHrs}h`, direction: 'up' });
  }

  return lines;
}

/**
 * Full narrative + impact-breakdown block, one section per active event.
 * Meant for a dedicated "Market Conditions" view, not the compact inline
 * subtitle (use getEventsStatusBlock for that).
 */
export async function getEventsDetailBlock(): Promise<string> {
  const events = await getActiveEvents();
  if (!events.length) return '_No market conditions in effect right now — business as usual._';

  const sections = events.map(e => {
    const lines = buildImpactLines(e);
    const impact = lines.length
      ? lines.map(l => `${l.direction === 'up' ? '▲' : '▼'} ${l.text}`).join('\n')
      : null;
    return (
      `${e.emoji} *${(e.headline || e.label).toUpperCase()}*\n` +
      `_${e.description}_` +
      (impact ? `\n\n${impact}` : '')
    );
  });

  return sections.join('\n\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n');
}