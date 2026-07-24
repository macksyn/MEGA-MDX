// @ts-nocheck
/***
 * plugins/eco_exchange.ts
 *
 * Taka-style peer-to-peer coin exchange. You spend your own coins, but the
 * resulting Groq Coins land in the TAGGED member's wallet, minus a fee that
 * goes into the fee pool. To get your own Groq Coins, someone else has to
 * run !exchange targeting you back.
 *
 * Usage: .exchange <coins> @user   (or reply to their message instead of tagging)
 *        .exchange owed            — see who owes you a reciprocal, and who you owe
 *
 * Allowed amounts are admin-configurable via settings.exchangeAllowedAmounts
 * (default: 10, 20, 50, 100).
 */
import {
  exchangeWithMember, getSettings, formatNumber, withEconomyGuard, syncIdentity,
  getWallet, getDebtsOwedToUser, getDebtsOwedByUser,
} from '../lib/economy.js';
import { cleanJid } from '../lib/isOwner.js';
import { extractTargetJid } from '../lib/resolveTarget.js';
import { resolveParticipant } from '../lib/contactUtil.js';

export const command = 'exchange';
export const aliases = ['convert'];
export const category = 'economy';
export const cooldown = 3000;

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, senderId, channelInfo } = context;
  const userId = cleanJid(senderId);
  const settings = await getSettings();

  if ((args[0] || '').toLowerCase() === 'owed') {
    return handleOwed(sock, chatId, message, userId, channelInfo);
  }

  const amount = parseInt(args[0], 10);
  const rawTargetJid = extractTargetJid(message, args);
  const allowedList = settings.exchangeAllowedAmounts.map(formatNumber).join(', ');

  if (!amount || !rawTargetJid) {
    return sock.sendMessage(chatId, {
      text:
        `⚠️ Usage: *.exchange <coins> @user*\n\n` +
        `Tag (or reply to) the member you want to exchange with — your coins convert into *their* Groq Coins 💲, minus a ${settings.exchangeFeePercent}% fee.\n\n` +
        `_Allowed amounts: ${allowedList} coins_\n` +
        `_Rate: ${formatNumber(settings.coinsPerGroqCoin)} coins = 1 Groq Coin 💲_\n\n` +
        `Check who owes you (or who you owe) with *.exchange owed*`,
      ...channelInfo
    }, { quoted: message });
  }

  if (!settings.exchangeAllowedAmounts.includes(amount)) {
    return sock.sendMessage(chatId, {
      text: `⚠️ *.exchange* only accepts these amounts: *${allowedList}* coins.\n\nUsage: *.exchange <amount> @user*`,
      ...channelInfo
    }, { quoted: message });
  }

  // Resolve @lid -> real jid + phone number before we do anything with it.
  const { jid: resolvedTargetJid, phoneNumber: targetPhone } = resolveParticipant(rawTargetJid, sock);
  const targetId = cleanJid(resolvedTargetJid);

  const result = await exchangeWithMember(userId, targetId, amount);

  // Recipient receives Groq Coins here but may not have sent a live message
  // in this chat — pass the raw JID we just resolved so their wallet's
  // .jid/.phone get persisted properly (same fix applied to eco_give.ts),
  // rather than relying only on this live, best-effort lookup.
  void syncIdentity(targetId, sock, null, rawTargetJid);

  if (!result.success) {
    const reasonText =
      result.reason === 'amount_not_allowed'  ? `That amount isn't allowed. Pick one of: ${allowedList} coins.` :
      result.reason === 'below_minimum'       ? `You need at least ${formatNumber(settings.coinsPerGroqCoin)} coins to convert into 1 Groq Coin.` :
      result.reason === 'insufficient_funds'  ? `You don't have enough coins for that.` :
      result.reason === 'self_exchange'       ? `You can't exchange with yourself — tag another member.` :
                                                 `Please enter a valid coin amount.`;
    return sock.sendMessage(chatId, { text: `❌ ${reasonText}`, ...channelInfo }, { quoted: message });
  }

  // If this exchange happened to settle a reciprocal debt (target had
  // previously sent to sender and was still owed one back), say so instead
  // of the generic nudge — closes the loop visibly for the group.
  const followUp = result.debtResolved
    ? `_That settles a reciprocal exchange you owed @${targetPhone} — nice!_`
    : `_Ask them to run !exchange on you to get your own Groq Coins back! Check with *.exchange owed*_`;

  await sock.sendMessage(chatId, {
    text:
      `♻️ Exchanged *${formatNumber(result.coinsSpent)} coins* with @${targetPhone}!\n\n` +
      `💲 They received *${formatNumber(result.groqCoinsGained)} Groq Coins* (${settings.exchangeFeePercent}% fee: ${formatNumber(result.fee)} GC).\n\n` +
      followUp,
    mentions: [resolvedTargetJid],
    ...channelInfo
  }, { quoted: message });
}

async function handleOwed(sock: any, chatId: string, message: any, userId: string, channelInfo: any) {
  const [owedToMe, iOwe] = await Promise.all([
    getDebtsOwedToUser(userId),
    getDebtsOwedByUser(userId),
  ]);

  if (owedToMe.length === 0 && iOwe.length === 0) {
    return sock.sendMessage(chatId, {
      text: `✅ You're all settled up — no pending reciprocal exchanges either way!`,
      ...channelInfo
    }, { quoted: message });
  }

  // Group each list by counterparty id (a person can owe more than once).
  const countBy = (ids: string[]) => ids.reduce((acc: Record<string, number>, id) => {
    acc[id] = (acc[id] || 0) + 1;
    return acc;
  }, {});

  const owedToMeCounts = countBy(owedToMe.map(d => d.debtorId));
  const iOweCounts = countBy(iOwe.map(d => d.creditorId));

  const allIds = Array.from(new Set([...Object.keys(owedToMeCounts), ...Object.keys(iOweCounts)]));
  const wallets = await Promise.all(allIds.map(id => getWallet(id)));
  const walletById: Record<string, any> = {};
  allIds.forEach((id, i) => { walletById[id] = wallets[i]; });

  const mentions: string[] = [];
  const displayFor = (id: string) => {
    const w = walletById[id];
    const label = w?.name ? `${w.name} ` : '';
    const number = w?.phone || id;
    const mentionJid = w?.jid || `${id}@s.whatsapp.net`;
    mentions.push(mentionJid);
    return `${label}@${number}`;
  };

  let text = `🔄 *EXCHANGE STATUS*\n\n`;

  if (Object.keys(owedToMeCounts).length > 0) {
    text += `*People who owe you a reciprocal exchange:*\n`;
    text += Object.entries(owedToMeCounts)
      .map(([id, count]) => `• ${displayFor(id)}${count > 1 ? ` (x${count})` : ''}`)
      .join('\n');
    text += `\n\n`;
  }

  if (Object.keys(iOweCounts).length > 0) {
    text += `*People you still owe a reciprocal exchange:*\n`;
    text += Object.entries(iOweCounts)
      .map(([id, count]) => `• ${displayFor(id)}${count > 1 ? ` (x${count})` : ''}`)
      .join('\n');
  }

  await sock.sendMessage(chatId, { text: text.trim(), mentions, ...channelInfo }, { quoted: message });
}

export const handler = withEconomyGuard(_handler);