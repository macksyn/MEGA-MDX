// @ts-nocheck
/***
 * lib/bankLocks.ts
 *
 * Money Lock — fixed-term savings in the style of PiggyVest Safelock. A member
 * locks coins from their savings for a plan's term; at maturity the principal
 * plus a fixed interest lands back in their savings, automatically. Break a
 * lock early and the interest is forfeited and a small fee is charged.
 *
 * ── How the bank uses locked money ───────────────────────────────────────
 * Locked coins are put to work: the bank may use them to fund loans and to
 * back game payouts. But a bank that lends out every coin can't pay anyone
 * back, so a RESERVE_REQUIREMENT share of all locked principal is always held
 * back, untouchable by games and loans:
 *
 *   usable "deposit capital"  =  (1 − RESERVE_REQUIREMENT) × locked principal
 *   visible pool              =  house pool  +  deposit capital
 *
 * The deposit capital is written into the jackpot store (setDepositCapital)
 * and ALWAYS recomputed from the lock records, never incremented, so a crash
 * can't make it drift. Games and loans keep reading getJackpotPool() and
 * simply see a bigger pool. (Plain savings are NOT lent out — they stay held
 * 1:1, see lib/bankLedger.ts. Only members who choose to lock take part.)
 *
 * Interest is a promise: at maturity it is paid out of the house pool even if
 * that pushes the bank below its floor (payFromReserve). The bank is then
 * "underwater" — the games enter their emergency state, and new locks and new
 * loans are refused until house profits rebuild it. Depositors are never
 * short-paid; the bank carries the loss.
 *
 * ── Crash safety ─────────────────────────────────────────────────────────
 * Creating a lock moves coins savings -> lock record (two records, no shared
 * transaction): a journal entry is written first, and a half-finished lock is
 * rolled forward by recoverLocks(). Settlement and early-break are small state
 * machines (active → settling → credited → matured / active → breaking →
 * broken); the credit step carries the lock id as a ref, so replaying it can
 * never pay twice. The one residual window: a crash between paying interest
 * from the pool and writing the final status would charge the pool twice on
 * replay — a house-side error of one interest amount, never a depositor loss.
 */
import { createStore } from './pluginStore.js';
import { withUserLock } from './bankLock.js';
import { ledgerCredit, ledgerDebit, getAvailableSavings, bankLockKey } from './bankLedger.js';
import { setDepositCapital, getJackpotPool, payFromReserve, contributeToJackpot, JACKPOT_SEED } from './slotMachine.js';
import { noteBalance } from './bankActivity.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LockPlan {
  id: string;
  name: string;
  emoji: string;
  days: number;
  rate: number;       // interest for the WHOLE term (0.04 = 4%)
  tagline: string;
}

export const LOCK_CONFIG = {
  RESERVE_REQUIREMENT: 0.5,     // share of locked principal held back (never lent or paid out)
  MIN_LOCK: 50,
  MAX_PER_MEMBER: 25_000,       // total a single member can have locked at once
  MAX_TOTAL: 100_000,           // total the bank will hold in locks at once
  BREAK_FEE_RATE: 0.03,         // early-break fee, % of principal (interest is forfeited on top)
  RECOVERY_MIN_AGE_MS: 2 * 60_000,
  PLANS: [
    { id: 'quick', name: 'Quick Lock',        emoji: '🌱', days: 14,  rate: 0.015, tagline: 'A short first step' },
    { id: 'm1',    name: 'Safelock 1 Month',  emoji: '🔒', days: 30,  rate: 0.04,  tagline: 'Steady monthly saving' },
    { id: 'm3',    name: 'Safelock 3 Months', emoji: '🏦', days: 90,  rate: 0.13,  tagline: 'Best for a quarter-long goal' },
    { id: 'm6',    name: 'Safelock 6 Months', emoji: '💎', days: 180, rate: 0.30,  tagline: 'Highest return for patient savers' },
  ] as LockPlan[],
};

