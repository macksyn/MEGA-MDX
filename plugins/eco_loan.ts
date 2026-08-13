// @ts-nocheck
/***
 * plugins/eco_loan.ts
 *
 * !loan — borrow coins from the community bank. Eligibility starts at
 * economy Level 2. The maximum grows after consecutive on-time full
 * repayments, and late repayments/defaults do not increase it. See
 * lib/loans.ts for the full engine and rationale.
 *
 * UX mirrors plugins/antilink.ts: bare `!loan` opens a USSD-style
 * promptMenu flow (numbered replies, no native buttons — confirmed
 * unreliable path per lib/menuSession.ts). Amount entry uses numbered
 * quick-picks with a "Custom amount" fallback to a typed command, same
 * pattern antilink uses for its freeform domain-add step. Typed
 * subcommands (`!loan apply 200`, `!loan repay all`, etc.) still work
 * directly for anyone who doesn't want the menu.
 *
 * Also registers its own hourly reminder sweep via the standard `schedules`
 * export (see lib/pluginLoader.ts's plugin contract) — fully self-contained,
 * no dependency on any other plugin's reminder infra.
 */
import { formatNumber, getWallet, withEconomyGuard } from '../lib/economy.js';
import {
  checkEligibility, applyForLoan, repayLoan, getLoanHistory, getActiveLoan,
  getLoanBookStats, getAllActiveLoans, getAllDefaultedLoans, forgiveLoan,
  getLoansDueForReminder, markReminderSent,
  LOAN_TIERS, DAILY_INTEREST_RATE, MIN_LOAN_AMOUNT, GRACE_PERIOD_MS, GARNISHMENT_RATE,
} from '../lib/loans.js';
import { promptMenu } from '../lib/menuSession.js';
import { cleanJid, isOwnerOnly } from '../lib/isOwner.js';

export const command = 'loan';
export const aliases = ['loans', 'borrow'];
export const category = 'economy';
export const cooldown = 3000;

// ── Formatting helpers ────────────────────────────────────────────────────────

function bar(percent: number, size = 10): string {
  const filled = Math.max(0, Math.min(size, Math.round((percent / 100) * size)));
  return `${'█'.repeat(filled)}${'░'.repeat(size - filled)}`;
}

function formatDuration(ms: number): string {
  const totalHrs = Math.max(0, Math.round(Math.abs(ms) / 3600000));
  const d = Math.floor(totalHrs / 24);
  const h = totalHrs % 24;
  if (d > 0) return `${d}d ${h}h`;
  return `${h}h`;
}

function dueLabel(loan: any): string {
  const now = Date.now();
  const remaining = loan.dueAt - now;
  if (remaining >= 0) return `⏳ Due in ${formatDuration(remaining)}`;
  const graceLeft = loan.dueAt + GRACE_PERIOD_MS - now;
  return graceLeft > 0
    ? `⚠️ Overdue by ${formatDuration(remaining)} — ${formatDuration(graceLeft)} grace left`
    : `🔴 In default`;
}

function extractTargetUser(message: any): string | null {
  const contextInfo = message.message?.extendedTextMessage?.contextInfo;
  if (contextInfo?.participant) return contextInfo.participant;
  if (contextInfo?.mentionedJid?.length) return contextInfo.mentionedJid[0];
  return null;
}

// ── Shared senders ─────────────────────────────────────────────────────────────

async function sendGarnishmentStatus(sock, message, chatId, channelInfo, userId) {
  const history = await getLoanHistory(userId);
  const loan = history.find(l => l.status === 'defaulted');

  if (!loan) {
    // Shouldn't happen if this was called because of reason === 'defaulted_loan',
    // but fail gracefully rather than crash on a race.
    await sock.sendMessage(chatId, { text: `❌ You're not eligible for a loan right now.`, ...channelInfo }, { quoted: message });
    return;
  }

  await sock.sendMessage(chatId, {
    text:
      `🔴 *LOAN IN DEFAULT* 🔴\n\n` +
      `Still owed: *${formatNumber(loan.balance)} coins*\n\n` +
      `New loans are on hold until this clears. It's being recovered automatically — *${(GARNISHMENT_RATE * 100).toFixed(0)}%* of every attendance/work/game-win credit goes toward it until it's paid off. Peer !transfer gifts you receive are never touched.\n\n` +
      `Paying it down faster works too: !loan repay <amount>\n\n` +
      `_Once this clears, you can borrow again at the Level 2+ base limit. Your repayment progress is reset, and future increases must be earned through on-time repayments._`,
    ...channelInfo
  }, { quoted: message });
}

