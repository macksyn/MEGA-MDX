// @ts-nocheck
/***
 * plugins/eco_loan.ts
 *
 * Loans now live INSIDE the bank menu (plugins/bank.ts + lib/bankLoans.ts) and
 * nowhere else. This plugin keeps only what can't live in a player menu:
 *
 *   • {prefix}loan admin [forgive @user | assess @user | credit]
 *                                          — owner/sudo loan book, forgiveness, and the credit tools
 *   • the hourly due-date / grace reminder DMs (self-contained `schedules`)
 *   • a redirect, so {prefix}loan / {prefix}loans / {prefix}borrow (and the old
 *     typed `apply` / `repay` / `history` forms) point players to the bank
 *     instead of silently doing nothing.
 *
 * The engine (eligibility, interest, garnishment, the reserve draw) is
 * unchanged — see lib/loans.ts.
 */
import { formatNumber, getWallet, withEconomyGuard } from '../lib/economy.js';
import config from '../config.js';
import {
  getLoanHistory, getLoanBookStats, getAllActiveLoans, getAllDefaultedLoans, forgiveLoan,
  getLoansDueForReminder, markReminderSent, getCreditProfile,
  DEFAULT_INTEREST_RATE, GRACE_PERIOD_MS, GARNISHMENT_RATE,
} from '../lib/loans.js';
import { CREDIT_CONFIG, assessCredit } from '../lib/credit.js';
import { listWagerSummaries } from '../lib/wagers.js';
import isOwnerOrSudo, { cleanJid } from '../lib/isOwner.js';

export const command = 'loan';
export const aliases = ['loans', 'borrow'];
export const category = 'economy';
export const cooldown = 3000;
const PREFIX = config.prefix || '.';
const LOAN_COMMAND = `${PREFIX}loan`;
const BANK_COMMAND = `${PREFIX}bank`;

function formatDuration(ms: number): string {
  const totalHrs = Math.max(0, Math.round(Math.abs(ms) / 3600000));
  const d = Math.floor(totalHrs / 24);
  const h = totalHrs % 24;
  if (d > 0) return `${d}d ${h}h`;
  return `${h}h`;
}

function extractTargetUser(message: any): string | null {
  const contextInfo = message.message?.extendedTextMessage?.contextInfo;
  if (contextInfo?.participant) return contextInfo.participant;
  if (contextInfo?.mentionedJid?.length) return contextInfo.mentionedJid[0];
  return null;
}

// ── Admin ────────────────────────────────────────────────────────────────────

