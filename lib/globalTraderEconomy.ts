// @ts-nocheck
/***
 * lib/globalTraderEconomy.ts – Global Trader core trading engine.
 * 
 * Features:
 * - Goods with individual traits (volatility, expiration, theft, legal flags)
 *   — surfaced to players via World News (globalTraderEvents.ts) and
 *   contextual warnings, not a static spec sheet
 * - Tier‑based licenses (one license covers all countries in a rank tier)
 * - In‑transit events (delay, pirates, temperature) with player choices
 * - Shared jackpot pool with slotMachine.ts
 */

import { createStore } from './pluginStore.js';
import { deductCoins, addCoins, deductGroqCoins, addGroqCoins, getSettings, todayStr, formatNumber } from './economy.js';
import { getJackpotPool, contributeToJackpot, deductFromJackpot, settleWin, JACKPOT_SEED } from './slotMachine.js';
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
const marketPulseCacheTbl = store.table('marketPulseCache'); // 'current' -> { text, computedAt }
const priceHistoryTbl = store.table('priceHistory'); // `${goodKey}:${hubKey}` -> Array<{date, price}>, oldest-first

// ── Currency: source in Groq Coins, sell in Coins ───────────────────────
//
// Mirrors real Nigerian import economics — you source in hard currency and
// sell to local markets in local currency. Every expense (goods, freight,
// duty, licenses, courier, warehousing, bribes/fines) is priced and paid in
// Groq Coins — this bot's withdrawable currency. Every sale payout stays in
// Coins, unchanged.
//
// All the pricing/RTP math elsewhere in this file is Coins-denominated —
// that's what was audited and tuned. Rather than re-derive all of it in a
// second currency, costs are still computed in Coins-equivalent internally,
// then converted to Groq Coins only at the point the player actually pays.
// The jackpot then receives the Coins-equivalent of what was ACTUALLY paid
// (post-rounding), not the pre-rounding theoretical cost — so nothing about
// the shared pool's funding balance shifts from the currency switch; GT
// still gets from this exactly what it pays out, just re-denominated.
export async function coinsToGroqCoins(coinsValue: number): Promise<number> {
  const settings = await getSettings();
  const rate = settings.coinsPerGroqCoin || 1; // confirmed: 1 Coin = 1 Groq Coin
  return Math.max(1, Math.ceil(coinsValue / rate)); // round UP — rounding never shortchanges the house
}

async function groqCoinsToCoinsEquivalent(groqCoinsValue: number): Promise<number> {
  const settings = await getSettings();
  const rate = settings.coinsPerGroqCoin || 1; // confirmed: 1 Coin = 1 Groq Coin
  return groqCoinsValue * rate; // exact coins-value of what was actually paid — no drift from the rounding above
}

interface TraderStats { lifetimeNetProfit: number; lifetimeTradingVolume: number; completedShipments: number; }
const DEFAULT_STATS: TraderStats = { lifetimeNetProfit: 0, lifetimeTradingVolume: 0, completedShipments: 0 };

// MISSING PIECE: statsTbl.set(...) was called in two places (getPlayerRank's
// callers via rank progression, and sellGoods) but nothing ever read/initialized
// it — every call to getPlayerRank (i.e. every single menu load) crashed with
// "getStats is not defined" before it could even show the main menu.
async function getStats(userId: string): Promise<TraderStats> {
  const stored = await statsTbl.get(userId);
  return stored ? { ...DEFAULT_STATS, ...stored } : { ...DEFAULT_STATS };
}

// ── Goods Registry ─────────────────────────────────────────────────────

export interface GoodDef {
  key: string;
  label: string;
  emoji: string;
  category: string;
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
  dailyStockCap: number;             // per-country daily supply cap for this specific product
}