async function sendLoanDetails(sock, message, chatId, channelInfo, loan) {
  const paidPct = loan.principal > 0
    ? Math.min(100, (loan.totalRepaid / (loan.totalRepaid + loan.balance)) * 100)
    : 0;

  await sock.sendMessage(chatId, {
    text:
      `┏━━━ 💳 *ACTIVE LOAN* ━━━┓\n\n` +
      `Tier: *${loan.tier}*\n` +
      `Borrowed: ${formatNumber(loan.principal)} coins\n` +
      `Owed now: *${formatNumber(loan.balance)} coins* _(5% daily after the 1-day grace period)_\n\n` +
      `Repaid so far  ${bar(paidPct)} ${paidPct.toFixed(0)}%\n\n` +
      `${dueLabel(loan)}\n\n` +
      `┗━━━━━━━━━━━━━━━━━━┛\n` +
      `💵 !loan repay <amount>  ·  !loan repay all`,
    ...channelInfo
  }, { quoted: message });
}

async function sendHistory(sock, message, chatId, channelInfo, userId) {
  const history = await getLoanHistory(userId);

  if (history.length === 0) {
    await sock.sendMessage(chatId, {
      text: `📜 No loan history yet. Run !loan to see if you're eligible.`,
      ...channelInfo
    }, { quoted: message });
    return;
  }

  const icons: Record<string, string> = { active: '💳', repaid: '✅', defaulted: '⚠️', recovered: '🔓', forgiven: '🕊️' };
  const lines = history.slice(0, 10).map(l => {
    const date = new Date(l.issuedAt).toLocaleDateString();
    return `${icons[l.status] || '•'} ${date} — ${l.tier}, borrowed ${formatNumber(l.principal)}, *${l.status}*`;
  });

  await sock.sendMessage(chatId, {
    text: `📜 *LOAN HISTORY* 📜\n\n${lines.join('\n')}`,
    ...channelInfo
  }, { quoted: message });
}

async function sendTiersInfo(sock, message, chatId, channelInfo) {
  const lines = LOAN_TIERS.map(t => {
    return (
      `*Level ${t.minLevel}+ · ${t.name}* — base limit ${formatNumber(t.baseMaxAmount)} coins, ${t.termWeeks}w term`
    );
  });

  await sock.sendMessage(chatId, {
    text:
      `💳 *HOW LOAN TIERS WORK* 💳\n\n` +
      lines.join('\n\n') +
      `\n\n_Level 2 is the minimum to qualify. Loans expire after 7 days with a 1-day grace period. After grace, the outstanding balance compounds at ${(DAILY_INTEREST_RATE * 100).toFixed(0)}% daily until fully repaid. Each loan fully repaid by its due date adds +15% capacity (capped at 2x); late repayments and defaults do not increase your limit._`,
    ...channelInfo
  }, { quoted: message });
}

async function sendEligibilityBreakdown(sock, message, chatId, channelInfo, eligibility) {
  const t = eligibility.nextTier;
  const level = eligibility.economyLevel;
  const progress = eligibility.progress?.economyLevel || 0;

  await sock.sendMessage(chatId, {
    text:
      `🔒 *NOT YET ELIGIBLE* 🔒\n\n` +
      `You are currently *Level ${level?.levelNumber} · ${level?.levelName}*.\n` +
      `Loan access starts at *Level ${t.minLevel} · ${t.name}*.\n\n` +
      `Economy level  ${bar(progress * 100)} ${(progress * 100).toFixed(0)}%\n\n` +
      `_Keep using the economy to reach Level 2, then you can apply for a loan. Your limit grows when you fully repay loans by their due date._`,
    ...channelInfo
  }, { quoted: message });
}

async function doApply(sock, message, chatId, channelInfo, userId, amount) {
  const result = await applyForLoan(userId, amount);

  if (result.success) {
    const l = result.loan;
    await sock.sendMessage(chatId, {
      text:
        `✅ *LOAN APPROVED* ✅\n\n` +
        `${formatNumber(l.principal)} coins deposited into your wallet.\n\n` +
        `Tier: ${l.tier}\n` +
        `Interest: ${(DAILY_INTEREST_RATE * 100).toFixed(0)}% daily after grace\n` +
        `Due: 7 days from now, followed by 1 day grace\n\n` +
        `Check anytime with !loan · repay with !loan repay <amount>`,
      ...channelInfo
    }, { quoted: message });
    return;
  }

  if (result.reason === 'ineligible') {
    return renderStatus(sock, message, chatId, channelInfo, userId, { forceText: true });
  }

  const messages: Record<string, string> = {
    below_minimum: `❌ Minimum loan amount is ${formatNumber(MIN_LOAN_AMOUNT)} coins.`,
    exceeds_tier_max: `❌ That's above your current limit — max is ${formatNumber((result as any).maxAmount)} coins.`,
    bank_capacity: `❌ The bank can't cover that right now — max available: ${formatNumber((result as any).maxAvailable)} coins. Try a smaller amount, or check back later.`,
  };
  await sock.sendMessage(chatId, {
    text: messages[result.reason] || `❌ Couldn't process that loan.`,
    ...channelInfo
  }, { quoted: message });
}

