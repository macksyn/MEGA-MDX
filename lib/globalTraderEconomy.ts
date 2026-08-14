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
import {
  getPriceMultiplier,
  getGoodsCostMultiplier,
  getFreightCostMultiplier,
  getDutyRateDeltaPct,
  getCourierRiskDelta,
  getClearanceDelayMs,
  getEventsStatusBlock,
  getEventsDetailBlock,
} from './globalTraderEvents.js';

const store = createStore('globaltrader');
const shipmentsTbl = store.table('shipments');
const licensesTbl = store.table('licenses');
const stockTbl = store.table('stock');
const marketTbl = store.table('market');
const statsTbl = store.table('stats');
const equipmentTbl = store.table('equipment'); // userId -> { clearingAgent: tierKey, warehouse: tierKey }

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
  inspectionExtraDutyPct: number;    // regulated goods (e.g. NAFDAC-style checks) add duty
  inspectionDelayHrs: number;        // and add a clearance hold on top
  blackMarketSeizureChance: number;  // chance of confiscation if sold somewhere it's restricted
  blackMarketPriceBonus: number;     // price multiplier IF a black-market sale succeeds
  traitLine: string;                 // short player-facing personality summary
}

export const GOODS: Record<string, GoodDef> = {
  electronics: {
    key: 'electronics', label: 'Electronics', baseCost: 800,
    priceVolatility: 0.4, demandStability: 0.3, expirationHours: 120,
    customsRiskMod: 1.4, theftRisk: 0.3, legalFlags: [], profitMarginBonus: 0.35,
    inspectionExtraDutyPct: 3, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    traitLine: '⚡ High profit · demand swings hard · draws customs scrutiny',
  },
  pharmaceuticals: {
    key: 'pharmaceuticals', label: 'Pharmaceuticals', baseCost: 600,
    priceVolatility: 0.1, demandStability: 0.9, expirationHours: 72,
    customsRiskMod: 0.8, theftRisk: 0.1, legalFlags: ['requiresInspection'], profitMarginBonus: 0.05,
    inspectionExtraDutyPct: 5, inspectionDelayHrs: 6, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    traitLine: '🛡️ Stable demand · low profit · government inspection adds a hold',
  },
  rubber: {
    key: 'rubber', label: 'Rubber & Auto Parts', baseCost: 700,
    priceVolatility: 0.3, demandStability: 0.6, expirationHours: 240,
    customsRiskMod: 1.0, theftRisk: 0.2, legalFlags: [], profitMarginBonus: 0.15,
    inspectionExtraDutyPct: 0, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    traitLine: '⚙️ Steady, low-risk — no major surprises',
  },
  textiles: {
    key: 'textiles', label: 'Textiles', baseCost: 1500,
    priceVolatility: 0.2, demandStability: 0.7, expirationHours: 240,
    customsRiskMod: 1.0, theftRisk: 0.2, legalFlags: [], profitMarginBonus: 0.20,
    inspectionExtraDutyPct: 0, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    traitLine: '🧵 Reliable mid-tier margin',
  },
  food: {
    key: 'food', label: 'Food & Perishables', baseCost: 200,
    priceVolatility: 0.5, demandStability: 0.4, expirationHours: 24,
    customsRiskMod: 1.2, theftRisk: 0.4, legalFlags: [], profitMarginBonus: 0.15,
    inspectionExtraDutyPct: 0, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    traitLine: '🧊 Spoils fast — sell within a day or lose it',
  },
  coffee_leather: {
    key: 'coffee_leather', label: 'Coffee & Leather', baseCost: 2000,
    priceVolatility: 0.3, demandStability: 0.6, expirationHours: 168,
    customsRiskMod: 1.0, theftRisk: 0.3, legalFlags: [], profitMarginBonus: 0.25,
    inspectionExtraDutyPct: 0, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    traitLine: '🧊 Perishable — sell within about a week',
  },
  olive_wine: {
    key: 'olive_wine', label: 'Olive Oil & Wine', baseCost: 1800,
    priceVolatility: 0.7, demandStability: 0.2, expirationHours: 720,
    customsRiskMod: 1.8, theftRisk: 0.5, legalFlags: ['bannedInKano', 'bannedInSokoto'], profitMarginBonus: 0.8,
    inspectionExtraDutyPct: 0, inspectionDelayHrs: 0, blackMarketSeizureChance: 0.35, blackMarketPriceBonus: 1.6,
    traitLine: '🔞 Restricted in Kano & Sokoto — huge profit if you risk it there',
  },
  dates_textiles: {
    key: 'dates_textiles', label: 'Dates & Textiles', baseCost: 2200,
    priceVolatility: 0.2, demandStability: 0.8, expirationHours: 240,
    customsRiskMod: 0.9, theftRisk: 0.2, legalFlags: [], profitMarginBonus: 0.25,
    inspectionExtraDutyPct: 0, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    traitLine: '🧊 Dates age moderately — don\u2019t sit on this too long',
  },
  perfume_cosmetics: {
    key: 'perfume_cosmetics', label: 'Perfume & Cosmetics', baseCost: 4500,
    priceVolatility: 0.5, demandStability: 0.4, expirationHours: 720,
    customsRiskMod: 1.2, theftRisk: 0.4, legalFlags: [], profitMarginBonus: 0.6,
    inspectionExtraDutyPct: 0, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    traitLine: '✨ High profit · demand spikes around festive events',
  },
  gold_perfume: {
    key: 'gold_perfume', label: 'Gold & Perfume', baseCost: 5000,
    priceVolatility: 0.2, demandStability: 0.9, expirationHours: 9999,
    customsRiskMod: 2.0, theftRisk: 0.7, legalFlags: ['requiresExtraSecurity'], profitMarginBonus: 1.0,
    inspectionExtraDutyPct: 4, inspectionDelayHrs: 4, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    traitLine: '💰 Very expensive · prime bandit target · extra security screening',
  },
  machinery: {
    key: 'machinery', label: 'Machinery', baseCost: 6000,
    priceVolatility: 0.1, demandStability: 0.9, expirationHours: 9999,
    customsRiskMod: 0.6, theftRisk: 0.1, legalFlags: [], profitMarginBonus: 0.30,
    inspectionExtraDutyPct: 0, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    traitLine: '🏗️ Heavy, steady, hard to steal',
  },
  luxury_goods: {
    key: 'luxury_goods', label: 'Luxury Goods', baseCost: 7000,
    priceVolatility: 0.3, demandStability: 0.7, expirationHours: 9999,
    customsRiskMod: 0.7, theftRisk: 0.3, legalFlags: [], profitMarginBonus: 0.50,
    inspectionExtraDutyPct: 0, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    traitLine: '✨ High profit · event-sensitive demand · tempting target',
  },
  rice: {
    key: 'rice', label: 'Rice', baseCost: 300,
    priceVolatility: 0.1, demandStability: 0.9, expirationHours: 240,
    customsRiskMod: 0.8, theftRisk: 0.1, legalFlags: [], profitMarginBonus: 0.1,
    inspectionExtraDutyPct: 0, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    traitLine: '📦 Cheap, steady, low margin — a safe starter good',
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
  containerCapacity: number; // units a single freight payment covers — order more, pay for more containers
  distanceHrs: number;
  risk: RiskTier;
  dutyRatePercent: number;
  dailyStockCap: number;
  licenseRenewCost: number;
}

export const COUNTRIES: CountryDef[] = [
  { key: 'benin',   label: 'Cotonou',     emoji: '🇧🇯', goodKey: 'rice',          baseFreightFee: 800,  containerCapacity: 50, distanceHrs: 6,  risk: 'high',   dutyRatePercent: 10, dailyStockCap: 200, licenseRenewCost: 1500 },
  { key: 'india',   label: 'India',        emoji: '🇮🇳', goodKey: 'pharmaceuticals', baseFreightFee: 3000, containerCapacity: 45, distanceHrs: 30, risk: 'medium', dutyRatePercent: 12, dailyStockCap: 180, licenseRenewCost: 2500 },
  { key: 'thailand', label: 'Thailand',   emoji: '🇹🇭', goodKey: 'rubber',        baseFreightFee: 3000, containerCapacity: 45, distanceHrs: 30, risk: 'medium', dutyRatePercent: 12, dailyStockCap: 180, licenseRenewCost: 2500 },
  { key: 'turkey',   label: 'Turkey',      emoji: '🇹🇷', goodKey: 'textiles',      baseFreightFee: 2500, containerCapacity: 35, distanceHrs: 24, risk: 'low',    dutyRatePercent: 12, dailyStockCap: 130, licenseRenewCost: 4500 },
  { key: 'china',    label: 'China',       emoji: '🇨🇳', goodKey: 'electronics',   baseFreightFee: 4000, containerCapacity: 50, distanceHrs: 48, risk: 'medium', dutyRatePercent: 14, dailyStockCap: 200, licenseRenewCost: 5000 },
  { key: 'brazil',   label: 'Brazil',      emoji: '🇧🇷', goodKey: 'coffee_leather', baseFreightFee: 4500, containerCapacity: 35, distanceHrs: 48, risk: 'medium', dutyRatePercent: 14, dailyStockCap: 130, licenseRenewCost: 5500 },
  { key: 'spain',    label: 'Spain',       emoji: '🇪🇸', goodKey: 'olive_wine',    baseFreightFee: 2500, containerCapacity: 30, distanceHrs: 24, risk: 'low',    dutyRatePercent: 14, dailyStockCap: 110, licenseRenewCost: 7000 },
  { key: 'saudi',    label: 'Saudi Arabia', emoji: '🇸🇦', goodKey: 'dates_textiles', baseFreightFee: 2200, containerCapacity: 30, distanceHrs: 18, risk: 'low',    dutyRatePercent: 14, dailyStockCap: 110, licenseRenewCost: 7500 },
  { key: 'france',   label: 'France',      emoji: '🇫🇷', goodKey: 'perfume_cosmetics', baseFreightFee: 5000, containerCapacity: 20, distanceHrs: 40, risk: 'low',   dutyRatePercent: 18, dailyStockCap: 70,  licenseRenewCost: 14000 },
  { key: 'uae',      label: 'UAE',         emoji: '🇦🇪', goodKey: 'gold_perfume',   baseFreightFee: 1500, containerCapacity: 15, distanceHrs: 12, risk: 'low',    dutyRatePercent: 18, dailyStockCap: 60,  licenseRenewCost: 16000 },
  { key: 'germany',  label: 'Germany',     emoji: '🇩🇪', goodKey: 'machinery',     baseFreightFee: 6000, containerCapacity: 15, distanceHrs: 48, risk: 'veryLow', dutyRatePercent: 20, dailyStockCap: 60, licenseRenewCost: 20000 },
  { key: 'usa',      label: 'USA',         emoji: '🇺🇸', goodKey: 'luxury_goods',  baseFreightFee: 6000, containerCapacity: 15, distanceHrs: 48, risk: 'low',    dutyRatePercent: 20, dailyStockCap: 60,  licenseRenewCost: 20000 },
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
  { key: 'cma', label: 'CMA CGM', speedMult: 1.3, costMult: 1.4 },
  { key: 'maersk', label: 'Maersk', speedMult: 1.8, costMult: 2.2 },
  { key: 'one', label: 'Ocean Network Express (ONE)', speedMult: 2.3, costMult: 2.8 },
  { key: 'cosco', label: 'Cosco Shipping', speedMult: 2.8, costMult: 3.2 },
];
// Real-world note: these 5 are all container-shipping lines, not air freight —
// keeping the spread within ~3x (was 1x–7x) reflects that they compete in the
// same speed class rather than implying one is an air carrier.

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
  courierName: string | null;
  courierFeePerUnit: number;
  priceMultiplier: number;
  bannedGoods?: string[]; // used only to flag black-market risk now, not to hard-block a sale
}

