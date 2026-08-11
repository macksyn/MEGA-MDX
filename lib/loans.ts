// @ts-nocheck
/***
 * lib/loans.ts
 *
 * Loan engine backing !loan. Loans are disbursed FROM and repaid TO the same
 * jackpot bank that backs !slots/!coinflip/!dice (see lib/slotMachine.ts) —
 * NOT minted, NOT a separate isolated pool. Disbursement is a bank payout
 * capped by solvency exactly like the attendance bonus (settleWin); repayment
 * flows back in via contributeToJackpot(), the same path a losing bet takes.
 * Neither disbursement nor repayment calls recordHouseActivity() — that
 * feeds !reserve's daily bet/won stats, which are specifically about
 * wagering activity, and mixing loan cashflow in would make "today's
 * wagered/paid" misleading. Loans get their own stats via getLoanBookStats().
 *
 * ── Eligibility: patronage + peak balance, not just tenure ──────────────
 * Account age alone rewards anyone who's been in the group a while,
 * including the large share of members who only ever collect the daily
 * attendance bonus and never actually engage with the coin economy. Two
 * signals fix that:
 *
 *   - Patronage = getPlayerProfile(userId).totalBet — lifetime coins
 *     WAGERED across slots/coinflip/dice, already tracked in slotMachine.ts.
 *     Attendance-only members sit at 0 forever, so this alone screens them
 *     out without needing new tracking.
 *   - Peak balance = the highest wallet.coins a member has ever actually
 *     held (see peakCoins on the Wallet — needs a small economy.ts patch,
 *     see notes shipped alongside this file). Signals real financial
 *     footing, not just a lucky moment-in-time balance.
 *
 * Both are required alongside account age and an unbroken repayment streak
 * — see LOAN_TIERS below.
 *
 * ── Capacity grows gradually, not just at tier boundaries ───────────────
 * Each consecutive fully-repaid loan (no default since) adds +15% onto the
 * tier's base max, capped at 2x. The streak resets to zero the moment a
 * loan defaults.
 *
 * ── Default: garnishment, not a permanent block ──────────────────────────
 * A defaulted loan isn't written off — GARNISHMENT_RATE of every future
 * attendance/work/game-win credit is automatically diverted to pay it down
 * (via a hook registered into lib/economy.ts; peer-to-peer transfers are
 * explicitly excluded, see garnishIncomingCredit below). New loans are
 * blocked only while a defaulted balance is still being actively recovered.
 *
 * Once garnishment fully clears it, the loan is marked 'recovered' — access
 * returns, BUT defaulting (whether later recovered or not) permanently caps
 * future eligibility at the Starter tier, the same way a real default dings
 * a credit score rather than disappearing once the balance is paid (see
 * checkEligibility's hasDinged check).
 *
 * Admin forgiveness ('forgiven') is deliberately stronger than natural
 * recovery: it stops garnishment immediately AND does not count toward the
 * Starter-tier cap, since it's a genuine clean-slate pardon rather than the
 * bank just getting its money back the hard way.
 *
 * ── Interest is capped, not indefinite ───────────────────────────────────
 * Interest compounds weekly on the outstanding balance, but accrual is
 * capped at (dueAt + GRACE_PERIOD_MS) — the moment a loan would default.
 * Without this cap, a loan nobody checks in on would keep silently
 * compounding between reads indefinitely, so someone who forgets about it
 * for two months could come back to a wildly inflated balance they never
 * had a chance to see grow or pay down in time. Capping it bounds the
 * worst case to what they'd have seen if they'd checked right at the
 * deadline.
 */
import { createStore } from './pluginStore.js';
import { getWallet, addCoins, deductCoins, registerGarnishmentHandler, type TransactionMeta } from './economy.js';
import { getJackpotPool, deductFromJackpot, contributeToJackpot, settleWin, getPlayerProfile } from './slotMachine.js';

