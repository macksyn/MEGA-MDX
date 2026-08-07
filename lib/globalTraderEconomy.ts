// @ts-nocheck
/***
 * lib/globalTraderEconomy.ts – Global Trader core trading engine.
 * 
 * Features:
 * - Goods with individual traits (volatility, expiration, theft, legal flags)
 * - Tier‑based licenses (one license covers all countries in a rank tier)
 * - In‑transit events (delay, pirates, temperature) with player choices
 * - Shared jackpot pool with slotMachine.ts
 */

import { createStore } from './pluginStore.js';
import { deductCoins, addCoins, todayStr, formatNumber } from './economy.js';
import { getJackpotPool, contributeToJackpot, deductFromJackpot, settleWin } from './slotMachine.js';

const store = createStore('globaltrader');
const shipmentsTbl = store.table('shipments');
const licensesTbl = store.table('licenses');
const stockTbl = store.table('stock');
const marketTbl = store.table('market');
const statsTbl = store.table('stats');

// ── Goods Registry ─────────────────────────────────────────────────────

export interface GoodDef {
  key: string;
  label: string;
  baseCost: number;
  priceVolatility: number;
  demandStability: number;
  expirationHours: number;
  customsRiskMod: number;
  theftRisk: number;
  legalFlags: string[];
  profitMarginBonus: number;
}

export const GOODS: Record<string, GoodDef> = {
  electronics: {
    key: 'electronics',
    label: 'Electronics',
    baseCost: 800,
    priceVolatility: 0.4,
    demandStability: 0.3,
    expirationHours: 120,
    customsRiskMod: 1.4,
    theftRisk: 0.3,
    legalFlags: [],
    profitMarginBonus: 0.35,
  },
  pharmaceuticals: {
    key: 'pharmaceuticals',
    label: 'Pharmaceuticals',
    baseCost: 600,
    priceVolatility: 0.1,
    demandStability: 0.9,
    expirationHours: 72,
    customsRiskMod: 0.8,
    theftRisk: 0.1,
    legalFlags: ['requiresInspection'],
    profitMarginBonus: 0.05,
  },
  rubber: {
    key: 'rubber',
    label: 'Rubber & Auto Parts',
    baseCost: 700,
    priceVolatility: 0.3,
    demandStability: 0.6,
    expirationHours: 240,
    customsRiskMod: 1.0,
    theftRisk: 0.2,
    legalFlags: [],
    profitMarginBonus: 0.15,
  },
  textiles: {
    key: 'textiles',
    label: 'Textiles',
    baseCost: 1500,
    priceVolatility: 0.2,
    demandStability: 0.7,
    expirationHours: 240,
    customsRiskMod: 1.0,
    theftRisk: 0.2,
    legalFlags: [],
    profitMarginBonus: 0.20,
  },
  food: {
    key: 'food',
    label: 'Food & Perishables',
    baseCost: 200,
    priceVolatility: 0.5,
    demandStability: 0.4,
    expirationHours: 24,
    customsRiskMod: 1.2,
    theftRisk: 0.4,
    legalFlags: [],
    profitMarginBonus: 0.15,
  },
  coffee_leather: {
    key: 'coffee_leather',
    label: 'Coffee & Leather',
    baseCost: 2000,
    priceVolatility: 0.3,
    demandStability: 0.6,
    expirationHours: 168,
    customsRiskMod: 1.0,
    theftRisk: 0.3,
    legalFlags: [],
    profitMarginBonus: 0.25,
  },
  olive_wine: {
    key: 'olive_wine',
    label: 'Olive Oil & Wine',
    baseCost: 1800,
    priceVolatility: 0.7,
    demandStability: 0.2,
    expirationHours: 720,
    customsRiskMod: 1.8,
    theftRisk: 0.5,
    legalFlags: ['bannedInKano', 'bannedInSokoto'],
    profitMarginBonus: 0.8,
  },
  dates_textiles: {
    key: 'dates_textiles',
    label: 'Dates & Textiles',
    baseCost: 2200,
    priceVolatility: 0.2,
    demandStability: 0.8,
    expirationHours: 240,
    customsRiskMod: 0.9,
    theftRisk: 0.2,
    legalFlags: [],
    profitMarginBonus: 0.25,
  },
  perfume_cosmetics: {
    key: 'perfume_cosmetics',
    label: 'Perfume & Cosmetics',
    baseCost: 4500,
    priceVolatility: 0.5,
    demandStability: 0.4,
    expirationHours: 720,
    customsRiskMod: 1.2,
    theftRisk: 0.4,
    legalFlags: [],
    profitMarginBonus: 0.6,
  },
  gold_perfume: {
    key: 'gold_perfume',
    label: 'Gold & Perfume',
    baseCost: 5000,
    priceVolatility: 0.2,
    demandStability: 0.9,
    expirationHours: 9999,
    customsRiskMod: 2.0,
    theftRisk: 0.7,
    legalFlags: ['requiresExtraSecurity'],
    profitMarginBonus: 1.0,
  },
  machinery: {
    key: 'machinery',
    label: 'Machinery',
    baseCost: 6000,
    priceVolatility: 0.1,
    demandStability: 0.9,
    expirationHours: 9999,
    customsRiskMod: 0.6,
    theftRisk: 0.1,
    legalFlags: [],
    profitMarginBonus: 0.30,
  },
  luxury_goods: {
    key: 'luxury_goods',
    label: 'Luxury Goods',
    baseCost: 7000,
    priceVolatility: 0.3,
    demandStability: 0.7,
    expirationHours: 9999,
    customsRiskMod: 0.7,
    theftRisk: 0.3,
    legalFlags: [],
    profitMarginBonus: 0.50,
  },
  rice: {
    key: 'rice',
    label: 'Rice',
    baseCost: 300,
    priceVolatility: 0.1,
    demandStability: 0.9,
    expirationHours: 240,
    customsRiskMod: 0.8,
    theftRisk: 0.1,
    legalFlags: [],
    profitMarginBonus: 0.1,
  },
};

