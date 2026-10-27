// @ts-nocheck
/***
 * lib/wagers.ts
 *
 * Play-volume ledger for credit assessment. A lender judges you on what you
 * actually do, so this turns the economy's transaction log into per-day
 * totals of coins STAKED on games and Sportybet — the raw material for
 * lib/credit.ts.
 *
 * ── Where the numbers come from ──────────────────────────────────────────
 * Every coin stake already passes through economy.deductCoins() and is logged
 * with a transaction `type`. WAGER_SOURCES below says which types count as a
 * stake and which bucket they belong in. Nothing in the game plugins or in
 * Sportybet needs to change — but each of them MUST tag its stake debit with
 * one of these types (slots / coinflip / dice / sportybet). A game that tags
 * its stakes 'other' is invisible here; add its tag to WAGER_SOURCES.
 *
 * Only STAKES count (debits). Winnings, payouts, refunds and cash-outs are
 * credits and are ignored, so this measures how much someone plays, not how
 * much they win or lose.
 *
 * ── How it stays correct ─────────────────────────────────────────────────
 * The transaction log keeps only the newest 200 entries per member, so it
 * can't be read at assessment time. ingestWagers() folds new stake entries
 * into permanent daily buckets, de-duplicated by transaction id (kept for a
 * short look-back window behind the newest entry, so a log write that lands a
 * few milliseconds out of order is still picked up) — running it any number
 * of times, from any number of places, never double counts. It runs automatically whenever someone's credit is assessed, and
 * an hourly sweep (plugins/bank.ts schedules) covers members who aren't
 * looking. The first run backfills whatever is still in each member's log.
 *
 * Known limits (all err on the cautious side for a lender):
 *   • The log's own writes aren't atomic, so two overlapping transactions by
 *     the SAME member can drop one entry — a slight undercount, never an over.
 *   • A stake that is later refunded (e.g. a voided coupon) still counts.
 *   • History starts from the log at first ingest, not from the beginning of time.
 */
import { createStore } from './pluginStore.js';
import { getTransactions, todayStr } from './economy.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_DAYS = 90;
const LAG_MS = 10_000; // log writes can land slightly out of order; re-check this far behind the newest entry

export type WagerSource = 'games' | 'sportybet';

/** transaction `type` -> bucket. Add a line here for any game that tags its stakes differently. */
export const WAGER_SOURCES: Record<string, WagerSource> = {
  slots: 'games',
  coinflip: 'games',
  dice: 'games',
  sportybet: 'sportybet',
};

const store = createStore('wagers');
const ledgerTbl = store.table('ledger'); // userId -> WagerRecord
const walletsTbl = createStore('economy').table('wallets'); // only used to know whose logs to sweep

interface DayBucket { games: number; sportybet: number; bets: number }

interface WagerRecord {
  v: 1;
  cursorTs: number;        // newest stake timestamp already folded in
  recent: Array<{ id: string; ts: number }>; // ids folded in within LAG_MS of cursorTs (the de-dupe set)
  firstAt: number | null;
  lifetimeStake: number;
  lifetimeBets: number;
  days: Record<string, DayBucket>; // 'YYYY-MM-DD' (economy timezone) -> totals
}

export interface WagerSummary {
  turnover: number;        // coins staked in the window
  bets: number;            // number of stakes in the window
  activeDays: number;      // distinct days with at least one stake in the window
  bySource: { games: number; sportybet: number };
  lifetimeTurnover: number;
  firstAt: number | null;
}

function emptyRecord(): WagerRecord {
  return { v: 1, cursorTs: 0, recent: [], firstAt: null, lifetimeStake: 0, lifetimeBets: 0, days: {} };
}

function normalize(raw: any): WagerRecord {
  if (!raw || typeof raw !== 'object') return emptyRecord();
  return { ...emptyRecord(), ...raw, recent: Array.isArray(raw.recent) ? raw.recent : [], days: raw.days && typeof raw.days === 'object' ? raw.days : {} };
}

/** Folds any not-yet-counted stakes from the member's transaction log into their ledger. Idempotent. */
export async function ingestWagers(userId: string): Promise<WagerRecord> {
  const log = await getTransactions(userId, 200); // newest first

  return ledgerTbl.mutate(userId, (current: any) => {
    const rec = normalize(current);
    const seen = new Set(rec.recent.map(r => r.id));
    let cursorTs = rec.cursorTs;
    const recent = [...rec.recent];

    // oldest -> newest
    for (const tx of [...log].reverse()) {
      const source = WAGER_SOURCES[tx.type];
      if (!source || tx.currency !== 'coins' || !(tx.amount < 0)) continue;
      if (tx.timestamp < rec.cursorTs - LAG_MS) continue;   // older than the look-back window: already handled
      if (seen.has(tx.id)) continue;

      const stake = -tx.amount;
      const day = todayStr(tx.timestamp);
      const bucket = rec.days[day] || (rec.days[day] = { games: 0, sportybet: 0, bets: 0 });
      bucket[source] += stake;
      bucket.bets += 1;
      rec.lifetimeStake += stake;
      rec.lifetimeBets += 1;
      if (rec.firstAt === null || tx.timestamp < rec.firstAt) rec.firstAt = tx.timestamp;

      seen.add(tx.id);
      recent.push({ id: tx.id, ts: tx.timestamp });
      if (tx.timestamp > cursorTs) cursorTs = tx.timestamp;
    }

    rec.cursorTs = cursorTs;
    rec.recent = recent.filter(r => r.ts >= cursorTs - LAG_MS);

    // keep ~90 days of daily buckets; lifetime totals live outside them
    const keepFrom = todayStr(Date.now() - KEEP_DAYS * DAY_MS);
    for (const key of Object.keys(rec.days)) if (key < keepFrom) delete rec.days[key];
    return rec;
  });
}

export function summarize(rec: WagerRecord, windowDays: number, now = Date.now()): WagerSummary {
  const startKey = todayStr(now - (windowDays - 1) * DAY_MS);
  let games = 0, sportybet = 0, bets = 0, activeDays = 0;
  for (const [key, b] of Object.entries(rec.days)) {
    if (key < startKey) continue;
    games += b.games; sportybet += b.sportybet; bets += b.bets;
    if (b.bets > 0) activeDays++;
  }
  return { turnover: games + sportybet, bets, activeDays, bySource: { games, sportybet }, lifetimeTurnover: rec.lifetimeStake, firstAt: rec.firstAt };
}

/** Rolling-window play summary for one member (ingests first, so it is always current). */
export async function getWagerSummary(userId: string, windowDays = 30, opts: { ingest?: boolean } = {}): Promise<WagerSummary> {
  const rec = opts.ingest === false ? normalize(await ledgerTbl.get(userId)) : await ingestWagers(userId);
  return summarize(rec, windowDays);
}

/** Hourly sweep: ingest every wallet owner's log. Returns how many ledgers were touched. */
export async function ingestAllWagers(): Promise<number> {
  const owners = Object.keys((await walletsTbl.getAll()) || {});
  let n = 0;
  for (const userId of owners) {
    try { await ingestWagers(userId); n++; } catch (err) { console.error('[wagers] ingest failed for', userId, err); }
  }
  return n;
}

/** Everyone with recorded play, from the ledger alone (no ingest) — for the admin credit view. */
export async function listWagerSummaries(windowDays = 30): Promise<Array<{ userId: string } & WagerSummary>> {
  const all = (await ledgerTbl.getAll()) || {};
  return Object.entries(all).map(([userId, raw]) => ({ userId, ...summarize(normalize(raw), windowDays) }));
}