async function doRepay(sock, message, chatId, channelInfo, userId, amount) {
  const result = await repayLoan(userId, amount);

  if (!result.success) {
    const messages: Record<string, string> = {
      no_outstanding_loan: `❌ You don't have an outstanding loan.`,
      invalid_amount: `❌ Enter a valid amount, or "all".`,
      insufficient_funds: `❌ You don't have enough coins — need ${formatNumber((result as any).needed)}.`,
    };
    await sock.sendMessage(chatId, {
      text: messages[result.reason] || `❌ Couldn't process that repayment.`,
      ...channelInfo
    }, { quoted: message });
    return;
  }

  await sock.sendMessage(chatId, {
    text: result.fullyRepaid
      ? result.onTime
        ? `🎉 *LOAN FULLY REPAID ON TIME!* 🎉\n\nPaid ${formatNumber(result.paid)} coins.\nYour repayment streak grew — your borrowing limit increases as you keep repaying on time.`
        : `✅ *LOAN FULLY REPAID!* \n\nPaid ${formatNumber(result.paid)} coins.\nThis repayment was after the due date, so your borrowing limit did not increase.`
      : `✅ Paid ${formatNumber(result.paid)} coins.\nRemaining balance: *${formatNumber(result.remaining)} coins*`,
    ...channelInfo
  }, { quoted: message });
}

// ── Interactive USSD menu (bare !loan) ────────────────────────────────────────

async function runApplyAmountMenu(sock, message, chatId, userId, channelInfo, eligibility) {
  const max = eligibility.maxAmount;
  const presets = Array.from(new Set(
    [0.25, 0.5, 0.75, 1].map(f => Math.round(max * f)).filter(n => n >= MIN_LOAN_AMOUNT)
  )).sort((a, b) => a - b);

  const options = presets.map(a => ({
    label: `${formatNumber(a)} coins`,
    value: String(a),
    description: a === max ? 'Full limit' : undefined,
  }));
  options.push({ label: 'Custom amount', value: 'custom' });

  const result = await promptMenu(sock, message, chatId, userId, {
    title: `💳 APPLY · ${eligibility.tier.name} tier`,
    subtitle: `7-day term · 1-day grace · ${(DAILY_INTEREST_RATE * 100).toFixed(0)}%/day after grace`,
    text: 'How much would you like to borrow?',
    options,
  });

  if (result.cancelled || result.timedOut || !result.value) return;

  if (result.value === 'custom') {
    await sock.sendMessage(chatId, {
      text: `✍️ Type the exact amount:\n\n\`!loan apply <amount>\`\n\n_Max: ${formatNumber(max)} coins_`,
      ...channelInfo
    }, { quoted: message });
    return;
  }

  return doApply(sock, message, chatId, channelInfo, userId, parseInt(result.value, 10));
}

async function runRepayAmountMenu(sock, message, chatId, userId, channelInfo, loan) {
  const presets = Array.from(new Set(
    [0.25, 0.5, 0.75, 1].map(f => Math.round(loan.balance * f)).filter(n => n > 0)
  )).sort((a, b) => a - b);

  const options = presets.map(a => ({
    label: `${formatNumber(a)} coins`,
    value: String(a),
    description: a >= loan.balance ? 'Clears the loan' : undefined,
  }));
  options.push({ label: 'Custom amount', value: 'custom' });

  const result = await promptMenu(sock, message, chatId, userId, {
    title: `💳 REPAY`,
    subtitle: `Owe ${formatNumber(loan.balance)} coins · ${dueLabel(loan)}`,
    text: 'How much would you like to pay?',
    options,
  });

  if (result.cancelled || result.timedOut || !result.value) return;

  if (result.value === 'custom') {
    await sock.sendMessage(chatId, {
      text: `✍️ Type the exact amount:\n\n\`!loan repay <amount>\`  or  \`!loan repay all\``,
      ...channelInfo
    }, { quoted: message });
    return;
  }

  return doRepay(sock, message, chatId, channelInfo, userId, parseInt(result.value, 10));
}