/** Simple annualised rate for display: rate × 365 / days. */
export const planApr = (p: LockPlan) => (p.rate * 365) / p.days;
export const getPlan = (id: string) => LOCK_CONFIG.PLANS.find(p => p.id === id) || null;

export type LockStatus = 'active' | 'settling' | 'credited' | 'breaking' | 'matured' | 'broken';

export interface Lock {
  id: string;
  userId: string;
  planId: string;
  planName: string;
  days: number;
  rate: number;
  principal: number;
  interest: number;         // fixed at creation
  startedAt: number;
  maturesAt: number;
  status: LockStatus;
  settledAt: number | null;
  fee: number;              // early-break fee actually charged
  updatedAt: number;
}

const root = createStore('bank');
const locksTbl = root.table('locks');               // userId -> Lock[] (newest first)
const lockJournalTbl = root.table('lockJournal');   // lockId -> half-created lock (only unfinished ones live here)

const rand = () => Math.random().toString(36).slice(2, 8);
const fmt = (n: number) => Number(n).toLocaleString('en-US');
const LOCKED_STATUSES = new Set<LockStatus>(['active', 'settling', 'breaking']);

async function readLocks(userId: string): Promise<Lock[]> {
  const v = await locksTbl.get(userId);
  return Array.isArray(v) ? v : [];
}

/** Atomic edit of one member's lock list. `fn` mutates the (copied) array in place. */
async function mutateLocks(userId: string, fn: (arr: Lock[]) => void): Promise<Lock[]> {
  return locksTbl.mutate(userId, (cur: any) => {
    const arr: Lock[] = Array.isArray(cur) ? cur.map(l => ({ ...l })) : [];
    fn(arr);
    // keep history bounded: all open locks + the 40 most recent finished ones
    const open = arr.filter(l => LOCKED_STATUSES.has(l.status) || l.status === 'credited');
    const done = arr.filter(l => !(LOCKED_STATUSES.has(l.status) || l.status === 'credited')).slice(0, 40);
    return [...open, ...done].sort((a, b) => b.startedAt - a.startedAt);
  });
}

async function setStatus(userId: string, lockId: string, status: LockStatus, extra: Partial<Lock> = {}): Promise<Lock | null> {
  let out: Lock | null = null;
  await mutateLocks(userId, arr => {
    const l = arr.find(x => x.id === lockId);
    if (l) { Object.assign(l, extra, { status, updatedAt: Date.now() }); out = { ...l }; }
  });
  return out;
}

const lockedOf = (arr: Lock[]) => arr.filter(l => LOCKED_STATUSES.has(l.status)).reduce((s, l) => s + l.principal, 0);

// ── Reserve ──────────────────────────────────────────────────────────────────

export interface LockTotals {
  count: number;
  members: number;
  lockedPrincipal: number;
  expectedInterest: number;
  depositCapital: number;      // usable by games/loans
  protectedAmount: number;     // held back
}

async function scanTotals(): Promise<LockTotals> {
  const all = (await locksTbl.getAll()) || {};
  let principal = 0, interest = 0, count = 0, members = 0;
  for (const arr of Object.values(all) as Lock[][]) {
    let mine = 0;
    for (const l of arr || []) if (LOCKED_STATUSES.has(l.status)) { principal += l.principal; interest += l.interest; count++; mine++; }
    if (mine) members++;
  }
  const depositCapital = Math.round(principal * (1 - LOCK_CONFIG.RESERVE_REQUIREMENT));
  return { count, members, lockedPrincipal: principal, expectedInterest: interest, depositCapital, protectedAmount: principal - depositCapital };
}

export const getLockTotals = scanTotals;

/**
 * Recomputes the bank's usable deposit capital from the lock records and publishes it to the pool.
 * Serialized, and always a full recompute — so concurrent lock operations and crashes converge on
 * the right number instead of drifting.
 */
export async function refreshReserve(): Promise<LockTotals> {
  return withUserLock('reserve:locks', async () => {
    const totals = await scanTotals();
    await setDepositCapital(totals.depositCapital);
    return totals;
  });
}

