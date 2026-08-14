// @ts-nocheck
import { getWallet, formatNumber, withEconomyGuard, getLevelInfo, getRollingExchangeCount } from '../lib/economy.js';
import { cleanJid } from '../lib/isOwner.js';
import { extractTargetJid } from '../lib/resolveTarget.js';
import { resolveParticipant } from '../lib/contactUtil.js';
import { promptMenu } from '../lib/menuSession.js';
import { sendStatement } from '../lib/statement.js';

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

  // Fetch rolling exchange count for the last 7 days
  const rollingCount = await getRollingExchangeCount(targetId, 7);
  const levelInfo = getLevelInfo(wallet.exchangeCount, rollingCount);

  const isSelf = targetId === cleanJid(senderId);
  const label = isSelf ? 'YOUR BALANCE' : `@${phoneNumber}'S BALANCE`;

  // Build level status line
  let levelStatus = `🏅 Level ${levelInfo.levelNumber}: *${levelInfo.levelName}*`;
  // If they are demoted due to low rolling count, show warning
  if (levelInfo.levelNumber === 1 && wallet.exchangeCount >= 25 && rollingCount < levelInfo.rollingRequired) {
    levelStatus += ` ⚠️ _(demoted – need ${levelInfo.exchangesNeededToMaintain} more exchanges in 7 days to restore)_`;
  } else if (levelInfo.levelNumber >= 2) {
    // Show maintenance status for level 2+
    if (rollingCount < levelInfo.rollingRequired) {
      levelStatus += ` ⚠️ _(${levelInfo.exchangesNeededToMaintain} exchanges needed in 7 days to maintain)_`;
    } else {
      levelStatus += ` ✅ _(maintained)_`;
    }
  }

  const text =
    `💰 *${label}*\n\n` +
    `🪙 Coins: *${formatNumber(wallet.coins)}*\n` +
    `💲 Groq Coins: *${formatNumber(wallet.groqCoins)}*\n` +
    `${levelStatus}\n` +
    `🔄 Exchanges (lifetime): *${formatNumber(wallet.exchangeCount)}*\n` +
    `🔄 Exchanges (last 7d): *${formatNumber(rollingCount)}* / ${levelInfo.rollingRequired}\n` +
    `📈 ${levelInfo.bar} ${levelInfo.progressPercent}%\n\n` +
    `➡️ _Next: *${levelInfo.nextLevelName || 'Max'}* at ${formatNumber(levelInfo.next)} exchanges_ `;

  await sock.sendMessage(chatId, {
    text,
    mentions: isSelf ? [] : [resolvedJid],
    ...channelInfo
  }, { quoted: message });

  // Follow-up statement-of-account view. Strictly self-only — even
  // owner/sudo don't get the option when looking at someone else's
  // balance. Only the account owner ever sees this menu.
  if (!isSelf) return;

  const selfId = cleanJid(senderId);

  const result = await promptMenu(sock, message, chatId, selfId, {
    title: '💰 BALANCE',
    text: 'Want more detail?',
    options: [
      { label: 'View statement of account', value: 'statement', description: 'Full transaction history' },
    ],
  });

  if (result.cancelled || result.timedOut || result.value !== 'statement') return;

  await sendStatement(sock, message, chatId, targetId, isSelf, 10, channelInfo);
}

export const handler = withEconomyGuard(_handler);