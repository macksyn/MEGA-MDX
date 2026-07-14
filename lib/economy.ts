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
import { getMonthlyLeaderboard, isGroupEnabled } from './activitytracker.js';
import { cleanJid } from './isOwner.js';

const root       = createStore('economy');
const wallets     = root.table('wallets');
const withdrawals = root.table('withdrawals');
const settingsTbl = root.table('settings');
const processed   = root.table('processed');
const feePool     = root.table('feePool'); // accumulated fees from peer-to-peer exchanges

const TZ = config.timeZone || 'Africa/Lagos';

// ── Settings ─────────────────────────────────────────────────────────────────

interface EconomySettings {
  coinsPerGroqCoin:        number;   // how many coins convert into 1 Groq Coin
  groqCoinWithdrawThreshold: number; // min Groq Coins balance required to request withdrawal
  dailyStreakBonuses:  Record<string, number>; // streak-day -> bonus coins, e.g. { "7": 500 }
  workMin:             number;
  workMax:             number;
  workCooldownMs:      number;
  top3Rewards:         [number, number, number]; // daily coins for whoever holds rank 1st/2nd/3rd on the monthly activity leaderboard, paid every day they hold that spot
  exchangeFeePercent:  number; // % cut taken from the Groq Coins side of a peer-to-peer !exchange, routed to the fee pool
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
  exchangeFeePercent: Number(process.env.ECONOMY_EXCHANGE_FEE_PERCENT) || 15,
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
    const { chatId, channelInfo, senderId } = context;
    if (!await isEconomyChat(chatId)) {
      return sock.sendMessage(chatId, {
        text: `❌ The coins & Groq Coins economy only works in the designated group.`,
        ...channelInfo
      }, { quoted: message });
    }
    // Fire-and-forget: keep the wallet's name/phone fresh from this live
    // message without delaying the actual command response.
    if (senderId) void syncIdentity(cleanJid(senderId), sock, message?.pushName);
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
  name: string | null;    // best-known display first name (WhatsApp pushName/contact), for recognition
  phone: string | null;   // best-known phone number, resolved from @lid where needed
  identitySyncedAt: number | null;
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
  name: null,
  phone: null,
  identitySyncedAt: null,
};

export async function getWallet(userId: string): Promise<Wallet> {
  const w = await wallets.get(userId);
  return w ? { ...EMPTY_WALLET, ...w } : { ...EMPTY_WALLET };
}

async function saveWallet(userId: string, wallet: Wallet): Promise<Wallet> {
  await wallets.set(userId, wallet);
  return wallet;
}

// ── Identity recognition (name + phone) ──────────────────────────────────────
// Every economy wallet is keyed by a normalized JID, which on its own is
// unrecognizable (raw digits, or a @lid identifier that isn't even a real
// phone number). To make wallets easy to recognize in admin tooling and
// leaderboards, we opportunistically resolve and persist a real name +
// phone number onto the wallet record — same approach used by
// plugins/birthday.ts (phone from @lid) and plugins/chatbot.ts (first name
// from pushName).