// ── Country Defs ──────────────────────────────────────────────────────

export type RiskTier = 'veryLow' | 'low' | 'medium' | 'high';

export interface CountryDef {
  key: string;
  label: string;
  emoji: string;
  goodKey: string;
  baseFreightFee: number;
  distanceHrs: number;
  risk: RiskTier;
  dutyRatePercent: number;
  dailyStockCap: number;
  licenseRenewCost: number;
}

export const COUNTRIES: CountryDef[] = [
  { key: 'benin',   label: 'Cotonou',     emoji: '🇧🇯', goodKey: 'rice',          baseFreightFee: 800,  distanceHrs: 6,  risk: 'high',   dutyRatePercent: 10, dailyStockCap: 200, licenseRenewCost: 1500 },
  { key: 'india',   label: 'India',        emoji: '🇮🇳', goodKey: 'pharmaceuticals', baseFreightFee: 3000, distanceHrs: 30, risk: 'medium', dutyRatePercent: 12, dailyStockCap: 180, licenseRenewCost: 2500 },
  { key: 'thailand', label: 'Thailand',   emoji: '🇹🇭', goodKey: 'rubber',        baseFreightFee: 3000, distanceHrs: 30, risk: 'medium', dutyRatePercent: 12, dailyStockCap: 180, licenseRenewCost: 2500 },
  { key: 'turkey',   label: 'Turkey',      emoji: '🇹🇷', goodKey: 'textiles',      baseFreightFee: 2500, distanceHrs: 24, risk: 'low',    dutyRatePercent: 12, dailyStockCap: 130, licenseRenewCost: 4500 },
  { key: 'china',    label: 'China',       emoji: '🇨🇳', goodKey: 'electronics',   baseFreightFee: 4000, distanceHrs: 48, risk: 'medium', dutyRatePercent: 14, dailyStockCap: 200, licenseRenewCost: 5000 },
  { key: 'brazil',   label: 'Brazil',      emoji: '🇧🇷', goodKey: 'coffee_leather', baseFreightFee: 4500, distanceHrs: 48, risk: 'medium', dutyRatePercent: 14, dailyStockCap: 130, licenseRenewCost: 5500 },
  { key: 'spain',    label: 'Spain',       emoji: '🇪🇸', goodKey: 'olive_wine',    baseFreightFee: 2500, distanceHrs: 24, risk: 'low',    dutyRatePercent: 14, dailyStockCap: 110, licenseRenewCost: 7000 },
  { key: 'saudi',    label: 'Saudi Arabia', emoji: '🇸🇦', goodKey: 'dates_textiles', baseFreightFee: 2200, distanceHrs: 18, risk: 'low',    dutyRatePercent: 14, dailyStockCap: 110, licenseRenewCost: 7500 },
  { key: 'france',   label: 'France',      emoji: '🇫🇷', goodKey: 'perfume_cosmetics', baseFreightFee: 5000, distanceHrs: 40, risk: 'low',   dutyRatePercent: 18, dailyStockCap: 70,  licenseRenewCost: 14000 },
  { key: 'uae',      label: 'UAE',         emoji: '🇦🇪', goodKey: 'gold_perfume',   baseFreightFee: 1500, distanceHrs: 12, risk: 'low',    dutyRatePercent: 18, dailyStockCap: 60,  licenseRenewCost: 16000 },
  { key: 'germany',  label: 'Germany',     emoji: '🇩🇪', goodKey: 'machinery',     baseFreightFee: 6000, distanceHrs: 48, risk: 'veryLow', dutyRatePercent: 20, dailyStockCap: 60, licenseRenewCost: 20000 },
  { key: 'usa',      label: 'USA',         emoji: '🇺🇸', goodKey: 'luxury_goods',  baseFreightFee: 6000, distanceHrs: 48, risk: 'low',    dutyRatePercent: 20, dailyStockCap: 60,  licenseRenewCost: 20000 },
];

const RISK_BRIBE_SUCCESS: Record<RiskTier, number> = {
  veryLow: 0.95,
  low: 0.85,
  medium: 0.70,
  high: 0.50,
};

// ── Freight Defs (Real Shipping Companies) ──────────────────────────

export interface FreightDef {
  key: string;
  label: string;
  speedMult: number;
  costMult: number;
}

