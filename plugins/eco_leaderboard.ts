// @ts-nocheck
import { getLeaderboard, formatNumber, withEconomyGuard } from '../lib/economy.js';

export const command = 'leaderboard';
export const aliases = ['lb', 'topcoins'];
export const category = 'economy';
export const cooldown = 3000;

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, channelInfo } = context;
  const type = (args[0] || 'coins').toLowerCase() === 'groqcoins' ? 'groqcoins' : 'coins';
  const emoji = type === 'coins' ? '🪙' : '💲';

  const top = await getLeaderboard(type as any, 10);

  if (top.length === 0) {
    return sock.sendMessage(chatId, { text: '📭 No wallets yet — start earning by submitting your attendance or with *!work*!', ...channelInfo }, { quoted: message });
  }

  const medals = ['🥇', '🥈', '🥉'];
  const lines = top.map((entry, i) => `${medals[i] || `${i + 1}.`} @${entry.userId} — ${formatNumber(entry.amount)} ${emoji}`);

  await sock.sendMessage(chatId, {
    text: `🏆 *${type === 'coins' ? 'Coins' : 'Groq Coins'} Leaderboard*\n\n${lines.join('\n')}`,
    mentions: top.map(e => `${e.userId}@s.whatsapp.net`),
    ...channelInfo
  }, { quoted: message });
}

export const handler = withEconomyGuard(_handler);