// ── Journal (half-created locks) ─────────────────────────────────────────────

interface LockJournal { id: string; userId: string; planId: string; amount: number; startedAt: number; stage: 'started' | 'debited' | 'recovering' | 'needs_review'; updatedAt: number }

const jStart = (id: string, userId: string, planId: string, amount: number, startedAt: number) =>
  lockJournalTbl.set(id, { id, userId, planId, amount, startedAt, stage: 'started', updatedAt: Date.now() } as LockJournal);
const jStage = (id: string, stage: LockJournal['stage']) => lockJournalTbl.patch(id, { stage, updatedAt: Date.now() });
const jEnd = (id: string) => lockJournalTbl.del(id);

function buildLock(id: string, userId: string, plan: LockPlan, amount: number, startedAt: number): Lock {
  return {
    id, userId, planId: plan.id, planName: plan.name, days: plan.days, rate: plan.rate,
    principal: amount, interest: Math.round(amount * plan.rate),
    startedAt, maturesAt: startedAt + plan.days * DAY_MS,
    status: 'active', settledAt: null, fee: 0, updatedAt: Date.now(),
  };
}

// ── Create ───────────────────────────────────────────────────────────────────

export type LockFailure =
  | 'unknown_plan' | 'below_minimum' | 'insufficient_savings' | 'held'
  | 'member_cap' | 'bank_cap' | 'underwater' | 'move_failed';

export type CreateLockResult =
  | { ok: true; lock: Lock; savings: number }
  | { ok: false; reason: LockFailure; min?: number; room?: number; held?: number; available?: number };

export async function createLock(userId: string, planId: string, rawAmount: number, now = Date.now()): Promise<CreateLockResult> {
  const plan = getPlan(planId);
  if (!plan) return { ok: false, reason: 'unknown_plan' };
  const amount = Math.floor(Number(rawAmount));
  if (!Number.isFinite(amount) || amount < LOCK_CONFIG.MIN_LOCK) return { ok: false, reason: 'below_minimum', min: LOCK_CONFIG.MIN_LOCK };

  return withUserLock(bankLockKey(userId), async () => {
    const sav = await getAvailableSavings(userId);
    if (amount > sav.balance) return { ok: false, reason: 'insufficient_savings', available: sav.available };
    if (amount > sav.available) return { ok: false, reason: 'held', held: sav.hold, available: sav.available };

    const mine = lockedOf(await readLocks(userId));
    if (mine + amount > LOCK_CONFIG.MAX_PER_MEMBER) {
      return { ok: false, reason: 'member_cap', room: Math.max(0, LOCK_CONFIG.MAX_PER_MEMBER - mine) };
    }
    const totals = await scanTotals();
    if (totals.lockedPrincipal + amount > LOCK_CONFIG.MAX_TOTAL) {
      return { ok: false, reason: 'bank_cap', room: Math.max(0, LOCK_CONFIG.MAX_TOTAL - totals.lockedPrincipal) };
    }
    // A bank below its own floor doesn't take on new promises while it rebuilds.
    if ((await getJackpotPool()) < JACKPOT_SEED) return { ok: false, reason: 'underwater' };

    const id = `lk_${now}_${rand()}`;
    await jStart(id, userId, plan.id, amount, now);

    // Step 1 — take the coins out of savings. Every ledger entry a lock produces has its OWN ref
    // (`<id>:lock`, `:settle`, `:break`, `:refund`): a shared ref would make the later credit look like a duplicate.
    let debit: any;
    try {
      debit = await ledgerDebit(userId, amount, 'lock', `${plan.name} (${plan.days} days)`, `${id}:lock`);
    } catch (err: any) {
      console.error(`[bankLocks] savings debit did not persist (user=${userId} amount=${amount}):`, err?.message || err);
      await jEnd(id);
      return { ok: false, reason: 'move_failed' };
    }
    if (!debit.ok) { await jEnd(id); return { ok: false, reason: debit.reason }; }
    await jStage(id, 'debited');

    // Step 2 — record the lock.
    const lock = buildLock(id, userId, plan, amount, now);
    try {
      await mutateLocks(userId, arr => { if (!arr.some(l => l.id === id)) arr.unshift(lock); });
      if (!(await readLocks(userId)).some(l => l.id === id)) throw new Error('lock_write_failed');
    } catch (err: any) {
      console.error(`[bankLocks] lock record failed after savings debit (user=${userId} amount=${amount}):`, err?.message || err);
      try {
        await ledgerCredit(userId, amount, 'adjust', 'Auto-refund: lock failed', false, `${id}:refund`);
        await jEnd(id);
      } catch (refundErr: any) {
        console.error(`[bankLocks] CRITICAL: lock refund ALSO failed (user=${userId} amount=${amount}) — journal ${id} will roll the lock forward:`, refundErr?.message || refundErr);
      }
      return { ok: false, reason: 'move_failed' };
    }

    await jEnd(id);
    await refreshReserve();
    await noteBalance(userId, { savings: debit.account.balance, locked: lockedOf(await readLocks(userId)) }, 'save').catch(() => {});
    return { ok: true, lock, savings: debit.account.balance };
  });
}