export const FREIGHT_TIERS: FreightDef[] = [
  { key: 'hapag', label: 'Hapag-Lloyd', speedMult: 1.0, costMult: 1.0 },
  { key: 'cma', label: 'CMA CGM', speedMult: 1.8, costMult: 2.0 },
  { key: 'maersk', label: 'Maersk', speedMult: 3.0, costMult: 3.5 },
  { key: 'one', label: 'Ocean Network Express (ONE)', speedMult: 4.5, costMult: 5.0 },
  { key: 'cosco', label: 'Cosco Shipping', speedMult: 6.0, costMult: 7.0 },
];

// ── Rank Defs ─────────────────────────────────────────────────────────

export interface RankDef {
  key: string;
  label: string;
  emoji: string;
  lifetimeProfitThreshold: number;
  addsCountries: string[];
  addsFreight: string[];
}

const RANK_DEFS: RankDef[] = [
  { 
    key: 'dropshipper', 
    label: 'Dropshipper', 
    emoji: '📦',
    lifetimeProfitThreshold: 0, 
    addsCountries: ['benin', 'india', 'thailand'], 
    addsFreight: ['hapag'] 
  },
  { 
    key: 'mini_importer', 
    label: 'Mini Importer', 
    emoji: '📦',
    lifetimeProfitThreshold: 30000, 
    addsCountries: ['turkey', 'china', 'brazil'], 
    addsFreight: ['cma'] 
  },
  { 
    key: 'sme', 
    label: 'SME', 
    emoji: '🛍️',
    lifetimeProfitThreshold: 100000, 
    addsCountries: ['spain', 'saudi'], 
    addsFreight: ['maersk'] 
  },
  { 
    key: 'importer', 
    label: 'Importer', 
    emoji: '📦',
    lifetimeProfitThreshold: 300000, 
    addsCountries: ['france', 'uae'], 
    addsFreight: ['one'] 
  },
  { 
    key: 'pro_trader', 
    label: 'Pro Trader', 
    emoji: '🚚',
    lifetimeProfitThreshold: 700000, 
    addsCountries: ['germany'], 
    addsFreight: ['cosco'] 
  },
  { 
    key: 'global_trader', 
    label: 'Global Trader', 
    emoji: '🌍',
    lifetimeProfitThreshold: 1500000, 
    addsCountries: ['usa'], 
    addsFreight: [] 
  },
];

// ── License Tiers ─────────────────────────────────────────────────────

export const LICENSE_TIERS = {
  dropshipper: {
    key: 'dropshipper',
    label: 'Dropshipper License',
    emoji: '📦',
    cost: 1500,
    countries: ['benin', 'india', 'thailand'],
    durationMs: 7 * 24 * 60 * 60 * 1000,
  },
  mini_importer: {
    key: 'mini_importer',
    label: 'Mini Importer License',
    emoji: '📦',
    cost: 4500,
    countries: ['turkey', 'china', 'brazil'],
    durationMs: 7 * 24 * 60 * 60 * 1000,
  },
  sme: {
    key: 'sme',
    label: 'SME License',
    emoji: '🛍️',
    cost: 7000,
    countries: ['spain', 'saudi'],
    durationMs: 7 * 24 * 60 * 60 * 1000,
  },
  importer: {
    key: 'importer',
    label: 'Importer License',
    emoji: '📦',
    cost: 14000,
    countries: ['france', 'uae'],
    durationMs: 7 * 24 * 60 * 60 * 1000,
  },
  pro_trader: {
    key: 'pro_trader',
    label: 'Pro Trader License',
    emoji: '🚚',
    cost: 20000,
    countries: ['germany'],
    durationMs: 7 * 24 * 60 * 60 * 1000,
  },
  global_trader: {
    key: 'global_trader',
    label: 'Global Trader License',
    emoji: '🌍',
    cost: 30000,
    countries: ['usa'],
    durationMs: 7 * 24 * 60 * 60 * 1000,
  },
} as const;

type LicenseTierKey = keyof typeof LICENSE_TIERS;

const LICENSE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const FORCED_RENEWAL_MULT = 1.6;
const FINE_MULT = 1.5;
const CLEARANCE_HOLD_HOURS = 24;
const BRIBE_COST_PERCENT = 30;
const MARKET_MARKUP = 1.6;

// ── Hubs ──────────────────────────────────────────────────────────────

export interface HubDef {
  key: string;
  label: string;
  courierRequired: boolean;
  courierFeePerUnit: number;
  priceMultiplier: number;
  bannedGoods?: string[];
}

export const HUBS: HubDef[] = [
  { key: 'lagos',   label: 'Lagos (Port)', courierRequired: false, courierFeePerUnit: 0,   priceMultiplier: 1.00, bannedGoods: [] },
  { key: 'onitsha', label: 'Onitsha',      courierRequired: true,  courierFeePerUnit: 150, priceMultiplier: 1.15, bannedGoods: [] },
  { key: 'aba',     label: 'Aba',          courierRequired: true,  courierFeePerUnit: 150, priceMultiplier: 1.12, bannedGoods: [] },
  { key: 'kano',    label: 'Kano',         courierRequired: true,  courierFeePerUnit: 180, priceMultiplier: 1.18, bannedGoods: ['olive_wine'] },
  { key: 'sokoto',  label: 'Sokoto',       courierRequired: true,  courierFeePerUnit: 180, priceMultiplier: 1.18, bannedGoods: ['olive_wine'] },
  { key: 'ph',      label: 'Port Harcourt', courierRequired: true, courierFeePerUnit: 180, priceMultiplier: 1.20, bannedGoods: [] },
];