export const HUBS: HubDef[] = [
  { key: 'lagos',   label: 'Lagos (Port)', courierRequired: false, courierName: null,                     courierFeePerUnit: 0,   priceMultiplier: 1.00, bannedGoods: [] },
  { key: 'onitsha', label: 'Onitsha',      courierRequired: true,  courierName: 'GIG Logistics',           courierFeePerUnit: 150, priceMultiplier: 1.15, bannedGoods: [] },
  { key: 'aba',     label: 'Aba',          courierRequired: true,  courierName: 'GIG Logistics',           courierFeePerUnit: 150, priceMultiplier: 1.12, bannedGoods: [] },
  { key: 'kano',    label: 'Kano',         courierRequired: true,  courierName: 'ABC Transport',           courierFeePerUnit: 180, priceMultiplier: 1.18, bannedGoods: ['olive_wine'] },
  { key: 'sokoto',  label: 'Sokoto',       courierRequired: true,  courierName: 'ABC Transport',           courierFeePerUnit: 180, priceMultiplier: 1.18, bannedGoods: ['olive_wine'] },
  { key: 'ph',      label: 'Port Harcourt', courierRequired: true, courierName: 'Young Shall Grow Motors', courierFeePerUnit: 180, priceMultiplier: 1.20, bannedGoods: [] },
];

