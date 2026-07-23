// @ts-nocheck
import { getLeaderboard, formatNumber, withEconomyGuard, getWallet } from '../lib/economy.js';
import { resolveParticipant } from '../lib/contactUtil.js';

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
  const wallets = await Promise.all(top.map(entry => getWallet(entry.userId)));
  const lines = top.map((entry, i) => {
    const { jid, phoneNumber, name } = resolveParticipant(entry.userId, sock);

    mentions.push(jid);

    return `${medals[i] || `${i + 1}.`} @${phoneNumber} — ${formatNumber(entry.amount)} ${emoji}`;
  });

  await sock.sendMessage(chatId, {
    text: `🏆 *${type === 'coins' ? 'Coins' : 'Groq Coins'} Leaderboard*\n\n${lines.join('\n')}`,
    mentions,
    ...channelInfo
  }, { quoted: message });
}

export const handler = withEconomyGuard(_handler);