// ── Stock ─────────────────────────────────────────────────────────────

export async function getStockLevel(countryKey: string): Promise<{ remaining: number; cap: number }> {
  const country = COUNTRIES.find(c => c.key === countryKey);
  if (!country) return { remaining: 0, cap: 0 };
  const stockKey = `${countryKey}:${todayStr()}`;
  const existing = await stockTbl.get(stockKey);
  const remaining = typeof existing === 'number' ? existing : country.dailyStockCap;
  return { remaining, cap: country.dailyStockCap };
}

async function decrementStock(countryKey: string, qty: number): Promise<boolean> {
  const { remaining } = await getStockLevel(countryKey);
  if (remaining < qty) return false;
  await stockTbl.set(`${countryKey}:${todayStr()}`, remaining - qty);
  return true;
}

// ── Stats ─────────────────────────────────────────────────────────────

async function getStats(userId: string): Promise<{ lifetimeProfit: number; completedShipments: number }> {
  const existing = await statsTbl.get(userId);
  return existing || { lifetimeProfit: 0, completedShipments: 0 };
}

export async function getPlayerRank(userId: string) {
  const stats = await getStats(userId);
  const profit = stats.lifetimeProfit;

  let current = RANK_DEFS[0];
  let unlockedCountries: string[] = [];
  let unlockedFreight: string[] = [];

  for (const rank of RANK_DEFS) {
    if (profit >= rank.lifetimeProfitThreshold) {
      current = rank;
      unlockedCountries = [...unlockedCountries, ...rank.addsCountries];
      unlockedFreight = [...unlockedFreight, ...rank.addsFreight];
    }
  }

  const currentIndex = RANK_DEFS.findIndex(r => r.key === current.key);
  const next = RANK_DEFS[currentIndex + 1] || null;

  return {
    key: current.key,
    label: current.label,
    emoji: current.emoji,
    lifetimeProfit: profit,
    nextThreshold: next ? next.lifetimeProfitThreshold : profit,
    unlockedCountries,
    unlockedFreight,
  };
}

// ── License System ────────────────────────────────────────────────────

interface LicenseRecord {
  tier: LicenseTierKey;
  expiresAt: number;
}

async function getLicenseRecord(userId: string, tierKey: LicenseTierKey): Promise<LicenseRecord | null> {
  const all = (await licensesTbl.get(userId)) || {};
  return all[tierKey] || null;
}

async function setLicenseRecord(userId: string, tierKey: LicenseTierKey, expiresAt: number): Promise<void> {
  const all = (await licensesTbl.get(userId)) || {};
  all[tierKey] = { tier: tierKey, expiresAt };
  await licensesTbl.set(userId, all);
}

function isLicenseValid(record: LicenseRecord | null): boolean {
  return !!record && record.expiresAt > Date.now();
}

async function hasValidLicenseForCountry(userId: string, countryKey: string): Promise<boolean> {
  const all = (await licensesTbl.get(userId)) || {};
  for (const [tierKey, record] of Object.entries(all)) {
    if (!isLicenseValid(record as LicenseRecord)) continue;
    const tier = LICENSE_TIERS[tierKey as LicenseTierKey];
    if (tier && tier.countries.includes(countryKey)) {
      return true;
    }
  }
  return false;
}

export async function getLicenseStatus(userId: string) {
  const all = (await licensesTbl.get(userId)) || {};
  const rank = await getPlayerRank(userId);
  const tierKeys = Object.keys(LICENSE_TIERS) as LicenseTierKey[];

  return tierKeys.map(tierKey => {
    const tier = LICENSE_TIERS[tierKey];
    const record = all[tierKey] || null;
    const isValid = isLicenseValid(record);
    const isEligible = rank.unlockedCountries.some(c => tier.countries.includes(c));

    return {
      tierKey,
      tierLabel: `${tier.emoji} ${tier.label}`,
      countries: tier.countries.map(c => {
        const country = COUNTRIES.find(ct => ct.key === c);
        return country ? `${country.emoji} ${country.label}` : c;
      }).join(', '),
      cost: tier.cost,
      expiresAt: record ? record.expiresAt : null,
      isValid,
      isEligible,
      hasLicense: !!record,
    };
  });
}

export async function buyLicense(
  userId: string,
  tierKey: LicenseTierKey
): Promise<{ success: boolean; reason?: string; cost?: number }> {
  const tier = LICENSE_TIERS[tierKey];
  if (!tier) return { success: false, reason: 'Invalid license tier.' };

  const rank = await getPlayerRank(userId);
  const hasEligibility = rank.unlockedCountries.some(c => tier.countries.includes(c));
  if (!hasEligibility) {
    return { success: false, reason: 'You haven\'t unlocked this tier yet.' };
  }

  const existing = await getLicenseRecord(userId, tierKey);
  if (existing && isLicenseValid(existing)) {
    return { success: false, reason: 'You already have a valid license for this tier.' };
  }

  const cost = tier.cost;
  const result = await deductCoins(userId, cost, { type: 'admin_debit', note: `buy license: ${tierKey}` });
  if (!result.success) return { success: false, reason: 'insufficient_funds' };

  await contributeToJackpot(cost);
  await setLicenseRecord(userId, tierKey, Date.now() + tier.durationMs);
  return { success: true, cost };
}

