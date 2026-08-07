// @ts-nocheck
/***
 * lib/globalTraderEconomy.ts – Global Trader core trading engine.
 *
 * Mirrors the structure of lib/economy.ts (wallets/ledger) and lib/slotMachine.ts
 * (shared bank pool) rather than inventing new plumbing. Nothing here talks to
 * WhatsApp — plugins/globalTrader.ts calls these functions and handles messaging.
 *
 * Storage: same pluginStore pattern as economy.ts, under a 'globaltrader'
 * namespace, split into tables: shipments, licenses, stock, market, stats.
 *
 * Shared bank pool: this module deliberately reuses lib/slotMachine.ts's
 * jackpot pool (getJackpotPool / contributeToJackpot / deductFromJackpot /
 * settleWin) rather than keeping its own — every coin a trader spends on
 * goods, freight, duty, bribes, fines, or license renewal becomes real bank
 * capital the same instant a slot bet does, and every sale draws back out
 * of that same pool. Ocean Hunt and Global Trader are one shared economy.
 */

import { createStore } from './pluginStore.js';
import { deductCoins, addCoins, todayStr, formatNumber } from './economy.js';
import { getJackpotPool, contributeToJackpot, deductFromJackpot, settleWin } from './slotMachine.js';

const store = createStore('globaltrader');
const shipmentsTbl = store.table('shipments');
const licensesTbl  = store.table('licenses');
const stockTbl     = store.table('stock');
const marketTbl    = store.table('market');
const statsTbl     = store.table('stats');

// ── Goods Registry ─────────────────────────────────────────────────────

export interface GoodDef {
  key: string;
  label: string;
  baseCost: number;             // per unit at source
  priceVolatility: number;      // 0–1, daily price swing amplitude
  demandStability: number;      // 0–1, 1 = stable (depletion hurts less)
  expirationHours: number;      // after clearance, must sell within this many hours
  customsRiskMod: number;       // multiplier on bribe failure chance
  theftRisk: number;            // 0–1, extra chance of loss during road courier
  legalFlags: string[];         // e.g. 'bannedInKano'
  profitMarginBonus: number;    // added to base markup (e.g. 0.2 = 20% extra)
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
};

// ── Country Defs ──────────────────────────────────────────────────────

export type RiskTier = 'veryLow' | 'low' | 'medium' | 'high';

export interface CountryDef {
  key: string;
  label: string;
  emoji: string;
  goodKey: string;                // reference to GOODS
  baseFreightFee: number;
  distanceHrs: number;
  risk: RiskTier;
  dutyRatePercent: number;
  dailyStockCap: number;
  licenseRenewCost: number;
}

export const COUNTRIES: CountryDef[] = [
  { key: 'benin',   label: 'Benin',        emoji: '🇧🇯', goodKey: 'electronics',   baseFreightFee: 800,  distanceHrs: 6,  risk: 'high',   dutyRatePercent: 10, dailyStockCap: 200, licenseRenewCost: 1500 },
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

// ── Freight Defs ──────────────────────────────────────────────────────

export interface FreightDef {
  key: string;
  label: string;
  speedMult: number;
  costMult: number;
}

export const FREIGHT_TIERS: FreightDef[] = [
  { key: 'economy', label: 'Economy Sea Freight', speedMult: 1,   costMult: 1 },
  { key: 'express', label: 'Express Air Cargo',   speedMult: 2,   costMult: 2.2 },
  { key: 'premium', label: 'Premium Charter',      speedMult: 4,   costMult: 4 },
];

// ── Rank Defs ─────────────────────────────────────────────────────────

export interface RankDef {
  key: string;
  label: string;
  lifetimeProfitThreshold: number;
  addsCountries: string[];
  addsFreight: string[];
}

const RANK_DEFS: RankDef[] = [
  { key: 'hawker',      label: 'Hawker',       lifetimeProfitThreshold: 0,       addsCountries: ['benin', 'india', 'thailand'], addsFreight: ['economy'] },
  { key: 'retailer',    label: 'Retailer',     lifetimeProfitThreshold: 50000,   addsCountries: ['turkey', 'china', 'brazil'],  addsFreight: ['express'] },
  { key: 'wholesaler',  label: 'Wholesaler',   lifetimeProfitThreshold: 200000,  addsCountries: ['spain', 'saudi'],             addsFreight: ['premium'] },
  { key: 'distributor', label: 'Distributor',  lifetimeProfitThreshold: 600000,  addsCountries: ['france', 'uae'],              addsFreight: [] },
  { key: 'mogul',       label: 'Import Mogul', lifetimeProfitThreshold: 1500000, addsCountries: ['germany', 'usa'],             addsFreight: [] },
];

const LICENSE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const FORCED_RENEWAL_MULT = 1.6;
const FINE_MULT = 1.5;
const CLEARANCE_HOLD_HOURS = 24;
const BRIBE_COST_PERCENT = 30;
const MARKET_MARKUP = 1.6;      // base multiplier (bonus added per good)

// ── Hubs ──────────────────────────────────────────────────────────────

export interface HubDef {
  key: string;
  label: string;
  courierRequired: boolean;
  courierFeePerUnit: number;
  priceMultiplier: number;
  bannedGoods?: string[];       // goods that cannot be sold here
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
    lifetimeProfit: profit,
    nextThreshold: next ? next.lifetimeProfitThreshold : profit,
    unlockedCountries,
    unlockedFreight,
  };
}