// ── Equipment: Clearing Agent (customs risk) & Warehouse (capacity + holding) ──
// This entire track was missing from the last build — restoring it here.

export interface AgentDef {
  tier: string;
  displayName: string;
  cost: number;
  bribeSuccessBonus: number;
  fineMultReduction: number;
}

export const CLEARING_AGENT_DEFS: AgentDef[] = [
  { tier: 'localFixer',     displayName: 'Local Fixer',     cost: 0,     bribeSuccessBonus: 0,    fineMultReduction: 0 },
  { tier: 'licensedBroker', displayName: 'Licensed Broker', cost: 3000,  bribeSuccessBonus: 0.08, fineMultReduction: 0.10 },
  { tier: 'customsBroker',  displayName: 'Customs Broker',  cost: 12000, bribeSuccessBonus: 0.15, fineMultReduction: 0.20 },
  { tier: 'customsInsider', displayName: 'Customs Insider', cost: 40000, bribeSuccessBonus: 0.25, fineMultReduction: 0.35 },
];

export interface WarehouseDef {
  tier: string;
  displayName: string;
  cost: number;
  capacity: number;
  freeHoldingDays: number;
  holdingFeePerUnitPerDay: number;
  preservationFactor: number; // multiplies effective aging speed for expiry — lower is better (cold storage)
}

