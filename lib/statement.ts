// @ts-nocheck
/***
 * lib/statement.ts
 *
 * Shared "statement of account" renderer — the ledger table + live balance
 * summary originally built for plugins/eco_history.ts (the .history
 * command), pulled out here so other plugins (e.g. eco_balance.ts, via its
 * menuSession follow-up) can send the exact same statement without a second
 * copy of the formatting logic drifting out of sync.
 *
 * Callers are responsible for resolving targetId/isSelf/permissions
 * themselves (each plugin's notion of "who am I allowed to show this for"
 * differs slightly) — this module only renders and sends.
 */
import { getTransactions, getWallet, formatNumber } from './economy.js';

// Used in the header/summary text, where emoji render fine (proportional font).

// Table labels — deliberately short (max 5 chars) and fixed-width. The
// original full-word labels (e.g. "Withdrawal refund" at 18 chars) were
// the main reason rows wrapped on a phone-width WhatsApp code block, since
// the whole row has to fit on one line for the column padding to mean
// anything once it wraps.
const TYPE_LABELS_PLAIN: Record<string, string> = {
  attendance:        'Attn',
  work:              'Work',
  top3:              'Top3',
  transfer_out:      'Sent',
  transfer_in:       'Recv',
  exchange_out:      'ExOut',
  exchange_in:       'ExIn',
  convert:           'Conv',
  slots:             'Slots',
  coinflip:          'CFlip',
  dice:              'Dice',
  admin_credit:      'AdmCr',
  admin_debit:       'AdmDb',
  admin_reset:       'Reset',
  withdrawal_hold:   'WdHld',
  withdrawal_refund: 'WdRef',
  other:             'Other',
};

// Suffix appended to amounts/balances in the table so mixed currencies
// stay distinguishable without needing emoji (which would break alignment
// inside a monospace block — glyph widths aren't consistent across clients).
const CURRENCY_SUFFIX: Record<string, string> = {
  coins: 'c',
  groqCoins: 'g',
};

function formatWhen(ts: number): string {
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 14) return `${days}d`;
  // No year — this is a rolling 30-entry ledger, a year-old entry surviving
  // in it is effectively impossible, and dropping it keeps this column a
  // consistent 5 chars ("12Aug") instead of ballooning for older rows.
  return new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }).replace(' ', '');
}

function trendArrow(net: number): string {
  if (net > 0) return '📈';
  if (net < 0) return '📉';
  return '➖';
}

function signed(n: number): string {
  return n > 0 ? `+${formatNumber(n)}` : formatNumber(n); // formatNumber already handles the '-'
}

/**
 * Fetches and sends a full statement of account (balance summary + aligned
 * ledger table) for `targetId`. Caller decides who's allowed to see whose
 * statement — this function just renders whatever targetId it's given.
 */
export async function sendStatement(
  sock: any,
  message: any,
  chatId: string,
  targetId: string,
  isSelf: boolean,
  limit: number = 10,
  channelInfo: Record<string, any> = {}
): Promise<void> {
  const cappedLimit = Math.max(1, Math.min(30, limit));

  const [txns, wallet] = await Promise.all([
    getTransactions(targetId, cappedLimit),
    getWallet(targetId),
  ]);

  const who = isSelf ? 'YOUR' : `@${targetId}'S`;
  const mentions = isSelf ? [] : [`${targetId}@s.whatsapp.net`];
  const balanceLine = `🪙 Coins: *${formatNumber(wallet.coins)}*    💲 Groq Coins: *${formatNumber(wallet.groqCoins)}*`;

  if (txns.length === 0) {
    await sock.sendMessage(chatId, {
      text:
        `🧾 *${who} STATEMENT OF ACCOUNT*\n` +
        `${balanceLine}\n\n` +
        (isSelf
          ? '📭 No transactions yet — start earning with *!attendance* or *!work*!'
          : `📭 No transactions yet.`),
      mentions,
      ...channelInfo
    }, { quoted: message });
    return;
  }

  // ── Summary: net movement over the shown page, per currency ────────────
  const netCoins = txns.filter(t => t.currency === 'coins').reduce((s, t) => s + t.amount, 0);
  const netGroq = txns.filter(t => t.currency === 'groqCoins').reduce((s, t) => s + t.amount, 0);
  const summaryLine = `${trendArrow(netCoins + netGroq)} This page: ${signed(netCoins)}🪙 · ${signed(netGroq)}💲`;

  // ── Ledger table (monospace — this is the only place column padding
  //    actually renders aligned on WhatsApp) ─────────────────────────────
  const rows = txns.map(tx => {
    const suf = CURRENCY_SUFFIX[tx.currency] || '';
    const sign = tx.amount >= 0 ? '+' : '-';
    return {
      when: formatWhen(tx.timestamp),
      type: TYPE_LABELS_PLAIN[tx.type] || TYPE_LABELS_PLAIN.other,
      amount: `${sign}${formatNumber(Math.abs(tx.amount))}${suf}`,
      balance: `${formatNumber(tx.balanceAfter)}${suf}`,
      note: tx.note ? String(tx.note).slice(0, 24) : '',
    };
  });

  // Short headers on purpose — a header longer than its column's own content
  // (e.g. "BALANCE" next to a one-digit balance) needlessly widens the row.
  const H = { when: 'WHEN', type: 'TYPE', amount: 'AMT', balance: 'BAL' };
  const whenW = Math.max(H.when.length, ...rows.map(r => r.when.length));
  const typeW = Math.max(H.type.length, ...rows.map(r => r.type.length));
  const amountW = Math.max(H.amount.length, ...rows.map(r => r.amount.length));
  const balanceW = Math.max(H.balance.length, ...rows.map(r => r.balance.length));

  // Single-space gaps between columns (was double) — every extra space here
  // is a chunk of the phone-width budget that isn't going toward actual data.
  const headerRow = `${H.when.padEnd(whenW)} ${H.type.padEnd(typeW)} ${H.amount.padStart(amountW)} ${H.balance.padStart(balanceW)}`;
  const sepRow = '─'.repeat(headerRow.length);
  const bodyRows: string[] = [];
  rows.forEach(r => {
    bodyRows.push(`${r.when.padEnd(whenW)} ${r.type.padEnd(typeW)} ${r.amount.padStart(amountW)} ${r.balance.padStart(balanceW)}`);
    // Notes go on their own line rather than trailing the row — appending
    // one there would make that single row's width unbounded and it'd wrap
    // on its own, breaking the alignment right at that entry.
    if (r.note) bodyRows.push(`  ↳ ${r.note}`);
  });

  const table = ['```', headerRow, sepRow, ...bodyRows, '```'].join('\n');

  // ── Footer: nudge toward more history when the page is full ────────────
  const canShowMore = txns.length === cappedLimit && cappedLimit < 30;
  const footer = canShowMore
    ? `\n_Showing last ${txns.length} · reply *.history 30* for more_`
    : `\n_Showing last ${txns.length} · newest first_`;

  await sock.sendMessage(chatId, {
    text:
      `🧾 *${who} STATEMENT OF ACCOUNT*\n` +
      `${balanceLine}\n` +
      `${summaryLine}\n\n` +
      `${table}\n` +
      `${footer}`,
    mentions,
    ...channelInfo
  }, { quoted: message });
}