// ── License ───────────────────────────────────────────────────────────

interface License {
  expiresAt: number;
}

async function getLicenseRecord(userId: string, countryKey: string): Promise<License | null> {
  const all = (await licensesTbl.get(userId)) || {};
  return all[countryKey] || null;
}

async function setLicenseRecord(userId: string, countryKey: string, expiresAt: number): Promise<void> {
  const all = (await licensesTbl.get(userId)) || {};
  all[countryKey] = { expiresAt };
  await licensesTbl.set(userId, all);
}

function isLicenseValid(license: License | null): boolean {
  return !!license && license.expiresAt > Date.now();
}

export async function getLicenseStatus(userId: string) {
  const all = (await licensesTbl.get(userId)) || {};
  return Object.entries(all).map(([countryKey, lic]: [string, License]) => {
    const country = COUNTRIES.find(c => c.key === countryKey);
    return {
      countryKey,
      countryLabel: country ? `${country.emoji} ${country.label}` : countryKey,
      expiresAt: lic.expiresAt,
      renewCost: country ? country.licenseRenewCost : 0,
    };
  });
}

export async function renewLicense(userId: string, countryKey: string, forced = false): Promise<{ success: boolean; reason?: string; cost?: number }> {
  const country = COUNTRIES.find(c => c.key === countryKey);
  if (!country) return { success: false, reason: 'invalid_country' };

  const cost = forced ? Math.round(country.licenseRenewCost * FORCED_RENEWAL_MULT) : country.licenseRenewCost;
  const result = await deductCoins(userId, cost, { type: 'admin_debit', note: `${forced ? 'forced ' : ''}license renewal: ${countryKey}` });
  if (!result.success) return { success: false, reason: 'insufficient_funds' };

  await contributeToJackpot(cost);
  await setLicenseRecord(userId, countryKey, Date.now() + LICENSE_DURATION_MS);
  return { success: true, cost };
}

// ── Shipment ──────────────────────────────────────────────────────────

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
}

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

  const license = await getLicenseRecord(userId, shipment.countryKey);
  const valid = isLicenseValid(license);

  const duty = Math.round(shipment.goodsCost * (country.dutyRatePercent / 100));

  // Case 1: valid license
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

  // Case 2: expired, no bribe
  if (!opts.bribe) {
    return seizeShipment(userId, all, idx, shipment);
  }

  // Case 3: expired + bribe
  const bribeCost = Math.round(duty * (BRIBE_COST_PERCENT / 100));
  const totalUpfront = duty + bribeCost;
  const paid = await deductCoins(userId, totalUpfront, { type: 'admin_debit', note: `duty + bribe: ${shipmentId}` });
  if (!paid.success) return { outcome: 'error', reason: 'Not enough coins for duty + bribe.' };
  await contributeToJackpot(totalUpfront);

  // Apply customs risk modifier
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

  // Bribe failed
  return seizeShipment(userId, all, idx, shipment);
}

async function seizeShipment(userId: string, all: Shipment[], idx: number, shipment: Shipment) {
  const fine = Math.round(shipment.totalCost * FINE_MULT);
  const finePaid = await deductCoins(userId, fine, { type: 'admin_debit', note: `customs seizure fine: ${shipment.id}` });
  if (finePaid.success) await contributeToJackpot(fine);

  const renewal = await renewLicense(userId, shipment.countryKey, true);

  shipment.status = 'seized';
  all[idx] = shipment;
  await shipmentsTbl.set(userId, all);

  return {
    outcome: 'seized',
    fine: finePaid.success ? fine : 0,
    forcedRenewalCost: renewal.success ? renewal.cost : 0,
    holdHours: CLEARANCE_HOLD_HOURS,
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

  // Check legal flags
  if (hub.bannedGoods && hub.bannedGoods.includes(good.key)) {
    return { success: false, reason: `This good cannot be sold in ${hub.label}.` };
  }

  // Check expiration
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