export const WAREHOUSE_DEFS: WarehouseDef[] = [
  { tier: 'dockside', displayName: 'Dockside Storage',  cost: 0,     capacity: 1, freeHoldingDays: 1, holdingFeePerUnitPerDay: 20, preservationFactor: 1.0 },
  { tier: 'rented',   displayName: 'Rented Warehouse',  cost: 5000,  capacity: 3, freeHoldingDays: 2, holdingFeePerUnitPerDay: 15, preservationFactor: 0.85 },
  { tier: 'private',  displayName: 'Private Warehouse', cost: 20000, capacity: 5, freeHoldingDays: 3, holdingFeePerUnitPerDay: 10, preservationFactor: 0.60 },
  { tier: 'bonded',   displayName: 'Bonded Warehouse',  cost: 60000, capacity: 8, freeHoldingDays: 5, holdingFeePerUnitPerDay: 5,  preservationFactor: 0.35 },
];

interface TraderEquipment { clearingAgent: string; warehouse: string; }
const DEFAULT_EQUIPMENT: TraderEquipment = { clearingAgent: 'localFixer', warehouse: 'dockside' };

export async function getEquipment(userId: string) {
  const stored = (await equipmentTbl.get(userId)) || {};
  const equipment: TraderEquipment = { ...DEFAULT_EQUIPMENT, ...stored };
  return {
    tiers: equipment,
    agent: CLEARING_AGENT_DEFS.find(a => a.tier === equipment.clearingAgent) || CLEARING_AGENT_DEFS[0],
    warehouse: WAREHOUSE_DEFS.find(w => w.tier === equipment.warehouse) || WAREHOUSE_DEFS[0],
  };
}

