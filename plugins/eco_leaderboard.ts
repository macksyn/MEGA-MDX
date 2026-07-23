// @ts-nocheck
import { getLeaderboard, formatNumber, withEconomyGuard, getWallet } from '../lib/economy.js';

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

  // entry.userId is the exact raw JID (e.g. @lid) captured at the time the
  // wallet was written — same pattern activitytracker/activity.ts uses for
  // its leaderboard, which mentions everyone correctly. That JID stays
  // valid for mentions later; no live re-resolution needed or wanted here.
  const wallets = await Promise.all(top.map(entry => getWallet(entry.userId)));

  const lines = top.map((entry, i) => {
    const w = wallets[i];
    const fallbackNumber = entry.userId.split('@')[0].split(':')[0];
    const label = w?.name ? `${w.name} ` : '';
    return `${medals[i] || `${i + 1}.`} ${label}@${w?.phone || fallbackNumber} — ${formatNumber(entry.amount)} ${emoji}`;
  });

  await sock.sendMessage(chatId, {
    text: `🏆 *${type === 'coins' ? 'Coins' : 'Groq Coins'} Leaderboard*\n\n${lines.join('\n')}`,
    mentions: top.map(entry => entry.userId),
    ...channelInfo
  }, { quoted: message });
}

export const handler = withEconomyGuard(_handler);