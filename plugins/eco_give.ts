// @ts-nocheck
import { transferCoins, formatNumber, withEconomyGuard, syncIdentity } from '../lib/economy.js';
import { cleanJid } from '../lib/isOwner.js';
import { extractTargetId } from '../lib/resolveTarget.js';

export const command = 'transfer';
export const aliases = ['give', 'send'];
export const category = 'economy';
export const cooldown = 3000;

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, senderId, channelInfo } = context;
  const fromId = cleanJid(senderId);

  const targetId = extractTargetId(message, args);
  const amountArg = args.find(a => /^\d+$/.test(a));
  const amount = amountArg ? parseInt(amountArg, 10) : NaN;

  if (!targetId || !amount || amount <= 0) {
    return sock.sendMessage(chatId, {
      text: `⚠️ Usage: *.transfer @user <amount>* or reply to their message with *.transfer <amount>*`,
      ...channelInfo
    }, { quoted: message });
  }

  const result = await transferCoins(fromId, targetId, amount);

  // Recipient may not have sent a live message here — fall back to whatever
  // contact info the bot already has cached for them.
  void syncIdentity(targetId, sock);

  if (!result.success) {
    const reasonText = result.reason === 'insufficient_funds'
      ? "You don't have enough coins for that."
      : result.reason === 'self_transfer'
      ? "You can't send coins to yourself."
      : 'Something went wrong with that transfer.';
    return sock.sendMessage(chatId, { text: `❌ ${reasonText}`, ...channelInfo }, { quoted: message });
  }

  await sock.sendMessage(chatId, {
    text: `✅ *TRANSFER SUCCESSFUL* ✅ \n\n Sent *${formatNumber(amount)} coins* to @${targetId}!`,
    mentions: [`${targetId}@s.whatsapp.net`],
    ...channelInfo
  }, { quoted: message });
}

export const handler = withEconomyGuard(_handler);
