// @ts-nocheck
/***
 * lib/bankActivity.ts
 *
 * The savings side of a member's credit file: how much they keep with the bank
 * and how consistently they save. (The play side is lib/wagers.ts.)
 *
 * Every time a member's savings or locked balance changes — deposit, withdrawal,
 * lock, unlock — the bank calls noteBalance(), which stamps today's bucket with
 * the balances as they stand and counts the event. Balances only change through
 * those calls, so a day with no event simply CARRIES FORWARD the last known
 * balance; no daily job is needed to keep the average honest.
 *
 *   avgBalance  average daily (savings + locked) over the window, carry-forward.
 *               Days before the first recorded balance count as 0, so a new
 *               account has to build history — it can't be bought in one day.
 *   saveDays    distinct days with a deposit or a new lock ("pays in regularly").
 *   eventDays   distinct days with ANY bank event (deposit, withdrawal, lock, unlock).
 *   lockedNow   locked principal as of the latest record.
 *
 * Moving coins in and out of the same account to look busy doesn't help much:
 * the score rewards a balance that STAYS, averaged across the whole window.
 */
import { createStore } from './pluginStore.js';
import { todayStr } from './economy.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_DAYS = 90;

const activityTbl = createStore('bank').table('activity'); // userId -> ActivityRecord

interface DayBucket { sav: number; lock: number; saves: number; moves: number }
interface ActivityRecord { v: 1; sav: number; lock: number; days: Record<string, DayBucket> }

export type BankEvent = 'save' | 'move' | null;

export interface BankingSummary {
  avgBalance: number;      // average daily savings + locked over the window
  saveDays: number;
  eventDays: string[];     // day keys with any bank event (for the "active days" union)
  currentSavings: number;
  lockedNow: number;
}

function emptyRecord(): ActivityRecord { return { v: 1, sav: 0, lock: 0, days: {} }; }

function normalize(raw: any): ActivityRecord {
  if (!raw || typeof raw !== 'object') return emptyRecord();
  return { ...emptyRecord(), ...raw, days: raw.days && typeof raw.days === 'object' ? raw.days : {} };
}

/**
 * Records the member's current balances. Pass only the part that changed:
 * `savings` for deposit/withdraw/lock/unlock debits and credits, `locked` for
 * lock creation/settlement. `event` says what kind of activity it was:
 * 'save' = money going IN (deposit / new lock), 'move' = any other bank activity.
 */
export async function noteBalance(
  userId: string,
  patch: { savings?: number; locked?: number },
  event: BankEvent = null,
  now = Date.now()
): Promise<void> {
  await activityTbl.mutate(userId, (cur: any) => {
    const rec = normalize(cur);
    if (patch.savings !== undefined) rec.sav = Math.max(0, Math.round(patch.savings));
    if (patch.locked !== undefined) rec.lock = Math.max(0, Math.round(patch.locked));

    const key = todayStr(now);
    const day = rec.days[key] || (rec.days[key] = { sav: rec.sav, lock: rec.lock, saves: 0, moves: 0 });
    day.sav = rec.sav;
    day.lock = rec.lock;
    if (event === 'save') { day.saves += 1; day.moves += 1; }
    else if (event === 'move') day.moves += 1;

    const keepFrom = todayStr(now - KEEP_DAYS * DAY_MS);
    for (const k of Object.keys(rec.days)) if (k < keepFrom) delete rec.days[k];
    return rec;
  });
}

export function summarizeBanking(rec: ActivityRecord, windowDays: number, now = Date.now()): BankingSummary {
  const keys: string[] = [];
  for (let i = windowDays - 1; i >= 0; i--) keys.push(todayStr(now - i * DAY_MS));
  const startKey = keys[0];

  // carry-forward seed: the latest bucket from BEFORE the window, if any (else the account didn't exist yet)
  let carry = 0;
  let best = '';
  for (const [k, d] of Object.entries(rec.days)) {
    if (k < startKey && k > best) { best = k; carry = d.sav + d.lock; }
  }

  let total = 0, saveDays = 0;
  const eventDays: string[] = [];
  for (const k of keys) {
    const d = rec.days[k];
    if (d) {
      carry = d.sav + d.lock;
      if (d.saves > 0) saveDays++;
      if (d.moves > 0) eventDays.push(k);
    }
    total += carry;
  }

  return {
    avgBalance: Math.round(total / windowDays),
    saveDays,
    eventDays,
    currentSavings: rec.sav,
    lockedNow: rec.lock,
  };
}

export async function getBankingSummary(userId: string, windowDays = 30): Promise<BankingSummary> {
  return summarizeBanking(normalize(await activityTbl.get(userId)), windowDays);
}

/** Everyone's summary straight from the ledger — for the admin credit view. */
export async function listBankingSummaries(windowDays = 30): Promise<Array<{ userId: string } & BankingSummary>> {
  const all = (await activityTbl.getAll()) || {};
  return Object.entries(all).map(([userId, raw]) => ({ userId, ...summarizeBanking(normalize(raw), windowDays) }));
}