// ── Settlement (maturity) ────────────────────────────────────────────────────

export interface SettleEvent { lock: Lock; credited: number }

// Caller holds the member lock and the lock is already in 'settling'.
async function finishSettlement(userId: string, lock: Lock, now: number): Promise<SettleEvent> {
  const payout = lock.principal + lock.interest;
  const note = `${lock.planName} matured: ${fmt(lock.principal)} + ${fmt(lock.interest)} interest`;

  // Credit is idempotent on its ref, so a replay after a crash can't pay twice.
  const cr = await ledgerCredit(userId, payout, 'unlock', note, false, `${lock.id}:settle`);
  if (!cr.ok) throw new Error(`settlement credit failed: ${cr.reason}`);
  await setStatus(userId, lock.id, 'credited');

  // The promised interest comes out of the house pool (deliberately not floor-limited — see header).
  if (lock.interest > 0) await payFromReserve(lock.interest);
  const done = (await setStatus(userId, lock.id, 'matured', { settledAt: now })) || { ...lock, status: 'matured', settledAt: now };

  await refreshReserve();
  await noteBalance(userId, { savings: cr.account.balance, locked: lockedOf(await readLocks(userId)) }, 'move').catch(() => {});
  return { lock: done, credited: payout };
}

async function settleOne(userId: string, lockId: string, now: number): Promise<SettleEvent | null> {
  let claimed: Lock | null = null;
  await mutateLocks(userId, arr => {
    const l = arr.find(x => x.id === lockId);
    if (l && l.status === 'active' && l.maturesAt <= now) { l.status = 'settling'; l.updatedAt = Date.now(); claimed = { ...l }; }
  });
  return claimed ? finishSettlement(userId, claimed, now) : null;
}

/** Pays out every matured lock this member has. Cheap when there is nothing due, so screens call it freely. */
export async function settleDue(userId: string, now = Date.now()): Promise<SettleEvent[]> {
  const due = (await readLocks(userId)).filter(l => l.status === 'active' && l.maturesAt <= now);
  if (due.length === 0) return [];
  return withUserLock(bankLockKey(userId), async () => {
    const events: SettleEvent[] = [];
    for (const l of due) {
      try {
        const ev = await settleOne(userId, l.id, now);
        if (ev) events.push(ev);
      } catch (err: any) {
        console.error(`[bankLocks] settlement failed (user=${userId} lock=${l.id}) — recoverLocks() will retry:`, err?.message || err);
      }
    }
    return events;
  });
}

// ── Early break ──────────────────────────────────────────────────────────────

export type BreakResult =
  | { ok: true; matured: false; payout: number; fee: number; lock: Lock }
  | { ok: true; matured: true; credited: number; lock: Lock }
  | { ok: false; reason: 'not_active' | 'move_failed' };

