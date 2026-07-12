// @ts-nocheck
import { withEconomyGuard, formatNumber } from '../lib/economy.js';
import { getJackpotPool, getStakeProfile } from '../lib/slotMachine.js';
import { handler as ecoAdminHandler } from './eco_admin.js';
import config from '../config.js';

export const command = 'economy';
export const aliases = ['eco', 'dashboard', 'stats'];
export const category = 'economy';
export const cooldown = 3000;

const prefix = config.prefix;

// ── Main menu ──────────────────────────────────────────────────────────────────

async function showMenu(sock: any, message: any, context: any) {
  const { chatId, channelInfo } = context;

  const text =
    `💰 *ECONOMY SYSTEM* 💰\n\n` +
    `💵 *Basic Commands:*\n` +
    `• *${prefix}balance* - Check your coin balance\n` +
    `• *${prefix}balance @user* - Check someone else's balance\n` +
    `• *${prefix}give @user <amount>* - Transfer coins to another member\n` +
    `• *${prefix}exchange <amount>* - Convert coins into Groq Coins\n\n` +
    `💼 *Earning:*\n` +
    `• *${prefix}attendance* - Mark daily attendance for coins (with streak bonus)\n` +
    `• *${prefix}topactive* - Preview today's most-active payout\n\n` +
    `🎰 *Games:*\n` +
    `• *${prefix}slots <amount>* - Spin the jungle slot machine\n` +
    `• *${prefix}coinflip <amount> <heads|tails>* - Flip for double or nothing\n` +
    `• *${prefix}jackpot* - Check the shared jackpot pool\n\n` +
    `🏆 *Leaderboards:*\n` +
    `• *${prefix}leaderboard* - Top coin holders\n` +
    `• *${prefix}leaderboard groqcoins* - Top Groq Coin holders\n` +
    `• *${prefix}topactive* - Most active members today\n\n` +
    `📊 *Info:*\n` +
    `• *${prefix}eco stats* - Live jungle economy stats & odds\n\n` +
    `⚙️ *Admin:* *${prefix}eco settings* (owner/admin only)`;

  await sock.sendMessage(chatId, { text, ...channelInfo }, { quoted: message });
}

// ── Jungle economy stats (previously the default view) ────────────────────────

async function showStats(sock: any, message: any, context: any) {
  const { chatId, channelInfo } = context;
  const pool = await getJackpotPool();
  const small = getStakeProfile(10);
  const mid = getStakeProfile(100);
  const large = getStakeProfile(1000);
  const pressure = Math.max(0.85, Math.min(1.15, 1 + (pool - 500) / 10000));

  const text =
    `📊 *Jungle Economy Dashboard* 📊\n\n` +
    `👑 Jackpot pool: *${formatNumber(pool)} coins*\n` +
    `📈 Economy pressure: *${pressure.toFixed(2)}x*\n` +
    `🎯 House bias: *slots 16% / coinflip 32% / dice 28%*\n\n` +
    `🎰 Slots profile\n` +
    `• Small stake big-win chance: *${(small.bigWinChance * 100).toFixed(2)}%*\n` +
    `• Mid stake big-win chance: *${(mid.bigWinChance * 100).toFixed(2)}%*\n` +
    `• Large stake big-win chance: *${(large.bigWinChance * 100).toFixed(2)}%*\n\n` +
    `🪙 Coinflip profile\n` +
    `• Base win rate: *${(0.48 * 100).toFixed(0)}%*\n` +
    `• Current pressure-adjusted win rate: *${Math.min(70, Math.max(28, (0.48 / pressure) * 100)).toFixed(0)}%*\n\n` +
    `🎲 Dice profile\n` +
    `• Base win rate: *${(0.42 * 100).toFixed(0)}%*\n` +
    `• Current pressure-adjusted win rate: *${Math.min(64, Math.max(20, (0.42 / pressure) * 100)).toFixed(0)}%*`;

  await sock.sendMessage(chatId, { text, ...channelInfo }, { quoted: message });
}

// ── Routed handler ─────────────────────────────────────────────────────────────
// `.eco settings ...` is handled here, *before* the economy-group guard, so it
// keeps working the same way !ecoadmin always has — from a DM, from outside the
// designated economy group, etc. Everything else (menu/stats) stays guarded.

async function _handler(sock: any, message: any, args: string[], context: any) {
  const sub = (args[0] || '').toLowerCase();

  if (sub === 'stats' || sub === 'jungle') {
    return showStats(sock, message, context);
  }

  return showMenu(sock, message, context);
}

const guardedHandler = withEconomyGuard(_handler);

export async function handler(sock: any, message: any, args: string[], context: any) {
  const sub = (args[0] || '').toLowerCase();

  if (sub === 'settings' || sub === 'admin') {
    const { chatId, senderIsOwnerOrSudo } = context;
    if (!message.key.fromMe && !senderIsOwnerOrSudo) {
      return sock.sendMessage(chatId, {
        text: '🚫 Only the owner can access economy settings.'
      }, { quoted: message });
    }
    // Reuse !ecoadmin's exact sub-command logic (addcoins, removecoins, settings, etc.)
    return ecoAdminHandler(sock, message, args.slice(1), context);
  }

  return guardedHandler(sock, message, args, context);
}