const root = createStore('loans');
const loansTbl = root.table('loans'); // userId -> Loan[] (full history, most recent first)

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
export const INTEREST_RATE = 0.20; // 20% weekly, compounding
export const GRACE_PERIOD_MS = 1 * DAY_MS; // grace window past due before default
export const DUE_SOON_WINDOW_MS = DAY_MS; // reminder fires when a loan is within this window of dueAt
export const GARNISHMENT_RATE = 0.50; // share of each future earning diverted to a defaulted balance
export const MIN_LOAN_AMOUNT = 100;

const REPAID_BONUS_PER_LOAN = 0.15;    // +15% capacity per consecutive fully-repaid loan
const MAX_REPAID_BONUS_MULTIPLIER = 2.0; // capacity growth caps at 2x tier base

// ── Tiers ────────────────────────────────────────────────────────────────────

export interface LoanTier {
  name: string;
  minAccountAgeMs: number;
  minPatronage: number;      // lifetime coins wagered (getPlayerProfile().totalBet)
  minPeakBalance: number;    // highest coins balance ever held
  minRepaidStreak: number;   // consecutive fully-repaid loans since last default
  baseMaxAmount: number;
  termWeeks: number;
}

export const LOAN_TIERS: LoanTier[] = [
  { name: 'Starter',     minAccountAgeMs: 3  * DAY_MS, minPatronage: 100,   minPeakBalance: 150,   minRepaidStreak: 0, baseMaxAmount: 100,  termWeeks: 1 },
  { name: 'Established', minAccountAgeMs: 7  * DAY_MS, minPatronage: 1000,  minPeakBalance: 800,   minRepaidStreak: 1, baseMaxAmount: 300, termWeeks: 2 },
  { name: 'Trusted',     minAccountAgeMs: 14 * DAY_MS, minPatronage: 5000,  minPeakBalance: 3000,  minRepaidStreak: 3, baseMaxAmount: 5000, termWeeks: 2 },
  { name: 'Elite',       minAccountAgeMs: 30 * DAY_MS, minPatronage: 20000, minPeakBalance: 10000, minRepaidStreak: 6, baseMaxAmount: 1000, termWeeks: 3 },
];

// ── Types ────────────────────────────────────────────────────────────────────

export type LoanStatus = 'active' | 'repaid' | 'defaulted' | 'recovered' | 'forgiven';

export interface Loan {
  id: string;
  userId: string;
  principal: number;
  balance: number;          // current outstanding, incl. compounded interest
  interestRate: number;
  issuedAt: number;
  dueAt: number;
  lastAccrualAt: number;
  status: LoanStatus;
  repaidAt: number | null;
  totalRepaid: number;
  tier: string;
  termWeeks: number;
  remindersSent: string[]; // e.g. ['due_soon', 'grace'] — dedupes the hourly reminder sweep in eco_loan.ts
}

export interface EligibilityResult {
  eligible: boolean;
  reason?: 'active_loan' | 'defaulted_loan' | 'below_minimum_tier';
  tier?: LoanTier;
  maxAmount?: number;        // streak-bonus-adjusted max for this tier
  repaidStreak?: number;
  patronage?: number;
  peakBalance?: number;
  accountAgeMs?: number;
  dinged?: boolean;          // true if a past default (never forgiven) is capping the tier at Starter
  // populated on below_minimum_tier — the lowest tier they're working toward,
  // plus 0-1 progress fractions against each of its requirements for UI bars
  nextTier?: LoanTier;
  progress?: { accountAge: number; patronage: number; peakBalance: number };
}

// ── Repayment streak (drives the gradual-growth bonus) ───────────────────────

function computeRepaidStreak(history: Loan[]): number {
  let streak = 0;
  for (const loan of history) { // most recent first
    if (loan.status === 'repaid') { streak++; continue; }
    if (loan.status === 'active') continue; // shouldn't occur here, but harmless
    break; // defaulted or forgiven breaks the streak
  }
  return streak;
}

// ── Interest accrual (lazy — computed on read, no cron dependency) ──────────