export async function renewLicense(
  userId: string,
  tierKey: LicenseTierKey,
  forced = false
): Promise<{ success: boolean; reason?: string; cost?: number }> {
  const tier = LICENSE_TIERS[tierKey];
  if (!tier) return { success: false, reason: 'Invalid license tier.' };

  const cost = forced ? Math.round(tier.cost * FORCED_RENEWAL_MULT) : tier.cost;
  const result = await deductCoins(userId, cost, { type: 'admin_debit', note: `${forced ? 'forced ' : ''}renew license: ${tierKey}` });
  if (!result.success) return { success: false, reason: 'insufficient_funds' };

  await contributeToJackpot(cost);
  await setLicenseRecord(userId, tierKey, Date.now() + tier.durationMs);
  return { success: true, cost };
}

// ── Shipment with Events ─────────────────────────────────────────────

export interface Shipment {
  id: string;
  userId: string;
  countryKey: string;
  countryLabel: string;
  goodKey: string;
  goodLabel: string;
  freightKey: string;
  freightLabel: string;
  qty: number;
  goodsCost: number;
  freightCost: number;
  totalCost: number;
  createdAt: number;
  travelTimeMs: number;
  status: 'in_transit' | 'cleared_unsold' | 'seized' | 'sold';
  dutyPaid: number | null;
  bribePaid: number | null;
  quality: number;
  hub: string | null;
  soldAt: number | null;
  clearedAt: number | null;
  triggeredEvents: string[];
}

// ── Event definitions ────────────────────────────────────────────────

export const EVENT_TYPES = {
  DELAY: 'delay',
  PIRATES: 'pirates',
  TEMPERATURE: 'temperature',
} as const;

type EventType = typeof EVENT_TYPES[keyof typeof EVENT_TYPES];

interface EventDef {
  type: EventType;
  cost: number;
  description: string;
  successEffect: (shipment: Shipment) => void;
  failEffect: (shipment: Shipment) => void;
}

export const EVENT_CONFIG: Record<EventType, EventDef> = {
  delay: {
    type: 'delay',
    cost: 3000,
    description: '⚠️ Your cargo ship is delayed. Pay 3,000 to reroute?',
    successEffect: (s) => { s.travelTimeMs = Math.round(s.travelTimeMs * 0.8); },
    failEffect: (s) => { s.travelTimeMs = Math.round(s.travelTimeMs * 1.3); },
  },
  pirates: {
    type: 'pirates',
    cost: 5000,
    description: '⚠️ Pirates detected. Hire escort for 5,000?',
    successEffect: () => {},
    failEffect: (s) => { s.quality *= 0.6; },
  },
  temperature: {
    type: 'temperature',
    cost: 2000,
    description: '⚠️ Cargo temperature rising. Buy cooling for 2,000?',
    successEffect: () => {},
    failEffect: (s) => { s.quality *= 0.75; },
  },
};

// ── Event checking ───────────────────────────────────────────────────

function getProgress(shipment: Shipment): number {
  if (shipment.status !== 'in_transit') return 1;
  const elapsed = Date.now() - shipment.createdAt;
  return Math.min(1, elapsed / shipment.travelTimeMs);
}

const EVENT_MILESTONES = [0.20, 0.50, 0.80];

export function getPendingEvents(shipment: Shipment): EventType[] {
  if (shipment.status !== 'in_transit') return [];
  const progress = getProgress(shipment);
  const triggered = new Set(shipment.triggeredEvents || []);
  const pending: EventType[] = [];

  for (const milestone of EVENT_MILESTONES) {
    if (progress >= milestone) {
      const seed = shipment.id + milestone.toString();
      let hash = 0;
      for (let i = 0; i < seed.length; i++) {
        hash = (hash << 5) - hash + seed.charCodeAt(i);
        hash |= 0;
      }
      const eventIndex = Math.abs(hash) % 3;
      const eventType = Object.values(EVENT_TYPES)[eventIndex];
      if (!triggered.has(eventType)) {
        pending.push(eventType);
      }
    }
  }
  return pending;
}

export async function resolveEvent(
  userId: string,
  shipmentId: string,
  eventType: EventType,
  choice: 'pay' | 'decline'
): Promise<{ success: boolean; reason?: string; outcome?: string }> {
  const all = await getAllShipments(userId);
  const idx = all.findIndex(s => s.id === shipmentId);
  if (idx === -1) return { success: false, reason: 'Shipment not found.' };

  const shipment = all[idx];
  const config = EVENT_CONFIG[eventType];
  if (!config) return { success: false, reason: 'Unknown event.' };

  if (shipment.triggeredEvents.includes(eventType)) {
    return { success: false, reason: 'Event already resolved.' };
  }

  let outcome: string;
  if (choice === 'pay') {
    const deducted = await deductCoins(userId, config.cost, { type: 'admin_debit', note: `event payment: ${eventType}` });
    if (!deducted.success) {
      return { success: false, reason: 'Not enough coins to pay.' };
    }
    await contributeToJackpot(config.cost);
    config.successEffect(shipment);
    outcome = `✅ Paid ${config.cost} – event resolved successfully.`;
  } else {
    config.failEffect(shipment);
    outcome = `❌ Declined – you suffered the consequences.`;
  }

  shipment.triggeredEvents.push(eventType);
  all[idx] = shipment;
  await saveShipments(userId, all);
  return { success: true, outcome };
}

