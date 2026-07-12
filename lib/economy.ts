// @ts-nocheck
/***
 * lib/economy.ts
 *
 * Core Groq-Economy module — coins (everyday currency) and Groq Coins
 * (scarce currency, cashable out for real airtime/cash once a threshold
 * is hit). Mirrors the Taka coins/Groq Coins model.
 *
 * Nothing in here talks to WhatsApp directly — plugins call these
 * functions and handle the messaging themselves. That keeps this file
 * testable and reusable across commands.
 *
 * Storage: uses your existing pluginStore (Mongo/Postgres/MySQL/SQLite/
 * file, whichever your env vars point to) under the 'economy' namespace,
 * split into tables: wallets, activity, withdrawals, settings.
 */

import moment from 'moment-timezone';
import { createStore } from './pluginStore.js';
import config from '../config.js';
import { getTopActiveForDay, isGroupEnabled } from './activitytracker.js';

const root       = createStore('economy');
const wallets     = root.table('wallets');
const withdrawals = root.table('withdrawals');
const settingsTbl = root.table('settings');
const processed   = root.table('processed');

const TZ = config.timeZone || 'Africa/Lagos';

// ── Settings ─────────────────────────────────────────────────────────────────

interface EconomySettings {
  coinsPerGroqCoin:        number;   // how many coins convert into 1 Groq Coin
  groqCoinWithdrawThreshold: number; // min Groq Coins balance required to request withdrawal
  dailyStreakBonuses:  Record<string, number>; // streak-day -> bonus coins, e.g. { "7": 500 }
  workMin:             number;
  workMax:             number;
  workCooldownMs:      number;
  top3Rewards:         [number, number, number]; // coins for 1st/2nd/3rd most active per day
  fineAmount:          number; // coins docked for bad-word/spam triggers (used by other plugins if wired up)
  economyGroupId:      string | null; // the ONE group JID (e.g. '1203xxxx@g.us') this economy is scoped to. null = unrestricted (any chat)
}

const DEFAULT_SETTINGS: EconomySettings = {
  coinsPerGroqCoin: Number(process.env.ECONOMY_COINS_PER_GROQCOIN) || 100,
  groqCoinWithdrawThreshold: Number(process.env.ECONOMY_GROQCOIN_WITHDRAW_THRESHOLD) || 50,
  dailyStreakBonuses: { '3': 50, '7': 250, '14': 600, '30': 1500 },
  workMin: Number(process.env.ECONOMY_WORK_MIN) || 50,
  workMax: Number(process.env.ECONOMY_WORK_MAX) || 300,
  workCooldownMs: Number(process.env.ECONOMY_WORK_COOLDOWN_MS) || 60 * 60 * 1000, // 1hr
  top3Rewards: [300, 200, 100],
  fineAmount: Number(process.env.ECONOMY_FINE_AMOUNT) || 20,
  economyGroupId: process.env.ECONOMY_GROUP_ID || null,
};

export async function getSettings(): Promise<EconomySettings> {
  const stored = await settingsTbl.get('global');
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}

export async function updateSettings(patch: Partial<EconomySettings>): Promise<EconomySettings> {
  await settingsTbl.patch('global', patch);
  return getSettings();
}

// ── Designated-group guard ───────────────────────────────────────────────────
// If economyGroupId is set, every user-facing economy command only works in
// that one group. Unset (null) means unrestricted — useful before you've
// picked a group, but you'll almost always want this set.

export async function isEconomyChat(chatId: string): Promise<boolean> {
  const settings = await getSettings();
  if (!settings.economyGroupId) return true;
  return chatId === settings.economyGroupId;
}

/**
 * Wraps a plugin handler so it silently no-ops (with a friendly message) in
 * any chat other than the designated economy group. Use for every
 * user-facing economy command; skip it for owner-only admin/withdrawal
 * review commands, which should still work from a DM.
 */
export function withEconomyGuard(handler: (sock: any, message: any, args: string[], context: any) => Promise<any>) {
  return async (sock: any, message: any, args: string[], context: any) => {
    const { chatId, channelInfo } = context;
    if (!await isEconomyChat(chatId)) {
      return sock.sendMessage(chatId, {
        text: `❌ The coins & Groq Coins economy only works in the designated group.`,
        ...channelInfo
      }, { quoted: message });
    }
    return handler(sock, message, args, context);
  };
}

// ── Wallet primitives ────────────────────────────────────────────────────────

export interface Wallet {
  coins: number;
  groqCoins: number;
  dailyStreak: number;
  lastDailyDate: string | null;   // 'YYYY-MM-DD' in TZ
  lastWorkTs: number;
  lifetimeCoinsEarned: number;
  lifetimeGroqCoinsEarned: number;
  exchangeCount: number;
  createdAt: number;
}