function accrue(loan: Loan): Loan {
  if (loan.status !== 'active') return loan;

  const cutoff = loan.dueAt + GRACE_PERIOD_MS;
  const effectiveNow = Math.min(Date.now(), cutoff);
  const weeksElapsed = Math.floor((effectiveNow - loan.lastAccrualAt) / WEEK_MS);

  if (weeksElapsed > 0) {
    loan.balance = Math.round(loan.balance * Math.pow(1 + loan.interestRate, weeksElapsed));
    loan.lastAccrualAt += weeksElapsed * WEEK_MS;
  }

  if (Date.now() > cutoff && loan.balance > 0) {
    loan.status = 'defaulted';
  }

  return loan;
}

/** Full loan history for a user, with lazy interest accrual applied and persisted. */
export async function getLoanHistory(userId: string): Promise<Loan[]> {
  const list: Loan[] = (await loansTbl.get(userId)) || [];
  let mutated = false;

  const updated = list.map(l => {
    if (l.status !== 'active') return l;
    const before = `${l.balance}:${l.status}:${l.lastAccrualAt}`;
    const accrued = accrue({ ...l });
    if (`${accrued.balance}:${accrued.status}:${accrued.lastAccrualAt}` !== before) mutated = true;
    return accrued;
  });

  if (mutated) await loansTbl.set(userId, updated);
  return updated;
}

export async function getActiveLoan(userId: string): Promise<Loan | null> {
  const list = await getLoanHistory(userId);
  return list.find(l => l.status === 'active') || null;
}

// ── Eligibility ───────────────────────────────────────────────────────────────

export async function checkEligibility(userId: string): Promise<EligibilityResult> {
  const wallet = await getWallet(userId);
  const history = await getLoanHistory(userId);

  if (history.some(l => l.status === 'active')) {
    return { eligible: false, reason: 'active_loan' };
  }
  // Only an UNRECOVERED default blocks borrowing outright — garnishment is
  // actively working on it. Once garnishment (or admin forgiveness) clears
  // it, borrowing opens back up (subject to the tier cap below).
  if (history.some(l => l.status === 'defaulted')) {
    return { eligible: false, reason: 'defaulted_loan' };
  }

  const repaidStreak = computeRepaidStreak(history);
  const accountAgeMs = Date.now() - wallet.createdAt;
  const peakBalance = wallet.peakCoins ?? wallet.coins;
  const profile = await getPlayerProfile(userId);
  const patronage = profile.totalBet;

  // A past default permanently caps eligibility at Starter, even after full
  // garnishment recovery — same as a real credit ding not disappearing just
  // because the balance eventually got paid. Admin forgiveness is excluded
  // on purpose: it's a deliberate clean-slate pardon, not automatic recovery.
  const dinged = history.some(l => l.status === 'defaulted' || l.status === 'recovered');

  let qualifiedTier: LoanTier | null = null;
  for (let i = LOAN_TIERS.length - 1; i >= 0; i--) {
    const t = LOAN_TIERS[i];
    if (dinged && t !== LOAN_TIERS[0]) continue; // capped at Starter
    if (
      accountAgeMs >= t.minAccountAgeMs &&
      patronage >= t.minPatronage &&
      peakBalance >= t.minPeakBalance &&
      repaidStreak >= t.minRepaidStreak
    ) {
      qualifiedTier = t;
      break;
    }
  }

  if (!qualifiedTier) {
    const t = LOAN_TIERS[0];
    return {
      eligible: false,
      reason: 'below_minimum_tier',
      nextTier: t,
      repaidStreak, patronage, peakBalance, accountAgeMs, dinged,
      progress: {
        accountAge: Math.min(1, accountAgeMs / t.minAccountAgeMs),
        patronage: Math.min(1, patronage / t.minPatronage),
        peakBalance: Math.min(1, peakBalance / t.minPeakBalance),
      },
    };
  }

  const bonusMultiplier = Math.min(MAX_REPAID_BONUS_MULTIPLIER, 1 + repaidStreak * REPAID_BONUS_PER_LOAN);
  const maxAmount = Math.round(qualifiedTier.baseMaxAmount * bonusMultiplier);

  return { eligible: true, tier: qualifiedTier, maxAmount, repaidStreak, patronage, peakBalance, accountAgeMs, dinged };
}

