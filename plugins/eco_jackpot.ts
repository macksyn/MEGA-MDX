// @ts-nocheck
/***
 * plugins/eco_jackpot.ts
 *
 * This is no longer just a jackpot display — it's the statement for the real
 * bank that backs !slots, !coinflip and !dice (see lib/slotMachine.ts). Every
 * stake wagered on those games becomes bank capital; every payout is drawn
 * back out of it. This command shows that honestly: current reserve, the
 * protected floor, today's actual inflow/outflow, and (for admins) the
 * internal health signals driving the RTP ceiling.
 *
 * NOTE: assumes lib/isOwner.js exports `isOwner(userId): boolean`. Adjust the
 * import below if your actual export name/signature differs.
 */
import { withEconomyGuard, formatNumber } from '../lib/economy.js';
import {
  getJackpotPool, getTodayStats, getSolvencyState, getHouseMood,
  TARGET_RTP, HARD_CEILING_RTP, EMERGENCY_CEILING_RTP,
} from '../lib/slotMachine.js';
import { cleanJid, isOwner } from '../lib/isOwner.js';

export const command = 'reserve';
export const aliases = ['jackpot', 'bank'];
export const category = 'economy-games';
export const cooldown = 3000;

const JACKPOT_SEED = 5000; // mirrors the protected floor in lib/slotMachine.ts

// Vague, ambient flavor only — deliberately doesn't say "odds are better/worse
// right now" or name the mechanic, so !jackpot can't be used to time bets
// around the house mood window.
const MOOD_FLAVOR: Record<string, string> = {
  hot:     `🌤️ The bank's been feeling generous lately.`,
  cold:    `🌥️ The bank's been playing it a little safe lately.`,
  neutral: `⛅ The bank's running steady as usual.`,
};

function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, senderId, channelInfo } = context;
  const userId = cleanJid(senderId);

  const wantsAdmin = (args[0] || '').toLowerCase() === 'admin';

  if (wantsAdmin) {
    if (!isOwner(userId)) {
      return sock.sendMessage(chatId, {
        text: `❌ That view is for admins only.`,
        ...channelInfo
      }, { quoted: message });
    }
    return sendAdminView(sock, chatId, message, channelInfo);
  }

  const pool = await getJackpotPool();
  const today = await getTodayStats();
  const mood = await getHouseMood();
  const surplus = Math.max(0, pool - JACKPOT_SEED);
  const netSign = today.net > 0 ? '+' : '';

  await sock.sendMessage(chatId, {
    text:
      `🏦 *THE COMMUNITY BANK* 🏦\n\n` +
      `💰 Current reserve: *${formatNumber(pool)} coins*\n` +
      `🛡️ Protected floor: *${formatNumber(JACKPOT_SEED)} coins* _(never spent — guarantees the bank can never fail)_\n` +
      `🎯 Available to win: *${formatNumber(surplus)} coins*\n\n` +
      `📊 *Today's activity*\n` +
      `   Wagered: ${formatNumber(today.bet)} coins\n` +
      `   Paid out: ${formatNumber(today.won)} coins\n` +
      `   Net: ${netSign}${formatNumber(today.net)} coins\n\n` +
      `${MOOD_FLAVOR[mood.mood] || MOOD_FLAVOR.neutral}\n\n` +
      `🎮 Fed by: *!slots*, *!coinflip*, *!dice*\n` +
      `_Every stake goes in. Every win comes out. No coins are ever printed — this is the real house account, not a bonus pot._`,
    ...channelInfo
  }, { quoted: message });
}

async function sendAdminView(sock: any, chatId: string, message: any, channelInfo: any) {
  const pool = await getJackpotPool();
  const today = await getTodayStats();
  const solvency = getSolvencyState(pool);
  const mood = await getHouseMood();
  const surplus = Math.max(0, pool - JACKPOT_SEED);
  const lifetimeNet = pool - JACKPOT_SEED; // pool = seed + Σcontributions - Σpayouts, so this IS lifetime net
  const activeCeiling = solvency.level === 'critical' ? EMERGENCY_CEILING_RTP : HARD_CEILING_RTP;
  const netSign = today.net > 0 ? '+' : '';
  const moodRemaining = formatDuration(mood.expiresAt - Date.now());

  await sock.sendMessage(chatId, {
    text:
      `🏦 *BANK — ADMIN VIEW* 🏦\n\n` +
      `💰 Reserve: *${formatNumber(pool)} coins*  (floor ${formatNumber(JACKPOT_SEED)}, surplus ${formatNumber(surplus)})\n` +
      `📈 Lifetime net: *${lifetimeNet >= 0 ? '+' : ''}${formatNumber(lifetimeNet)} coins* _(all-time wagered − paid out)_\n\n` +
      `🛡️ Solvency: *${solvency.level.toUpperCase()}*  (pressure ×${solvency.pressure.toFixed(3)})\n` +
      `🎲 House mood: *${mood.mood}*  (×${mood.multiplier.toFixed(2)}, resets in ~${moodRemaining})\n` +
      `🎯 Active RTP ceiling: *${(activeCeiling * 100).toFixed(0)}%*  (target ${(TARGET_RTP * 100).toFixed(1)}%, hard ${(HARD_CEILING_RTP * 100).toFixed(0)}%, emergency ${(EMERGENCY_CEILING_RTP * 100).toFixed(0)}%)\n\n` +
      `📊 Today: wagered ${formatNumber(today.bet)}  |  paid ${formatNumber(today.won)}  |  net ${netSign}${formatNumber(today.net)}\n\n` +
      `_Ocean Hunt runs its own separate bank — not included here._`,
    ...channelInfo
  }, { quoted: message });
}

export const handler = withEconomyGuard(_handler);