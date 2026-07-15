// @ts-nocheck
/***
 * plugins/eco_history.ts
 *
 * Surfaces the transaction ledger (lib/economy.ts: logTransaction/
 * getTransactions) so balances are auditable — "I never got that
 * transfer!" now has an answer.
 *
 * Usage:
 *   .history            -> your own last 10 transactions
 *   .history 20         -> your own last 20 (max 30)
 *   .history @user      -> owner/sudo only, someone else's history
 */
import { getTransactions, formatNumber, withEconomyGuard } from '../lib/economy.js';
import { cleanJid } from '../lib/isOwner.js';
import { extractTargetId } from '../lib/resolveTarget.js';

export const command = 'history';
export const aliases = ['txns', 'ledger'];
export const category = 'economy';
export const cooldown = 3000;

const TYPE_LABELS: Record<string, string> = {
  attendance:        '📋 Attendance',
  work:              '💼 Work',
  top3:              '🏆 Top-3 payout',
  transfer_out:      '📤 Sent',
  transfer_in:       '📥 Received',
  exchange_out:      '♻️ Exchange sent',
  exchange_in:       '♻️ Exchange received',
  convert:           '🔄 Converted',
  slots:             '🎰 Slots',
  coinflip:          '🪙 Coinflip',
  dice:              '🎲 Dice',
  admin_credit:      '⚙️ Admin credit',
  admin_debit:       '⚙️ Admin debit',
  admin_reset:       '♻️ Wallet reset',
  withdrawal_hold:   '💲 Withdrawal hold',
  withdrawal_refund: '💲 Withdrawal refund',
  other:             '❔ Other',
};

function formatWhen(ts: number): string {
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, senderId, channelInfo, senderIsOwnerOrSudo } = context;
  const selfId = cleanJid(senderId);

  // Only owner/sudo can pull someone else's ledger — this is financial history,
  // not something every member should be able to check on any other member.
  const mentionedTargetId = extractTargetId(message, args);
  const targetId = (mentionedTargetId && senderIsOwnerOrSudo) ? mentionedTargetId : selfId;
  const isSelf = targetId === selfId;

  const limitArg = parseInt(args.find(a => /^\d+$/.test(a)) || '', 10);
  const limit = Number.isFinite(limitArg) ? Math.max(1, Math.min(30, limitArg)) : 10;

  const txns = await getTransactions(targetId, limit);

  if (txns.length === 0) {
    return sock.sendMessage(chatId, {
      text: isSelf
        ? '📭 No transactions yet — start earning with *!attendance* or *!work*!'
        : `📭 @${targetId} has no transactions yet.`,
      mentions: isSelf ? [] : [`${targetId}@s.whatsapp.net`],
      ...channelInfo
    }, { quoted: message });
  }

  const lines = txns.map(tx => {
    const label = TYPE_LABELS[tx.type] || TYPE_LABELS.other;
    const sign = tx.amount >= 0 ? '+' : '-';
    const emoji = tx.currency === 'coins' ? '🪙' : '💲';
    const when = formatWhen(tx.timestamp);
    const note = tx.note ? ` _(${tx.note})_` : '';
    return `${label}: ${sign}${formatNumber(Math.abs(tx.amount))} ${emoji} — ${when}${note}`;
  });

  const label = isSelf ? 'YOUR TRANSACTION HISTORY' : `@${targetId}'S TRANSACTION HISTORY`;

  await sock.sendMessage(chatId, {
    text: `🧾 *${label}*\n_last ${txns.length}_\n\n${lines.join('\n')}`,
    mentions: isSelf ? [] : [`${targetId}@s.whatsapp.net`],
    ...channelInfo
  }, { quoted: message });
}

export const handler = withEconomyGuard(_handler);