// ── Issuance ─────────────────────────────────────────────────────────────────

export type ApplyResult =
  | { success: false; reason: 'below_minimum' }
  | { success: false; reason: 'ineligible'; eligibility: EligibilityResult }
  | { success: false; reason: 'exceeds_tier_max'; maxAmount: number }
  | { success: false; reason: 'bank_capacity'; maxAvailable: number }
  | { success: true; loan: Loan };

export async function applyForLoan(userId: string, requestedAmount: number): Promise<ApplyResult> {
  if (!Number.isFinite(requestedAmount) || requestedAmount < MIN_LOAN_AMOUNT) {
    return { success: false, reason: 'below_minimum' };
  }

  const eligibility = await checkEligibility(userId);
  if (!eligibility.eligible) return { success: false, reason: 'ineligible', eligibility };

  const amount = Math.floor(requestedAmount);
  if (amount > eligibility.maxAmount!) {
    return { success: false, reason: 'exceeds_tier_max', maxAmount: eligibility.maxAmount! };
  }

  // Solvency check — reject rather than silently short-pay. A loan is an
  // explicit ask with explicit interest terms; giving less than requested
  // while still charging interest as if the full amount was disbursed would
  // be a bait-and-switch.
  const pool = await getJackpotPool();
  const { payout: maxAvailable } = settleWin(amount, pool);
  if (maxAvailable < amount) {
    return { success: false, reason: 'bank_capacity', maxAvailable };
  }

  await deductFromJackpot(amount);

  const now = Date.now();
  const loan: Loan = {
    id: `loan_${now}_${Math.random().toString(36).slice(2, 8)}`,
    userId,
    principal: amount,
    balance: amount,
    interestRate: INTEREST_RATE,
    issuedAt: now,
    dueAt: now + eligibility.tier!.termWeeks * WEEK_MS,
    lastAccrualAt: now,
    status: 'active',
    repaidAt: null,
    totalRepaid: 0,
    tier: eligibility.tier!.name,
    termWeeks: eligibility.tier!.termWeeks,
    remindersSent: [],
  };

  const list: Loan[] = (await loansTbl.get(userId)) || [];
  list.unshift(loan);
  await loansTbl.set(userId, list);

  await addCoins(userId, amount, { type: 'loan_disbursement', note: `${loan.tier} tier loan, ${loan.termWeeks}w term` });

  return { success: true, loan };
}

// ── Repayment ────────────────────────────────────────────────────────────────

export type RepayResult =
  | { success: false; reason: 'no_active_loan' }
  | { success: false; reason: 'invalid_amount' }
  | { success: false; reason: 'insufficient_funds'; needed: number }
  | { success: true; loan: Loan; paid: number; remaining: number; fullyRepaid: boolean };

export async function repayLoan(userId: string, amount: number | 'all'): Promise<RepayResult> {
  const loan = await getActiveLoan(userId);
  if (!loan) return { success: false, reason: 'no_active_loan' };

  const requested = amount === 'all' ? loan.balance : Math.floor(amount);
  if (!requested || requested <= 0) return { success: false, reason: 'invalid_amount' };

  const payAmount = Math.min(requested, loan.balance);

  const result = await deductCoins(userId, payAmount, { type: 'loan_repayment', note: `loan ${loan.id}` });
  if (!result.success) return { success: false, reason: 'insufficient_funds', needed: payAmount };

  loan.balance -= payAmount;
  loan.totalRepaid += payAmount;

  const fullyRepaid = loan.balance <= 0;
  if (fullyRepaid) {
    loan.status = 'repaid';
    loan.repaidAt = Date.now();
    loan.balance = 0;
  }

  const list: Loan[] = (await loansTbl.get(userId)) || [];
  const idx = list.findIndex(l => l.id === loan.id);
  if (idx !== -1) list[idx] = loan;
  await loansTbl.set(userId, list);

  // Return the payment to the same bank the principal came from — the same
  // path a losing bet takes.
  await contributeToJackpot(payAmount);

  return { success: true, loan, paid: payAmount, remaining: loan.balance, fullyRepaid };
}