async function finishBreak(userId: string, lock: Lock): Promise<{ payout: number; fee: number; lock: Lock }> {
  const payout = lock.principal - lock.fee;
  const note = `${lock.planName} broken early: ${fmt(lock.fee)} fee, interest forfeited`;
  const cr = await ledgerCredit(userId, payout, 'unlock', note, false, `${lock.id}:break`);
  if (!cr.ok) throw new Error(`break credit failed: ${cr.reason}`);
  const done = (await setStatus(userId, lock.id, 'broken', { settledAt: Date.now() })) || { ...lock, status: 'broken' };
  if (lock.fee > 0) await contributeToJackpot(lock.fee);   // the fee stays with the bank
  await refreshReserve();
  await noteBalance(userId, { savings: cr.account.balance, locked: lockedOf(await readLocks(userId)) }, 'move').catch(() => {});
  return { payout, fee: lock.fee, lock: done };
}

export function breakFee(principal: number): number {
  return Math.max(1, Math.round(principal * LOCK_CONFIG.BREAK_FEE_RATE));
}

export async function breakLock(userId: string, lockId: string, now = Date.now()): Promise<BreakResult> {
  return withUserLock(bankLockKey(userId), async () => {
    const lock = (await readLocks(userId)).find(l => l.id === lockId);
    if (!lock || lock.status !== 'active') return { ok: false, reason: 'not_active' };

    // Already matured but not yet swept: that's a normal payout, no penalty.
    if (lock.maturesAt <= now) {
      const ev = await settleOne(userId, lockId, now);
      return ev ? { ok: true, matured: true, credited: ev.credited, lock: ev.lock } : { ok: false, reason: 'not_active' };
    }

    let claimed: Lock | null = null;
    await mutateLocks(userId, arr => {
      const l = arr.find(x => x.id === lockId);
      if (l && l.status === 'active') { l.status = 'breaking'; l.fee = breakFee(l.principal); l.updatedAt = Date.now(); claimed = { ...l }; }
    });
    if (!claimed) return { ok: false, reason: 'not_active' };

    try {
      const done = await finishBreak(userId, claimed);
      return { ok: true, matured: false, ...done };
    } catch (err: any) {
      console.error(`[bankLocks] early break failed (user=${userId} lock=${lockId}) — recoverLocks() will retry:`, err?.message || err);
      return { ok: false, reason: 'move_failed' };
    }
  });
}

// ── Reading ──────────────────────────────────────────────────────────────────

export interface LockSummary {
  active: Lock[];             // open locks, soonest maturity first
  recent: Lock[];             // finished locks, newest first
  lockedPrincipal: number;
  expectedInterest: number;
  nextMaturity: number | null;
}

/** Settles anything due first, so what the member sees is always current. */
export async function getLockSummary(userId: string, now = Date.now()): Promise<LockSummary & { settled: SettleEvent[] }> {
  const settled = await settleDue(userId, now);
  const all = await readLocks(userId);
  const active = all.filter(l => l.status === 'active').sort((a, b) => a.maturesAt - b.maturesAt);
  const recent = all.filter(l => l.status === 'matured' || l.status === 'broken').sort((a, b) => (b.settledAt || 0) - (a.settledAt || 0)).slice(0, 8);
  return {
    active, recent, settled,
    lockedPrincipal: lockedOf(all),
    expectedInterest: active.reduce((s, l) => s + l.interest, 0),
    nextMaturity: active.length ? active[0].maturesAt : null,
  };
}

export async function getLockedPrincipal(userId: string): Promise<number> {
  return lockedOf(await readLocks(userId));
}

export async function getLock(userId: string, lockId: string): Promise<Lock | null> {
  return (await readLocks(userId)).find(l => l.id === lockId) || null;
}

// ── Sweep + recovery ─────────────────────────────────────────────────────────

/**
 * Finishes anything a crash left half-done: locks whose savings were debited but never recorded,
 * settlements stuck mid-way, and early breaks stuck mid-way.
 */