export const GOODS: Record<string, GoodDef> = {
  // ── Staples & Industrial (existing) ──────────────────────────────
  electronics: {
    key: 'electronics', label: 'Electronics & Accessories', emoji: '🔌', category: 'Electronics', baseCost: 5,
    priceVolatility: 0.4, demandStability: 0.3, expirationHours: 120,
    customsRiskMod: 1.4, theftRisk: 0.3, legalFlags: [], profitMarginBonus: 0.12,
    inspectionExtraDutyPct: 3, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 90,
  },
  pharmaceuticals: {
    key: 'pharmaceuticals', label: 'Pharmaceuticals', emoji: '💊', category: 'Regulated', baseCost: 4,
    priceVolatility: 0.1, demandStability: 0.9, expirationHours: 72,
    customsRiskMod: 0.8, theftRisk: 0.1, legalFlags: ['requiresInspection'], profitMarginBonus: 0.21,
    inspectionExtraDutyPct: 5, inspectionDelayHrs: 6, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 70,
  },
  rubber: {
    key: 'rubber', label: 'Rubber & Auto Parts', emoji: '🔧', category: 'Industrial', baseCost: 5,
    priceVolatility: 0.3, demandStability: 0.6, expirationHours: 240,
    customsRiskMod: 1.0, theftRisk: 0.2, legalFlags: [], profitMarginBonus: 0.06,
    inspectionExtraDutyPct: 0, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 80,
  },
  textiles: {
    key: 'textiles', label: 'Textiles', emoji: '🧵', category: 'Fashion', baseCost: 10,
    priceVolatility: 0.2, demandStability: 0.7, expirationHours: 240,
    customsRiskMod: 1.0, theftRisk: 0.2, legalFlags: [], profitMarginBonus: 0.03,
    inspectionExtraDutyPct: 9.3, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 60,
  },
  food: {
    key: 'food', label: 'Food & Perishables', emoji: '🌽', category: 'Staples', baseCost: 1,
    priceVolatility: 0.5, demandStability: 0.4, expirationHours: 24,
    customsRiskMod: 1.2, theftRisk: 0.4, legalFlags: [], profitMarginBonus: 0.15,
    inspectionExtraDutyPct: 0, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 100,
  },
  coffee_leather: {
    key: 'coffee_leather', label: 'Coffee & Leather', emoji: '☕', category: 'Industrial', baseCost: 13,
    priceVolatility: 0.3, demandStability: 0.6, expirationHours: 168,
    customsRiskMod: 1.0, theftRisk: 0.3, legalFlags: [], profitMarginBonus: 0.03,
    inspectionExtraDutyPct: 12.2, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 55,
  },
  olive_wine: {
    key: 'olive_wine', label: 'Olive Oil & Wine', emoji: '🍷', category: 'Regulated', baseCost: 12,
    priceVolatility: 0.7, demandStability: 0.2, expirationHours: 720,
    customsRiskMod: 1.8, theftRisk: 0.5, legalFlags: ['bannedInKano', 'bannedInSokoto'], profitMarginBonus: 0.11,
    inspectionExtraDutyPct: 0, inspectionDelayHrs: 0, blackMarketSeizureChance: 0.35, blackMarketPriceBonus: 1.6,
    dailyStockCap: 45,
  },
  dates_textiles: {
    key: 'dates_textiles', label: 'Dates & Textiles', emoji: '🌴', category: 'Staples', baseCost: 15,
    priceVolatility: 0.2, demandStability: 0.8, expirationHours: 240,
    customsRiskMod: 0.9, theftRisk: 0.2, legalFlags: [], profitMarginBonus: 0.03,
    inspectionExtraDutyPct: 0, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 55,
  },
  perfume_cosmetics: {
    key: 'perfume_cosmetics', label: 'Perfume & Cosmetics', emoji: '🧴', category: 'Fashion', baseCost: 30,
    priceVolatility: 0.5, demandStability: 0.4, expirationHours: 720,
    customsRiskMod: 1.2, theftRisk: 0.4, legalFlags: [], profitMarginBonus: 0.03,
    inspectionExtraDutyPct: 0, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 35,
  },
  machinery: {
    key: 'machinery', label: 'Machinery', emoji: '🏭', category: 'Industrial', baseCost: 40,
    priceVolatility: 0.1, demandStability: 0.9, expirationHours: 9999,
    customsRiskMod: 0.6, theftRisk: 0.1, legalFlags: [], profitMarginBonus: 0.03,
    inspectionExtraDutyPct: 19.2, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 25,
  },
  rice: {
    key: 'rice', label: 'Rice', emoji: '🌾', category: 'Staples', baseCost: 5,
    priceVolatility: 0.1, demandStability: 0.9, expirationHours: 240,
    customsRiskMod: 0.8, theftRisk: 0.1, legalFlags: [], profitMarginBonus: 0.06,
    inspectionExtraDutyPct: 0, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 100,
  },

  // ── Phones ────────────────────────────────────────────────────────
  iphone: {
    key: 'iphone', label: 'iPhone', emoji: '📱', category: 'Phones', baseCost: 43,
    priceVolatility: 0.35, demandStability: 0.5, expirationHours: 9999,
    customsRiskMod: 1.5, theftRisk: 0.5, legalFlags: [], profitMarginBonus: 0.04,
    inspectionExtraDutyPct: 2, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 18,
  },
  samsung_galaxy: {
    key: 'samsung_galaxy', label: 'Samsung Galaxy', emoji: '📱', category: 'Phones', baseCost: 32,
    priceVolatility: 0.3, demandStability: 0.55, expirationHours: 9999,
    customsRiskMod: 1.3, theftRisk: 0.4, legalFlags: [], profitMarginBonus: 0.04,
    inspectionExtraDutyPct: 2, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 22,
  },
  tecno_camon: {
    key: 'tecno_camon', label: 'Tecno Camon', emoji: '📱', category: 'Phones', baseCost: 9,
    priceVolatility: 0.25, demandStability: 0.8, expirationHours: 9999,
    customsRiskMod: 1.0, theftRisk: 0.2, legalFlags: [], profitMarginBonus: 0.03,
    inspectionExtraDutyPct: 0, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 140,
  },
  infinix_note: {
    key: 'infinix_note', label: 'Infinix Note', emoji: '📱', category: 'Phones', baseCost: 7,
    priceVolatility: 0.25, demandStability: 0.8, expirationHours: 9999,
    customsRiskMod: 1.0, theftRisk: 0.2, legalFlags: [], profitMarginBonus: 0.06,
    inspectionExtraDutyPct: 0, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 150,
  },

  // ── Precious Metals & Jewelry ─────────────────────────────────────
  gold_bars: {
    key: 'gold_bars', label: 'Gold Bars', emoji: '🪙', category: 'Precious Metals', baseCost: 80,
    priceVolatility: 0.15, demandStability: 0.9, expirationHours: 9999,
    customsRiskMod: 2.2, theftRisk: 0.8, legalFlags: ['requiresExtraSecurity'], profitMarginBonus: 0.15,
    inspectionExtraDutyPct: 5, inspectionDelayHrs: 6, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 6,
  },
  diamond_jewelry: {
    key: 'diamond_jewelry', label: 'Diamond Jewelry', emoji: '💎', category: 'Precious Metals', baseCost: 70,
    priceVolatility: 0.3, demandStability: 0.6, expirationHours: 9999,
    customsRiskMod: 2.4, theftRisk: 0.85, legalFlags: ['requiresExtraSecurity'], profitMarginBonus: 0.15,
    inspectionExtraDutyPct: 6, inspectionDelayHrs: 8, blackMarketSeizureChance: 0.1, blackMarketPriceBonus: 1.3,
    dailyStockCap: 5,
  },
  silver_jewelry: {
    key: 'silver_jewelry', label: 'Silver Jewelry', emoji: '💍', category: 'Precious Metals', baseCost: 17,
    priceVolatility: 0.25, demandStability: 0.65, expirationHours: 9999,
    customsRiskMod: 1.4, theftRisk: 0.4, legalFlags: [], profitMarginBonus: 0.03,
    inspectionExtraDutyPct: 0, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 35,
  },

  // ── Fashion & Computers ───────────────────────────────────────────
  designer_shoes: {
    key: 'designer_shoes', label: 'Designer Shoes', emoji: '👞', category: 'Fashion', baseCost: 21,
    priceVolatility: 0.35, demandStability: 0.45, expirationHours: 9999,
    customsRiskMod: 1.3, theftRisk: 0.3, legalFlags: [], profitMarginBonus: 0.03,
    inspectionExtraDutyPct: 14.1, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 45,
  },
  designer_bags: {
    key: 'designer_bags', label: 'Designer Bags', emoji: '👜', category: 'Fashion', baseCost: 28,
    priceVolatility: 0.35, demandStability: 0.45, expirationHours: 9999,
    customsRiskMod: 1.3, theftRisk: 0.35, legalFlags: [], profitMarginBonus: 0.03,
    inspectionExtraDutyPct: 13.9, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 40,
  },
  macbook: {
    key: 'macbook', label: 'MacBook', emoji: '💻', category: 'Computers', baseCost: 37,
    priceVolatility: 0.2, demandStability: 0.6, expirationHours: 9999,
    customsRiskMod: 1.2, theftRisk: 0.3, legalFlags: [], profitMarginBonus: 0.11,
    inspectionExtraDutyPct: 0, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 25,
  },

  // ── Vehicles ──────────────────────────────────────────────────────
  toyota_corolla: {
    key: 'toyota_corolla', label: 'Toyota Corolla (New)', emoji: '🚗', category: 'New Vehicles', baseCost: 147,
    priceVolatility: 0.1, demandStability: 0.85, expirationHours: 9999,
    customsRiskMod: 1.1, theftRisk: 0.15, legalFlags: [], profitMarginBonus: 0.04,
    inspectionExtraDutyPct: 0, inspectionDelayHrs: 4, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 4,
  },
  toyota_camry: {
    key: 'toyota_camry', label: 'Toyota Camry (New)', emoji: '🚗', category: 'New Vehicles', baseCost: 180,
    priceVolatility: 0.1, demandStability: 0.85, expirationHours: 9999,
    customsRiskMod: 1.1, theftRisk: 0.15, legalFlags: [], profitMarginBonus: 0.05,
    inspectionExtraDutyPct: 0, inspectionDelayHrs: 4, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 3,
  },
  lexus_rx: {
    key: 'lexus_rx', label: 'Lexus RX (New)', emoji: '🚙', category: 'New Vehicles', baseCost: 253,
    priceVolatility: 0.15, demandStability: 0.75, expirationHours: 9999,
    customsRiskMod: 1.2, theftRisk: 0.2, legalFlags: [], profitMarginBonus: 0.03,
    inspectionExtraDutyPct: 0, inspectionDelayHrs: 4, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 2,
  },
  ferrari: {
    key: 'ferrari', label: 'Ferrari', emoji: '🏎️', category: 'Luxury Vehicles', baseCost: 433,
    priceVolatility: 0.2, demandStability: 0.4, expirationHours: 9999,
    customsRiskMod: 1.6, theftRisk: 0.4, legalFlags: ['requiresExtraSecurity'], profitMarginBonus: 0.03,
    inspectionExtraDutyPct: 14.3, inspectionDelayHrs: 8, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 1,
  },
  lamborghini: {
    key: 'lamborghini', label: 'Lamborghini', emoji: '🏎️', category: 'Luxury Vehicles', baseCost: 467,
    priceVolatility: 0.2, demandStability: 0.35, expirationHours: 9999,
    customsRiskMod: 1.6, theftRisk: 0.4, legalFlags: ['requiresExtraSecurity'], profitMarginBonus: 0.03,
    inspectionExtraDutyPct: 16.2, inspectionDelayHrs: 8, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 1,
  },
  tokunbo_corolla: {
    key: 'tokunbo_corolla', label: 'Corolla (Tokunbo)', emoji: '🚘', category: 'Tokunbo Vehicles', baseCost: 57,
    priceVolatility: 0.15, demandStability: 0.8, expirationHours: 9999,
    customsRiskMod: 0.9, theftRisk: 0.2, legalFlags: [], profitMarginBonus: 0.03,
    inspectionExtraDutyPct: 20.7, inspectionDelayHrs: 2, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 9,
  },
  tokunbo_camry: {
    key: 'tokunbo_camry', label: 'Camry (Tokunbo)', emoji: '🚘', category: 'Tokunbo Vehicles', baseCost: 73,
    priceVolatility: 0.15, demandStability: 0.8, expirationHours: 9999,
    customsRiskMod: 0.9, theftRisk: 0.2, legalFlags: [], profitMarginBonus: 0.03,
    inspectionExtraDutyPct: 21.7, inspectionDelayHrs: 2, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 7,
  },

  // ── Mobility ──────────────────────────────────────────────────────
  motorcycle_bajaj: {
    key: 'motorcycle_bajaj', label: 'Bajaj Motorcycle', emoji: '🏍️', category: 'Mobility', baseCost: 13,
    priceVolatility: 0.2, demandStability: 0.7, expirationHours: 9999,
    customsRiskMod: 0.8, theftRisk: 0.25, legalFlags: [], profitMarginBonus: 0.03,
    inspectionExtraDutyPct: 17.2, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 70,
  },
  keke_napep: {
    key: 'keke_napep', label: 'Keke Napep', emoji: '🛺', category: 'Mobility', baseCost: 17,
    priceVolatility: 0.2, demandStability: 0.65, expirationHours: 9999,
    customsRiskMod: 0.8, theftRisk: 0.2, legalFlags: [], profitMarginBonus: 0.03,
    inspectionExtraDutyPct: 18, inspectionDelayHrs: 0, blackMarketSeizureChance: 0, blackMarketPriceBonus: 1,
    dailyStockCap: 55,
  },

  // ── Okirika (Used Clothing) ───────────────────────────────────────
  // Modeled with real friction: secondhand-clothing import faces
  // inconsistent enforcement in Nigeria — reflected as extra customs
  // risk and a black-market path rather than an outright ban.
  okirika_grade_a: {
    key: 'okirika_grade_a', label: 'Okirika Bales (Grade A)', emoji: '👕', category: 'Used Clothing', baseCost: 6,
    priceVolatility: 0.3, demandStability: 0.6, expirationHours: 720,
    customsRiskMod: 1.5, theftRisk: 0.15, legalFlags: ['requiresInspection'], profitMarginBonus: 0.15,
    inspectionExtraDutyPct: 0, inspectionDelayHrs: 0, blackMarketSeizureChance: 0.15, blackMarketPriceBonus: 1.2,
    dailyStockCap: 90,
  },
  okirika_grade_b: {
    key: 'okirika_grade_b', label: 'Okirika Bales (Grade B)', emoji: '👕', category: 'Used Clothing', baseCost: 4,
    priceVolatility: 0.3, demandStability: 0.55, expirationHours: 720,
    customsRiskMod: 1.5, theftRisk: 0.15, legalFlags: ['requiresInspection'], profitMarginBonus: 0.23,
    inspectionExtraDutyPct: 0, inspectionDelayHrs: 0, blackMarketSeizureChance: 0.15, blackMarketPriceBonus: 1.2,
    dailyStockCap: 100,
  },
};