const EMPTY_WALLET: Wallet = {
  coins: 0,
  groqCoins: 0,
  dailyStreak: 0,
  lastDailyDate: null,
  lastWorkTs: 0,
  lifetimeCoinsEarned: 0,
  lifetimeGroqCoinsEarned: 0,
  exchangeCount: 0,
  createdAt: Date.now(),
};

export async function getWallet(userId: string): Promise<Wallet> {
  const w = await wallets.get(userId);
  return w ? { ...EMPTY_WALLET, ...w } : { ...EMPTY_WALLET };
}

async function saveWallet(userId: string, wallet: Wallet): Promise<Wallet> {
  await wallets.set(userId, wallet);
  return wallet;
}

export function todayStr(): string {
  return moment().tz(TZ).format('YYYY-MM-DD');
}

function yesterdayOf(dateStr: string): string {
  return moment.tz(dateStr, 'YYYY-MM-DD', TZ).subtract(1, 'day').format('YYYY-MM-DD');
}

export async function addCoins(userId: string, amount: number): Promise<Wallet> {
  const wallet = await getWallet(userId);
  wallet.coins += amount;
  if (amount > 0) wallet.lifetimeCoinsEarned += amount;
  return saveWallet(userId, wallet);
}

export async function addGroqCoins(userId: string, amount: number): Promise<Wallet> {
  const wallet = await getWallet(userId);
  wallet.groqCoins += amount;
  if (amount > 0) wallet.lifetimeGroqCoinsEarned += amount;
  return saveWallet(userId, wallet);
}

export async function deductCoins(userId: string, amount: number): Promise<{ success: boolean; wallet: Wallet }> {
  const wallet = await getWallet(userId);
  if (wallet.coins < amount) return { success: false, wallet };
  wallet.coins -= amount;
  return { success: true, wallet: await saveWallet(userId, wallet) };
}

export async function deductGroqCoins(userId: string, amount: number): Promise<{ success: boolean; wallet: Wallet }> {
  const wallet = await getWallet(userId);
  if (wallet.groqCoins < amount) return { success: false, wallet };
  wallet.groqCoins -= amount;
  return { success: true, wallet: await saveWallet(userId, wallet) };
}

export async function addExchange(userId: string, amount = 1): Promise<Wallet> {
  const wallet = await getWallet(userId);
  wallet.exchangeCount += amount;
  return saveWallet(userId, wallet);
}

const LEVEL_DEFS = [
  { name: 'Novice', nextName: 'Active', threshold: 0 },
  { name: 'Active', nextName: 'Pro', threshold: 25 },
  { name: 'Pro', nextName: 'Elite', threshold: 50 },
  { name: 'Elite', nextName: 'Legend', threshold: 100 },
  { name: 'Legend', nextName: null, threshold: 200 },
] as const;

function createProgressBar(percent: number, size = 10): string {
  const filled = Math.round((percent / 100) * size);
  const safeFilled = Math.max(0, Math.min(size, filled));
  return `${'█'.repeat(safeFilled)}${'░'.repeat(size - safeFilled)}`;
}

export function getLevelInfo(exchangeCount: number): {
  levelNumber: number;
  levelName: string;
  nextLevelName: string | null;
  progressPercent: number;
  current: number;
  next: number;
  bar: string;
} {
  const safeCount = Math.max(0, Math.floor(exchangeCount || 0));
  let levelIndex = LEVEL_DEFS.length - 1;

  while (levelIndex > 0 && safeCount < LEVEL_DEFS[levelIndex].threshold) {
    levelIndex -= 1;
  }

  const currentLevel = LEVEL_DEFS[levelIndex];
  const nextLevel = LEVEL_DEFS[levelIndex + 1] || null;
  const rangeStart = currentLevel.threshold;
  const rangeEnd = nextLevel ? nextLevel.threshold : rangeStart + 25;
  const totalForLevel = Math.max(1, rangeEnd - rangeStart);
  const progressPercent = nextLevel
    ? Math.min(100, Math.max(0, Math.round(((safeCount - rangeStart) / totalForLevel) * 100)))
    : 100;

  return {
    levelNumber: levelIndex + 1,
    levelName: currentLevel.name,
    nextLevelName: currentLevel.nextName,
    progressPercent,
    current: safeCount,
    next: nextLevel ? nextLevel.threshold : safeCount,
    bar: createProgressBar(progressPercent),
  };
}