export async function recoverLocks(now = Date.now()): Promise<{ recovered: number; needsReview: number }> {
  const report = { recovered: 0, needsReview: 0 };

  // 1) half-created locks: savings debited, lock never recorded -> roll forward
  const journal = (await lockJournalTbl.getAll()) || {};
  for (const [id, raw] of Object.entries(journal)) {
    const j = raw as LockJournal | null;
    if (!j) { await lockJournalTbl.del(id); continue; }
    const age = now - (j.updatedAt || 0);
    if (j.stage === 'needs_review') { report.needsReview++; continue; }
    if (j.stage === 'started') {
      if (age > 10 * 60_000) { await jStage(id, 'needs_review'); console.error(`[bankLocks] journal ${id} stuck at 'started' — needs manual review`); report.needsReview++; }
      continue;
    }
    if (j.stage !== 'debited' || age < LOCK_CONFIG.RECOVERY_MIN_AGE_MS) continue;

    const plan = getPlan(j.planId);
    if (!plan) { await jStage(id, 'needs_review'); report.needsReview++; continue; }
    try {
      await withUserLock(bankLockKey(j.userId), async () => {
        const have = (await readLocks(j.userId)).some(l => l.id === id);
        if (!have) {
          const lock = buildLock(id, j.userId, plan, j.amount, j.startedAt);   // original start time: maturity isn't pushed back
          await mutateLocks(j.userId, arr => { arr.unshift(lock); });
        }
      });
      await jEnd(id);
      await refreshReserve();
      report.recovered++;
      console.warn(`[bankLocks] recovered half-created lock ${id} (${j.amount} for ${j.userId})`);
    } catch (err: any) {
      console.error(`[bankLocks] recovery of journal ${id} failed:`, err?.message || err);
    }
  }

  // 2) stuck settlements / breaks
  const all = (await locksTbl.getAll()) || {};
  for (const [userId, arr] of Object.entries(all) as Array<[string, Lock[]]>) {
    for (const l of arr || []) {
      if (!['settling', 'credited', 'breaking'].includes(l.status)) continue;
      if (now - (l.updatedAt || 0) < LOCK_CONFIG.RECOVERY_MIN_AGE_MS) continue;
      try {
        await withUserLock(bankLockKey(userId), async () => {
          const fresh = (await readLocks(userId)).find(x => x.id === l.id);
          if (!fresh) return;
          if (fresh.status === 'settling') await finishSettlement(userId, fresh, now);
          else if (fresh.status === 'credited') {
            // credit already landed; only the pool charge + final status are left
            if (fresh.interest > 0) await payFromReserve(fresh.interest);
            await setStatus(userId, fresh.id, 'matured', { settledAt: now });
            await refreshReserve();
          } else if (fresh.status === 'breaking') await finishBreak(userId, fresh);
        });
        report.recovered++;
        console.warn(`[bankLocks] recovered stuck lock ${l.id} (${l.status}) for ${userId}`);
      } catch (err: any) {
        report.needsReview++;
        console.error(`[bankLocks] recovery of lock ${l.id} failed:`, err?.message || err);
      }
    }
  }
  return report;
}

/** Hourly: recover, pay out everything matured, republish deposit capital. Returns the payouts so callers can notify. */
export async function sweepLocks(now = Date.now()): Promise<Array<SettleEvent & { userId: string }>> {
  await recoverLocks(now).catch(err => console.error('[bankLocks] recovery pass failed:', err));
  const all = (await locksTbl.getAll()) || {};
  const out: Array<SettleEvent & { userId: string }> = [];
  for (const [userId, arr] of Object.entries(all) as Array<[string, Lock[]]>) {
    if (!(arr || []).some(l => l.status === 'active' && l.maturesAt <= now)) continue;
    for (const ev of await settleDue(userId, now)) out.push({ userId, ...ev });
  }
  await refreshReserve();   // self-heals the published deposit capital even when nothing was due
  return out;
}