// ── Country Defs ──────────────────────────────────────────────────────

export type RiskTier = 'veryLow' | 'low' | 'medium' | 'high';

export interface CountryDef {
  key: string;
  label: string;
  emoji: string;
  goodKeys: string[];         // countries export multiple product lines now, not just one
  baseFreightFee: number;
  containerCapacity: number; // units a single freight payment covers — order more, pay for more containers
  distanceHrs: number;
  risk: RiskTier;
  dutyRatePercent: number;
  licenseRenewCost: number;
}

export const COUNTRIES: CountryDef[] = [
  { key: 'benin',    label: 'Cotonou',      emoji: '🇧🇯', goodKeys: ['rice', 'tokunbo_corolla', 'tokunbo_camry'],            baseFreightFee: 5,  containerCapacity: 50, distanceHrs: 6,  risk: 'high',    dutyRatePercent: 10, licenseRenewCost: 10 },
  { key: 'india',    label: 'India',        emoji: '🇮🇳', goodKeys: ['pharmaceuticals', 'motorcycle_bajaj', 'silver_jewelry'], baseFreightFee: 20, containerCapacity: 45, distanceHrs: 30, risk: 'medium',  dutyRatePercent: 12, licenseRenewCost: 17 },
  { key: 'thailand', label: 'Thailand',     emoji: '🇹🇭', goodKeys: ['rubber'],                                              baseFreightFee: 20, containerCapacity: 45, distanceHrs: 30, risk: 'medium',  dutyRatePercent: 12, licenseRenewCost: 17 },
  { key: 'turkey',   label: 'Turkey',       emoji: '🇹🇷', goodKeys: ['textiles', 'designer_shoes', 'designer_bags'],         baseFreightFee: 17, containerCapacity: 35, distanceHrs: 24, risk: 'low',     dutyRatePercent: 12, licenseRenewCost: 30 },
  { key: 'china',    label: 'China',        emoji: '🇨🇳', goodKeys: ['electronics', 'tecno_camon', 'infinix_note', 'keke_napep'], baseFreightFee: 27, containerCapacity: 50, distanceHrs: 48, risk: 'medium', dutyRatePercent: 14, licenseRenewCost: 33 },
  { key: 'brazil',   label: 'Brazil',       emoji: '🇧🇷', goodKeys: ['coffee_leather'],                                      baseFreightFee: 30, containerCapacity: 35, distanceHrs: 48, risk: 'medium',  dutyRatePercent: 14, licenseRenewCost: 37 },
  { key: 'spain',    label: 'Spain',        emoji: '🇪🇸', goodKeys: ['olive_wine'],                                          baseFreightFee: 17, containerCapacity: 30, distanceHrs: 24, risk: 'low',     dutyRatePercent: 14, licenseRenewCost: 47 },
  { key: 'saudi',    label: 'Saudi Arabia', emoji: '🇸🇦', goodKeys: ['dates_textiles'],                                      baseFreightFee: 15, containerCapacity: 30, distanceHrs: 18, risk: 'low',     dutyRatePercent: 14, licenseRenewCost: 50 },
  { key: 'france',   label: 'France',       emoji: '🇫🇷', goodKeys: ['perfume_cosmetics'],                                   baseFreightFee: 33, containerCapacity: 20, distanceHrs: 40, risk: 'low',     dutyRatePercent: 18, licenseRenewCost: 93 },
  { key: 'uae',      label: 'UAE',          emoji: '🇦🇪', goodKeys: ['gold_bars', 'diamond_jewelry', 'iphone', 'samsung_galaxy', 'ferrari', 'lamborghini'], baseFreightFee: 10, containerCapacity: 15, distanceHrs: 12, risk: 'low', dutyRatePercent: 18, licenseRenewCost: 107 },
  { key: 'germany',  label: 'Germany',      emoji: '🇩🇪', goodKeys: ['machinery'],                                           baseFreightFee: 40, containerCapacity: 15, distanceHrs: 48, risk: 'veryLow', dutyRatePercent: 20, licenseRenewCost: 133 },
  { key: 'usa',      label: 'USA',          emoji: '🇺🇸', goodKeys: ['macbook'],                                             baseFreightFee: 40, containerCapacity: 15, distanceHrs: 48, risk: 'low',     dutyRatePercent: 20, licenseRenewCost: 133 },
  { key: 'japan',    label: 'Japan',        emoji: '🇯🇵', goodKeys: ['toyota_corolla', 'toyota_camry', 'lexus_rx'],          baseFreightFee: 37, containerCapacity: 2,  distanceHrs: 32, risk: 'low',     dutyRatePercent: 25, licenseRenewCost: 133 },
  { key: 'uk',       label: 'UK',           emoji: '🇬🇧', goodKeys: ['okirika_grade_a', 'okirika_grade_b'],                  baseFreightFee: 23, containerCapacity: 40, distanceHrs: 20, risk: 'low',     dutyRatePercent: 15, licenseRenewCost: 40 },
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
  netProfitThreshold: number; // Primary: direct net profit requirement
  volumeThreshold?: number; // Optional: trading volume alternative path
  minNetProfitForVolume?: number; // If volume is met, this lower net profit requirement applies
  addsCountries: string[];
  addsFreight: string[];
}