// ── Shipment helpers ─────────────────────────────────────────────────

async function getAllShipments(userId: string): Promise<Shipment[]> {
  return (await shipmentsTbl.get(userId)) || [];
}

async function saveShipments(userId: string, list: Shipment[]): Promise<void> {
  await shipmentsTbl.set(userId, list);
}

function formatDuration(ms: number): string {
  const totalMins = Math.max(0, Math.round(ms / 60000));
  const days = Math.floor(totalMins / 1440);
  const hrs = Math.floor((totalMins % 1440) / 60);
  const mins = totalMins % 60;
  if (days > 0) return `${days}d ${hrs}h`;
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins}m`;
}

const TRANSIT_STAGES: Array<{ upTo: number; stage: string; label: string }> = [
  { upTo: 0.05, stage: 'order_placed', label: '📝 Order Placed' },
  { upTo: 0.10, stage: 'payment',       label: '💰 Payment Processing' },
  { upTo: 0.15, stage: 'documents',     label: '📄 Documents Issued' },
  { upTo: 0.20, stage: 'loading',       label: '📦 Loading Cargo' },
  { upTo: 0.25, stage: 'departed',      label: '🚢 Departed' },
  { upTo: 0.90, stage: 'in_transit',    label: '🌊 In Transit' },
  { upTo: 1.00, stage: 'approaching',   label: '🧭 Approaching Nigeria' },
];

export async function getShipmentProgress(shipment: Shipment) {
  if (shipment.status === 'cleared_unsold') return { stage: 'cleared_unsold', pct: 100, etaMs: 0, label: '✅ Cleared — ready to sell' };
  if (shipment.status === 'seized') return { stage: 'seized', pct: 100, etaMs: 0, label: '❌ Seized' };
  if (shipment.status === 'sold') return { stage: 'sold', pct: 100, etaMs: 0, label: '🏪 Sold' };

  const elapsed = Date.now() - shipment.createdAt;
  const rawPct = Math.min(1, elapsed / shipment.travelTimeMs);

  if (rawPct >= 1) {
    return { stage: 'awaiting_clearance', pct: 100, etaMs: 0, label: '⚓ Arrived — Awaiting Clearance' };
  }

  const found = TRANSIT_STAGES.find(s => rawPct <= s.upTo) || TRANSIT_STAGES[TRANSIT_STAGES.length - 1];
  const etaMs = shipment.travelTimeMs - elapsed;
  return { stage: found.stage, pct: Math.round(rawPct * 100), etaMs, label: found.label };
}

export async function getActiveShipments(userId: string) {
  const all = await getAllShipments(userId);
  const active = all.filter(s => s.status !== 'sold');
  return Promise.all(active.map(async s => {
    const progress = await getShipmentProgress(s);
    const coarseStage =
      s.status === 'cleared_unsold' ? 'cleared_unsold' :
      s.status === 'seized' ? 'seized' :
      progress.stage === 'awaiting_clearance' ? 'awaiting_clearance' : 'in_transit';
    return { ...s, stage: coarseStage, etaLabel: formatDuration(progress.etaMs) };
  }));
}

// ── Source ────────────────────────────────────────────────────────────

export async function sourceShipment(userId: string, countryKey: string, freightKey: string, qty: number) {
  const country = COUNTRIES.find(c => c.key === countryKey);
  if (!country) return { success: false, reason: 'Unknown country.' };
  const freight = FREIGHT_TIERS.find(f => f.key === freightKey);
  if (!freight) return { success: false, reason: 'Unknown freight option.' };

  const good = GOODS[country.goodKey];
  if (!good) return { success: false, reason: 'Good not defined.' };

  const rank = await getPlayerRank(userId);
  if (!rank.unlockedCountries.includes(countryKey)) return { success: false, reason: 'Your rank hasn’t unlocked this country yet.' };
  if (!rank.unlockedFreight.includes(freightKey)) return { success: false, reason: 'Your rank hasn’t unlocked this freight option yet.' };

  const { remaining } = await getStockLevel(countryKey);
  if (remaining < qty) return { success: false, reason: `Only ${remaining} units left in today's supply.` };

  const goodsCost = good.baseCost * qty;
  const freightCost = Math.round(country.baseFreightFee * freight.costMult);
  const totalCost = goodsCost + freightCost;

  const deducted = await deductCoins(userId, totalCost, { type: 'admin_debit', note: `sourced ${qty}x ${good.label} from ${country.label}` });
  if (!deducted.success) return { success: false, reason: 'Not enough coins for that order.' };

  const stockOk = await decrementStock(countryKey, qty);
  if (!stockOk) {
    await addCoins(userId, totalCost, { type: 'admin_credit', note: 'refund: stock unavailable' });
    return { success: false, reason: 'That stock just sold out — try again or pick another country.' };
  }

  await contributeToJackpot(totalCost);

  const travelTimeMs = Math.round((country.distanceHrs * 3600000) / freight.speedMult);
  const shipment: Shipment = {
    id: `GT${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`,
    userId,
    countryKey,
    countryLabel: country.label,
    goodKey: good.key,
    goodLabel: good.label,
    freightKey,
    freightLabel: freight.label,
    qty,
    goodsCost,
    freightCost,
    totalCost,
    createdAt: Date.now(),
    travelTimeMs,
    status: 'in_transit',
    dutyPaid: null,
    bribePaid: null,
    quality: 1.0,
    hub: null,
    soldAt: null,
    clearedAt: null,
    triggeredEvents: [],
  };

  const all = await getAllShipments(userId);
  all.push(shipment);
  await saveShipments(userId, all);

  return {
    success: true,
    shipment: {
      id: shipment.id,
      totalCost,
      etaLabel: formatDuration(travelTimeMs),
    },
  };
}