export async function transferCoins(fromId: string, toId: string, amount: number): Promise<{ success: boolean; reason?: string }> {
  if (amount <= 0) return { success: false, reason: 'invalid_amount' };
  if (fromId === toId) return { success: false, reason: 'self_transfer' };

  const from = await deductCoins(fromId, amount);
  if (!from.success) return { success: false, reason: 'insufficient_funds' };

  await addCoins(toId, amount);
  return { success: true };
}

export async function convertCoinsToGroqCoins(userId: string, coinsAmount: number): Promise<{ success: boolean; reason?: string; groqCoinsGained?: number }> {
  const settings = await getSettings();
  if (coinsAmount < settings.coinsPerGroqCoin) {
    return { success: false, reason: 'below_minimum' };
  }
  const groqCoinsGained = Math.floor(coinsAmount / settings.coinsPerGroqCoin);
  const coinsToSpend = groqCoinsGained * settings.coinsPerGroqCoin;

  const result = await deductCoins(userId, coinsToSpend);
  if (!result.success) return { success: false, reason: 'insufficient_funds' };

  await addGroqCoins(userId, groqCoinsGained);
  await addExchange(userId, 1);
  return { success: true, groqCoinsGained };
}

// ── Attendance-triggered daily bonus (streak-based) ──────────────────────────
// No more manual "!daily" claim — this is called once by attendance.ts right
// after it approves a submission for the day. Same streak-milestone math as
// before, just triggered by a real attendance form instead of a command.
//
// The base reward and image bonus amounts are NOT configured here — they live
// in plugins/attendance.ts's own settings (.attendance settings) so there's a
// single place admins adjust them. This function is only handed the resolved
// numbers and applies the streak-milestone math + wallet crediting on top.

export async function awardAttendanceBonus(
  userId: string,
  hasImage = false,
  baseReward: number,
  imageBonusAmount = 0
): Promise<
  | { success: false; reason: 'already_awarded_today' }
  | { success: true; reward: number; streak: number; streakBonus: number; imageBonus: number }
> {
  const settings = await getSettings();
  const wallet = await getWallet(userId);
  const today = todayStr();

  if (wallet.lastDailyDate === today) {
    // Already credited today — attendance.ts already blocks a second
    // submission on the same day, this is just a defensive double-check.
    return { success: false, reason: 'already_awarded_today' };
  }

  const wasYesterday = wallet.lastDailyDate === yesterdayOf(today);
  const newStreak = wasYesterday ? wallet.dailyStreak + 1 : 1;

  // Find the highest streak-bonus milestone reached (checked in descending order)
  let streakBonus = 0;
  const milestones = Object.keys(settings.dailyStreakBonuses).map(Number).sort((a, b) => b - a);
  for (const m of milestones) {
    if (newStreak >= m && newStreak % m === 0) {
      streakBonus = settings.dailyStreakBonuses[String(m)];
      break;
    }
  }

  const imageBonus = hasImage ? imageBonusAmount : 0;
  const reward = baseReward + streakBonus + imageBonus;

  wallet.coins += reward;
  wallet.lifetimeCoinsEarned += reward;
  wallet.dailyStreak = newStreak;
  wallet.lastDailyDate = today;
  await saveWallet(userId, wallet);

  return { success: true, reward, streak: newStreak, streakBonus, imageBonus };
}

// ── Work command (cooldown-based random payout) ──────────────────────────────

export async function doWork(userId: string): Promise<
  | { success: false; remainingMs: number }
  | { success: true; reward: number }
> {
  const settings = await getSettings();
  const wallet = await getWallet(userId);
  const now = Date.now();
  const readyAt = wallet.lastWorkTs + settings.workCooldownMs;

  if (now < readyAt) {
    return { success: false, remainingMs: readyAt - now };
  }

  const reward = Math.floor(Math.random() * (settings.workMax - settings.workMin + 1)) + settings.workMin;
  wallet.coins += reward;
  wallet.lifetimeCoinsEarned += reward;
  wallet.lastWorkTs = now;
  await saveWallet(userId, wallet);

  return { success: true, reward };
}

// ── Top-3-most-active payout ─────────────────────────────────────────────────
// Raw daily message counts come from your existing lib/activitytracker.ts
// (same hook already wired into messageHandler.ts — nothing new tracked here).

/**
 * Pays out coins to the top-3 most active users for a given group+date.
 * Idempotent — safe to call more than once for the same chat+date (e.g. if
 * the bot restarts near the scheduled time), it will only pay out once.
 * Skips groups that don't have activity tracking enabled (via !activity enable).
 */
