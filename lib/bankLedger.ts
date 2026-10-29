// @ts-nocheck
/***
 * lib/bankLedger.ts
 *
 * Customer savings accounts for the community bank. Pure money logic — no
 * WhatsApp / sock code — so every screen, command and scheduled job goes
 * through the same safe paths.
 *
 * ── Money model ──────────────────────────────────────────────────────────
 * Wallet coins live in lib/economy.ts. Savings live HERE, in their own store,
 * completely separate from the jackpot pool (the house bankroll). Deposits are
 * the bank's LIABILITY, not capital: slots/coinflip/dice can never pay out of
 * depositors' money. Later features (interest, locks) are paid from the
 * reserve's surplus above JACKPOT_SEED, never from deposits.
 *
 * ── Collateral hold ─────────────────────────────────────────────────────
 * While a member has a loan (active OR in default), savings up to the amount
 * they owe are HELD as security: they can't be withdrawn or locked away, only
 * used to repay (see payLoanFromSavings in lib/bankLoans.ts) or seized by the
 * default setoff sweep. This is what makes saving-based credit safe — a loan
 * can never be walked away from while the savings that earned it are still here.
 *
 * ── Why the journal ──────────────────────────────────────────────────────
 * A deposit or withdrawal moves coins between TWO records (wallet <-> account)
 * that no store transaction can cover. Each move is: write intent -> debit the
 * source -> mark 'debited' -> credit the destination -> clear intent. A crash
 * or failure after 'debited' is always rolled FORWARD (recoverPending), so
 * coins can't vanish. A crash before 'debited' is ambiguous and is flagged
 * 'needs_review' instead of guessed at.
 *
 * ── Store caveat this file works around ──────────────────────────────────
 * pluginStore.set() swallows adapter errors (logs, never throws). Every
 * account write therefore bumps `rev` and is read back; a mismatch throws, so
 * a silently-failed write can't be reported to the player as a success.
 */
import { createStore } from './pluginStore.js';
import { addCoins, deductCoins } from './economy.js';
import { withUserLock } from './bankLock.js';
import { getRepayableLoan } from './loans.js';
import { noteBalance } from './bankActivity.js';

const root = createStore('bank');
const accountsTbl = root.table('accounts'); // userId -> Account
const journalTbl = root.table('journal');   // journalId -> JournalEntry (only UNFINISHED moves live here)

export const BANK_CONFIG = {
  MIN_TXN: 10,                        // smallest deposit/withdrawal (a full-balance withdrawal may be smaller)
  MAX_SAVINGS: 250_000,               // per-account safety cap; tune once interest exists
  HISTORY_CAP: 60,                    // statement lines kept inside the account record
  RECOVERY_MIN_AGE_MS: 2 * 60_000,    // don't touch a move that might still be in flight
  RECOVERY_STUCK_AFTER_MS: 10 * 60_000,
  RECOVERY_MAX_ATTEMPTS: 5,
};

// ── Types ────────────────────────────────────────────────────────────────────

export type EntryKind = 'deposit' | 'withdraw' | 'interest' | 'lock' | 'unlock' | 'adjust';

export interface BankEntry {
  id: string;
  ts: number;
  kind: EntryKind;
  amount: number;        // signed from the account's point of view: + in, - out
  balanceAfter: number;
  note: string | null;
  ref?: string | null;   // idempotency key (e.g. a lock id): the same ref is never credited twice
}

export interface Account {
  balance: number;
  openedAt: number;
  rev: number;           // bumped on every successful write; used to verify the write landed
  lifetimeDeposited: number;
  lifetimeWithdrawn: number;
  history: BankEntry[];  // newest first, capped — lives inside the record so balance + statement change atomically
}

interface JournalEntry {
  id: string;
  kind: 'deposit' | 'withdraw';
  userId: string;
  amount: number;
  stage: 'started' | 'debited' | 'recovering' | 'needs_review';
  createdAt: number;
  updatedAt: number;
  attempts: number;
}