export async function buyEquipment(userId: string, type: 'clearingAgent' | 'warehouse', tier: string) {
  const defs = type === 'clearingAgent' ? CLEARING_AGENT_DEFS : WAREHOUSE_DEFS;
  const def = defs.find(d => d.tier === tier);
  if (!def) return { success: false, reason: 'Unknown tier.' };

  const current = await getEquipment(userId);
  const currentTier = type === 'clearingAgent' ? current.tiers.clearingAgent : current.tiers.warehouse;
  if (currentTier === tier) return { success: false, reason: 'Already equipped.' };

  const paid = await deductCoins(userId, def.cost, { type: 'admin_debit', note: `bought ${type}: ${tier}` });
  if (!paid.success) return { success: false, reason: 'Not enough coins.' };
  await contributeToJackpot(def.cost);

  const stored = (await equipmentTbl.get(userId)) || { ...DEFAULT_EQUIPMENT };
  stored[type] = tier;
  await equipmentTbl.set(userId, stored);
  return { success: true, def };
}

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
  costFraction: number; // % of shipment.totalCost — BUG FIX: was a flat coin amount before, which crushed small starter shipments and was trivial for large ones
  minCost: number;
  buildDescription: (cost: number) => string;
  successEffect: (shipment: Shipment) => void;
  failEffect: (shipment: Shipment) => void;
}

export const EVENT_CONFIG: Record<EventType, EventDef> = {
  delay: {
    type: 'delay',
    costFraction: 0.08,
    minCost: 800,
    buildDescription: (cost) => `⚠️ Your cargo ship is delayed. Pay ${formatNumber(cost)} to reroute?`,
    // BUG FIX: this used to multiply travelTimeMs directly, which retroactively
    // changed what "50% done" meant for time that had already elapsed, making
    // the progress bar jump forward or snap backward. Now it only shifts the
    // REMAINING time, by nudging createdAt — already-elapsed progress is untouched.
    successEffect: (s) => {
      const elapsed = Date.now() - s.createdAt;
      const remaining = Math.max(0, s.travelTimeMs - elapsed);
      s.createdAt -= Math.round(remaining * 0.2); // arrives ~20% of the remaining time sooner
    },
    failEffect: (s) => {
      const elapsed = Date.now() - s.createdAt;
      const remaining = Math.max(0, s.travelTimeMs - elapsed);
      s.createdAt += Math.round(remaining * 0.3); // arrives ~30% of the remaining time later
    },
  },
  pirates: {
    type: 'pirates',
    costFraction: 0.12,
    minCost: 1200,
    buildDescription: (cost) => `⚠️ Pirates detected. Hire escort for ${formatNumber(cost)}?`,
    successEffect: () => {},
    failEffect: (s) => { s.quality *= 0.6; },
  },
  temperature: {
    type: 'temperature',
    costFraction: 0.06,
    minCost: 600,
    buildDescription: (cost) => `⚠️ Cargo temperature rising. Buy cooling for ${formatNumber(cost)}?`,
    successEffect: () => {},
    failEffect: (s) => { s.quality *= 0.75; },
  },
};

export function getEventCost(shipment: Shipment, eventType: EventType): number {
  const config = EVENT_CONFIG[eventType];
  return Math.max(config.minCost, Math.round(shipment.totalCost * config.costFraction));
}

export function getEventDescription(shipment: Shipment, eventType: EventType): string {
  return EVENT_CONFIG[eventType].buildDescription(getEventCost(shipment, eventType));
}

// ── Event checking ───────────────────────────────────────────────────

function getProgress(shipment: Shipment): number {
  if (shipment.status !== 'in_transit') return 1;
  const elapsed = Date.now() - shipment.createdAt;
  return Math.min(1, elapsed / shipment.travelTimeMs);
}