/** Extract the first real name word from a WhatsApp pushName/contact name. */
function extractFirstName(pushName: string | undefined | null): string | null {
  if (!pushName) return null;
  const tokens = pushName.trim().split(/\s+/);
  for (const token of tokens) {
    const letters = token.replace(/[^\p{L}'\-]/gu, '');
    if (letters.length >= 2) {
      return letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase();
    }
  }
  return null;
}

/** Resolve a real phone number for a userId, unwrapping @lid identifiers when possible. */
async function resolvePhone(userId: string, sock: any): Promise<string | null> {
  const raw = userId.split('@')[0].split(':')[0];
  if (!userId.includes('@lid')) return raw || null;
  if (!sock) return null;

  // 1. Check store contacts
  const stored = sock.store?.contacts?.[userId]?.phone;
  if (stored) return stored;

  // 2. Check runtime lidToPhone map (populated from group events)
  const fromMap = sock.store?.lidToPhone?.[raw];
  if (fromMap) return fromMap;

  // 3. Ask Baileys signal repository directly — works without cached mapping
  try {
    const lidMapping = sock?.signalRepository?.lidMapping;
    const pnJid: string | null = lidMapping ? await lidMapping.getPNForLID(userId) : null;
    if (pnJid) {
      const phone = pnJid.split('@')[0].split(':')[0];
      if (sock.store?.lidToPhone) sock.store.lidToPhone[raw] = phone;
      return phone;
    }
  } catch (_) {}

  return null;
}

/** Resolve a display first name, preferring a fresh pushName over a cached contact entry. */
function resolveName(userId: string, sock: any, pushNameHint?: string | null): string | null {
  const fromHint = extractFirstName(pushNameHint);
  if (fromHint) return fromHint;

  const contact = sock?.store?.contacts?.[userId];
  const notify = contact?.notify || contact?.name || contact?.pushName;
  return extractFirstName(notify);
}

/**
 * Opportunistically fill in / refresh a wallet's name + phone so it's
 * recognizable in admin tooling and leaderboards. Cheap, non-blocking,
 * safe to call on every economy command — only writes when something
 * actually changed. Never throws.
 */
export async function syncIdentity(userId: string, sock: any, pushName?: string | null): Promise<void> {
  if (!userId || !sock) return;
  try {
    const wallet = await getWallet(userId);
    const [phone, name] = [await resolvePhone(userId, sock), resolveName(userId, sock, pushName)];

    const patch: Partial<Wallet> = {};
    if (phone && phone !== wallet.phone) patch.phone = phone;
    if (name && name !== wallet.name) patch.name = name;

    if (Object.keys(patch).length > 0) {
      patch.identitySyncedAt = Date.now();
      await wallets.patch(userId, patch);
    }
  } catch (_) {
    // Best-effort — identity recognition should never break an economy command.
  }
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

// ── Peer-to-peer exchange (Taka-style "beans" trade) ─────────────────────────
// Unlike convertCoinsToGroqCoins (self-service conversion, kept above for any
// other callers), THIS is the mechanic behind the !exchange command: you
// spend your own coins, but the resulting Groq Coins land in the TARGET
// member's wallet, minus a fee that's routed to the fee pool rather than
// disappearing or going to either party. To get your own Groq Coins, someone
// else has to run !exchange targeting you.

/** Add to the persistent fee pool (Groq Coins collected from !exchange fees). */
export async function addToFeePool(amount: number): Promise<number> {
  if (amount <= 0) return getFeePoolBalance();
  const current = (await feePool.get('groqCoins')) || 0;
  const updated = current + amount;
  await feePool.set('groqCoins', updated);
  return updated;
}

/** Current fee pool balance, in Groq Coins. */
export async function getFeePoolBalance(): Promise<number> {
  return (await feePool.get('groqCoins')) || 0;
}

/** Owner-only: drain the fee pool (e.g. after spending it on something), returning what was drained. */
export async function drainFeePool(): Promise<number> {
  const current = await getFeePoolBalance();
  await feePool.set('groqCoins', 0);
  return current;
}

export async function exchangeWithMember(senderId: string, targetId: string, coinsAmount: number): Promise<
  | { success: false; reason: 'invalid_amount' | 'self_exchange' | 'below_minimum' | 'insufficient_funds' }
  | { success: true; coinsSpent: number; groqCoinsGained: number; fee: number }
> {
  if (!coinsAmount || coinsAmount <= 0) return { success: false, reason: 'invalid_amount' };
  if (senderId === targetId) return { success: false, reason: 'self_exchange' };

  const settings = await getSettings();
  if (coinsAmount < settings.coinsPerGroqCoin) {
    return { success: false, reason: 'below_minimum' };
  }

  // Only the portion of coinsAmount that converts evenly is actually spent
  // (same rounding behavior as convertCoinsToGroqCoins).
  const groqCoinsGross = Math.floor(coinsAmount / settings.coinsPerGroqCoin);
  const coinsToSpend = groqCoinsGross * settings.coinsPerGroqCoin;

  const spend = await deductCoins(senderId, coinsToSpend);
  if (!spend.success) return { success: false, reason: 'insufficient_funds' };

  const feePercent = settings.exchangeFeePercent;
  const fee = Math.floor(groqCoinsGross * feePercent / 100);
  const netGroqCoins = groqCoinsGross - fee;

  if (netGroqCoins > 0) await addGroqCoins(targetId, netGroqCoins);
  if (fee > 0) await addToFeePool(fee);

  // Counts toward the SENDER's exchange-level progress, same as self-conversion did.
  await addExchange(senderId, 1);

  return { success: true, coinsSpent: coinsToSpend, groqCoinsGained: netGroqCoins, fee };
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

// ── Top-3-on-the-monthly-leaderboard payout ──────────────────────────────────
// Rank comes from lib/activitytracker.ts's cumulative monthly POINTS
// leaderboard (messages, stickers, videos, etc. — whatever's weighted in
// !activity settings), NOT a daily-reset counter. This is re-evaluated fresh
// every time it runs: whoever holds rank 1/2/3 *right now* gets paid for
// today. No streak state to track — if someone gets overtaken, they simply
// aren't in the top 3 next time this runs, and stop earning; the person who
// overtook them starts earning immediately. The leaderboard position IS the
// streak.

/**
 * Pays out coins to whoever holds the top-3 spots on the monthly activity
 * leaderboard for a given group+date. Idempotent — safe to call more than
 * once for the same chat+date (e.g. if the bot restarts near the scheduled
 * time), it will only pay out once. Skips groups that don't have activity
 * tracking enabled (via !activity enable).
 */
export async function payoutMonthlyTop3(chatId: string, dateStr: string): Promise<Array<{ userId: string; points: number; reward: number; rank: number }>> {
  if (!await isEconomyChat(chatId)) return [];
  if (!await isGroupEnabled(chatId)) return [];

  const processedKey = `monthlyTop3:${dateStr}:${chatId}`;
  if (await processed.get(processedKey)) return [];

  const settings = await getSettings();
  const top3 = await getMonthlyLeaderboard(chatId, null, 3);

  const results: Array<{ userId: string; points: number; reward: number; rank: number }> = [];
  for (let i = 0; i < top3.length; i++) {
    const reward = settings.top3Rewards[i] || 0;
    if (reward > 0) {
      await addCoins(top3[i].userId, reward);
    }
    results.push({ userId: top3[i].userId, points: top3[i].points, reward, rank: i + 1 });
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