// ── Admin ────────────────────────────────────────────────────────────────────

export interface LoanBookStats {
  activeCount: number;
  activeOutstanding: number;
  totalDisbursed: number;
  totalRepaid: number;
  totalInterestEarned: number;
  defaultedCount: number;       // currently defaulted, garnishment in progress
  defaultedOutstanding: number;
  recoveredCount: number;       // defaults fully clawed back via garnishment
  recoveredViaGarnishment: number;
  forgivenCount: number;
}

/**
 * NOTE: active loan balances here reflect whatever was last persisted —
 * interest only accrues (and gets written back) when a user's own loan is
 * read via getLoanHistory/getActiveLoan. A borrower who hasn't checked !loan
 * in a while may show a slightly stale (lower than true) balance here. This
 * is a display quirk, not a real accounting gap — their actual balance
 * catches up the moment they or an admin next reads it.
 */
export async function getLoanBookStats(): Promise<LoanBookStats> {
  const all = (await loansTbl.getAll()) || {};
  const stats: LoanBookStats = {
    activeCount: 0, activeOutstanding: 0,
    totalDisbursed: 0, totalRepaid: 0, totalInterestEarned: 0,
    defaultedCount: 0, defaultedOutstanding: 0,
    recoveredCount: 0, recoveredViaGarnishment: 0,
    forgivenCount: 0,
  };

  for (const list of Object.values(all) as Loan[][]) {
    for (const loan of list) {
      stats.totalDisbursed += loan.principal;
      stats.totalRepaid += loan.totalRepaid;
      if (loan.status === 'active') {
        stats.activeCount++;
        stats.activeOutstanding += loan.balance;
      } else if (loan.status === 'repaid') {
        stats.totalInterestEarned += Math.max(0, loan.totalRepaid - loan.principal);
      } else if (loan.status === 'defaulted') {
        stats.defaultedCount++;
        stats.defaultedOutstanding += loan.balance;
      } else if (loan.status === 'recovered') {
        stats.recoveredCount++;
        stats.recoveredViaGarnishment += loan.totalRepaid;
      } else if (loan.status === 'forgiven') {
        stats.forgivenCount++;
      }
    }
  }

  return stats;
}

/** All currently-active loans across every borrower, most recently issued first. */
export async function getAllActiveLoans(): Promise<Loan[]> {
  const all = (await loansTbl.getAll()) || {};
  const out: Loan[] = [];
  for (const list of Object.values(all) as Loan[][]) {
    const active = list.find(l => l.status === 'active');
    if (active) out.push(active);
  }
  return out.sort((a, b) => b.issuedAt - a.issuedAt);
}

/** All currently-defaulted loans, for admin review/forgiveness. */
export async function getAllDefaultedLoans(): Promise<Loan[]> {
  const all = (await loansTbl.getAll()) || {};
  const out: Loan[] = [];
  for (const list of Object.values(all) as Loan[][]) {
    out.push(...list.filter(l => l.status === 'defaulted'));
  }
  return out.sort((a, b) => b.dueAt - a.dueAt);
}

/**
 * Clears a defaulted loan so the borrower can access loans again. Marked
 * 'forgiven', not 'repaid' — it does NOT restart the repaid-loan streak
 * future tier/capacity growth requires, since it wasn't actually paid back.
 * Unlike garnishment recovery, forgiveness is also excluded from the
 * Starter-tier ding (see checkEligibility) — a genuine clean-slate pardon,
 * stronger than the bank simply getting its money back the hard way.
 * Balance is zeroed and interest/garnishment stop.
 */
export async function forgiveLoan(userId: string, loanId: string): Promise<{ success: boolean; reason?: string; loan?: Loan }> {
  const list: Loan[] = (await loansTbl.get(userId)) || [];
  const idx = list.findIndex(l => l.id === loanId);
  if (idx === -1) return { success: false, reason: 'not_found' };
  if (list[idx].status !== 'defaulted') return { success: false, reason: 'not_defaulted' };

  list[idx].status = 'forgiven';
  list[idx].repaidAt = Date.now();
  list[idx].balance = 0;
  await loansTbl.set(userId, list);

  return { success: true, loan: list[idx] };
}

