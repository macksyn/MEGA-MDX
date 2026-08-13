// @ts-nocheck
import { getLeaderboard, formatNumber, withEconomyGuard, getWallet } from '../lib/economy.js';

export const command = 'leaderboard';
export const aliases = ['lb', 'topcoins'];
export const category = 'economy';
export const cooldown = 3000;

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, channelInfo } = context;
  const type = (args[0] || 'coins').toLowerCase() === 'groqcoins' ? 'groqcoins' : 'coins';
  const isCoins = type === 'coins';
  const emoji = isCoins ? '🪙' : '💲';
  const label = isCoins ? 'Coins' : 'Groq Coins';

  const top = await getLeaderboard(type as any, 10);

  if (top.length === 0) {
    return sock.sendMessage(chatId, { text: '📭 No wallets yet — start earning by submitting your attendance or with *!work*!', ...channelInfo }, { quoted: message });
  }

  // Medal for top 3, keycap number emoji for the rest — keeps every rank
  // visually distinct without falling back to plain "4." text.
  const RANK_ICONS = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

  // entry.userId is a cleanJid()'d key — bare digits, domain already
  // stripped, so it can never be safely turned back into a mention JID by
  // guessing. wallet.jid (added to economy.ts) is the raw JID captured the
  // last time this person ran an economy command, domain intact — that's
  // the only reliable source for a mention here.
  const wallets = await Promise.all(top.map(entry => getWallet(entry.userId)));

  // Just the mention + their coins — the mention pill already shows their
  // name, so printing it again in text before @number was pure duplication.
  const lines = top.map((entry, i) => {
    const w = wallets[i];
    const number = w?.phone || entry.userId; // last-resort: may be a LID, not a real phone, until they run an economy command once
    const rankIcon = RANK_ICONS[i] || `${i + 1}.`;
    return `${rankIcon} @${number} ┈ ${emoji} *${formatNumber(entry.amount)}*`;
  });

  // Wallets that predate this fix (or that have never triggered an economy
  // command since) won't have .jid yet — for those we fall back to the old
  // guess, which will keep failing for @lid users until they run any
  // economy command once (that alone will populate .jid going forward).
  const mentions = top.map((entry, i) => wallets[i]?.jid || `${entry.userId}@s.whatsapp.net`);

  const divider = '┈'.repeat(24);
  const tip = isCoins
    ? '_Run *.exchange* to convert coins into Groq Coins_'
    : '_Cash out anytime with *.withdraw* once you hit the threshold_';

  const text =
    `🏆 *${label.toUpperCase()} LEADERBOARD*\n` +
    `${divider}\n\n` +
    lines.join('\n') +
    `\n\n${divider}\n` +
    `${tip}`;

  await sock.sendMessage(chatId, { text, mentions, ...channelInfo }, { quoted: message });
}

export const handler = withEconomyGuard(_handler);