const RANK_DEFS: RankDef[] = [
  { 
    key: 'dropshipper', 
    label: 'Dropshipper', 
    emoji: '📦',
    netProfitThreshold: 0,
    addsCountries: ['benin', 'india', 'thailand'], 
    addsFreight: ['hapag'] 
  },
  { 
    key: 'mini_importer', 
    label: 'Mini Importer', 
    emoji: '📦',
    netProfitThreshold: 200,
    volumeThreshold: 667,
    minNetProfitForVolume: 67,
    addsCountries: ['turkey', 'china', 'brazil'], 
    addsFreight: ['cma'] 
  },
  { 
    key: 'sme', 
    label: 'SME', 
    emoji: '🛍️',
    netProfitThreshold: 667,
    volumeThreshold: 3333,
    minNetProfitForVolume: 333,
    addsCountries: ['spain', 'saudi', 'uk'], 
    addsFreight: ['maersk'] 
  },
  { 
    key: 'importer', 
    label: 'Importer', 
    emoji: '📦',
    netProfitThreshold: 2000,
    volumeThreshold: 10000,
    minNetProfitForVolume: 1000,
    addsCountries: ['france', 'uae'], 
    addsFreight: ['one'] 
  },
  { 
    key: 'pro_trader', 
    label: 'Pro Trader', 
    emoji: '🚚',
    netProfitThreshold: 4667,
    volumeThreshold: 20000,
    minNetProfitForVolume: 2333,
    addsCountries: ['germany', 'japan'], 
    addsFreight: ['cosco'] 
  },
  { 
    key: 'global_trader', 
    label: 'Global Trader', 
    emoji: '🌍',
    netProfitThreshold: 10000,
    // No volume shortcut for final rank — forces actual profitability
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
    cost: 10,
    countries: ['benin', 'india', 'thailand'],
    durationMs: 7 * 24 * 60 * 60 * 1000,
  },
  mini_importer: {
    key: 'mini_importer',
    label: 'Mini Importer License',
    emoji: '📦',
    cost: 30,
    countries: ['turkey', 'china', 'brazil'],
    durationMs: 7 * 24 * 60 * 60 * 1000,
  },
  sme: {
    key: 'sme',
    label: 'SME License',
    emoji: '🛍️',
    cost: 47,
    countries: ['spain', 'saudi', 'uk'],
    durationMs: 7 * 24 * 60 * 60 * 1000,
  },
  importer: {
    key: 'importer',
    label: 'Importer License',
    emoji: '📦',
    cost: 93,
    countries: ['france', 'uae'],
    durationMs: 7 * 24 * 60 * 60 * 1000,
  },
  pro_trader: {
    key: 'pro_trader',
    label: 'Pro Trader License',
    emoji: '🚚',
    cost: 133,
    countries: ['germany', 'japan'],
    durationMs: 7 * 24 * 60 * 60 * 1000,
  },
  global_trader: {
    key: 'global_trader',
    label: 'Global Trader License',
    emoji: '🌍',
    cost: 200,
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
// NOTE: No hardcoded MARKET_MARKUP. Prices now float dynamically based on demand,
// events, and depletion. profitMarginBonus is a baseline expectation, not guaranteed.

/**
 * RTP Control: Subtle 2% marketplace fee (NOT obviously displayed as "house edge").
 * Combined with natural economic friction:
 *   - Freight costs (~3-7% of goods cost)
 *   - Duty rates (~10-20% of goods cost)  
 *   - Market depletion (supply/demand crashes prices)
 *   - Theft/spoilage (random loss to quality)
 *   - Holding fees (time cost on delayed sales)
 * ...converges to ~94-96% player RTP (4-6% sink) over 100 trades.
 *
 * Key design: Individual trades feel rewarding (70-80% are profitable).
 * But cumulative effect over many trades = slow bleed toward sustainability.
 * Players feel successful mid-term, but game doesn't become an ATM long-term.
 */
const TRADING_COMMISSION_PCT = 2.0; // 2% marketplace fee (subtle, not prominently labeled)

// A single Global Trader sale (a full day's stock of a bulk good) can request
// a far bigger payout than a typical slot/coinflip/dice win. This caps any
// one sale to a share of the jackpot's *current* surplus above its protected
// floor, so one big trade can't unilaterally claim the whole pool that other
// games are drawing from — it degrades gracefully instead. This applies on
// top of, not instead of, settleWin()'s own floor protection.
const MAX_SINGLE_SALE_POOL_SHARE = 0.20; // one Trader sale can claim at most 20% of current surplus

// Buy-side scarcity pricing (see sourceShipment): barely moves early in the
// day's stock, climbs fast once most of it is gone. At SCARCITY_STRENGTH=0.5,
// buying the very last unit of a fully depleted day's stock costs up to 1.5x
// base — enough to feel real without being punitive for normal-sized orders.
const SCARCITY_STRENGTH = 0.5;
const SCARCITY_POWER = 1.6;

/** Exported so the UI can preview the live scarcity premium before a player commits to a quantity. */
export function getScarcityMultiplier(remaining: number, cap: number): number {
  const depletedFraction = 1 - (remaining / cap);
  return 1 + SCARCITY_STRENGTH * Math.pow(Math.max(0, depletedFraction), SCARCITY_POWER);
}

// ── Hubs ──────────────────────────────────────────────────────────────

export interface HubDef {
  key: string;
  label: string;
  courierRequired: boolean;
  courierName: string | null;
  courierFeePerUnit: number;
  priceMultiplier: number;
  bannedGoods?: string[]; // used only to flag black-market risk now, not to hard-block a sale
  categoryAffinity?: Record<string, number>; // per-category demand multiplier — only list deviations from 1.0
}

// Each hub has a real personality: what it actually wants to buy, not
// just a flat price bump. A Ferrari and a bag of rice should not move
// the same way from city to city — Abuja pays up for luxury and jewelry,
// Onitsha pays up for phones and fast-moving wholesale goods, Aba pays
// up for fashion, Kano/Sokoto pay up for mobility and textiles, Port
// Harcourt pays up for industrial/heavy goods. Categories not listed
// default to neutral (1.0) — no across-the-board winner city.
export const HUBS: HubDef[] = [
  {
    key: 'lagos', label: 'Lagos (Port)', courierRequired: false, courierName: null, courierFeePerUnit: 0,
    priceMultiplier: 1.00, bannedGoods: [],
    categoryAffinity: { Phones: 1.05, Electronics: 1.05, Fashion: 1.05, 'New Vehicles': 1.02, Computers: 1.05 },
  },
  {
    key: 'abuja', label: 'Abuja', courierRequired: true, courierName: 'ABC Transport', courierFeePerUnit: 1,
    priceMultiplier: 1.10, bannedGoods: [],
    categoryAffinity: {
      Phones: 1.08, 'Precious Metals': 1.15, 'Luxury Vehicles': 1.18, 'New Vehicles': 1.1, Fashion: 1.08, Computers: 1.08,
      Staples: 0.9, 'Used Clothing': 0.88, Mobility: 0.9,
    },
  },
  {
    key: 'onitsha', label: 'Onitsha', courierRequired: true, courierName: 'GIG Logistics', courierFeePerUnit: 1,
    priceMultiplier: 1.15, bannedGoods: [],
    categoryAffinity: { Phones: 1.1, Electronics: 1.13, Industrial: 1.05, 'Precious Metals': 0.88, 'Luxury Vehicles': 0.85 },
  },
  {
    key: 'aba', label: 'Aba', courierRequired: true, courierName: 'GIG Logistics', courierFeePerUnit: 1,
    priceMultiplier: 1.12, bannedGoods: [],
    categoryAffinity: { Fashion: 1.15, 'Used Clothing': 1.1, 'Precious Metals': 0.93, 'Luxury Vehicles': 0.85 },
  },
  {
    key: 'kano', label: 'Kano', courierRequired: true, courierName: 'ABC Transport', courierFeePerUnit: 1,
    priceMultiplier: 1.18, bannedGoods: ['olive_wine'],
    categoryAffinity: { Mobility: 1.15, Fashion: 1.08, 'Tokunbo Vehicles': 1.05, 'Precious Metals': 0.9, 'Luxury Vehicles': 0.85 },
  },
  {
    key: 'sokoto', label: 'Sokoto', courierRequired: true, courierName: 'ABC Transport', courierFeePerUnit: 1,
    priceMultiplier: 1.18, bannedGoods: ['olive_wine'],
    categoryAffinity: { Mobility: 1.13, Staples: 1.05, Fashion: 1.02, 'Precious Metals': 0.9, 'Luxury Vehicles': 0.83 },
  },
  {
    key: 'ph', label: 'Port Harcourt', courierRequired: true, courierName: 'Young Shall Grow Motors', courierFeePerUnit: 1,
    priceMultiplier: 1.20, bannedGoods: [],
    categoryAffinity: { Industrial: 1.15, 'New Vehicles': 1.08, 'Tokunbo Vehicles': 1.05, Electronics: 1.02, 'Used Clothing': 0.93 },
  },
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
  { tier: 'licensedBroker', displayName: 'Licensed Broker', cost: 20,  bribeSuccessBonus: 0.08, fineMultReduction: 0.10 },
  { tier: 'customsBroker',  displayName: 'Customs Broker',  cost: 80, bribeSuccessBonus: 0.15, fineMultReduction: 0.20 },
  { tier: 'customsInsider', displayName: 'Customs Insider', cost: 267, bribeSuccessBonus: 0.25, fineMultReduction: 0.35 },
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
  { tier: 'dockside', displayName: 'Dockside Storage',  cost: 0,     capacity: 1, freeHoldingDays: 1, holdingFeePerUnitPerDay: 1, preservationFactor: 1.0 },
  { tier: 'rented',   displayName: 'Rented Warehouse',  cost: 33,  capacity: 3, freeHoldingDays: 2, holdingFeePerUnitPerDay: 1, preservationFactor: 0.85 },
  { tier: 'private',  displayName: 'Private Warehouse', cost: 133, capacity: 5, freeHoldingDays: 3, holdingFeePerUnitPerDay: 1, preservationFactor: 0.60 },
  { tier: 'bonded',   displayName: 'Bonded Warehouse',  cost: 400, capacity: 8, freeHoldingDays: 5, holdingFeePerUnitPerDay: 1,  preservationFactor: 0.35 },
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

  const groqCost = await coinsToGroqCoins(def.cost);
  const paid = await deductGroqCoins(userId, groqCost, { type: 'admin_debit', note: `bought ${type}: ${tier}` });
  if (!paid.success) return { success: false, reason: 'Not enough Groq Coins.' };
  await contributeToJackpot(await groqCoinsToCoinsEquivalent(groqCost));

  const stored = (await equipmentTbl.get(userId)) || { ...DEFAULT_EQUIPMENT };
  stored[type] = tier;
  await equipmentTbl.set(userId, stored);
  return { success: true, def, groqCost };
}

// ── Stock ─────────────────────────────────────────────────────────────

export async function getStockLevel(countryKey: string, goodKey: string): Promise<{ remaining: number; cap: number }> {
  const country = COUNTRIES.find(c => c.key === countryKey);
  const good = GOODS[goodKey];
  if (!country || !good || !country.goodKeys.includes(goodKey)) return { remaining: 0, cap: 0 };
  const stockKey = `${countryKey}:${goodKey}:${todayStr()}`;
  const existing = await stockTbl.get(stockKey);
  const remaining = typeof existing === 'number' ? existing : good.dailyStockCap;
  return { remaining, cap: good.dailyStockCap };
}

async function decrementStock(countryKey: string, goodKey: string, qty: number): Promise<boolean> {
  const { remaining } = await getStockLevel(countryKey, goodKey);
  if (remaining < qty) return false;
  await stockTbl.set(`${countryKey}:${goodKey}:${todayStr()}`, remaining - qty);
  return true;
}

export async function getPlayerRank(userId: string) {
  const stats = await getStats(userId);
  const netProfit = stats.lifetimeNetProfit;
  const volume = stats.lifetimeTradingVolume;

  let current = RANK_DEFS[0];
  let unlockedCountries: string[] = [];
  let unlockedFreight: string[] = [];

  for (const rank of RANK_DEFS) {
    // Check direct path: net profit >= threshold
    const directPath = netProfit >= rank.netProfitThreshold;
    
    // Check volume path: if defined, volume >= threshold AND net profit >= minNetProfitForVolume
    const volumePath = rank.volumeThreshold && rank.minNetProfitForVolume
      ? (volume >= rank.volumeThreshold && netProfit >= rank.minNetProfitForVolume)
      : false;
    
    if (directPath || volumePath) {
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
    lifetimeNetProfit: netProfit,
    nextThreshold: next ? next.netProfitThreshold : netProfit,
    nextVolumeThreshold: next?.volumeThreshold || null,
    nextMinNetProfitForVolume: next?.minNetProfitForVolume || null,
    lifetimeTradingVolume: volume,
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
  const groqCost = await coinsToGroqCoins(cost);
  const result = await deductGroqCoins(userId, groqCost, { type: 'admin_debit', note: `buy license: ${tierKey}` });
  if (!result.success) return { success: false, reason: 'insufficient_funds' };

  await contributeToJackpot(await groqCoinsToCoinsEquivalent(groqCost));
  await setLicenseRecord(userId, tierKey, Date.now() + tier.durationMs);
  return { success: true, cost: groqCost };
}

export async function renewLicense(
  userId: string,
  tierKey: LicenseTierKey,
  forced = false
): Promise<{ success: boolean; reason?: string; cost?: number }> {
  const tier = LICENSE_TIERS[tierKey];
  if (!tier) return { success: false, reason: 'Invalid license tier.' };

  const cost = forced ? Math.round(tier.cost * FORCED_RENEWAL_MULT) : tier.cost;
  const groqCost = await coinsToGroqCoins(cost);
  const result = await deductGroqCoins(userId, groqCost, { type: 'admin_debit', note: `${forced ? 'forced ' : ''}renew license: ${tierKey}` });
  if (!result.success) return { success: false, reason: 'insufficient_funds' };

  await contributeToJackpot(await groqCoinsToCoinsEquivalent(groqCost));
  await setLicenseRecord(userId, tierKey, Date.now() + tier.durationMs);
  return { success: true, cost: groqCost };
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
  qty: number; // current quantity (may be reduced by spoilage or delivery loss)
  originalQty?: number; // CRITICAL: original qty at clearance. Spoilage is calculated from this, not from the reduced qty. Prevents repeated spoilage calculations on retry attempts.
  goodsCost: number;
  freightCost: number;
  totalCost: number; // Coins-equivalent — internal RTP/duty math basis
  groqCoinsCost: number; // what was ACTUALLY charged to the player, in Groq Coins
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
    minCost: 35,
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
    minCost: 50,
    buildDescription: (cost) => `⚠️ Pirates detected. Hire escort for ${formatNumber(cost)}?`,
    successEffect: () => {},
    failEffect: (s) => { s.quality *= 0.6; },
  },
  temperature: {
    type: 'temperature',
    costFraction: 0.06,
    minCost: 25,
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
    const groqCost = await coinsToGroqCoins(cost);
    const deducted = await deductGroqCoins(userId, groqCost, { type: 'admin_debit', note: `event payment: ${eventType}` });
    if (!deducted.success) {
      return { success: false, reason: 'Not enough Groq Coins to pay.' };
    }
    await contributeToJackpot(await groqCoinsToCoinsEquivalent(groqCost));
    config.successEffect(shipment);
    outcome = `✅ Paid ${formatNumber(groqCost)} Groq Coins – event resolved successfully.`;
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

export async function sourceShipment(userId: string, countryKey: string, goodKey: string, freightKey: string, qty: number) {
  const country = COUNTRIES.find(c => c.key === countryKey);
  if (!country) return { success: false, reason: 'Unknown country.' };
  const freight = FREIGHT_TIERS.find(f => f.key === freightKey);
  if (!freight) return { success: false, reason: 'Unknown freight option.' };

  const good = GOODS[goodKey];
  if (!good || !country.goodKeys.includes(goodKey)) return { success: false, reason: 'That good isn\u2019t sourced from here.' };

  const rank = await getPlayerRank(userId);
  if (!rank.unlockedCountries.includes(countryKey)) return { success: false, reason: 'Your rank hasn’t unlocked this country yet.' };
  if (!rank.unlockedFreight.includes(freightKey)) return { success: false, reason: 'Your rank hasn’t unlocked this freight option yet.' };

  const { remaining } = await getStockLevel(countryKey, goodKey);
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

  // Real scarcity, not just a hard stock cutoff: the more of today's
  // allocation other players have already bought, the pricier what's left
  // gets — mirrors real commodity behavior and gives "buy early" a genuine
  // reason beyond just risking a sellout. Barely moves for the first ~60%
  // of stock, then climbs fast for the last stretch (up to 1.5x at zero
  // remaining). This is a live, honest signal World News reports on.
  const scarcityMultiplier = getScarcityMultiplier(remaining, good.dailyStockCap);

  // Freight pays for container capacity, not a flat toll — order more than
  // one container's worth of units and you need (and pay for) another one.
  // Without this, a 5-unit order and a 200-unit order cost the same freight,
  // which isn't how shipping actually works.
  const containersNeeded = Math.ceil(qty / country.containerCapacity);

  const goodsCost = Math.round(good.baseCost * qty * goodsCostMult * scarcityMultiplier);
  const freightCost = Math.round(country.baseFreightFee * freight.costMult * freightCostMult * containersNeeded);
  const totalCost = goodsCost + freightCost; // Coins-equivalent — drives all the RTP-tuned math downstream unchanged

  const groqTotalCost = await coinsToGroqCoins(totalCost);
  const deducted = await deductGroqCoins(userId, groqTotalCost, { type: 'admin_debit', note: `sourced ${qty}x ${good.label} from ${country.label}` });
  if (!deducted.success) return { success: false, reason: 'Not enough Groq Coins for that order.' };

  const stockOk = await decrementStock(countryKey, goodKey, qty);
  if (!stockOk) {
    await addGroqCoins(userId, groqTotalCost, { type: 'admin_credit', note: 'refund: stock unavailable' });
    return { success: false, reason: 'That stock just sold out — try again or pick another country.' };
  }

  await contributeToJackpot(await groqCoinsToCoinsEquivalent(groqTotalCost));

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
    groqCoinsCost: groqTotalCost,
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
      goodLabel: good.label,
      goodsCost,
      freightCost,
      containersUsed: containersNeeded,
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
    const groqDuty = await coinsToGroqCoins(duty);
    const paid = await deductGroqCoins(userId, groqDuty, { type: 'admin_debit', note: `customs duty: ${shipmentId}` });
    if (!paid.success) return { outcome: 'error', reason: 'Not enough Groq Coins for duty.' };
    await contributeToJackpot(await groqCoinsToCoinsEquivalent(groqDuty));

    shipment.status = 'cleared_unsold';
    shipment.dutyPaid = duty;
    shipment.quality = 1.0;
    shipment.clearedAt = Date.now();
    shipment.originalQty = shipment.qty; // CRITICAL: Store original qty to prevent repeated spoilage on retry attempts
    await saveShipments(userId, all);
    return { outcome: 'cleared', dutyPaid: duty, bribePaid: 0, dutyPaidGroq: groqDuty, bribePaidGroq: 0 };
  }

  if (!opts.bribe) {
    return seizeShipment(userId, all, idx, shipment);
  }

  const bribeCost = Math.round(duty * (BRIBE_COST_PERCENT / 100));
  const totalUpfront = duty + bribeCost;
  const groqUpfront = await coinsToGroqCoins(totalUpfront);
  const paid = await deductGroqCoins(userId, groqUpfront, { type: 'admin_debit', note: `duty + bribe: ${shipmentId}` });
  if (!paid.success) return { outcome: 'error', reason: 'Not enough Groq Coins for duty + bribe.' };
  await contributeToJackpot(await groqCoinsToCoinsEquivalent(groqUpfront));

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
    shipment.originalQty = shipment.qty; // CRITICAL: Store original qty to prevent repeated spoilage on retry attempts
    await saveShipments(userId, all);
    // groqUpfront covers duty+bribe together (one combined payment) — split
    // proportionally for display so the two lines add up to what was charged.
    const dutyPaidGroq = await coinsToGroqCoins(duty);
    return { outcome: 'cleared', dutyPaid: duty, bribePaid: bribeCost, dutyPaidGroq, bribePaidGroq: Math.max(0, groqUpfront - dutyPaidGroq) };
  }

  return seizeShipment(userId, all, idx, shipment);
}

async function seizeShipment(userId: string, all: Shipment[], idx: number, shipment: Shipment) {
  const { agent } = await getEquipment(userId);
  const effectiveFineMult = Math.max(1.0, FINE_MULT - agent.fineMultReduction);
  const fine = Math.round(shipment.totalCost * effectiveFineMult);
  const groqFine = await coinsToGroqCoins(fine);
  const finePaid = await deductGroqCoins(userId, groqFine, { type: 'admin_debit', note: `customs seizure fine: ${shipment.id}` });
  if (finePaid.success) await contributeToJackpot(await groqCoinsToCoinsEquivalent(groqFine));

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
    fineGroq: finePaid.success ? groqFine : 0,
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
 * Deterministic per (good, hub, day) demand wobble — allows ±volatility swings
 * (e.g. volatility 0.4 = ±40% price swing), giving true market unpredictability.
 * Stable across repeated reads within the same day — fixes the old bug where
 * Math.random() was called fresh on every read, causing estimated vs. actual
 * price mismatches.
 *
 * Range: volatility 0.1 (rice) = ±10%, up to 0.7 (olive oil) = ±70%.
 */
function getDemandWobble(goodKey: string, hubKey: string, volatility: number): number {
  if (volatility <= 0) return 1;
  const hash = hashString(`${goodKey}:${hubKey}:${todayStr()}`);
  const normalized = (hash % 1000) / 1000; // 0..1
  const swing = (normalized * 2 - 1) * volatility; // Full volatility range, not 0.4x
  return 1 + swing;
}

// ── Goods Intel / Analyst Commentary ────────────────────────────────
//
// Ambient, stat-derived commentary for World News. Distinct from
// globalTraderEvents.ts (which reports live, expiring conditions tied to
// real-world triggers) — this surfaces each good's *inherent* character
// (volatility, theft risk, customs friction, perishability) as narrative
// instead of a spec sheet. A rotating subset of goods gets featured each
// day (same cadence as the daily stock reset) so players build intuition
// by reading the wire over time rather than seeing everything at once.

const WATCHLIST_SIZE = 6;

function pickDeterministic<T>(arr: T[], seed: string): T {
  return arr[hashString(seed) % arr.length];
}

/** Maps a good's raw stats to narrative angles — a good can carry several. */
function goodIntelAngles(good: GoodDef): string[][] {
  const angles: string[][] = [];

  if (good.priceVolatility >= 0.5) {
    angles.push([
      `Analysts flag sharp price swings on ${good.label} this week — timing matters more than usual.`,
      `${good.label} is trading in a wide band right now. Buy low, don\u2019t chase the peak.`,
      `Desks are calling ${good.label} the most unpredictable line on the board today.`,
    ]);
  } else if (good.priceVolatility <= 0.15) {
    angles.push([
      `${good.label} continues to trade in a tight, predictable band — a reliable line for steady margins.`,
      `Nothing exciting to report on ${good.label}. Steady as always.`,
    ]);
  }

  if (good.theftRisk >= 0.5) {
    angles.push([
      `Security desks are urging shippers to tighten escorts on ${good.label} — it\u2019s a known target.`,
      `Insurers have flagged ${good.label} shipments as high-risk this quarter.`,
    ]);
  }

  if (good.customsRiskMod >= 1.4) {
    angles.push([
      `${good.label} keeps drawing extra attention at customs — clear early, don\u2019t cut it close.`,
      `Word from the docks: ${good.label} shipments are getting pulled for extra checks more often lately.`,
    ]);
  }

  if (good.legalFlags?.some(f => f.startsWith('bannedIn'))) {
    angles.push([
      `${good.label} remains a flashpoint in restricted hubs — enforcement is inconsistent, and so is the payoff.`,
      `Traders whisper that ${good.label} still moves under the table up north, for the right price.`,
    ]);
  }

  if (good.legalFlags?.includes('requiresInspection') || good.legalFlags?.includes('requiresExtraSecurity')) {
    angles.push([
      `Regulators are keeping a close eye on ${good.label} — expect the paperwork to slow you down.`,
    ]);
  }

  if (good.expirationHours <= 48) {
    angles.push([
      `${good.label} is moving fast off the shelves — nobody wants to hold it long, and it shows.`,
    ]);
  }

  if (good.profitMarginBonus >= 0.5 && good.priceVolatility < 0.5) {
    angles.push([
      `Demand for ${good.label} is running hot with margins to match — one of the better lines on the board.`,
    ]);
  }

  if (!angles.length) {
    angles.push([`${good.label} is trading without much drama today.`]);
  }

  return angles;
}

/**
 * Rotating analyst commentary for a handful of goods each day, generated
 * from their actual stats. Deterministic per day (same hashing approach
 * as getDemandWobble) so it doesn't flicker between reads, and reshuffles
 * with the daily reset so there's a reason to check back.
 */
export function getGoodsIntelBlock(): string {
  const day = todayStr();
  const ranked = Object.keys(GOODS).sort((a, b) => hashString(`${a}:${day}`) - hashString(`${b}:${day}`));
  const featured = ranked.slice(0, Math.min(WATCHLIST_SIZE, ranked.length));

  const lines = featured.map(key => {
    const good = GOODS[key];
    const angleSet = pickDeterministic(goodIntelAngles(good), `${key}:${day}:angle`);
    return `• ${pickDeterministic(angleSet, `${key}:${day}:line`)}`;
  });

  return `📊 *ANALYST WATCHLIST*\n${lines.join('\n')}`;
}

// ── Market Pulse: real player-driven signals for World News ────────────
//
// Unlike the scripted Nigeria events (globalTraderEvents.ts, macro/world
// flavor) or the Analyst Watchlist above (ambient, static per-good stats),
// this scans what players have actually done TODAY — real stock depletion
// from buying, real sell volume from dumping — and reports it as news.
// This is what makes "what you dump gets cheaper, what's scarce gets
// pricier" visible and legible instead of a silent number change nobody
// notices. Both mechanics (scarcity pricing in sourceShipment, depletion
// pricing in getMarketPrice) already move real prices; this just tells
// players about it in time to act.
const PULSE_SCARCITY_THRESHOLD = 0.5; // report a good once 50%+ of today's stock anywhere is gone
const PULSE_DUMP_THRESHOLD = 0.35;    // report a hub once sell volume hits 35%+ of that good's daily cap
const MARKET_PULSE_CACHE_TTL_MS = 3 * 60 * 1000; // real signal, but doesn't need to be instant — real news isn't either

export async function getMarketPulseBlock(): Promise<string> {
  // This scan is ~250 store reads (every country×good pair, every good×hub
  // pair). Fine occasionally, wasteful if World News gets checked a lot —
  // cache the computed block for a few minutes rather than rescan on every
  // single tap. Falls back to a live recompute if the cache read fails for
  // any reason, so a cache outage never breaks the screen.
  try {
    const cached = await marketPulseCacheTbl.get('current');
    if (cached && typeof cached === 'object' && Date.now() - (cached as any).computedAt < MARKET_PULSE_CACHE_TTL_MS) {
      return (cached as any).text;
    }
  } catch {
    // cache unavailable — fall through to a live computation below
  }

  const text = await computeMarketPulseBlock();

  try {
    await marketPulseCacheTbl.set('current', { text, computedAt: Date.now() });
  } catch {
    // caching failed — not fatal, the block itself is still valid to return
  }

  return text;
}

async function computeMarketPulseBlock(): Promise<string> {
  const scarcityStories: { text: string; severity: number }[] = [];
  const dumpStories: { text: string; severity: number }[] = [];

  // Buy-side: how much of today's allocation is actually gone, per country×good?
  for (const country of COUNTRIES) {
    for (const goodKey of country.goodKeys) {
      const good = GOODS[goodKey];
      const { remaining, cap } = await getStockLevel(country.key, goodKey);
      if (cap <= 0) continue;
      const depleted = 1 - remaining / cap;
      if (depleted >= PULSE_SCARCITY_THRESHOLD) {
        const pctLeft = Math.round((remaining / cap) * 100);
        scarcityStories.push({
          severity: depleted,
          text: remaining === 0
            ? `🔴 ${good.emoji} ${good.label} out of ${country.label} is SOLD OUT for today — nothing left in today's allocation.`
            : `📈 ${good.emoji} ${good.label} out of ${country.label} is running low — just ${pctLeft}% of today's stock left, and prices are climbing.`,
        });
      }
    }
  }

  // Sell-side: has anyone actually flooded a hub with a good today?
  for (const goodKey of Object.keys(GOODS)) {
    const good = GOODS[goodKey];
    for (const hub of HUBS) {
      if (hub.bannedGoods?.includes(goodKey)) continue;
      const sold = await getUnitsSoldToday(goodKey, hub.key);
      if (sold <= 0 || good.dailyStockCap <= 0) continue;
      const ratio = sold / good.dailyStockCap;
      if (ratio >= PULSE_DUMP_THRESHOLD) {
        dumpStories.push({
          severity: ratio,
          text: `📉 ${good.emoji} ${good.label} is flooding ${hub.label} — ${sold} units sold there today, and prices have softened.`,
        });
      }
    }
  }

  scarcityStories.sort((a, b) => b.severity - a.severity);
  dumpStories.sort((a, b) => b.severity - a.severity);
  const picks = [...scarcityStories.slice(0, 2), ...dumpStories.slice(0, 2)];

  if (!picks.length) {
    return '_Markets are quiet so far today — no major supply moves reported yet. Be the first to move it._';
  }

  return `🔥 *MARKET PULSE* _(live, from real trading activity today)_\n${picks.map(p => `• ${p.text}`).join('\n')}`;
}

/**
 * How hard a hub's market has been hit by selling today, as a multiplier
 * on price (1 = full price, floor = fully dumped).
 *
 * Curve: floor + (1-floor) * e^(-rate * units^power). Lowered floor allows
 * prices to crash hard when a market is flooded, creating real loss scenarios.
 *
 * Example depletion for volatile (demandStability = 0) good:
 *   20 units  → ~95%     100 units → ~70%
 *   50 units  → ~85%     200 units → ~45%     300 units → ~30%
 *
 * demandStability (0..1, per good) softens the curve for staple goods and
 * sharpens it for volatile ones: stability 1 halves the effective rate,
 * stability 0 applies the raw curve above at full strength.
 *
 * At DEPLETION_FLOOR = 0.15, a flooded market can easily sell below cost when
 * combined with duty, freight, and events — creating genuine profit risk.
 */
const DEPLETION_FLOOR = 0.15;
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

  // New price model: no guaranteed markup. Prices float dynamically.
  // profitMarginBonus acts as baseline demand expectation, not a guaranteed margin.
  const wobble = getDemandWobble(goodKey, hubKey, good.priceVolatility);
  const eventMultiplier = await getPriceMultiplier(goodKey, hubKey);
  const affinity = hub.categoryAffinity?.[good.category] ?? 1.0;
  // base = cost × (1 + baseline margin) × demand wobble × event factors × hub personality
  // This can drop below cost if wobble is -50% and events are bad.
  const base = good.baseCost * (1.0 + good.profitMarginBonus) * wobble * eventMultiplier * affinity;

  const soldToday = await getUnitsSoldToday(goodKey, hubKey);
  const depletionFactor = getDepletionFactor(soldToday, good.demandStability);

  // Apply market depletion and hub markup to final price.
  // With low depletion floor (0.15), flooded markets can sell at 15% of base.
  // If base is cost × 1.35 and depletion is 0.15, final price is cost × 0.2 — a loss.
  return Math.round(base * hub.priceMultiplier * depletionFactor);
}

/**
 * The "open" reference price for a (good, hub) pair — same formula as
 * getMarketPrice minus the depletion factor. Depletion reflects real
 * same-day trading activity (already visible live via Market Pulse and the
 * live price itself); the open price is what a trend should track instead,
 * so "is this market rising or falling" reflects genuine day-over-day
 * market movement (wobble + events + hub personality), not just "did
 * someone else already sell here today."
 */
async function getOpenPrice(goodKey: string, hubKey: string): Promise<number> {
  const good = GOODS[goodKey];
  const hub = HUBS.find(h => h.key === hubKey);
  if (!good || !hub) return 0;
  const wobble = getDemandWobble(goodKey, hubKey, good.priceVolatility);
  const eventMultiplier = await getPriceMultiplier(goodKey, hubKey);
  const affinity = hub.categoryAffinity?.[good.category] ?? 1.0;
  const base = good.baseCost * (1.0 + good.profitMarginBonus) * wobble * eventMultiplier * affinity;
  return Math.round(base * hub.priceMultiplier);
}

const PRICE_HISTORY_DAYS = 8; // 8 days kept so "7d ago" always has a real data point once the history fills up

async function recordDailySnapshotIfNeeded(goodKey: string, hubKey: string): Promise<Array<{ date: string; price: number }>> {
  const key = `${goodKey}:${hubKey}`;
  const history = ((await priceHistoryTbl.get(key)) as Array<{ date: string; price: number }>) || [];
  const today = todayStr();
  if (history.length && history[history.length - 1].date === today) return history;

  const openPrice = await getOpenPrice(goodKey, hubKey);
  history.push({ date: today, price: openPrice });
  while (history.length > PRICE_HISTORY_DAYS) history.shift();
  await priceHistoryTbl.set(key, history);
  return history;
}

export interface PriceTrend {
  current: number;
  openToday: number;
  changeSinceOpenPct: number;      // today's live movement — mostly reflects real dumping/depletion
  yesterdayOpen: number | null;
  change24hPct: number | null;     // day-over-day market movement (wobble/events), independent of depletion
  weekAgoOpen: number | null;
  change7dPct: number | null;
  direction: 'rising' | 'falling' | 'stable';
  daysTracked: number;             // how many real days of history we actually have (transparency, not a guess)
}

/**
 * Real price trend for a (good, hub) pair, built from actual daily open
 * snapshots — not simulated or estimated. First time any good/hub pair is
 * checked, this starts its own history from that day; trend data fills in
 * naturally over the following days rather than being backfilled or faked.
 */
export async function getPriceTrend(goodKey: string, hubKey: string): Promise<PriceTrend> {
  const history = await recordDailySnapshotIfNeeded(goodKey, hubKey);
  const current = await getMarketPrice(goodKey, hubKey);
  const openToday = history[history.length - 1].price;

  const yesterdayOpen = history.length >= 2 ? history[history.length - 2].price : null;
  const weekAgoOpen = history.length >= 8 ? history[0].price : null;

  const pctChange = (from: number | null, to: number): number | null =>
    from && from > 0 ? Math.round(((to - from) / from) * 100) : null;

  const changeSinceOpenPct = pctChange(openToday, current) ?? 0;
  const change24hPct = pctChange(yesterdayOpen, openToday);
  const change7dPct = pctChange(weekAgoOpen, openToday);

  const direction: PriceTrend['direction'] =
    changeSinceOpenPct > 3 ? 'rising' : changeSinceOpenPct < -3 ? 'falling' : 'stable';

  return { current, openToday, changeSinceOpenPct, yesterdayOpen, change24hPct, weekAgoOpen, change7dPct, direction, daysTracked: history.length };
}

function formatPct(pct: number | null): string {
  if (pct === null) return 'n/a';
  return pct > 0 ? `+${pct}%` : `${pct}%`;
}

/** Compact one-line trend badge for inline use next to a price, e.g. in the sell menu's hub list. */
export function formatTrendBadge(trend: PriceTrend): string {
  const arrow = trend.direction === 'rising' ? '📈' : trend.direction === 'falling' ? '📉' : '➖';
  return `${arrow} ${formatPct(trend.changeSinceOpenPct)} today`;
}

/** Full multi-hub trend report for a good — the "check before you commit" screen. */
export async function getPriceTrendReport(goodKey: string): Promise<string> {
  const good = GOODS[goodKey];
  if (!good) return '_Unknown good._';

  const lines: string[] = [];
  for (const hub of HUBS) {
    if (hub.bannedGoods?.includes(goodKey)) continue;
    const trend = await getPriceTrend(goodKey, hub.key);
    const arrow = trend.direction === 'rising' ? '📈' : trend.direction === 'falling' ? '📉' : '➖';
    const historyNote = trend.daysTracked < 2 ? ' _(first day tracked — no history yet)_' : '';
    lines.push(
      `${hub.label}: ${formatNumber(trend.current)} ${arrow}\n` +
      `  Today: ${formatPct(trend.changeSinceOpenPct)}  ·  24h: ${formatPct(trend.change24hPct)}  ·  7d: ${formatPct(trend.change7dPct)}${historyNote}`
    );
  }

  return `📈 *${good.emoji} ${good.label} — Price Trend*\n${lines.join('\n')}`;
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
    // CRITICAL FIX: Calculate spoilage from originalQty (set at clearance), not from the
    // already-reduced shipment.qty. This prevents repeated spoilage on retry attempts:
    // without this, calling sell() twice on the same old shipment would lose units both times.
    const originalQty = shipment.originalQty || shipment.qty; // fallback for old shipments without originalQty
    const rawAge = Date.now() - shipment.clearedAt;
    const effectiveAge = rawAge * warehouse.preservationFactor;
    const expiryMs = good.expirationHours * 3600000;
    if (effectiveAge > expiryMs) {
      const spoilFactor = Math.max(0.1, 1 - ((effectiveAge - expiryMs) / expiryMs) * 0.8);
      const spoiledQty = Math.round(originalQty * spoilFactor);
      if (spoiledQty === 0) {
        shipment.status = 'sold';
        shipment.soldAt = Date.now();
        all[idx] = shipment;
        await saveShipments(userId, all);
        return { success: false, reason: 'Goods have spoiled completely. Shipment discarded.' };
      }
      shipment.qty = spoiledQty; // Set qty to the spoiled amount for THIS sale attempt
    }
  }

  let courierFee = 0;
  let deliveredQty = shipment.qty;
  let courierNote = '';
  if (hub.courierRequired) {
    courierFee = hub.courierFeePerUnit * shipment.qty;
    const groqCourierFee = await coinsToGroqCoins(courierFee);
    const feeResult = await deductGroqCoins(userId, groqCourierFee, { type: 'admin_debit', note: `courier to ${hub.label}` });
    if (!feeResult.success) return { success: false, reason: 'Not enough Groq Coins for the courier fee.' };
    await contributeToJackpot(await groqCoinsToCoinsEquivalent(groqCourierFee));

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

  // Subtle marketplace fee (2% of proceeds). Combined with freight, duty, depletion,
  // and spoilage, this creates ~4-6% total drag without feeling explicitly "punchy".
  // Players see mostly profitable trades, but lose money slowly over many trades.
  const tradingCommission = Math.round(gross * (TRADING_COMMISSION_PCT / 100));
  const netProceeds = gross - tradingCommission;

  // Global Trader can generate single-sale payouts larger than a typical
  // slot/coinflip/dice win (a full day's stock of a bulk good sold at once). settleWin()'s floor protects the bank from
  // going negative, but says nothing about one Trader sale claiming the
  // *entire* surplus that slots/coinflip/dice players are also drawing from
  // in the same pool. This caps any single Trader sale to a share of the
  // current surplus, so one big trade degrades gracefully instead of either
  // draining the shared pool in one shot or blindsiding the player with a
  // silent full cap. Tune MAX_SINGLE_SALE_POOL_SHARE to taste.
  const poolBeforeSale = await getJackpotPool();
  const surplusBeforeSale = Math.max(0, poolBeforeSale - JACKPOT_SEED);
  const shareLimitedWin = Math.min(netProceeds, Math.round(surplusBeforeSale * MAX_SINGLE_SALE_POOL_SHARE));

  const { payout, capped: hardCapped } = settleWin(shareLimitedWin, poolBeforeSale);
  const capped = hardCapped || shareLimitedWin < netProceeds;
  await addCoins(userId, payout, { type: 'admin_credit', note: `sold ${deliveredQty}x ${good.label} @ ${hub.label}` });
  await deductFromJackpot(payout);
  await contributeToJackpot(tradingCommission); // House edge to jackpot
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
      const groqHoldingFee = await coinsToGroqCoins(holdingFee);
      const feeResult = await deductGroqCoins(userId, groqHoldingFee, { type: 'admin_debit', note: `warehouse holding fee: ${shipmentId}` });
      holdingFee = feeResult.success ? holdingFee : 0;
      if (feeResult.success) await contributeToJackpot(await groqCoinsToCoinsEquivalent(groqHoldingFee));
    }
  }

  // Cost basis includes trading commission (it reduces effective payout to player)
  const costBasis = shipment.totalCost + (shipment.dutyPaid || 0) + (shipment.bribePaid || 0) + courierFee + holdingFee + tradingCommission;
  const profit = payout - costBasis;
  const marginPct = costBasis > 0 ? Math.round((profit / costBasis) * 100) : 0;

  shipment.status = 'sold';
  shipment.hub = hubKey;
  shipment.soldAt = Date.now();
  all[idx] = shipment;
  await saveShipments(userId, all);

  const stats = await getStats(userId);
  stats.lifetimeNetProfit += profit; // Actual net: includes losses (negative values)
  stats.lifetimeTradingVolume += payout; // Gross value of sale for volume tracking
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
    tradingCommission,
    blackMarket: isRestrictedHere,
    courierNote: courierNote || null,
  };
}

// Re-exported for the UI layer — same status-line role as the events module
// plays internally; lets the menu show what's happening in Nigeria right now.
export { getEventsStatusBlock, getEventsDetailBlock };