// @ts-nocheck
/***
 * lib/bankLoans.ts
 *
 * Loan screens for the bank menu. The bank menu is the ONLY player-facing way
 * to use loans — plugins/eco_loan.ts keeps just the admin tools and the
 * due-date reminders, and points everyone else here.
 *
 * The engine (credit score, interest, garnishment, the strict reserve draw and
 * the per-user lock) lives in lib/loans.ts, lib/credit.ts, lib/wagers.ts and
 * lib/bankActivity.ts; this file is presentation and navigation, plus the
 * pay-from-savings helper:
 *
 *   home ─▶ loan (hub, changes with the member's state)
 *             ├─ loanApply ─▶ loanConfirm ─▶ (loan approved, back to home)
 *             ├─ loanRepay / "Pay in full"
 *             ├─ loanProfile   (the credit factors behind the limit)
 *             ├─ loanHistory
 *             └─ loanInfo
 *
 * The Loans button on the home screen only exists for members whose credit
 * score qualifies them right now, or who already hold a loan
 * (see getLoanAccess / loanMenuOption).
 *
 * NOTE on headings: promptMenu already prints each screen's `title` (bold)
 * and `subtitle` above the body, so card text must NOT repeat them.
 */
import { formatNumber, getWallet } from './economy.js';
import config from '../config.js';
import {
  checkEligibility, applyForLoan, repayLoan, getLoanHistory, getRepayableLoan, getCreditProfile,
  INTEREST_RATE, DEFAULT_INTEREST_RATE, MIN_LOAN_AMOUNT, GRACE_PERIOD_MS, GARNISHMENT_RATE,
} from './loans.js';
import { CREDIT_CONFIG } from './credit.js';
import { withdraw as bankWithdraw, getAvailableSavings } from './bankLedger.js';
import { askAmount, type Screen } from './bankUi.js';

const fmt = formatNumber;
const pct = (r: number) => `${(r * 100).toFixed(0)}%`;
const GRADE_ICON = ['🥉', '🥈', '🥇', '💎'];

// ── Formatting ───────────────────────────────────────────────────────────────

function duration(ms: number): string {
  const hrs = Math.max(0, Math.round(Math.abs(ms) / 3_600_000));
  const d = Math.floor(hrs / 24);
  return d > 0 ? `${d}d ${hrs % 24}h` : `${hrs}h`;
}

function bar(percent: number, size = 10): string {
  const filled = Math.max(0, Math.min(size, Math.round((percent / 100) * size)));
  return `${'█'.repeat(filled)}${'░'.repeat(size - filled)}`;
}

function dueLabel(loan: any): string {
  const now = Date.now();
  const remaining = loan.dueAt - now;
  if (remaining >= 0) return `⏳ Due in ${duration(remaining)}`;
  const graceLeft = loan.dueAt + GRACE_PERIOD_MS - now;
  return graceLeft > 0
    ? `⚠️ Overdue by ${duration(remaining)} — ${duration(graceLeft)} grace left`
    : `🔴 In default`;
}

// One-line version for button descriptions.
function dueShort(loan: any): string {
  if (loan.status === 'defaulted') return 'in default';
  const now = Date.now();
  if (loan.dueAt - now >= 0) return `due in ${duration(loan.dueAt - now)}`;
  return loan.dueAt + GRACE_PERIOD_MS - now > 0 ? 'overdue · in grace' : 'in default';
}

// ── Access: who gets a Loans button ──────────────────────────────────────────

export interface LoanAccess {
  loan: any | null;          // active OR defaulted (anything repayable)
  eligibility: any | null;   // only computed when there's no loan
  hasLoanButton: boolean;
}

/** Loans are visible to members whose credit score qualifies right now, or who already hold a loan — nobody else. */
export async function getLoanAccess(userId: string): Promise<LoanAccess> {
  const loan = await getRepayableLoan(userId).catch(() => null);
  let eligibility = null;
  if (!loan) eligibility = await checkEligibility(userId).catch(() => null);
  return { loan, eligibility, hasLoanButton: !!loan || !!eligibility?.eligible };
}

