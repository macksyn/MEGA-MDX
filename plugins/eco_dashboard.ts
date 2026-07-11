// @ts-nocheck
import { withEconomyGuard, formatNumber } from '../lib/economy.js';
import { getJackpotPool, getStakeProfile } from '../lib/slotMachine.js';

export const command = 'economy';
export const aliases = ['eco', 'dashboard', 'stats'];
export const category = 'economy';
export const cooldown = 3000;

async function _handler(sock: any, message: any, _args: string[], context: any) {
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

  await sock.sendMessage(chatId, {
    text,
    ...channelInfo
  }, { quoted: message });
}

export const handler = withEconomyGuard(_handler);
