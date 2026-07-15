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
 */
import { exchangeWithMember, getSettings, formatNumber, withEconomyGuard, syncIdentity } from '../lib/economy.js';
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

  const amount = parseInt(args[0], 10);
  const rawTargetJid = extractTargetJid(message, args);

  if (!amount || amount <= 0 || !rawTargetJid) {
    return sock.sendMessage(chatId, {
      text:
        `⚠️ Usage: *.exchange <coins> @user*\n\n` +
        `Tag (or reply to) the member you want to exchange with — your coins convert into *their* Groq Coins 💲, minus a ${settings.exchangeFeePercent}% fee.\n\n` +
        `_Rate: ${formatNumber(settings.coinsPerGroqCoin)} coins = 1 Groq Coin 💲_`,
      ...channelInfo
    }, { quoted: message });
  }

  // Resolve @lid -> real jid + phone number before we do anything with it.
  const { jid: resolvedTargetJid, phoneNumber: targetPhone } = resolveParticipant(rawTargetJid, sock);
  const targetId = cleanJid(resolvedTargetJid);

  const result = await exchangeWithMember(userId, targetId, amount);

  // Recipient receives Groq Coins here but may not have sent a live message
  // in this chat — sync whatever contact info the bot already has cached for
  // them, same as eco_give.ts does for transfer recipients.
  void syncIdentity(targetId, sock);

  if (!result.success) {
    const reasonText =
      result.reason === 'below_minimum'      ? `You need at least ${formatNumber(settings.coinsPerGroqCoin)} coins to convert into 1 Groq Coin.` :
      result.reason === 'insufficient_funds' ? `You don't have enough coins for that.` :
      result.reason === 'self_exchange'      ? `You can't exchange with yourself — tag another member.` :
                                                `Please enter a valid coin amount.`;
    return sock.sendMessage(chatId, { text: `❌ ${reasonText}`, ...channelInfo }, { quoted: message });
  }

  await sock.sendMessage(chatId, {
    text:
      `♻️ Exchanged *${formatNumber(result.coinsSpent)} coins* with @${targetPhone}!\n\n` +
      `💲 They received *${formatNumber(result.groqCoinsGained)} Groq Coins* (${settings.exchangeFeePercent}% fee: ${formatNumber(result.fee)} GC).\n\n` +
      `_Ask them to run !exchange on you to get your own Groq Coins back!_`,
    mentions: [resolvedTargetJid],
    ...channelInfo
  }, { quoted: message });
}

export const handler = withEconomyGuard(_handler);