// @ts-nocheck
import { transferCoins, formatNumber, withEconomyGuard, syncIdentity, getWallet } from '../lib/economy.js';
import { cleanJid } from '../lib/isOwner.js';
import { extractTargetJid } from '../lib/resolveTarget.js';

export const command = 'transfer';
export const aliases = ['give', 'send'];
export const category = 'economy';
export const cooldown = 3000;

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, senderId, channelInfo } = context;
  const fromId = cleanJid(senderId);

  // extractTargetJid returns the raw JID (domain intact — @lid or
  // @s.whatsapp.net) rather than a pre-cleaned id, so we can both key the
  // wallet correctly (cleanJid'd) AND persist/mention the real JID.
  const rawTargetJid = extractTargetJid(message, args);
  const targetId = rawTargetJid ? cleanJid(rawTargetJid) : null;

  const amountArg = args.find(a => /^\d+$/.test(a));
  const amount = amountArg ? parseInt(amountArg, 10) : NaN;

  if (!targetId || !amount || amount <= 0) {
    return sock.sendMessage(chatId, {
      text: `⚠️ Usage: *.transfer @user <amount>* or reply to their message with *.transfer <amount>*`,
      ...channelInfo
    }, { quoted: message });
  }

  const result = await transferCoins(fromId, targetId, amount);

  // Recipient may not have sent a live message here — pass the raw JID we
  // just resolved so their wallet's .jid/.phone get filled in properly
  // rather than falling back to a guess.
  void syncIdentity(targetId, sock, null, rawTargetJid);

  if (!result.success) {
    const reasonText = result.reason === 'insufficient_funds'
      ? "You don't have enough coins for that."
      : result.reason === 'self_transfer'
      ? "You can't send coins to yourself."
      : 'Something went wrong with that transfer.';
    return sock.sendMessage(chatId, { text: `❌ ${reasonText}`, ...channelInfo }, { quoted: message });
  }

  // Mention the recipient using their persisted raw JID when we have one
  // (most reliable — survives even if they're offline right now), then the
  // JID we just resolved live, and only guess @s.whatsapp.net as a last
  // resort for a brand-new wallet with neither.
  const targetWallet = await getWallet(targetId);
  const mentionJid = targetWallet.jid || rawTargetJid || `${targetId}@s.whatsapp.net`;
  const displayNumber = targetWallet.phone || targetId;

  await sock.sendMessage(chatId, {
    text: `✅ *TRANSFER SUCCESSFUL* ✅ \n\n Sent *${formatNumber(amount)} coins* to @${displayNumber}!`,
    mentions: [mentionJid],
    ...channelInfo
  }, { quoted: message });
}

export const handler = withEconomyGuard(_handler);