export type MoveFailure =
  | 'below_minimum' | 'insufficient_funds' | 'insufficient_savings'
  | 'over_cap' | 'empty' | 'held' | 'move_failed';

export type MoveResult =
  | { ok: true; account: Account; entry: BankEntry }
  | { ok: false; reason: MoveFailure; min?: number; room?: number; held?: number; available?: number };

// ── Account helpers ──────────────────────────────────────────────────────────

const rand = () => Math.random().toString(36).slice(2, 8);
const userLockKey = (userId: string) => `bank:${userId}`;
/** The per-member lock every balance-changing operation (here and in lib/bankLocks.ts) runs under. */
export const bankLockKey = userLockKey;

function emptyAccount(): Account {
  return { balance: 0, openedAt: Date.now(), rev: 0, lifetimeDeposited: 0, lifetimeWithdrawn: 0, history: [] };
}

function normalize(raw: any): Account {
  if (!raw || typeof raw !== 'object') return emptyAccount();
  return { ...emptyAccount(), ...raw, history: Array.isArray(raw.history) ? raw.history : [] };
}

export async function getAccount(userId: string): Promise<Account> {
  return normalize(await accountsTbl.get(userId));
}

export async function getStatement(userId: string, limit = 10): Promise<BankEntry[]> {
  const acc = await getAccount(userId);
  return acc.history.slice(0, Math.max(1, Math.min(limit, BANK_CONFIG.HISTORY_CAP)));
}

/** Sums every savings balance — computed, not a stored counter, so it can never drift. Admin/solvency use. */
export async function getBankTotals(): Promise<{ accounts: number; totalDeposits: number }> {
  const all = (await accountsTbl.getAll()) || {};
  let totalDeposits = 0;
  let accounts = 0;
  for (const raw of Object.values(all)) {
    const acc = normalize(raw);
    if (acc.balance > 0) { accounts++; totalDeposits += acc.balance; }
  }
  return { accounts, totalDeposits };
}

/**
 * Single choke point for changing an account. `step` mutates the (already
 * normalized) account and returns {ok:true,...} — or {ok:false,...} WITHOUT
 * touching it. Runs inside the store's own per-record lock, then reads the
 * record back to confirm the write landed.
 */
async function mutateAccount(userId: string, step: (acc: Account) => any): Promise<any> {
  let outcome: any;
  const saved = await accountsTbl.mutate(userId, (current: any) => {
    const acc = normalize(current);
    outcome = step(acc);
    if (outcome.ok) acc.rev += 1;
    return acc;
  });
  const account = normalize(saved);

  if (outcome.ok) {
    const check = await accountsTbl.get(userId);
    if (!check || check.rev !== account.rev) throw new Error('bank_store_write_failed');
  }
  return { ...outcome, account };
}

function pushEntry(acc: Account, kind: EntryKind, signedAmount: number, note?: string, ref?: string | null): BankEntry {
  const entry: BankEntry = {
    id: `b_${Date.now()}_${rand()}`,
    ts: Date.now(),
    kind,
    amount: signedAmount,
    balanceAfter: acc.balance,
    note: note || null,
    ref: ref || null,
  };
  acc.history.unshift(entry);
  if (acc.history.length > BANK_CONFIG.HISTORY_CAP) acc.history.length = BANK_CONFIG.HISTORY_CAP;
  return entry;
}

// NOTE: creditAccount/debitAccount do NOT take the user lock — callers do.
async function creditAccount(userId: string, amount: number, kind: EntryKind, note?: string, enforceCap = true, ref: string | null = null): Promise<any> {
  return mutateAccount(userId, (acc) => {
    // Idempotent when a ref is given: re-running a settlement can never credit it twice.
    if (ref) {
      const dup = acc.history.find(h => h.ref === ref);
      if (dup) return { ok: true, entry: dup, duplicate: true };
    }
    if (enforceCap && acc.balance + amount > BANK_CONFIG.MAX_SAVINGS) {
      return { ok: false, reason: 'over_cap', room: Math.max(0, BANK_CONFIG.MAX_SAVINGS - acc.balance) };
    }
    acc.balance += amount;
    if (kind === 'deposit') acc.lifetimeDeposited += amount;
    return { ok: true, entry: pushEntry(acc, kind, +amount, note, ref) };
  });
}