const EVENT_MILESTONES = [0.20, 0.50, 0.80];
// BUG FIX: previously an event ALWAYS fired at every passed milestone
// (guaranteed 3 per shipment) — deterministic per shipment so it doesn't
// flicker between reads, but no longer guaranteed, matching "occasional
// flavor" rather than a mandatory tollbooth on every single shipment.
const EVENT_TRIGGER_CHANCE = 0.45;

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
      const absHash = Math.abs(hash);
      const triggerRoll = (absHash % 1000) / 1000;
      if (triggerRoll < EVENT_TRIGGER_CHANCE) {
        const eventIndex = Math.abs(hash >> 3) % 3;
        const eventType = Object.values(EVENT_TYPES)[eventIndex];
        if (!triggered.has(eventType)) {
          pending.push(eventType);
        }
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

  const cost = getEventCost(shipment, eventType);
  let outcome: string;
  if (choice === 'pay') {
    const deducted = await deductCoins(userId, cost, { type: 'admin_debit', note: `event payment: ${eventType}` });
    if (!deducted.success) {
      return { success: false, reason: 'Not enough coins to pay.' };
    }
    await contributeToJackpot(cost);
    config.successEffect(shipment);
    outcome = `✅ Paid ${formatNumber(cost)} – event resolved successfully.`;
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
    // Port Strike backs up clearance for everyone; a regulated good (e.g.
    // Pharmaceuticals, Gold) adds its own inspection hold on top — both
    // checked live, so either lifting shortens the wait immediately.
    const good = GOODS[shipment.goodKey];
    const strikeDelayMs = await getClearanceDelayMs();
    const inspectionDelayMs = (good?.inspectionDelayHrs || 0) * 3600000;
    const clearanceDelayMs = strikeDelayMs + inspectionDelayMs;
    const timeSinceArrival = elapsed - shipment.travelTimeMs;
    if (clearanceDelayMs > 0 && timeSinceArrival < clearanceDelayMs) {
      const remaining = clearanceDelayMs - timeSinceArrival;
      const label = inspectionDelayMs > 0 && strikeDelayMs > 0
        ? '⚓ Arrived — Backlog + Inspection Hold'
        : inspectionDelayMs > 0
          ? '⚓ Arrived — Regulatory Inspection'
          : '⚓ Arrived — Customs Backlog (Port Strike)';
      return { stage: 'arrived', pct: 100, etaMs: remaining, label };
    }
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

  const existingShipments = await getAllShipments(userId);
  const activeCount = existingShipments.filter(s => s.status === 'in_transit' || s.status === 'cleared_unsold').length;
  const { warehouse } = await getEquipment(userId);
  if (activeCount >= warehouse.capacity) {
    return { success: false, reason: `Warehouse full (${activeCount}/${warehouse.capacity}). Sell or clear something first, or upgrade your warehouse.` };
  }

  // Nigerian conditions bleed into import cost too — Dollar Scarcity makes
  // everything you bring in more expensive before it even ships.
  const goodsCostMult = await getGoodsCostMultiplier();
  const freightCostMult = await getFreightCostMultiplier();

  // Freight pays for container capacity, not a flat toll — order more than
  // one container's worth of units and you need (and pay for) another one.
  // Without this, a 5-unit order and a 200-unit order cost the same freight,
  // which isn't how shipping actually works.
  const containersNeeded = Math.ceil(qty / country.containerCapacity);

  const goodsCost = Math.round(good.baseCost * qty * goodsCostMult);
  const freightCost = Math.round(country.baseFreightFee * freight.costMult * freightCostMult * containersNeeded);
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
    containersUsed: containersNeeded,
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

  // A New Customs Tariff or Port Strike adds points nationwide; a regulated
  // good (Pharmaceuticals, Gold) adds its own inspection surcharge on top.
  const dutyDeltaPct = await getDutyRateDeltaPct();
  const effectiveDutyRate = country.dutyRatePercent + dutyDeltaPct + good.inspectionExtraDutyPct;
  const duty = Math.round(shipment.goodsCost * (effectiveDutyRate / 100));

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

  const { agent } = await getEquipment(userId);
  const baseChance = RISK_BRIBE_SUCCESS[country.risk];
  const adjustedChance = Math.min(0.97, Math.max(0.1, (baseChance / good.customsRiskMod) + agent.bribeSuccessBonus));
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
  const { agent } = await getEquipment(userId);
  const effectiveFineMult = Math.max(1.0, FINE_MULT - agent.fineMultReduction);
  const fine = Math.round(shipment.totalCost * effectiveFineMult);
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
  let renewalCost = 0;
  if (tierKey) {
    const renewal = await renewLicense(userId, tierKey, true);
    renewalSucceeded = renewal.success;
    renewalCost = renewal.success ? (renewal.cost || 0) : 0; // BUG FIX: this used to report `fine` here, not the actual renewal cost
  }

  shipment.status = 'seized';
  all[idx] = shipment;
  await saveShipments(userId, all);

  return {
    outcome: 'seized',
    fine: finePaid.success ? fine : 0,
    forcedRenewalCost: renewalCost,
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

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

/**
 * Deterministic per (good, hub, day) demand wobble — same shape as the
 * original -20%..+20%*volatility swing, but stable across repeated reads
 * within the same day. This fixes a real bug: the old version called
 * Math.random() fresh on every call, so the estimated price shown in the
 * sell-hub picker could silently differ from the price actually charged a
 * few seconds later when the sale executed.
 */
function getDemandWobble(goodKey: string, hubKey: string, volatility: number): number {
  if (volatility <= 0) return 1;
  const hash = hashString(`${goodKey}:${hubKey}:${todayStr()}`);
  const normalized = (hash % 1000) / 1000; // 0..1
  const swing = (normalized * 2 - 1) * volatility * 0.4;
  return 1 + swing;
}

/**
 * How hard a hub's market has been hit by selling today, as a multiplier
 * on price (1 = full price, floor = fully dumped).
 *
 * Curve: floor + (1-floor) * e^(-rate * units^power), fitted directly
 * against the target depletion table for a volatile (demandStability = 0)
 * good:
 *   20 units  → ~98%     100 units → ~83%
 *   50 units  → ~92%     200 units → ~67%     300 units → ~55%
 * i.e. dumping a market meaningfully collapses the price well before
 * anyone reaches "sell everything in one hub" territory — a handful of
 * players discovering the same good/hub combo runs into diminishing
 * returns fast instead of draining it at near-full price.
 *
 * demandStability (0..1, per good) softens the curve for staple goods and
 * sharpens it for volatile ones: stability 1 halves the effective rate,
 * stability 0 applies the raw curve above at full strength.
 */
const DEPLETION_FLOOR = 0.28;
const DEPLETION_RATE = 0.00125;
const DEPLETION_POWER = 1.17;

function getDepletionFactor(unitsSold: number, demandStability: number): number {
  if (unitsSold <= 0) return 1;
  const effectiveRate = DEPLETION_RATE * (1 - demandStability * 0.5);
  const decay = Math.exp(-effectiveRate * Math.pow(unitsSold, DEPLETION_POWER));
  return DEPLETION_FLOOR + (1 - DEPLETION_FLOOR) * decay;
}

export async function getMarketPrice(goodKey: string, hubKey: string): Promise<number> {
  const good = GOODS[goodKey];
  const hub = HUBS.find(h => h.key === hubKey);
  if (!good || !hub) return 0;

  const wobble = getDemandWobble(goodKey, hubKey, good.priceVolatility);
  const eventMultiplier = await getPriceMultiplier(goodKey, hubKey);
  const base = good.baseCost * (MARKET_MARKUP + good.profitMarginBonus) * wobble * eventMultiplier;

  const soldToday = await getUnitsSoldToday(goodKey, hubKey);
  const depletionFactor = getDepletionFactor(soldToday, good.demandStability);

  return Math.round(base * hub.priceMultiplier * depletionFactor);
}

function resolveCourierRisk(theftRisk: number, eventRiskDelta = 0): { deliveredFraction: number; note: string } {
  const troubleChance = 0.05 + theftRisk * 0.3 + eventRiskDelta;
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
  if (shipment.status !== 'cleared_unsold') return { success: false, reason: 'That shipment isn\u2019t cleared and ready to sell.' };

  const hub = HUBS.find(h => h.key === hubKey);
  if (!hub) return { success: false, reason: 'Unknown market hub.' };

  const good = GOODS[shipment.goodKey];
  if (!good) return { success: false, reason: 'Good data missing.' };

  // BUG FIX: this used to be a hard block ("cannot be sold here"), which
  // contradicted the "illegal in some markets, huge profit, very risky"
  // design — there was no gamble, just a wall. Now it's a real risk: sell
  // anyway, roll for local-authority seizure, and if it goes through you
  // get a black-market price premium instead of a normal sale.
  const isRestrictedHere = !!(hub.bannedGoods && hub.bannedGoods.includes(good.key));
  if (isRestrictedHere && Math.random() < good.blackMarketSeizureChance) {
    shipment.status = 'sold';
    shipment.soldAt = Date.now();
    all[idx] = shipment;
    await saveShipments(userId, all);
    return { success: false, reason: `🚨 Local authorities confiscated the shipment — ${good.label} is restricted in ${hub.label}.` };
  }

  const { warehouse } = await getEquipment(userId);

  if (shipment.clearedAt) {
    // BUG FIX: a better Warehouse tier now genuinely slows spoilage (cold
    // storage), via preservationFactor, instead of Warehouse having no
    // effect on perishables at all.
    const rawAge = Date.now() - shipment.clearedAt;
    const effectiveAge = rawAge * warehouse.preservationFactor;
    const expiryMs = good.expirationHours * 3600000;
    if (effectiveAge > expiryMs) {
      const spoilFactor = Math.max(0.1, 1 - ((effectiveAge - expiryMs) / expiryMs) * 0.8);
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

    const eventRiskDelta = await getCourierRiskDelta(hubKey);
    const risk = resolveCourierRisk(good.theftRisk, eventRiskDelta);
    deliveredQty = Math.round(shipment.qty * risk.deliveredFraction);
    courierNote = hub.courierName ? `${hub.courierName}: ${risk.note}` : risk.note;
  }

  if (deliveredQty === 0) {
    shipment.status = 'sold';
    shipment.soldAt = Date.now();
    all[idx] = shipment;
    await saveShipments(userId, all);
    return { success: false, reason: `Total loss in transit to ${hub.label}. ${courierNote}` };
  }

  let unitPrice = await getMarketPrice(good.key, hubKey);
  if (isRestrictedHere) unitPrice = Math.round(unitPrice * good.blackMarketPriceBonus); // survived the risk — black-market premium
  const gross = Math.round(unitPrice * deliveredQty * shipment.quality);

  const { payout, capped } = settleWin(gross, await getJackpotPool());
  await addCoins(userId, payout, { type: 'admin_credit', note: `sold ${deliveredQty}x ${good.label} @ ${hub.label}` });
  await deductFromJackpot(payout);
  await addUnitsSoldToday(good.key, hubKey, deliveredQty);

  // Warehouse holding fee — restored. Sitting on cleared goods past your
  // free window costs real money per day, same tension as the deferred-sale
  // choice everywhere else in this economy.
  let holdingFee = 0;
  if (shipment.clearedAt) {
    const daysHeld = (Date.now() - shipment.clearedAt) / 86400000;
    const billableDays = Math.max(0, Math.ceil(daysHeld - warehouse.freeHoldingDays));
    if (billableDays > 0) {
      holdingFee = billableDays * warehouse.holdingFeePerUnitPerDay * shipment.qty;
      const feeResult = await deductCoins(userId, holdingFee, { type: 'admin_debit', note: `warehouse holding fee: ${shipmentId}` });
      holdingFee = feeResult.success ? holdingFee : 0;
      if (feeResult.success) await contributeToJackpot(holdingFee);
    }
  }

  const costBasis = shipment.totalCost + (shipment.dutyPaid || 0) + (shipment.bribePaid || 0) + courierFee + holdingFee;
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
    holdingFee,
    blackMarket: isRestrictedHere,
    courierNote: courierNote || null,
  };
}

// Re-exported for the UI layer — same status-line role as the events module
// plays internally; lets the menu show what's happening in Nigeria right now.
export { getEventsStatusBlock, getEventsDetailBlock };