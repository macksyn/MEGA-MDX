// @ts-nocheck
import { getWallet, formatNumber, withEconomyGuard, getLevelInfo } from '../lib/economy.js';
import { cleanJid } from '../lib/isOwner.js';
import { extractTargetJid } from '../lib/resolveTarget.js';
import { resolveParticipant } from '../lib/contactUtil.js';

export const command = 'balance';
export const aliases = ['bal', 'wallet'];
export const category = 'economy';
export const cooldown = 2000;

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, senderId, channelInfo } = context;

  // Allow checking someone else's balance: !balance @user
  const rawTargetJid = extractTargetJid(message, args) || senderId;

  // Resolves @lid -> real @s.whatsapp.net jid (when known), plus a display
  // name and a clean phone number for the mention text.
  const { jid: resolvedJid, name, phoneNumber } = resolveParticipant(rawTargetJid, sock);

  // Wallets are keyed by cleanJid's output, so look the wallet up on the
  // resolved jid, not the raw (possibly @lid) one.
  const targetId = cleanJid(resolvedJid);
  const wallet = await getWallet(targetId);

  const isSelf = targetId === cleanJid(senderId);
  const label = isSelf ? 'YOUR BALANCE' : `@${phoneNumber}'S BALANCE`;
  const levelInfo = getLevelInfo(wallet.exchangeCount);

  const text =
    `💰 *${label}*\n\n` +
    `🪙 Coins: *${formatNumber(wallet.coins)}*\n` +
    `💲 Groq Coins: *${formatNumber(wallet.groqCoins)}*\n` +
    `🏅 Level ${levelInfo.levelNumber}: *${levelInfo.levelName}*\n` +
    `🔄 Exchanges: *${formatNumber(wallet.exchangeCount)}*\n` +
    `📈 ${levelInfo.bar} ${levelInfo.progressPercent}%\n\n` +
    `➡️ _Next: *${levelInfo.nextLevelName || 'Max'}* at ${formatNumber(levelInfo.next)} exchanges_ `;

  await sock.sendMessage(chatId, {
    text,
    mentions: isSelf ? [] : [`${phoneNumber}@s.whatsapp.net`],
    ...channelInfo
  }, { quoted: message });
}

export const handler = withEconomyGuard(_handler);