async function debitAccount(userId: string, amount: number, kind: EntryKind, note?: string, ref: string | null = null): Promise<any> {
  return mutateAccount(userId, (acc) => {
    if (acc.balance < amount) return { ok: false, reason: 'insufficient_savings' };
    acc.balance -= amount;
    if (kind === 'withdraw') acc.lifetimeWithdrawn += amount;
    return { ok: true, entry: pushEntry(acc, kind, -amount, note, ref) };
  });
}

// For lib/bankLocks.ts. Neither takes the member lock — the caller holds bankLockKey(userId).
export const ledgerCredit = creditAccount;
export const ledgerDebit = debitAccount;

// ── Collateral hold ──────────────────────────────────────────────────────────

async function getHold(userId: string): Promise<number> {
  try {
    const loan = await getRepayableLoan(userId);
    return loan ? Math.max(0, Math.ceil(loan.balance)) : 0;
  } catch (_) { return 0; }
}

/** Savings split into what is held as loan security and what can actually be moved. */
export async function getAvailableSavings(userId: string): Promise<{ balance: number; hold: number; available: number }> {
  const [acc, hold] = await Promise.all([getAccount(userId), getHold(userId)]);
  return { balance: acc.balance, hold: Math.min(hold, acc.balance), available: Math.max(0, acc.balance - hold) };
}

/** Every account's balance — for the activity sync sweep and admin views. */
export async function listAccountBalances(): Promise<Array<{ userId: string; balance: number }>> {
  const all = (await accountsTbl.getAll()) || {};
  return Object.entries(all).map(([userId, raw]) => ({ userId, balance: normalize(raw).balance }));
}

// ── Journal ──────────────────────────────────────────────────────────────────

async function jStart(kind: JournalEntry['kind'], userId: string, amount: number): Promise<string> {
  const id = `j_${Date.now()}_${rand()}`;
  const now = Date.now();
  await journalTbl.set(id, { id, kind, userId, amount, stage: 'started', createdAt: now, updatedAt: now, attempts: 0 } as JournalEntry);
  return id;
}
const jStage = (id: string, stage: JournalEntry['stage']) => journalTbl.patch(id, { stage, updatedAt: Date.now() });
const jEnd = (id: string) => journalTbl.del(id);

// ── Deposit: wallet -> savings ───────────────────────────────────────────────