async function runMainMenu(sock, message, chatId, userId, channelInfo) {
  const active = await getActiveLoan(userId);

  if (active) {
    const result = await promptMenu(sock, message, chatId, userId, {
      title: '💳 LOANS',
      subtitle: `Active — owe ${formatNumber(active.balance)} · ${dueLabel(active)}`,
      text: 'What would you like to do?',
      options: [
        { label: 'View loan details', value: 'details' },
        { label: 'Make a payment', value: 'pay', description: 'Pick an amount to pay down' },
        { label: 'Pay in full', value: 'payfull', description: `Clears ${formatNumber(active.balance)} owed` },
        { label: 'Loan history', value: 'history' },
      ],
    });
    if (result.cancelled || result.timedOut) return;

    switch (result.value) {
      case 'details': return sendLoanDetails(sock, message, chatId, channelInfo, active);
      case 'pay': return runRepayAmountMenu(sock, message, chatId, userId, channelInfo, active);
      case 'payfull': return doRepay(sock, message, chatId, channelInfo, userId, 'all');
      case 'history': return sendHistory(sock, message, chatId, channelInfo, userId);
    }
    return;
  }

  const eligibility = await checkEligibility(userId);

  if (eligibility.eligible) {
    const result = await promptMenu(sock, message, chatId, userId, {
      title: '💳 LOANS',
      subtitle: `✅ Eligible — Level ${eligibility.economyLevel.levelNumber} · ${eligibility.tier.name}, up to ${formatNumber(eligibility.maxAmount)} coins`,
      text: 'What would you like to do?',
      options: [
        { label: 'Apply for a loan', value: 'apply', description: `Up to ${formatNumber(eligibility.maxAmount)} coins` },
        { label: 'Loan history', value: 'history' },
        { label: 'How tiers work', value: 'tiers' },
      ],
    });
    if (result.cancelled || result.timedOut) return;

    switch (result.value) {
      case 'apply': return runApplyAmountMenu(sock, message, chatId, userId, channelInfo, eligibility);
      case 'history': return sendHistory(sock, message, chatId, channelInfo, userId);
      case 'tiers': return sendTiersInfo(sock, message, chatId, channelInfo);
    }
    return;
  }

  if (eligibility.reason === 'defaulted_loan') {
    return sendGarnishmentStatus(sock, message, chatId, channelInfo, userId);
  }

  const result = await promptMenu(sock, message, chatId, userId, {
    title: '💳 LOANS',
    subtitle: `🔒 Not yet eligible`,
    text: 'What would you like to see?',
    options: [
      { label: 'Why am I not eligible?', value: 'why' },
      { label: 'Loan history', value: 'history' },
      { label: 'How tiers work', value: 'tiers' },
    ],
  });
  if (result.cancelled || result.timedOut) return;

  switch (result.value) {
    case 'why': return sendEligibilityBreakdown(sock, message, chatId, channelInfo, eligibility);
    case 'history': return sendHistory(sock, message, chatId, channelInfo, userId);
    case 'tiers': return sendTiersInfo(sock, message, chatId, channelInfo);
  }
}

// ── Status view used both by menu entry and by doApply's ineligible fallback ──

async function renderStatus(sock, message, chatId, channelInfo, userId, opts: { forceText?: boolean } = {}) {
  const active = await getActiveLoan(userId);
  if (active) return sendLoanDetails(sock, message, chatId, channelInfo, active);

  const eligibility = await checkEligibility(userId);
  if (eligibility.eligible) {
    await sock.sendMessage(chatId, {
      text:
        `💳 *LOANS* 💳\n\n✅ Eligible — *Level ${eligibility.economyLevel.levelNumber} · ${eligibility.tier.name}*\n` +
        `Max loan: *${formatNumber(eligibility.maxAmount)} coins*\n` +
        `Term: ${eligibility.tier.termWeeks} week${eligibility.tier.termWeeks > 1 ? 's' : ''}\n\n` +
        `Borrow with: !loan apply <amount>`,
      ...channelInfo
    }, { quoted: message });
    return;
  }
  if (eligibility.reason === 'defaulted_loan') {
    return sendGarnishmentStatus(sock, message, chatId, channelInfo, userId);
  }
  return sendEligibilityBreakdown(sock, message, chatId, channelInfo, eligibility);
}