// ── Reminders ────────────────────────────────────────────────────────────────
// No dependency on any other plugin's reminder infra. eco_loan.ts registers
// its own hourly sweep via the standard `schedules` export every plugin can
// use (see lib/pluginLoader.ts) and calls getLoansDueForReminder() /
// markReminderSent() below — fully self-contained to this feature.

export interface ReminderBatch {
  dueSoon: Loan[]; // due within DUE_SOON_WINDOW_MS, 'due_soon' reminder not yet sent
  inGrace: Loan[]; // past due, still within grace, 'grace' reminder not yet sent
}

/** Scans every active loan for ones needing a reminder. Doesn't mark anything sent — call markReminderSent after actually delivering the DM. */
export async function getLoansDueForReminder(): Promise<ReminderBatch> {
  const all = (await loansTbl.getAll()) || {};
  const now = Date.now();
  const dueSoon: Loan[] = [];
  const inGrace: Loan[] = [];

  for (const list of Object.values(all) as Loan[][]) {
    for (const loan of list) {
      if (loan.status !== 'active') continue;
      const sent = loan.remindersSent || [];

      const untilDue = loan.dueAt - now;
      if (untilDue > 0 && untilDue <= DUE_SOON_WINDOW_MS && !sent.includes('due_soon')) {
        dueSoon.push(loan);
        continue; // one reminder per sweep per loan is enough
      }

      const graceCutoff = loan.dueAt + GRACE_PERIOD_MS;
      if (now > loan.dueAt && now <= graceCutoff && !sent.includes('grace')) {
        inGrace.push(loan);
      }
    }
  }

  return { dueSoon, inGrace };
}

export async function markReminderSent(userId: string, loanId: string, kind: 'due_soon' | 'grace'): Promise<void> {
  const list: Loan[] = (await loansTbl.get(userId)) || [];
  const idx = list.findIndex(l => l.id === loanId);
  if (idx === -1) return;
  const sent = new Set(list[idx].remindersSent || []);
  sent.add(kind);
  list[idx].remindersSent = Array.from(sent);
  await loansTbl.set(userId, list);
}


// Registered into lib/economy.ts as its garnishment hook (see economy.ts's
// registerGarnishmentHandler for why this is a hook rather than a direct
// import — avoids a circular dependency, since this file already imports
// economy.ts). Intercepts a share of every future attendance/work/game-win
// credit and diverts it to a defaulted balance before it lands in the
// wallet. Peer-to-peer transfers are explicitly exempted — a friend's gift
// shouldn't get clawed toward a stranger's debt.

const GARNISHMENT_EXEMPT_TYPES = new Set(['transfer_in']);

async function garnishIncomingCredit(
  userId: string,
  amount: number,
  meta: TransactionMeta
): Promise<{ garnished: number; remaining: number }> {
  if (amount <= 0 || (meta.type && GARNISHMENT_EXEMPT_TYPES.has(meta.type))) {
    return { garnished: 0, remaining: amount };
  }

  const list: Loan[] = (await loansTbl.get(userId)) || [];
  const idx = list.findIndex(l => l.status === 'defaulted');
  if (idx === -1) return { garnished: 0, remaining: amount };

  const loan = list[idx];
  const garnishAmount = Math.min(loan.balance, Math.ceil(amount * GARNISHMENT_RATE));
  if (garnishAmount <= 0) return { garnished: 0, remaining: amount };

  loan.balance -= garnishAmount;
  loan.totalRepaid += garnishAmount;

  if (loan.balance <= 0) {
    loan.status = 'recovered';
    loan.repaidAt = Date.now();
    loan.balance = 0;
  }

  list[idx] = loan;
  await loansTbl.set(userId, list);

  // Recovered garnishment returns to the bank via the same path any
  // voluntary repayment takes.
  await contributeToJackpot(garnishAmount);

  return { garnished: garnishAmount, remaining: amount - garnishAmount };
}

registerGarnishmentHandler(garnishIncomingCredit);