export async function deposit(userId: string, rawAmount: number): Promise<MoveResult> {
  const amount = Math.floor(Number(rawAmount));
  if (!Number.isFinite(amount) || amount < BANK_CONFIG.MIN_TXN) {
    return { ok: false, reason: 'below_minimum', min: BANK_CONFIG.MIN_TXN };
  }

  return withUserLock(userLockKey(userId), async () => {
    const pre = await getAccount(userId);
    if (pre.balance + amount > BANK_CONFIG.MAX_SAVINGS) {
      return { ok: false, reason: 'over_cap', room: Math.max(0, BANK_CONFIG.MAX_SAVINGS - pre.balance) };
    }

    const jid = await jStart('deposit', userId, amount);

    // Step 1 — take the coins out of the wallet (atomic inside economy.ts).
    let spend: any;
    try {
      spend = await deductCoins(userId, amount, { type: 'bank_deposit', note: 'savings deposit' });
    } catch (err: any) {
      // Ambiguous: we can't tell whether the wallet was touched. Leave the journal at 'started'
      // so recoverPending() flags it for review instead of guessing.
      console.error(`[bank] wallet debit threw during deposit (user=${userId} amount=${amount}):`, err?.message || err);
      return { ok: false, reason: 'move_failed' };
    }
    if (!spend.success) { await jEnd(jid); return { ok: false, reason: 'insufficient_funds' }; }
    await jStage(jid, 'debited');

    // Step 2 — land them in the account.
    try {
      const res = await creditAccount(userId, amount, 'deposit', 'Deposit from wallet');
      if (!res.ok) throw new Error(res.reason);
      await jEnd(jid);
      await noteBalance(userId, { savings: res.account.balance }, 'save').catch(() => {});  // credit-file activity, best effort
      return { ok: true, account: res.account, entry: res.entry };
    } catch (err: any) {
      console.error(`[bank] deposit credit failed after wallet debit (user=${userId} amount=${amount}):`, err?.message || err);
      try {
        await addCoins(userId, amount, { type: 'bank_refund', note: 'auto-refund: deposit failed' });
        await jEnd(jid);
      } catch (refundErr: any) {
        // Journal stays 'debited' -> recoverPending() will complete the deposit instead.
        console.error(`[bank] CRITICAL: deposit refund ALSO failed (user=${userId} amount=${amount}) — journal ${jid} will roll the deposit forward:`, refundErr?.message || refundErr);
      }
      return { ok: false, reason: 'move_failed' };
    }
  });
}

// ── Withdraw: savings -> wallet ──────────────────────────────────────────────

export async function withdraw(
  userId: string,
  rawAmount: number | 'all',
  opts: { bypassHold?: boolean; note?: string } = {}   // bypassHold: ONLY for repaying that member's own loan (setoff / pay-from-savings)
): Promise<MoveResult> {
  return withUserLock(userLockKey(userId), async () => {
    const acc = await getAccount(userId);
    const hold = opts.bypassHold ? 0 : await getHold(userId);
    const available = Math.max(0, acc.balance - hold);
    const amount = rawAmount === 'all' ? available : Math.floor(Number(rawAmount));
    const heldNow = Math.min(hold, acc.balance);

    if (!Number.isFinite(amount) || amount <= 0) {
      if (rawAmount === 'all') {
        return acc.balance > 0 && available === 0
          ? { ok: false, reason: 'held', held: heldNow, available: 0 }
          : { ok: false, reason: 'empty', min: BANK_CONFIG.MIN_TXN };
      }
      return { ok: false, reason: 'below_minimum', min: BANK_CONFIG.MIN_TXN };
    }
    if (amount > available && amount <= acc.balance) {
      return { ok: false, reason: 'held', held: heldNow, available };
    }
    // The minimum doesn't trap dust: withdrawing your ENTIRE available balance is always allowed.
    if (amount < BANK_CONFIG.MIN_TXN && amount !== available) {
      return { ok: false, reason: 'below_minimum', min: BANK_CONFIG.MIN_TXN };
    }

    const jid = await jStart('withdraw', userId, amount);

    // Step 1 — take the coins out of the account.
    let debit: any;
    try {
      debit = await debitAccount(userId, amount, 'withdraw', opts.note || 'Withdrawal to wallet');
    } catch (err: any) {
      // mutateAccount only throws when the read-back shows the write did NOT land, so nothing moved.
      console.error(`[bank] account debit did not persist during withdraw (user=${userId} amount=${amount}):`, err?.message || err);
      await jEnd(jid);
      return { ok: false, reason: 'move_failed' };
    }
    if (!debit.ok) { await jEnd(jid); return { ok: false, reason: debit.reason }; }
    await jStage(jid, 'debited');

    // Step 2 — hand them to the wallet. 'bank_withdraw' must be garnishment-exempt (see PATCHES.md).
    try {
      await addCoins(userId, amount, { type: 'bank_withdraw', note: 'savings withdrawal' });
      await jEnd(jid);
      await noteBalance(userId, { savings: debit.account.balance }, 'move').catch(() => {});
      return { ok: true, account: debit.account, entry: debit.entry };
    } catch (err: any) {
      console.error(`[bank] withdraw wallet credit failed after account debit (user=${userId} amount=${amount}):`, err?.message || err);
      try {
        await creditAccount(userId, amount, 'adjust', 'Auto-refund: withdrawal failed', false);
        await jEnd(jid);
      } catch (refundErr: any) {
        console.error(`[bank] CRITICAL: withdraw refund ALSO failed (user=${userId} amount=${amount}) — journal ${jid} will roll the withdrawal forward:`, refundErr?.message || refundErr);
      }
      return { ok: false, reason: 'move_failed' };
    }
  });
}