// ── Clearance ─────────────────────────────────────────────────────────

export async function clearShipment(userId: string, shipmentId: string, opts: { bribe: boolean }) {
  const all = await getAllShipments(userId);
  const idx = all.findIndex(s => s.id === shipmentId);
  if (idx === -1) return { outcome: 'error', reason: 'Shipment not found.' };

  const shipment = all[idx];
  const progress = await getShipmentProgress(shipment);
  if (progress.stage !== 'awaiting_clearance') return { outcome: 'error', reason: 'Not ready for clearance yet.' };

  const country = COUNTRIES.find(c => c.key === shipment.countryKey)!;
  const good = GOODS[shipment.goodKey];
  if (!good) return { outcome: 'error', reason: 'Good data missing.' };

  const valid = await hasValidLicenseForCountry(userId, shipment.countryKey);

  const duty = Math.round(shipment.goodsCost * (country.dutyRatePercent / 100));

  if (valid) {
    const paid = await deductCoins(userId, duty, { type: 'admin_debit', note: `customs duty: ${shipmentId}` });
    if (!paid.success) return { outcome: 'error', reason: 'Not enough coins for duty.' };
    await contributeToJackpot(duty);

    shipment.status = 'cleared_unsold';
    shipment.dutyPaid = duty;
    shipment.quality = 1.0;
    shipment.clearedAt = Date.now();
    await saveShipments(userId, all);
    return { outcome: 'cleared', dutyPaid: duty, bribePaid: 0 };
  }

  if (!opts.bribe) {
    return seizeShipment(userId, all, idx, shipment);
  }

  const bribeCost = Math.round(duty * (BRIBE_COST_PERCENT / 100));
  const totalUpfront = duty + bribeCost;
  const paid = await deductCoins(userId, totalUpfront, { type: 'admin_debit', note: `duty + bribe: ${shipmentId}` });
  if (!paid.success) return { outcome: 'error', reason: 'Not enough coins for duty + bribe.' };
  await contributeToJackpot(totalUpfront);

  const baseChance = RISK_BRIBE_SUCCESS[country.risk];
  const adjustedChance = Math.min(1, Math.max(0.1, baseChance / good.customsRiskMod));
  const success = Math.random() < adjustedChance;

  if (success) {
    shipment.status = 'cleared_unsold';
    shipment.dutyPaid = duty;
    shipment.bribePaid = bribeCost;
    shipment.quality = 0.9;
    shipment.clearedAt = Date.now();
    await saveShipments(userId, all);
    return { outcome: 'cleared', dutyPaid: duty, bribePaid: bribeCost };
  }

  return seizeShipment(userId, all, idx, shipment);
}

async function seizeShipment(userId: string, all: Shipment[], idx: number, shipment: Shipment) {
  const fine = Math.round(shipment.totalCost * FINE_MULT);
  const finePaid = await deductCoins(userId, fine, { type: 'admin_debit', note: `customs seizure fine: ${shipment.id}` });
  if (finePaid.success) await contributeToJackpot(fine);

  let tierKey: LicenseTierKey | null = null;
  for (const [key, tier] of Object.entries(LICENSE_TIERS)) {
    if (tier.countries.includes(shipment.countryKey)) {
      tierKey = key as LicenseTierKey;
      break;
    }
  }

  let renewalSucceeded = false;
  if (tierKey) {
    const renewal = await renewLicense(userId, tierKey, true);
    renewalSucceeded = renewal.success;
  }

  shipment.status = 'seized';
  all[idx] = shipment;
  await saveShipments(userId, all);

  return {
    outcome: 'seized',
    fine: finePaid.success ? fine : 0,
    forcedRenewalCost: renewalSucceeded ? fine : 0,
    holdHours: CLEARANCE_HOLD_HOURS,
    renewalSucceeded,
  };
}

// ── Market & Selling ─────────────────────────────────────────────────

async function getUnitsSoldToday(goodKey: string, hub: string): Promise<number> {
  const key = `${goodKey}:${hub}:${todayStr()}`;
  return (await marketTbl.get(key)) || 0;
}

