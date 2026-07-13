// @ts-nocheck
import { getWallet, formatNumber, withEconomyGuard, getLevelInfo } from '../lib/economy.js';
import { cleanJid } from '../lib/isOwner.js';
import { extractTargetId } from '../lib/resolveTarget.js';

export const command = 'balance';
export const aliases = ['bal', 'wallet'];
export const category = 'economy';
export const cooldown = 2000;

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, senderId, channelInfo } = context;

  // Allow checking someone else's balance: !balance @user
  const targetId = extractTargetId(message, args) || cleanJid(senderId);
  const wallet = await getWallet(targetId);

  const isSelf = targetId === cleanJid(senderId);
  const label = isSelf ? 'Your' : `@${targetId}'s`;
  const levelInfo = getLevelInfo(wallet.exchangeCount);
  const recognized = wallet.name ? ` (${wallet.name}${wallet.phone ? ` · ${wallet.phone}` : ''})` : '';

  const text =
    `💰 *${label} Wallet*${recognized}\n\n` +
    `🪙 Coins: *${formatNumber(wallet.coins)}*\n` +
    `💲 Groq Coins: *${formatNumber(wallet.groqCoins)}*\n` +
    `🏅 Level ${levelInfo.levelNumber}: *${levelInfo.levelName}*\n` +
    `🔄 Exchanges: *${formatNumber(wallet.exchangeCount)}*\n` +
    `📈 ${levelInfo.bar} ${levelInfo.progressPercent}%\n\n` +
    `➡️ _Next: *${levelInfo.nextLevelName || 'Max'}* at ${formatNumber(levelInfo.next)} exchanges_ `;

  await sock.sendMessage(chatId, {
    text,
    mentions: isSelf ? [] : [`${targetId}@s.whatsapp.net`],
    ...channelInfo
  }, { quoted: message });
}

export const handler = withEconomyGuard(_handler);