/** The home-menu row for loans, or null when this member shouldn't see one. */
export function loanMenuOption(access: LoanAccess) {
  if (access.loan) {
    const l = access.loan;
    return l.status === 'defaulted'
      ? { label: '🔴 My loan', value: 'loan', description: `In default · owes ${fmt(l.balance)}` }
      : { label: '💳 My loan', value: 'loan', description: `Owes ${fmt(l.balance)} · ${dueShort(l)}` };
  }
  if (access.eligibility?.eligible) {
    return { label: '💳 Get a loan', value: 'loan', description: `Borrow up to ${fmt(access.eligibility.maxAmount)} coins` };
  }
  return null;
}

// ── Text builders ────────────────────────────────────────────────────────────

const holdLine = (hold: number) =>
  hold > 0 ? `🔐 *${fmt(hold)}* of your savings is held as security — repaying frees it.` : '';

function activeLoanCard(loan: any, walletCoins: number, hold = 0): string {
  const paidPct = loan.principal > 0
    ? Math.min(100, (loan.totalRepaid / (loan.totalRepaid + loan.balance)) * 100)
    : 0;
  return [
    `Credit: *${loan.tier}* · Borrowed ${fmt(loan.principal)}`,
    `Owed now: *${fmt(loan.balance)}* coins`,
    `Repaid  ${bar(paidPct)} ${paidPct.toFixed(0)}%`,
    dueLabel(loan),
    `_plus ${pct(INTEREST_RATE)}._`,
    holdLine(hold),
    ``,
    `💰 Wallet: ${fmt(walletCoins)}`,
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}

function defaultedLoanCard(loan: any, walletCoins: number, hold = 0): string {
  return [
    `🔴 *LOAN IN DEFAULT*`,
    `You are still owing *${fmt(loan.balance)}* coins`,
    ``,
    `*${pct(GARNISHMENT_RATE)}* of every attendance / work / game-win credit goes toward it until it's cleared. Transfers you receive are never touched.`,
    `Your savings are used to repay it automatically. New loans are on hold until it clears.`,
    holdLine(hold),
    ``,
    `💰 Wallet: ${fmt(walletCoins)}`,
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}

function eligibleCard(e: any, walletCoins: number): string {
  const s = e.signals;
  return [
    `✅ Eligible — *${e.grade.name}* credit`,
    `You can borrow up to *${fmt(e.maxAmount)}* coins`,
    ``,
    `📈 *Activity in the last ${CREDIT_CONFIG.WINDOW_DAYS} days*`,
    ` ${fmt(s.turnover)} coins played · ${s.activeDays} active days`,
    ` ${fmt(s.avgBalance)} average savings · saved on ${s.saveDays} days`,
    ` Credit score: ${e.assessment.score}/100`,
    `⏳ *Loan term:* ${e.grade.termWeeks} week`,
    `💸 *Interest:* ${pct(INTEREST_RATE)}`,
    ``,
    `💰 Wallet: ${fmt(walletCoins)}`,
  ].join('\n');
}

// Only reachable if a member's standing changed since the home screen was drawn.
function notEligibleCard(e: any): string {
  const gates = (e?.assessment?.gates || []).map(g => `${g.met ? '✅' : '❌'} ${g.label}: ${fmt(g.have)} / ${fmt(g.need)}`);
  return [
    `🔒 *NOT YET ELIGIBLE*`,
    `Loan offers are giving to active Casino and sportybet players, and to members who bank with us. In the last ${CREDIT_CONFIG.WINDOW_DAYS} days you need:`,
    ...gates,
    `_Coins staked on games and Sportybet count — and so do your savings, deposits and Money Locks._`,
  ].join('\n');
}

// Keep the +15% / 2× wording in sync with REPAID_BONUS_PER_LOAN / MAX_REPAID_BONUS_MULTIPLIER in lib/loans.ts.
function infoText(): string {
  const grades = CREDIT_CONFIG.GRADES.map((g, i) =>
    `${GRADE_ICON[i] || '•'} ${g.name} — score ${g.minScore}+ → up to ${fmt(g.baseMaxAmount)}`).join('\n');
  return [
    `*Who qualifies:* active members who, within the last ${CREDIT_CONFIG.WINDOW_DAYS} days, have built a credit score of at least ${CREDIT_CONFIG.GRADES[0].minScore} by playing games or Sportybet and banking with us (savings, regular deposits, Money Locks), across at least ${CREDIT_CONFIG.MIN_ACTIVITY_DAYS}+ different days.`,
    ``,
    `*Your limit* grows with how much you play and save:`,
    grades,
    ``,
    `• A ${pct(INTEREST_RATE)} interest is applied upfront, including for loans repaid the same day.`,
    `• Repayment is due at the end of the loan term, followed by a ${duration(GRACE_PERIOD_MS)} grace period with no edditional charge.`,
    `• After the grace period, the loan is in default. An additional +${pct(DEFAULT_INTEREST_RATE)} is added daily until the balance is cleared, ${pct(GARNISHMENT_RATE)} of your earnings will be applied to repayment, and your savings are used to clear it.`,
    `• While a loan is open, savings equal to what you owe are held as security.`,
    `• Repaying on time increase your limit by +15% per loan (max 2×).`,
  ].join('\n');
}

/**
 * Repays a member's loan out of their savings. Two ordinary, individually-safe steps:
 * move the coins savings -> wallet (the only place that may bypass the collateral hold,
 * because the coins are going straight to that member's own loan), then repay from the wallet.
 * Also used by the default setoff sweep in plugins/bank.ts.
 */
export async function payLoanFromSavings(userId: string, requested: number | 'all' = 'all') {
  const loan = await getRepayableLoan(userId);
  if (!loan) return { success: false, reason: 'no_outstanding_loan' };
  const { balance } = await getAvailableSavings(userId);
  const owed = Math.ceil(loan.balance);
  const amount = requested === 'all' ? Math.min(owed, balance) : Math.min(Math.floor(requested), owed, balance);
  if (amount <= 0) return { success: false, reason: 'no_savings' };

  const w = await bankWithdraw(userId, amount, { bypassHold: true, note: 'Loan repayment from savings' });
  if (!w.ok) return { success: false, reason: 'no_savings' };
  return repayLoan(userId, amount);
}

function repayNav(result: any) {
  if (!result.success) {
    const messages: Record<string, string> = {
      no_outstanding_loan: `❌ You don't have an outstanding loan.`,
      no_savings: `❌ You have no savings to use.`,
      invalid_amount: `❌ Enter a valid amount.`,
      insufficient_funds: `❌ Not enough coins in your wallet — need ${fmt(result.needed ?? 0)}.`,
    };
    const notice = messages[result.reason] || `❌ Couldn't process that repayment.`;
    return result.reason === 'no_outstanding_loan'
      ? { go: 'home', reset: true, notice }
      : { stay: true, notice };
  }

  if (result.fullyRepaid) {
    return {
      go: 'home', reset: true,
      notice: result.onTime
        ? `🎉 *LOAN FULLY REPAID ON TIME!*\nPaid ${fmt(result.paid)} coins. Your repayment streak grew — your borrowing limit increases as you keep repaying on time.`
        : `✅ *LOAN FULLY REPAID!*\nPaid ${fmt(result.paid)} coins. This was after the due date, so your borrowing limit did not increase.`,
    };
  }
  return { back: true, notice: `✅ Paid *${fmt(result.paid)}* coins\nRemaining balance: *${fmt(result.remaining)}*` };
}

// ── Screens ──────────────────────────────────────────────────────────────────

/** Hub — one screen whose content and buttons follow the member's loan state. */
const loanHub: Screen = {
  async view(ctx) {
    const [access, wallet, sav] = await Promise.all([getLoanAccess(ctx.userId), getWallet(ctx.userId), getAvailableSavings(ctx.userId)]);
    const profile = { label: '📊 Credit profile', value: 'profile', description: 'What sets your limit' };
    const history = { label: '📜 Loan history', value: 'history' };
    const info = { label: 'ℹ️ How loans work', value: 'info' };

    if (access.loan) {
      const l = access.loan;
      return {
        title: '💳 LOANS',
        subtitle: l.status === 'defaulted' ? undefined : `Active — ${dueShort(l)}`,
        text: l.status === 'defaulted' ? defaultedLoanCard(l, wallet.coins, sav.hold) : activeLoanCard(l, wallet.coins, sav.hold),
        options: [
          { label: '💵 Make a payment', value: 'pay', description: 'Pick an amount to pay down' },
          { label: '✅ Pay in full', value: 'payfull', description: `Clears ${fmt(l.balance)} owed` },
          profile, history, info,
        ],
      };
    }
    if (access.eligibility?.eligible) {
      const e = access.eligibility;
      return {
        title: '💳 LOANS',
        subtitle: `${e.grade.name} credit · up to ${fmt(e.maxAmount)} coins`,
        text: eligibleCard(e, wallet.coins),
        options: [
          { label: '💳 Apply for a loan', value: 'apply', description: `Up to ${fmt(e.maxAmount)} coins` },
          profile, history, info,
        ],
      };
    }
    // Defensive: state changed since the home screen was drawn.
    return { title: '💳 LOANS', text: notEligibleCard(access.eligibility), options: [profile, history, info] };
  },
  async select(value, ctx) {
    switch (value) {
      case 'apply':   return { go: 'loanApply' };
      case 'pay':     return { go: 'loanRepay' };
      case 'profile': return { go: 'loanProfile' };
      case 'history': return { go: 'loanHistory' };
      case 'info':    return { go: 'loanInfo' };
      case 'payfull': return repayNav(await repayLoan(ctx.userId, 'all'));
    }
    return { stay: true };
  },
};

const loanApply: Screen = {
  async view(ctx) {
    const e = await checkEligibility(ctx.userId).catch(() => null);
    if (!e?.eligible) {
      return { title: '💳 APPLY', text: `❌ You're not eligible for a loan right now.`, options: [] };
    }
    const max = e.maxAmount;
    const presets = Array.from(new Set(
      [0.25, 0.5, 0.75, 1].map(f => Math.round(max * f)).filter(n => n >= MIN_LOAN_AMOUNT)
    )).sort((a, b) => a - b);
    const options = presets.map(a => ({
      label: `${fmt(a)} coins`, value: String(a),
      description: a === max ? 'Full limit' : undefined,
    }));
    if (max > MIN_LOAN_AMOUNT) options.push({ label: '✍️ Custom amount', value: 'custom' });
    return {
      title: '💳 APPLY',
      subtitle: `Eligible for up to ${fmt(max)} coins`,
      text: 'How much would you like to borrow?',
      options,
    };
  },
  async select(value, ctx) {
    let amount: number | 'all' | null;
    if (value === 'custom') {
      amount = await askAmount(ctx, { prompt: `✍️ *How much do you want to borrow?*\n_Minimum ${fmt(MIN_LOAN_AMOUNT)} coins_` });
      if (amount === null) return { stay: true };
    } else {
      amount = parseInt(value, 10);
    }
    const e = await checkEligibility(ctx.userId);
    if (!e.eligible) return { go: 'home', reset: true, notice: `❌ You're not eligible for a loan right now.` };
    if (amount < MIN_LOAN_AMOUNT) return { stay: true, notice: `❌ Minimum loan amount is ${fmt(MIN_LOAN_AMOUNT)} coins.` };
    if (amount > e.maxAmount) return { stay: true, notice: `❌ That's above your limit — max is ${fmt(e.maxAmount)} coins.` };
    return { go: 'loanConfirm', params: { amount } };
  },
};

/** Interest is charged upfront and defaults are costly, so a loan is never one tap from the amount. */
const loanConfirm: Screen = {
  async view(ctx, params) {
    const amount = params.amount;
    const e = await checkEligibility(ctx.userId).catch(() => null);
    const interest = Math.round(amount * INTEREST_RATE);
    const termDays = (e?.grade?.termWeeks || 1) * 7;
    return {
      title: '💳 CONFIRM LOAN',
      text: [
        `*Loan Amount:* ${fmt(amount)} coins`,
        `*Interest:* ${fmt(interest)} coins`,
        `*Total Repayment:* ${fmt(amount + interest)} coins`,
        `⏳ Due in ${termDays} days.`,
        ``,
        `⚠️ If it isn't repaid before due date: +${pct(DEFAULT_INTEREST_RATE)} is added daily, ${pct(GARNISHMENT_RATE)} of your earnings will go towards outstanding debt, and you lose future loan eligibility..`,
        `🔐 Savings equal to what you owe are held as security until it's repaid.`,
      ].join('\n'),
      options: [{ label: '✅ Confirm loan', value: 'confirm' }],
    };
  },
  async select(value, ctx, params) {
    if (value !== 'confirm') return { stay: true };
    const result = await applyForLoan(ctx.userId, params.amount);

    if (result.success) {
      const l = result.loan;
      return {
        go: 'home', reset: true,
        notice: `✅ *LOAN APPROVED*\n*${fmt(l.principal)} coins* are in your wallet.\nYou owe *${fmt(l.balance)}* · ${dueLabel(l)}`,
      };
    }
    if (result.reason === 'ineligible') return { go: 'home', reset: true, notice: `❌ You're not eligible for a loan right now.` };

    const messages: Record<string, string> = {
      below_minimum: `❌ Minimum loan amount is ${fmt(MIN_LOAN_AMOUNT)} coins.`,
      exceeds_limit: `❌ That's above your current limit — max is ${fmt(result.maxAmount ?? 0)} coins.`,
      bank_capacity: `❌ The bank can't cover that right now — max available: ${fmt(result.maxAvailable ?? 0)} coins. Try a smaller amount, or check back later.`,
    };
    return { back: true, notice: messages[result.reason] || `❌ Couldn't process that loan.` };
  },
};

const loanRepay: Screen = {
  async view(ctx) {
    const [loan, wallet, sav] = await Promise.all([getRepayableLoan(ctx.userId).catch(() => null), getWallet(ctx.userId), getAvailableSavings(ctx.userId)]);
    if (!loan) return { title: '💳 REPAY', text: `You don't have an outstanding loan.`, options: [] };
    const presets = Array.from(new Set(
      [0.25, 0.5, 0.75, 1].map(f => Math.round(loan.balance * f)).filter(n => n > 0)
    )).sort((a, b) => a - b);
    const options: any[] = presets.map(a => ({
      label: `${fmt(a)} coins`, value: String(a),
      description: a >= loan.balance ? 'Clears the loan' : undefined,
    }));
    if (sav.balance > 0) {
      options.push({
        label: '🏦 Pay from savings', value: 'fromsavings',
        description: `Uses up to ${fmt(Math.min(Math.ceil(loan.balance), sav.balance))} of your savings`,
      });
    }
    options.push({ label: '✍️ Custom amount', value: 'custom' });
    return {
      title: '💳 REPAY',
      subtitle: `Owe ${fmt(loan.balance)} · Wallet ${fmt(wallet.coins)}`,
      text: 'How much would you like to pay?',
      options,
    };
  },
  async select(value, ctx) {
    if (value === 'fromsavings') return repayNav(await payLoanFromSavings(ctx.userId, 'all'));
    let amount: number | 'all' | null;
    if (value === 'custom') {
      amount = await askAmount(ctx, { prompt: `✍️ *How much do you want to pay?*`, allowAll: true });
      if (amount === null) return { stay: true };
    } else {
      amount = parseInt(value, 10);
    }
    return repayNav(await repayLoan(ctx.userId, amount));
  },
};

/** The factors behind the limit, laid out the way a bank app shows a credit file. */
const loanProfile: Screen = {
  async view(ctx) {
    const p = await getCreditProfile(ctx.userId);
    const a = p.assessment;
    const s = p.signals;
    const first = CREDIT_CONFIG.GRADES[0];
    const actGate = a.gates.find(g => g.key === 'activity');

    const lines = [
      a.grade
        ? `*Credit Grade:* ${a.grade.name}${a.nextGrade ? `  \n  *Next Tier:* *${a.nextGrade.name}* at score ${a.nextGrade.minScore}` : '  _(top grade)_'}`
        : `Grade: _none yet_ — ${first.name} starts at score ${first.minScore}`,
      `📊 *Credit Score:* ${a.score}/100  (🎮 ${a.pillars.play.points} · 🏦 ${a.pillars.banking.points})`,
      `Progress  ${bar(a.progress * 100)}  ${a.score}${a.nextGrade ? ` / ${a.nextGrade.minScore}` : ''}`,
      `📈*Activity Overview*`,
      `🎰 Games: ${fmt(s.bySource.games)} coins`,
      `⚽ Sportybet: ${fmt(s.bySource.sportybet)} coins`,
      `🏦 *Banking Overview*`,
      `💰 Average savings: ${fmt(s.avgBalance)} coins`,
      `📅 Saved on ${s.saveDays} days · 🔒 Locked: ${fmt(s.lockedNow)} coins`,
      `📆 Active days:  *${s.activityDays}* ${actGate?.met ? '✅' : `❌ _(need ${CREDIT_CONFIG.MIN_ACTIVITY_DAYS})_`}`,
      p.repaidStreak > 0
        ? `💳 *Repayment History* \nOn-Time Repayments: ${p.repaidStreak} \nPotential Credit Limit Increase (+${Math.min(100, p.repaidStreak * 15)}%)`
        : `Repayment record: no on-time streak yet`,
      p.maxAmount ? `Your limit: *${fmt(p.maxAmount)}* coins` : `Your limit: _not yet_`,
    ];
    return { title: '📊 CREDIT PROFILE', subtitle: `Assesment Period: Last ${CREDIT_CONFIG.WINDOW_DAYS} days`, text: lines.join('\n'), options: [] };
  },
  async select() { return { back: true }; },
};

const loanHistory: Screen = {
  async view(ctx) {
    const history = await getLoanHistory(ctx.userId);
    const icons: Record<string, string> = { active: '💳', repaid: '✅', defaulted: '⚠️', recovered: '🔓', forgiven: '🕊️' };
    const lines = history.length === 0
      ? '_No loan history yet._'
      : history.slice(0, 10).map(l => {
          const date = new Date(l.issuedAt).toLocaleDateString('en-GB', { timeZone: config.timeZone || 'Africa/Lagos', day: '2-digit', month: 'short' });
          return `${icons[l.status] || '•'} ${date} — ${l.tier}, borrowed ${fmt(l.principal)}, *${l.status}*`;
        }).join('\n');
    return { title: '📜 LOAN HISTORY', subtitle: 'Most recent first', text: lines, options: [] };
  },
  async select() { return { back: true }; },
};

const loanInfo: Screen = {
  async view() { return { title: 'ℹ️ HOW LOANS WORK', text: infoText(), options: [] }; },
  async select() { return { back: true }; },
};

export const LOAN_SCREENS = { loan: loanHub, loanApply, loanConfirm, loanRepay, loanProfile, loanHistory, loanInfo };