// ── Crash recovery ───────────────────────────────────────────────────────────

export interface RecoveryReport { recovered: number; retriable: number; needsReview: number }

/**
 * Rolls forward any move that already debited its source but never finished.
 * Safe to call on a schedule: moves younger than RECOVERY_MIN_AGE_MS are left
 * alone, and each is claimed with a compare-and-set so it's applied once.
 */
export async function recoverPending(now = Date.now()): Promise<RecoveryReport> {
  const report: RecoveryReport = { recovered: 0, retriable: 0, needsReview: 0 };
  const all = (await journalTbl.getAll()) || {};

  for (const [id, raw] of Object.entries(all)) {
    const j = raw as JournalEntry | null;
    if (!j) { await journalTbl.del(id); continue; } // junk row left by a lost race
    const age = now - (j.updatedAt || j.createdAt || 0);

    if (j.stage === 'needs_review') { report.needsReview++; continue; }

    // Crashed before/while debiting the source: we can't know which side it died on. Flag, don't guess.
    if (j.stage === 'started' || (j.stage === 'recovering' && age > BANK_CONFIG.RECOVERY_STUCK_AFTER_MS)) {
      if (age > BANK_CONFIG.RECOVERY_STUCK_AFTER_MS) {
        await jStage(id, 'needs_review');
        console.error(`[bank] journal ${id} (${j.kind} ${j.amount} for ${j.userId}) stuck at '${j.stage}' — needs manual review`);
        report.needsReview++;
      }
      continue;
    }

    if (j.stage !== 'debited' || age < BANK_CONFIG.RECOVERY_MIN_AGE_MS) continue;

    // Claim it (compare-and-set) so two sweeps can't both apply it.
    let claimed = false;
    await journalTbl.mutate(id, (cur: any) => {
      if (cur && cur.stage === 'debited') {
        claimed = true;
        return { ...cur, stage: 'recovering', attempts: (cur.attempts || 0) + 1, updatedAt: now };
      }
      return cur;
    });
    if (!claimed) continue;

    try {
      await withUserLock(userLockKey(j.userId), async () => {
        if (j.kind === 'deposit') {
          const res = await creditAccount(j.userId, j.amount, 'deposit', 'Deposit completed (recovered)', false);
          if (!res.ok) throw new Error(res.reason);
        } else {
          await addCoins(j.userId, j.amount, { type: 'bank_withdraw', note: 'savings withdrawal (recovered)' });
        }
      });
      await jEnd(id);
      report.recovered++;
      console.warn(`[bank] recovered ${j.kind} of ${j.amount} for ${j.userId} (journal ${id})`);
    } catch (err: any) {
      const giveUp = (j.attempts || 0) + 1 >= BANK_CONFIG.RECOVERY_MAX_ATTEMPTS;
      await jStage(id, giveUp ? 'needs_review' : 'debited');
      console.error(`[bank] recovery of journal ${id} failed (${giveUp ? 'giving up' : 'will retry'}):`, err?.message || err);
      giveUp ? report.needsReview++ : report.retriable++;
    }
  }
  return report;
}

/** Unfinished moves, for an admin view. Empty in a healthy bank. */
export async function getUnfinishedMoves(): Promise<JournalEntry[]> {
  return Object.values((await journalTbl.getAll()) || {}).filter(Boolean) as JournalEntry[];
}
