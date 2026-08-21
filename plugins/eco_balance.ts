// @ts-nocheck
import { getWallet, formatNumber, withEconomyGuard, getLevelInfo, getRollingExchangeCount } from '../lib/economy.js';
import { cleanJid } from '../lib/isOwner.js';
import { extractTargetJid } from '../lib/resolveTarget.js';
import { resolveParticipant } from '../lib/contactUtil.js';
import { promptMenu } from '../lib/buttonSession.js';
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
  const levelInfo = getLevelInfo(wallet.exchangeCount, rollingCount, wallet.level2SinceTs);

  const isSelf = targetId === cleanJid(senderId);
  const label = isSelf ? 'YOUR BALANCE' : `@${phoneNumber}'S BALANCE`;

  // Build level status line
  let levelStatus = `🏅 Level ${levelInfo.levelNumber}: *${levelInfo.levelName}*`;
  // If they are demoted due to low rolling count, show warning
  if (levelInfo.levelNumber === 1 && wallet.exchangeCount >= 25 && rollingCount < levelInfo.rollingRequired) {
    levelStatus += ` ⚠️ _(demoted – need ${levelInfo.exchangesNeededToMaintain} more exchanges in 7 days to restore)_`;
  } else if (levelInfo.levelNumber >= 2) {
    // Show maintenance status for level 2+
    if (levelInfo.inGracePeriod && rollingCount < levelInfo.rollingRequired) {
      levelStatus += ` 🕒 _(new! ${levelInfo.graceDaysLeft} day(s) left in grace period before the 7-day maintenance rule applies)_`;
    } else if (rollingCount < levelInfo.rollingRequired) {
      levelStatus += ` ⚠️ _(${levelInfo.exchangesNeededToMaintain} exchanges needed in 7 days to maintain)_`;
    } else {
      levelStatus += ` ✅ _(maintained)_`;
    }
  }

  const statsBlock =
    `🪙 Coins: *${formatNumber(wallet.coins)}*\n` +
    `💲 Groq Coins: *${formatNumber(wallet.groqCoins)}*\n` +
    `${levelStatus}\n` +
    `🔄 Exchanges (lifetime): *${formatNumber(wallet.exchangeCount)}*\n` +
    `🔄 Exchanges (last 7d): *${formatNumber(rollingCount)}* / ${levelInfo.rollingRequired}\n` +
    `📈 ${levelInfo.bar} ${levelInfo.progressPercent}%\n\n` +
    `➡️ _Next: *${levelInfo.nextLevelName || 'Max'}* at ${formatNumber(levelInfo.next)} exchanges_ `;

  // Viewing someone else's balance never offered the statement button
  // (strictly self-only, even for owner/sudo) — keep that as a plain
  // message so we can still pass mentions, which promptMenu doesn't
  // support forwarding into the send payload.
  if (!isSelf) {
    await sock.sendMessage(chatId, {
      text: `💰 *${label}*\n\n${statsBlock}`,
      mentions: [resolvedJid],
      ...channelInfo
    }, { quoted: message });
    return;
  }

  // Self-view: balance report and the "view statement" option go out as
  // ONE button message instead of a report followed by a separate menu
  // prompt. Only the account owner ever sees this option.
  const selfId = cleanJid(senderId);

  const result = await promptMenu(sock, message, chatId, selfId, {
    title: `💰 ${label}`,
    text: statsBlock,
    footer: 'Tap below for your full transaction history',
    options: [
      { label: 'View statement', value: 'statement', description: 'Full transaction history' },
    ],
  });

  if (result.cancelled || result.timedOut || result.value !== 'statement') return;

  await sendStatement(sock, message, chatId, targetId, isSelf, 10, channelInfo);
}

export const handler = withEconomyGuard(_handler);