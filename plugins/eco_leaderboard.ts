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

  // entry.userId is a cleanJid()'d key — bare digits, domain already
  // stripped, so it can never be safely turned back into a mention JID by
  // guessing. wallet.jid (added to economy.ts) is the raw JID captured the
  // last time this person ran an economy command, domain intact — that's
  // the only reliable source for a mention here.
  const wallets = await Promise.all(top.map(entry => getWallet(entry.userId)));

  const lines = top.map((entry, i) => {
    const w = wallets[i];
    const label = w?.name ? `${w.name} ` : '';
    // Display number: prefer the resolved real phone; entry.userId as a
    // last resort may actually be a LID number, not a phone number, if this
    // wallet has never been synced with a raw JID.
    return `${medals[i] || `${i + 1}.`} ${label}@${w?.phone || entry.userId} — ${formatNumber(entry.amount)} ${emoji}`;
  });

  // Wallets that predate this fix (or that have never triggered an economy
  // command since) won't have .jid yet — for those we fall back to the old
  // guess, which will keep failing for @lid users until they run any
  // economy command once (that alone will populate .jid going forward).
  const mentions = top.map((entry, i) => wallets[i]?.jid || `${entry.userId}@s.whatsapp.net`);

  await sock.sendMessage(chatId, {
    text: `🏆 *${type === 'coins' ? 'Coins' : 'Groq Coins'} Leaderboard*\n\n${lines.join('\n')}`,
    mentions,
    ...channelInfo
  }, { quoted: message });
}

export const handler = withEconomyGuard(_handler);