async function handleAdmin(sock, message, context, args) {
  const { chatId, senderId, channelInfo } = context;

  // Same gate as the jackpot plugin: isOwnerOnly misses sudo users and group @lid identities.
  if (!(await isOwnerOrSudo(senderId, sock, chatId))) {
    await sock.sendMessage(chatId, { text: `❌ That view is for admins only.`, ...channelInfo }, { quoted: message });
    return;
  }

  const sub = (args[1] || '').toLowerCase();

  if (sub === 'forgive') {
    const mentioned = extractTargetUser(message);
    if (!mentioned) {
      await sock.sendMessage(chatId, {
        text: `❌ Tag or reply to the user to forgive: ${LOAN_COMMAND} admin forgive @user`,
        ...channelInfo
      }, { quoted: message });
      return;
    }
    const targetId = cleanJid(mentioned);
    const defaults = (await getLoanHistory(targetId)).filter(l => l.status === 'defaulted');
    if (defaults.length === 0) {
      await sock.sendMessage(chatId, { text: `❌ That user has no defaulted loan to forgive.`, ...channelInfo }, { quoted: message });
      return;
    }
    const result = await forgiveLoan(targetId, defaults[0].id);
    await sock.sendMessage(chatId, {
      text: result.success
        ? `🕊️ Forgiven. Garnishment stops immediately. Their repayment progress stays reset, since this loan wasn't actually repaid.`
        : `❌ Couldn't forgive that loan (${result.reason}).`,
      ...channelInfo
    }, { quoted: message });
    return;
  }

  if (sub === 'assess') {
    const mentioned = extractTargetUser(message);
    if (!mentioned) {
      await sock.sendMessage(chatId, { text: `❌ Tag or reply to the member: ${LOAN_COMMAND} admin assess @user`, ...channelInfo }, { quoted: message });
      return;
    }
    const targetId = cleanJid(mentioned);
    const [p, history, wallet] = await Promise.all([getCreditProfile(targetId), getLoanHistory(targetId), getWallet(targetId)]);
    const a = p.assessment;
    const standing = history.find(l => l.status === 'defaulted') ? '🔴 in default'
      : history.find(l => l.status === 'active') ? '💳 active loan' : '✅ no loan outstanding';
    await sock.sendMessage(chatId, {
      text:
        `📊 *CREDIT FILE — ${wallet.name || targetId}*\n\n` +
        `Play (${CREDIT_CONFIG.WINDOW_DAYS}d): *${formatNumber(p.signals.turnover)}* staked · ${p.signals.bets} bets · ${p.signals.activeDays} active days\n` +
        `   🎰 Games ${formatNumber(p.signals.bySource.games)} · ⚽ Sportybet ${formatNumber(p.signals.bySource.sportybet)}\n` +
        `Lifetime staked (tracked): ${formatNumber(p.signals.lifetimeTurnover)}\n\n` +
        a.gates.map(g => `${g.met ? '✅' : '❌'} ${g.label}: ${formatNumber(g.have)} / ${formatNumber(g.need)}`).join('\n') + `\n\n` +
        `Grade: *${a.grade ? a.grade.name : 'none'}*${a.nextGrade ? ` (next: ${a.nextGrade.name}, ${formatNumber(a.volumeToNext)} more)` : ''}\n` +
        `Repayment streak: ${p.repaidStreak}\n` +
        `Limit: *${p.maxAmount ? formatNumber(p.maxAmount) : '—'}*  ·  Qualifies on play: ${a.qualifies ? 'yes' : 'no'}\n` +
        `Standing: ${standing}`,
      ...channelInfo
    }, { quoted: message });
    return;
  }

  if (sub === 'credit') {
    const rows = (await listWagerSummaries(CREDIT_CONFIG.WINDOW_DAYS))
      .filter(r => r.turnover > 0)
      .sort((x, y) => y.turnover - x.turnover);
    const qualifying = rows.filter(r => assessCredit(r).qualifies).length;
    const top = await Promise.all(rows.slice(0, 10).map(async (r, i) => {
      const a = assessCredit(r);
      const w = await getWallet(r.userId);
      return `${i + 1}. ${w.name || r.userId} — ${formatNumber(r.turnover)} · ${r.activeDays}d · ${a.grade ? a.grade.name : '—'} ${a.qualifies ? '✅' : '❌'}`;
    }));
    const tiers = CREDIT_CONFIG.GRADES.map(g => `${g.name} ${formatNumber(g.minTurnover)}+ → ${formatNumber(g.baseMaxAmount)}`).join(' · ');
    await sock.sendMessage(chatId, {
      text:
        `📈 *CREDIT BOOK — last ${CREDIT_CONFIG.WINDOW_DAYS} days*\n\n` +
        `Members with recorded play: ${rows.length}\n` +
        `Qualifying for a loan right now: ${qualifying}\n\n` +
        (top.length ? `*Top by volume (staked · active days · grade):*\n${top.join('\n')}\n\n` : `_No play recorded yet._\n\n`) +
        `Grades: ${tiers}\n` +
        `Gate: ${CREDIT_CONFIG.GRADES[0].minTurnover}+ staked on ${CREDIT_CONFIG.MIN_ACTIVE_DAYS}+ days\n` +
        `_Tune thresholds in lib/credit.ts (CREDIT_CONFIG) once you see how real members distribute._`,
      ...channelInfo
    }, { quoted: message });
    return;
  }

  const stats = await getLoanBookStats();
  const activeLoans = await getAllActiveLoans();
  const defaultedLoans = await getAllDefaultedLoans();

  const activeLines = activeLoans.slice(0, 10).map(l =>
    `  • ${l.userId} — ${l.tier}, owes ${formatNumber(l.balance)}, due ${new Date(l.dueAt).toLocaleDateString()}`
  );
  const defaultedLines = defaultedLoans.slice(0, 10).map(l =>
    `  • ${l.userId} — owes ${formatNumber(l.balance)} since ${new Date(l.dueAt).toLocaleDateString()} · garnishing @ ${(GARNISHMENT_RATE * 100).toFixed(0)}%`
  );

  await sock.sendMessage(chatId, {
    text:
      `💳 *LOAN BOOK — ADMIN VIEW* 💳\n\n` +
      `Active loans: ${stats.activeCount}  (${formatNumber(stats.activeOutstanding)} outstanding)\n` +
      `Total ever disbursed: ${formatNumber(stats.totalDisbursed)}\n` +
      `Total ever repaid: ${formatNumber(stats.totalRepaid)}\n` +
      `Interest earned (repaid loans): ${formatNumber(stats.totalInterestEarned)}\n` +
      `In default (being garnished @ ${(GARNISHMENT_RATE * 100).toFixed(0)}%): ${stats.defaultedCount}  (${formatNumber(stats.defaultedOutstanding)} outstanding)\n` +
      `Recovered via garnishment: ${stats.recoveredCount}  (${formatNumber(stats.recoveredViaGarnishment)} clawed back)\n` +
      `Forgiven by admins: ${stats.forgivenCount}\n\n` +
      (activeLines.length ? `*Active:*\n${activeLines.join('\n')}\n\n` : '') +
      (defaultedLines.length ? `*In default:*\n${defaultedLines.join('\n')}\n\n` : '') +
      `_Active/defaulted balances reflect last check-in — may lag true accrued interest/garnishment until the borrower next has activity._\n` +
      `_Also: ${LOAN_COMMAND} admin forgive @user · ${LOAN_COMMAND} admin assess @user · ${LOAN_COMMAND} admin credit_`,
    ...channelInfo
  }, { quoted: message });
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function _handler(sock, message, args, context) {
  const { chatId, channelInfo } = context;
  const sub = (args[0] || '').toLowerCase();

  if (sub === 'admin') return handleAdmin(sock, message, context, args);

  // Everything else — bare command, apply, repay, history — moved into the bank.
  return sock.sendMessage(chatId, {
    text:
      `💳 *Loans have moved into the bank.*\n\n` +
      `Type *${BANK_COMMAND}* and tap *Get a loan* — or *My loan* if you already have one.\n\n` +
      `*Who qualifies:* active players — at least ${formatNumber(CREDIT_CONFIG.GRADES[0].minTurnover)} coins staked on games or Sportybet over the last ${CREDIT_CONFIG.WINDOW_DAYS} days, across ${CREDIT_CONFIG.MIN_ACTIVE_DAYS}+ different days. The more you play, the higher your limit.\n\n` +
      `_The Loans button appears once you qualify, or if you already have a loan._`,
    ...channelInfo
  }, { quoted: message });
}

export const handler = withEconomyGuard(_handler);
export const usage = `${LOAN_COMMAND} admin — loan book (owner/sudo). Players: use ${BANK_COMMAND}`;

// ── Self-contained due-date reminders ─────────────────────────────────────────
// Uses the plugin contract's own `schedules` field (see lib/pluginLoader.ts).
// Sweeps hourly; getLoansDueForReminder()/markReminderSent() in lib/loans.ts
// dedupe so each loan only ever gets one 'due_soon' and one 'grace' DM.

async function sendReminderDM(sock: any, loan: any, kind: 'due_soon' | 'grace') {
  const wallet = await getWallet(loan.userId);
  // wallet.jid is the domain-intact raw JID (userId itself has the domain
  // stripped by cleanJid()) — the only field that reliably builds a DM target.
  if (!wallet.jid) return;

  const text = kind === 'due_soon'
    ? `⏰ *LOAN REMINDER* ⏰\n\n` +
      `Your loan balance of *${formatNumber(loan.balance)} coins* is due within 24 hours.\n\n` +
      `Pay it off: type *${BANK_COMMAND}* → *My loan* → *Pay in full* (or *Make a payment*). The ${formatDuration(GRACE_PERIOD_MS)} grace window after the due date has no extra charge; after grace, a default adds ${(DEFAULT_INTEREST_RATE * 100).toFixed(0)}% daily until fully repaid.`
    : `🔴 *LOAN OVERDUE — GRACE PERIOD* 🔴\n\n` +
      `Your loan balance of *${formatNumber(loan.balance)} coins* is now overdue. You have a ${formatDuration(GRACE_PERIOD_MS)} grace window left before it defaults.\n\n` +
      `Clear it now: type *${BANK_COMMAND}* → *My loan* → *Pay in full*`;

  try {
    await sock.sendMessage(wallet.jid, { text });
  } catch (err) {
    console.error('[eco_loan] reminder DM failed:', err);
  }
}

export const schedules = [
  {
    every: 60 * 60 * 1000, // hourly sweep
    handler: async (sock: any) => {
      const { dueSoon, inGrace } = await getLoansDueForReminder();

      for (const loan of dueSoon) {
        await sendReminderDM(sock, loan, 'due_soon');
        await markReminderSent(loan.userId, loan.id, 'due_soon');
      }
      for (const loan of inGrace) {
        await sendReminderDM(sock, loan, 'grace');
        await markReminderSent(loan.userId, loan.id, 'grace');
      }
    },
  },
];