// ── Direct typed subcommands (bypass the menu) ───────────────────────────────

async function handleApplyDirect(sock, message, context, userId, args) {
  const { chatId, channelInfo } = context;
  const amount = parseInt(args[1], 10);
  if (!amount || amount < MIN_LOAN_AMOUNT) {
    await sock.sendMessage(chatId, {
      text: `❌ Enter a valid amount, minimum ${formatNumber(MIN_LOAN_AMOUNT)} coins. Example: !loan apply 200`,
      ...channelInfo
    }, { quoted: message });
    return;
  }
  return doApply(sock, message, chatId, channelInfo, userId, amount);
}

async function handleRepayDirect(sock, message, context, userId, args) {
  const { chatId, channelInfo } = context;
  const raw = (args[1] || '').toLowerCase();
  const amount = raw === 'all' ? 'all' : parseInt(raw, 10);
  if (raw !== 'all' && (!amount || amount <= 0)) {
    await sock.sendMessage(chatId, {
      text: `❌ Enter a valid amount, or "all". Example: !loan repay 100  ·  !loan repay all`,
      ...channelInfo
    }, { quoted: message });
    return;
  }
  return doRepay(sock, message, chatId, channelInfo, userId, amount);
}

// ── Admin ────────────────────────────────────────────────────────────────────

async function handleAdmin(sock, message, context, userId, args) {
  const { chatId, channelInfo } = context;

  if (!isOwnerOnly(userId)) {
    await sock.sendMessage(chatId, { text: `❌ That view is for admins only.`, ...channelInfo }, { quoted: message });
    return;
  }

  const sub = (args[1] || '').toLowerCase();

  if (sub === 'forgive') {
    const mentioned = extractTargetUser(message);
    if (!mentioned) {
      await sock.sendMessage(chatId, {
        text: `❌ Tag or reply to the user to forgive: !loan admin forgive @user`,
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
      `_Active/defaulted balances reflect last check-in — may lag true accrued interest/garnishment until the borrower next has activity. Forgive early with: !loan admin forgive @user_`,
    ...channelInfo
  }, { quoted: message });
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function _handler(sock, message, args, context) {
  const { chatId, senderId, channelInfo } = context;
  const userId = cleanJid(senderId);
  const sub = (args[0] || '').toLowerCase();

  if (sub === 'apply') return handleApplyDirect(sock, message, context, userId, args);
  if (sub === 'repay') return handleRepayDirect(sock, message, context, userId, args);
  if (sub === 'history') return sendHistory(sock, message, chatId, channelInfo, userId);
  if (sub === 'admin') return handleAdmin(sock, message, context, userId, args);

  // No subcommand → USSD-style interactive menu
  return runMainMenu(sock, message, chatId, userId, channelInfo);
}

export const handler = withEconomyGuard(_handler);
export const usage = '!loan — opens the menu. Or: !loan <apply|repay|history|admin>';

// ── Self-contained due-date reminders ─────────────────────────────────────────
// Uses the plugin contract's own `schedules` field (see lib/pluginLoader.ts)
// — no dependency on any other plugin's reminder/scheduling code. Sweeps
// hourly; getLoansDueForReminder()/markReminderSent() in lib/loans.ts dedupe
// so each loan only ever gets one 'due_soon' and one 'grace' DM.

async function sendReminderDM(sock: any, loan: any, kind: 'due_soon' | 'grace') {
  const wallet = await getWallet(loan.userId);
  // wallet.jid is the domain-intact raw JID (userId itself has the domain
  // stripped by cleanJid()) — the only field that reliably builds a DM target.
  if (!wallet.jid) return;

  const text = kind === 'due_soon'
    ? `⏰ *LOAN REMINDER* ⏰\n\n` +
      `Your loan balance of *${formatNumber(loan.balance)} coins* is due within 24 hours.\n\n` +
       `Pay it off with !loan repay <amount> or !loan repay all. You have a ${formatDuration(GRACE_PERIOD_MS)} grace window after day 7 with no extra interest; after grace, the balance compounds at ${(DAILY_INTEREST_RATE * 100).toFixed(0)}% daily until fully repaid.`
    : `🔴 *LOAN OVERDUE — GRACE PERIOD* 🔴\n\n` +
      `Your loan balance of *${formatNumber(loan.balance)} coins* is now overdue. You have a ${formatDuration(GRACE_PERIOD_MS)} grace window left before it defaults.\n\n` +
      `Clear it now: !loan repay all`;

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