export async function payoutTopActive(chatId: string, dateStr: string): Promise<Array<{ userId: string; count: number; reward: number; rank: number }>> {
  if (!await isEconomyChat(chatId)) return [];
  if (!await isGroupEnabled(chatId)) return [];

  const processedKey = `${dateStr}:${chatId}`;
  if (await processed.get(processedKey)) return [];

  const settings = await getSettings();
  const top3 = await getTopActiveForDay(chatId, dateStr, 3);

  const results: Array<{ userId: string; count: number; reward: number; rank: number }> = [];
  for (let i = 0; i < top3.length; i++) {
    const reward = settings.top3Rewards[i] || 0;
    if (reward > 0) {
      await addCoins(top3[i].userId, reward);
    }
    results.push({ ...top3[i], reward, rank: i + 1 });
  }

  await processed.set(processedKey, true);
  return results;
}

// ── Withdrawals (Groq Coins -> real payout, admin-approved) ───────────────────────

export interface WithdrawalRequest {
  id: string;
  userId: string;
  groqCoins: number;
  payoutInfo: string;
  status: 'pending' | 'approved' | 'rejected' | 'paid';
  requestedAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
  note: string | null;
}

export async function requestWithdrawal(userId: string, groqCoinsAmount: number, payoutInfo: string): Promise<
  | { success: false; reason: 'below_threshold' | 'insufficient_funds' }
  | { success: true; request: WithdrawalRequest }
> {
  const settings = await getSettings();
  const wallet = await getWallet(userId);

  if (groqCoinsAmount < settings.groqCoinWithdrawThreshold) {
    return { success: false, reason: 'below_threshold' };
  }
  if (wallet.groqCoins < groqCoinsAmount) {
    return { success: false, reason: 'insufficient_funds' };
  }

  // Hold the Groq Coins in escrow immediately so they can't be double-spent
  // while the request is pending.
  await deductGroqCoins(userId, groqCoinsAmount);

  const id = `wd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const request: WithdrawalRequest = {
    id,
    userId,
    groqCoins: groqCoinsAmount,
    payoutInfo,
    status: 'pending',
    requestedAt: Date.now(),
    resolvedAt: null,
    resolvedBy: null,
    note: null,
  };

  await withdrawals.set(id, request);
  return { success: true, request };
}

export async function listWithdrawals(status?: WithdrawalRequest['status']): Promise<WithdrawalRequest[]> {
  const all = await withdrawals.getAll();
  const list = Object.values(all) as WithdrawalRequest[];
  return status ? list.filter(w => w.status === status) : list;
}

export async function getWithdrawal(id: string): Promise<WithdrawalRequest | null> {
  return withdrawals.get(id);
}

export async function resolveWithdrawal(
  id: string,
  adminId: string,
  approve: boolean,
  note?: string
): Promise<{ success: boolean; reason?: string; request?: WithdrawalRequest }> {
  const request: WithdrawalRequest | null = await withdrawals.get(id);
  if (!request) return { success: false, reason: 'not_found' };
  if (request.status !== 'pending') return { success: false, reason: 'already_resolved' };

  if (!approve) {
    // Refund the escrowed Groq Coins back to the user
    await addGroqCoins(request.userId, request.groqCoins);
  }

  request.status = approve ? 'approved' : 'rejected';
  request.resolvedAt = Date.now();
  request.resolvedBy = adminId;
  request.note = note || null;
  await withdrawals.set(id, request);

  return { success: true, request };
}

export async function markWithdrawalPaid(id: string, adminId: string, note?: string): Promise<{ success: boolean; reason?: string; request?: WithdrawalRequest }> {
  const request: WithdrawalRequest | null = await withdrawals.get(id);
  if (!request) return { success: false, reason: 'not_found' };
  if (request.status !== 'approved') return { success: false, reason: 'not_approved' };

  request.status = 'paid';
  request.resolvedAt = Date.now();
  request.resolvedBy = adminId;
  request.note = note || request.note;
  await withdrawals.set(id, request);

  return { success: true, request };
}

// ── Leaderboard ───────────────────────────────────────────────────────────────

export async function getLeaderboard(type: 'coins' | 'groqcoins', limit = 10): Promise<Array<{ userId: string; amount: number }>> {
  const all = await wallets.getAll();
  return Object.entries(all)
    .map(([userId, w]: [string, any]) => ({ userId, amount: type === 'coins' ? (w.coins || 0) : (w.groqCoins || 0) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit);
}

// ── Admin utilities ───────────────────────────────────────────────────────────

export async function resetWallet(userId: string): Promise<void> {
  await wallets.set(userId, { ...EMPTY_WALLET, createdAt: Date.now() });
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}