async function addUnitsSoldToday(goodKey: string, hub: string, qty: number): Promise<void> {
  const key = `${goodKey}:${hub}:${todayStr()}`;
  const current = await getUnitsSoldToday(goodKey, hub);
  await marketTbl.set(key, current + qty);
}

export async function getMarketPrice(goodKey: string, hubKey: string): Promise<number> {
  const good = GOODS[goodKey];
  const hub = HUBS.find(h => h.key === hubKey);
  if (!good || !hub) return 0;

  const dailyShift = 1 + (good.priceVolatility * (Math.random() - 0.5) * 0.4);
  const base = good.baseCost * (MARKET_MARKUP + good.profitMarginBonus) * dailyShift;

  const soldToday = await getUnitsSoldToday(goodKey, hubKey);
  const depletionFactor = Math.max(0.6, 1 - (soldToday * 0.002) * (1 - good.demandStability * 0.5));

  return Math.round(base * hub.priceMultiplier * depletionFactor);
}

function resolveCourierRisk(theftRisk: number): { deliveredFraction: number; note: string } {
  const troubleChance = 0.05 + theftRisk * 0.3;
  const roll = Math.random();
  if (roll < troubleChance) {
    if (roll < troubleChance * 0.5) return { deliveredFraction: 0, note: 'Total loss — bandit attack.' };
    return { deliveredFraction: 0.7, note: 'Bandits hit — some units lost.' };
  }
  return { deliveredFraction: 1.0, note: 'Delivered safely.' };
}

export async function sellGoods(userId: string, shipmentId: string, hubKey: string, qty: number) {
  const all = await getAllShipments(userId);
  const idx = all.findIndex(s => s.id === shipmentId);
  if (idx === -1) return { success: false, reason: 'Shipment not found.' };

  const shipment = all[idx];
  if (shipment.status !== 'cleared_unsold') return { success: false, reason: 'That shipment isn’t cleared and ready to sell.' };

  const hub = HUBS.find(h => h.key === hubKey);
  if (!hub) return { success: false, reason: 'Unknown market hub.' };

  const good = GOODS[shipment.goodKey];
  if (!good) return { success: false, reason: 'Good data missing.' };

  if (hub.bannedGoods && hub.bannedGoods.includes(good.key)) {
    return { success: false, reason: `This good cannot be sold in ${hub.label}.` };
  }

  if (shipment.clearedAt) {
    const age = Date.now() - shipment.clearedAt;
    const expiryMs = good.expirationHours * 3600000;
    if (age > expiryMs) {
      const spoilFactor = Math.max(0.1, 1 - ((age - expiryMs) / expiryMs) * 0.8);
      const spoiledQty = Math.round(shipment.qty * spoilFactor);
      if (spoiledQty === 0) {
        shipment.status = 'sold';
        shipment.soldAt = Date.now();
        all[idx] = shipment;
        await saveShipments(userId, all);
        return { success: false, reason: 'Goods have spoiled completely. Shipment discarded.' };
      }
      shipment.qty = spoiledQty;
    }
  }

  let courierFee = 0;
  let deliveredQty = shipment.qty;
  let courierNote = '';
  if (hub.courierRequired) {
    courierFee = hub.courierFeePerUnit * shipment.qty;
    const feeResult = await deductCoins(userId, courierFee, { type: 'admin_debit', note: `courier to ${hub.label}` });
    if (!feeResult.success) return { success: false, reason: 'Not enough coins for the courier fee.' };
    await contributeToJackpot(courierFee);

    const risk = resolveCourierRisk(good.theftRisk);
    deliveredQty = Math.round(shipment.qty * risk.deliveredFraction);
    courierNote = risk.note;
  }

  if (deliveredQty === 0) {
    shipment.status = 'sold';
    shipment.soldAt = Date.now();
    all[idx] = shipment;
    await saveShipments(userId, all);
    return { success: false, reason: `Total loss in transit to ${hub.label}. ${courierNote}` };
  }

  const unitPrice = await getMarketPrice(good.key, hubKey);
  const gross = Math.round(unitPrice * deliveredQty * shipment.quality);

  const { payout, capped } = settleWin(gross, await getJackpotPool());
  await addCoins(userId, payout, { type: 'admin_credit', note: `sold ${deliveredQty}x ${good.label} @ ${hub.label}` });
  await deductFromJackpot(payout);
  await addUnitsSoldToday(good.key, hubKey, deliveredQty);

  const costBasis = shipment.totalCost + (shipment.dutyPaid || 0) + (shipment.bribePaid || 0) + courierFee;
  const profit = payout - costBasis;
  const marginPct = costBasis > 0 ? Math.round((profit / costBasis) * 100) : 0;

  shipment.status = 'sold';
  shipment.hub = hubKey;
  shipment.soldAt = Date.now();
  all[idx] = shipment;
  await saveShipments(userId, all);

  const stats = await getStats(userId);
  stats.lifetimeProfit += Math.max(0, profit);
  stats.completedShipments += 1;
  await statsTbl.set(userId, stats);

  return {
    success: true,
    hubLabel: hub.label,
    qty: deliveredQty,
    unitPrice,
    gross: payout,
    costBasis,
    profit,
    marginPct,
    capped,
    courierNote: courierNote || null,
  };
}