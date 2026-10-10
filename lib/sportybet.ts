/**
 * lib/sportybet.ts
 *
 * Virtual Premier League sportsbook — pure logic engine, no WhatsApp socket
 * calls. Mirrors economy.ts / slotMachine.ts's separation: this file owns
 * match data, coupon placement, and settlement; plugins/sportybet.ts owns
 * the button-menu UI and calls into these exports.
 *
 * BEFORE THIS COMPILES:
 * 1. Add 'sportybet' to the TransactionType union in economy.ts, alongside
 *    the existing 'slots' | 'coinflip' | 'dice', so ledger entries for
 *    stakes/payouts are typed consistently with the other games.
 * 2. Set FOOTBALL_DATA_API_TOKEN and ODDS_API_KEY in your environment.
 *    Malvin is no longer used anywhere in this file — fixtures/results come
 *    straight from football-data.org (Malvin's /epl/upcoming and
 *    /epl/matches turned out to be stuck serving stale matchday 1-2 data),
 *    and odds come straight from The Odds API (richer market access than
 *    Malvin's h2h-only wrapper allowed).
 */

import { createStore } from './pluginStore.js';
import { getWallet, addCoins, deductCoins, formatNumber } from './economy.js';
import { cleanJid } from './isOwner.js';
import { getJackpotPool, contributeToJackpot, deductFromJackpot, settleWin, recordHouseActivity } from './slotMachine.js';

// ─────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────

const FOOTBALL_DATA_BASE = 'https://api.football-data.org/v4';
const FOOTBALL_DATA_API_TOKEN = process.env.FOOTBALL_DATA_API_TOKEN || '';

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const ODDS_API_KEY = process.env.ODDS_API_KEY || '';

// football-data.org's limit is per-minute (10/min), so a short cache is plenty.
//
// The Odds API's free tier is a flat 500 CREDITS/month instead. What a call costs:
//   bulk  /sports/soccer_epl/odds ........ markets x regions
//   event /events/{id}/odds .............. UNIQUE MARKETS ACTUALLY RETURNED x regions
//   event /events/{id}/markets ........... 1  (no longer used — see below)
// Because the event endpoint only bills for markets that come back, asking for
// a market the UK books don't list is free. That makes the old per-match
// "/markets availability check" (1 credit) pure waste: we just request the
// bundle and see what's returned.
//
// Spend plan (1 region = uk):
//   bulk h2h, 8h cache ................... <= 3 calls/day x 1 credit  = <= 90/month
//   CORE bundle (<= 5 markets) ........... <= 5 credits per match, once per 24h,
//                                          only when a player opens that match
//   EXTRA bundle (<= 3 markets) .......... <= 3 credits per match, only if a player
//                                          taps "More markets"
//   reserve .............................. 40 credits per-match fetches never touch
// ~38 EPL matches a month, so even if every one is opened (and half also tap
// "More markets") that's roughly 38x5 + 19x3 = ~250, plus <= 90 bulk = ~340 of 500.
// All odds caches are also persisted to the plugin store, so a bot restart
// never re-buys odds that are still fresh.
const FIXTURES_CACHE_TTL_MS = 60_000;
const SEASON_MATCHES_CACHE_TTL_MS = 60_000;
const ODDS_CACHE_TTL_MS = 8 * 60 * 60_000; // bulk h2h
const EVENT_ODDS_CACHE_TTL_MS = 24 * 60 * 60_000; // per-match market bundles

/** Per-match fetches refuse to run if they could dip the account below this. Bulk h2h may use it. */
const ODDS_CREDIT_RESERVE = 40;

// Market bundles requested from /events/{id}/odds. The alternate_* ladders also
// contain the main line, so the plain `totals` / `team_totals` keys are not
// requested (one credit each saved per match). If a one-off curl on a real match
// shows the ladder missing the main line, add the plain key back here.
const CORE_MARKET_KEYS = ['btts', 'double_chance', 'draw_no_bet', 'alternate_totals', 'alternate_team_totals'] as const;
const EXTRA_MARKET_KEYS = ['btts_h1', 'double_chance_h1', 'halftime_fulltime'] as const;

/** Bets close this long before kickoff — pre-match only, and half-time markets must never be bettable mid-game. */
export const BETTING_CUTOFF_MS = 5 * 60_000;

/** Max over/under lines offered per ladder — 5 lines x 2 sides = 10 buttons, the proven menu ceiling. */
const MAX_LADDER_LINES = 5;

export const MIN_STAKE = 10;
export const MAX_STAKE = 5000;
export const MAX_LEGS_PER_COUPON = 10;

// ─────────────────────────────────────────────────────────────────────────
// Raw API shapes (as returned by football-data.org and The Odds API directly)
// ─────────────────────────────────────────────────────────────────────────

interface FootballDataTeam {
  id: number;
  name: string; // official name, e.g. "Arsenal FC"
  shortName?: string;
  tla?: string;
  crest?: string;
}

/** A match as returned by football-data.org's /v4/competitions/PL/matches. */
interface FootballDataMatch {
  id: number;
  utcDate: string; // ISO 8601 UTC
  status: string; // SCHEDULED | LIVE | IN_PLAY | PAUSED | FINISHED | POSTPONED | SUSPENDED | CANCELLED
  matchday: number;
  homeTeam: FootballDataTeam;
  awayTeam: FootballDataTeam;
  score: {
    winner: 'HOME_TEAM' | 'AWAY_TEAM' | 'DRAW' | null;
    fullTime: { home: number | null; away: number | null };
    /** Needed by the 1st-half markets (btts_h1, double_chance_h1, halftime_fulltime). */
    halfTime?: { home: number | null; away: number | null };
  };
}

interface FootballDataMatchesResponse {
  competition: { id: number; name: string; code: string };
  matches: FootballDataMatch[];
}

interface OddsTip {
  eventId: string; // The Odds API's event id — needed later for the per-event BTTS lookup
  homeTeam: string; // short name, e.g. "Arsenal"
  awayTeam: string;
  commenceTime: string; // ISO 8601 UTC
  bookmakers: number;
  h2h: { home: number; draw: number; away: number } | null;
}

// ─────────────────────────────────────────────────────────────────────────
// Domain types
// ─────────────────────────────────────────────────────────────────────────

export type Market =
  | '1x2'
  | 'totals' // over/under total goals — any line from the alternate_totals ladder
  | 'btts'
  | 'draw_no_bet'
  | 'double_chance'
  | 'team_totals' // over/under ONE team's goals — any line from alternate_team_totals
  | 'btts_h1'
  | 'double_chance_h1'
  | 'halftime_fulltime';

export type TeamSide = 'home' | 'away';
/** 1X = home or draw, 12 = home or away (no draw), X2 = draw or away. */
export type DoubleChanceSel = '1x' | '12' | 'x2';
/** "<half-time result>/<full-time result>", each 1 = home, x = draw, 2 = away. */
export type HtFtSel = '1/1' | '1/x' | '1/2' | 'x/1' | 'x/x' | 'x/2' | '2/1' | '2/x' | '2/2';
export type Selection = 'home' | 'draw' | 'away' | 'over' | 'under' | 'yes' | 'no' | DoubleChanceSel | HtFtSel;
export type LegStatus = 'pending' | 'won' | 'lost' | 'voided';
export type CouponStatus = 'pending' | 'won' | 'lost';

export interface FixtureWithOdds {
  eventId: string | null; // null if no Odds API match was found for this fixture yet
  homeTeam: string; // official name — carried through to settlement
  awayTeam: string;
  kickoff: string; // ISO 8601 UTC
  matchday: number;
  h2h: { home: number; draw: number; away: number } | null;
}

export interface Leg {
  id: string;
  homeTeam: string;
  awayTeam: string;
  kickoff: string;
  market: Market;
  selection: Selection;
  point?: number; // only for 'totals' / 'team_totals' — the over/under line, e.g. 2.5
  team?: TeamSide; // only for 'team_totals' — whose goals the line applies to
  oddsAtPlacement: number;
  status: LegStatus;
  finalScore?: string;
}

export interface Coupon {
  id: string;
  userId: string;
  stake: number;
  legs: Leg[];
  combinedOdds: number;
  potentialPayout: number;
  /** What was actually credited on a 'won' coupon — only differs from potentialPayout if the bank's floor capped it. */
  actualPayout?: number;
  status: CouponStatus;
  placedAt: number;
  settledAt?: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────

const root = createStore('sportybet');
const couponsByUser = root.table!('couponsByUser'); // userId -> Coupon[]

const MAX_COUPONS_PER_USER = 100;

// ─────────────────────────────────────────────────────────────────────────
// Shared community bank — sportybet feeds the SAME jackpot pool that backs
// slots/coinflip/dice (lib/slotMachine.ts), not a separate pool of its own
// like Ocean Hunt's. Every stake becomes real pool capital at placement
// (contributeToJackpot), and every win is drawn back out through the same
// settleWin()-then-deductFromJackpot() choke point every other game uses —
// including its floor protection, so a big accumulator can never pay out
// more than the bank can actually afford. recordHouseActivity keeps
// !reserve's daily wagered/paid totals honest across bet-day and,
// separately, whatever later day a coupon actually settles on.
// ─────────────────────────────────────────────────────────────────────────

export async function getReserveBalance(): Promise<number> {
  return getJackpotPool();
}

// ─────────────────────────────────────────────────────────────────────────
// Tiny in-memory cache — shared across every user's menu opens and the
// settlement poller, so several people browsing at once still cost one
// upstream call per TTL window, not one each.
// ─────────────────────────────────────────────────────────────────────────

const cache = new Map<string, { value: any; expiresAt: number }>();

async function cached<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const value = await fetcher();
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

// ─────────────────────────────────────────────────────────────────────────
// football-data.org client — fixtures & results
// ─────────────────────────────────────────────────────────────────────────

async function footballDataGet<T>(path: string): Promise<T> {
  const res = await fetch(`${FOOTBALL_DATA_BASE}${path}`, {
    headers: { 'X-Auth-Token': FOOTBALL_DATA_API_TOKEN },
  });
  if (!res.ok) throw new Error(`football-data.org ${path} responded ${res.status}`);
  return (await res.json()) as T;
}

/** Bettable fixture list — not-yet-played PL matches only. */
export async function fetchUpcomingFixtures(): Promise<FootballDataMatch[]> {
  return cached('sportybet:upcoming', FIXTURES_CACHE_TTL_MS, async () => {
    const data = await footballDataGet<FootballDataMatchesResponse>('/competitions/PL/matches?status=SCHEDULED');
    return data.matches;
  });
}

/** Full-season match list (past/live/scheduled) — the settlement source of truth. */
export async function fetchAllSeasonMatches(): Promise<FootballDataMatch[]> {
  return cached('sportybet:season', SEASON_MATCHES_CACHE_TTL_MS, async () => {
    const data = await footballDataGet<FootballDataMatchesResponse>('/competitions/PL/matches');
    return data.matches;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// The Odds API client — odds, direct (no more Malvin dependency at all now
// that fixtures/results and odds both come straight from their real sources)
//
// Two kinds of call, deliberately split to protect the 500-credit month:
//
//  1. BULK  /odds?markets=h2h — one call prices EVERY upcoming fixture's 1X2
//     (1 credit). That's all the fixture list needs.
//  2. EVENT /events/{id}/odds?markets=... — everything else (BTTS, double
//     chance, draw no bet, goal ladders, team ladders, 1st-half markets,
//     HT/FT). Fetched lazily, ONLY when a player opens that specific match,
//     in two bundles (core / extra) so the extra markets are only paid for
//     when someone actually asks for them. Billed per market RETURNED.
//
// The raw response is one array entry per fixture, each with its own list of
// UK bookmakers, each bookmaker carrying its own markets/outcomes — nothing
// is pre-aggregated. Everything below that says "best price" is us picking
// the highest price per outcome across bookmakers ourselves.
//
// One real quirk this confirmed from a live pull: exchange bookmakers
// (Betfair Exchange, Smarkets) carry a SECOND market, "h2h_lay" — the price
// to bet AGAINST an outcome, not for it. One live sample had a Nottingham
// Forest "h2h_lay" price of 80.0 against every normal bookmaker's ~5.0-5.75
// — picking a "best" price without filtering to key === 'h2h' specifically
// would have handed out a wildly wrong payout multiplier. Every lookup below
// matches market keys EXACTLY; never touch h2h_lay (or any *_lay market).
// ─────────────────────────────────────────────────────────────────────────

interface OddsApiOutcome {
  name: string; // team name, "Draw", "Over"/"Under", "Yes"/"No", or a combo like "Arsenal or Draw"
  price: number;
  point?: number; // present on line-based markets, e.g. 2.5 for Over/Under 2.5
  description?: string; // for team_totals-style markets: which team the line belongs to
}

interface OddsApiMarket {
  key: string; // exact match only — 'h2h' is wanted, 'h2h_lay' must be excluded
  outcomes: OddsApiOutcome[];
}

interface OddsApiBookmaker {
  key: string;
  title: string;
  markets: OddsApiMarket[];
}

interface OddsApiEvent {
  id: string;
  commence_time: string; // ISO 8601 UTC
  home_team: string; // short name, matches Malvin's old naming convention
  away_team: string;
  bookmakers: OddsApiBookmaker[];
}

// ── Persistent cache + credit accounting ─────────────────────────────────
//
// The in-memory `cache` above dies with the process; odds are the one thing
// that costs real credits, so they also live in the plugin store. A restart
// (or a crash loop while developing) no longer re-buys odds that are still
// fresh.

const oddsCacheTable = root.table!('oddsCache'); // key -> { value, expiresAt }
const oddsMetaTable = root.table!('oddsApiMeta'); // 'usage' -> { remaining, at }

interface CacheEntry {
  value: any;
  expiresAt: number;
}

const inflight = new Map<string, Promise<any>>();

/** Fresh cached value (memory, then store) or null. Never fetches, never spends credits. */
async function peekPersisted<T>(key: string): Promise<T | null> {
  const mem = cache.get(key);
  if (mem && mem.expiresAt > Date.now()) return mem.value as T;
  try {
    const stored = (await oddsCacheTable.get(key)) as CacheEntry | null | undefined;
    if (stored && stored.expiresAt > Date.now()) {
      cache.set(key, stored);
      return stored.value as T;
    }
  } catch (err) {
    console.error('[sportybet] odds cache read failed:', err);
  }
  return null;
}

/**
 * Memory -> store -> fetch. Concurrent callers for the same key share ONE
 * fetch (two players opening the same match in the same second must not buy
 * its odds twice).
 */
async function persistentCached<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const running = inflight.get(key);
  if (running) return running as Promise<T>;

  const hit = await peekPersisted<T>(key);
  if (hit !== null) return hit;

  const raced = inflight.get(key); // another caller may have started while we awaited the store
  if (raced) return raced as Promise<T>;

  const promise = (async () => {
    const value = await fetcher();
    const entry: CacheEntry = { value, expiresAt: Date.now() + ttlMs };
    cache.set(key, entry);
    try {
      await oddsCacheTable.set(key, entry);
    } catch (err) {
      console.error('[sportybet] odds cache write failed:', err);
    }
    return value;
  })().finally(() => inflight.delete(key));

  inflight.set(key, promise);
  return promise;
}

let knownRemaining: number | null = null;

async function getKnownRemaining(): Promise<number | null> {
  if (knownRemaining !== null) return knownRemaining;
  try {
    const meta = (await oddsMetaTable.get('usage')) as { remaining?: number } | null | undefined;
    if (meta && typeof meta.remaining === 'number') knownRemaining = meta.remaining;
  } catch {
    /* no meta yet — treat as unknown */
  }
  return knownRemaining;
}

/** Reads The Odds API's own usage headers after every call, logs the real cost, and remembers what's left. */
async function recordUsage(res: Response, label: string): Promise<void> {
  const rawRemaining = res.headers.get('x-requests-remaining');
  const rawLast = res.headers.get('x-requests-last');
  // Number(null) is 0 — only trust a header that is actually present.
  const remaining = rawRemaining !== null && rawRemaining.trim() !== '' ? Number(rawRemaining) : NaN;
  const last = rawLast !== null && rawLast.trim() !== '' ? Number(rawLast) : NaN;

  if (Number.isFinite(remaining)) {
    knownRemaining = remaining;
    try {
      await oddsMetaTable.set('usage', { remaining, at: Date.now() });
    } catch {
      /* best effort */
    }
  }
  console.log(
    `[sportybet] odds-api ${label}: cost=${Number.isFinite(last) ? last : '?'} remaining=${Number.isFinite(remaining) ? remaining : '?'}`
  );
}

export class CreditBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreditBudgetError';
  }
}

export function isCreditBudgetError(err: unknown): boolean {
  return err instanceof Error && err.name === 'CreditBudgetError';
}

/** Per-match fetches stop while the account is within ODDS_CREDIT_RESERVE of empty, so the bulk fixture list keeps working. */
async function assertCreditBudget(worstCaseCost: number): Promise<void> {
  const remaining = await getKnownRemaining();
  if (remaining !== null && remaining - worstCaseCost < ODDS_CREDIT_RESERVE) {
    throw new CreditBudgetError(
      `Odds API credits low (${remaining} left, reserve ${ODDS_CREDIT_RESERVE}) — per-match fetch skipped`
    );
  }
}

// ── Bulk h2h (1 credit) ──────────────────────────────────────────────────

async function fetchOddsApiEvents(markets: string): Promise<OddsApiEvent[]> {
  const url = `${ODDS_API_BASE}/sports/soccer_epl/odds/?regions=uk&markets=${markets}&oddsFormat=decimal&apiKey=${ODDS_API_KEY}`;
  const res = await fetch(url);
  await recordUsage(res, `bulk ${markets}`);
  if (!res.ok) throw new Error(`The Odds API responded ${res.status}`);
  return (await res.json()) as OddsApiEvent[];
}

/** Best (highest) UK price for h2h (1X2), across every bookmaker offering it. */
export async function fetchOddsTips(): Promise<OddsTip[]> {
  return persistentCached<OddsTip[]>('bulk_h2h', ODDS_CACHE_TTL_MS, async () => {
    const events = await fetchOddsApiEvents('h2h');
    return events.map((ev): OddsTip => {
      const bestH2h = new Map<string, number>(); // outcome name -> best price seen
      let bookmakerCount = 0;

      for (const bm of ev.bookmakers) {
        const h2h = bm.markets.find((m) => m.key === 'h2h'); // exactly 'h2h' — never 'h2h_lay'
        if (!h2h) continue;
        bookmakerCount++;
        for (const outcome of h2h.outcomes) {
          const current = bestH2h.get(outcome.name);
          if (current === undefined || outcome.price > current) bestH2h.set(outcome.name, outcome.price);
        }
      }

      const home = bestH2h.get(ev.home_team);
      const away = bestH2h.get(ev.away_team);
      const draw = bestH2h.get('Draw');

      return {
        eventId: ev.id,
        homeTeam: ev.home_team,
        awayTeam: ev.away_team,
        commenceTime: ev.commence_time,
        bookmakers: bookmakerCount,
        h2h: home !== undefined && away !== undefined && draw !== undefined ? { home, draw, away } : null,
      };
    });
  });
}

// ── Per-match markets (billed per market returned) ───────────────────────

export interface TotalsLine {
  point: number;
  over: number;
  under: number;
}

/** Everything priced for ONE match beyond 1X2. Any key can be absent — the books simply may not list it. */
export interface EventMarkets {
  btts?: { yes: number; no: number };
  btts_h1?: { yes: number; no: number };
  draw_no_bet?: { home: number; away: number };
  double_chance?: Record<DoubleChanceSel, number>;
  double_chance_h1?: Record<DoubleChanceSel, number>;
  totals?: TotalsLine[]; // total-goals ladder, ascending by line
  team_totals?: { home: TotalsLine[]; away: TotalsLine[] };
  halftime_fulltime?: Partial<Record<HtFtSel, number>>;
}

const DOUBLE_CHANCE_ORDER: DoubleChanceSel[] = ['1x', '12', 'x2'];
const HTFT_ORDER: HtFtSel[] = ['1/1', '1/x', '1/2', 'x/1', 'x/x', 'x/2', '2/1', '2/x', '2/2'];

function sameTeam(a: string | undefined, b: string): boolean {
  return !!a && normalizeTeamName(a) === normalizeTeamName(b);
}

/**
 * Best price with a guard against one wild outlier: with 3+ quotes, anything
 * more than 1.5x the median is ignored. Alternate lines are often priced by
 * only a handful of books, and a single stale/odd quote must not become the
 * payout multiplier (same lesson as the h2h_lay incident above).
 */
function robustBest(prices: number[]): number | undefined {
  if (!prices.length) return undefined;
  if (prices.length < 3) return Math.max(...prices);
  const sorted = [...prices].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return Math.max(...prices.filter((p) => p <= median * 1.5));
}

/** Every outcome of ONE exact market key, pooled across all bookmakers. */
function outcomesFor(ev: OddsApiEvent, marketKey: string): OddsApiOutcome[] {
  const all: OddsApiOutcome[] = [];
  for (const bm of ev.bookmakers ?? []) {
    const market = (bm.markets ?? []).find((m) => m.key === marketKey);
    if (market) all.push(...market.outcomes);
  }
  return all;
}

/** Groups outcomes into named buckets (null = skip) and returns the robust best price per bucket. */
function bestByBucket(outcomes: OddsApiOutcome[], bucketOf: (o: OddsApiOutcome) => string | null): Map<string, number> {
  const prices = new Map<string, number[]>();
  for (const o of outcomes) {
    const bucket = bucketOf(o);
    if (bucket === null) continue;
    const list = prices.get(bucket);
    if (list) list.push(o.price);
    else prices.set(bucket, [o.price]);
  }
  const best = new Map<string, number>();
  for (const [bucket, list] of prices) {
    const value = robustBest(list);
    if (value !== undefined) best.set(bucket, value);
  }
  return best;
}

function warnUnparsed(eventLabel: string, marketKey: string, names: Set<string>): void {
  if (names.size) console.warn(`[sportybet] ${eventLabel} ${marketKey}: unrecognized outcome names ignored: ${[...names].join(' | ')}`);
}

function parseYesNo(outcomes: OddsApiOutcome[]): { yes: number; no: number } | undefined {
  const best = bestByBucket(outcomes, (o) => {
    const n = o.name.trim().toLowerCase();
    return n === 'yes' ? 'yes' : n === 'no' ? 'no' : null;
  });
  const yes = best.get('yes');
  const no = best.get('no');
  return yes !== undefined && no !== undefined ? { yes, no } : undefined;
}

function parseDrawNoBet(outcomes: OddsApiOutcome[], home: string, away: string): { home: number; away: number } | undefined {
  const best = bestByBucket(outcomes, (o) => (sameTeam(o.name, home) ? 'home' : sameTeam(o.name, away) ? 'away' : null));
  const h = best.get('home');
  const a = best.get('away');
  return h !== undefined && a !== undefined ? { home: h, away: a } : undefined;
}

/**
 * Double-chance outcome names aren't guaranteed to be in any one shape
 * ("Arsenal or Draw", "Draw or Chelsea", "Home or Draw", "1X"), so classify by
 * WHICH of {home, draw, away} the name mentions rather than by exact string.
 */
export function classifyDoubleChance(name: string, home: string, away: string): DoubleChanceSel | null {
  const n = normalizeTeamName(name);
  if (n === '1x' || n === '12' || n === 'x2') return n;
  const hasDraw = /\bdraw\b|\btie\b/.test(n);
  const hasHome = n.includes(normalizeTeamName(home)) || /\bhome\b/.test(n);
  const hasAway = n.includes(normalizeTeamName(away)) || /\baway\b/.test(n);
  if (hasDraw && hasHome && !hasAway) return '1x';
  if (hasDraw && hasAway && !hasHome) return 'x2';
  if (hasHome && hasAway && !hasDraw) return '12';
  return null;
}

function parseDoubleChance(
  outcomes: OddsApiOutcome[],
  home: string,
  away: string,
  warn: Set<string>
): Record<DoubleChanceSel, number> | undefined {
  const best = bestByBucket(outcomes, (o) => {
    const c = classifyDoubleChance(o.name, home, away);
    if (!c) warn.add(o.name);
    return c;
  });
  const a = best.get('1x');
  const b = best.get('12');
  const c = best.get('x2');
  return a !== undefined && b !== undefined && c !== undefined ? { '1x': a, '12': b, x2: c } : undefined;
}

/** "Arsenal/Draw" (or "Arsenal - Draw") -> 'x/...' style selection; null if either half isn't recognisable. */
export function parseHtFtName(name: string, home: string, away: string): HtFtSel | null {
  const parts = name.split(/\s*\/\s*|\s+-\s+/);
  if (parts.length !== 2) return null;
  const code = (p: string): '1' | 'x' | '2' | null => {
    const t = p.trim().toLowerCase();
    if (sameTeam(p, home) || t === 'home') return '1';
    if (sameTeam(p, away) || t === 'away') return '2';
    if (t === 'draw' || t === 'x' || t === 'tie') return 'x';
    return null;
  };
  const ht = code(parts[0]);
  const ft = code(parts[1]);
  return ht && ft ? (`${ht}/${ft}` as HtFtSel) : null;
}

function parseHtFt(outcomes: OddsApiOutcome[], home: string, away: string, warn: Set<string>): Partial<Record<HtFtSel, number>> | undefined {
  const best = bestByBucket(outcomes, (o) => {
    const sel = parseHtFtName(o.name, home, away);
    if (!sel) warn.add(o.name);
    return sel;
  });
  // A complete 9-way market or nothing — a half-priced HT/FT book would be a trap.
  if (best.size < HTFT_ORDER.length) return undefined;
  const out: Partial<Record<HtFtSel, number>> = {};
  for (const sel of HTFT_ORDER) out[sel] = best.get(sel);
  return out;
}

/** Keeps at most MAX_LADDER_LINES lines, centred on the "main" line (the one whose over/under prices are closest to even). */
function trimLadder(lines: TotalsLine[]): TotalsLine[] {
  const sorted = [...lines].sort((a, b) => a.point - b.point);
  if (sorted.length <= MAX_LADDER_LINES) return sorted;
  const main = sorted.reduce((best, l) => (Math.abs(l.over - l.under) < Math.abs(best.over - best.under) ? l : best));
  return [...sorted]
    .sort((a, b) => Math.abs(a.point - main.point) - Math.abs(b.point - main.point) || a.point - b.point)
    .slice(0, MAX_LADDER_LINES)
    .sort((a, b) => a.point - b.point);
}

function parseLadder(outcomes: OddsApiOutcome[]): TotalsLine[] {
  const best = bestByBucket(outcomes, (o) => {
    if (o.point === undefined) return null;
    const side = o.name.trim().toLowerCase();
    return side === 'over' || side === 'under' ? `${o.point}|${side}` : null;
  });
  const points = new Set<number>();
  for (const bucket of best.keys()) points.add(Number(bucket.split('|')[0]));

  const lines: TotalsLine[] = [];
  for (const point of points) {
    if (!Number.isInteger(point * 2)) continue; // quarter lines settle as half-win/half-loss — not supported
    const over = best.get(`${point}|over`);
    const under = best.get(`${point}|under`);
    if (over !== undefined && under !== undefined) lines.push({ point, over, under });
  }
  return trimLadder(lines);
}

/** Pure: raw event JSON -> EventMarkets. Exported so it can be tested without spending a credit. */
export function parseEventMarkets(ev: OddsApiEvent, keys: readonly string[]): EventMarkets {
  const home = ev.home_team;
  const away = ev.away_team;
  const label = `${home} v ${away}`;
  const out: EventMarkets = {};

  for (const key of keys) {
    const outcomes = outcomesFor(ev, key);
    if (!outcomes.length) continue;
    const unparsed = new Set<string>();

    switch (key) {
      case 'btts': {
        const v = parseYesNo(outcomes);
        if (v) out.btts = v;
        break;
      }
      case 'btts_h1': {
        const v = parseYesNo(outcomes);
        if (v) out.btts_h1 = v;
        break;
      }
      case 'draw_no_bet': {
        const v = parseDrawNoBet(outcomes, home, away);
        if (v) out.draw_no_bet = v;
        break;
      }
      case 'double_chance': {
        const v = parseDoubleChance(outcomes, home, away, unparsed);
        if (v) out.double_chance = v;
        break;
      }
      case 'double_chance_h1': {
        const v = parseDoubleChance(outcomes, home, away, unparsed);
        if (v) out.double_chance_h1 = v;
        break;
      }
      case 'alternate_totals': {
        const ladder = parseLadder(outcomes);
        if (ladder.length) out.totals = ladder;
        break;
      }
      case 'alternate_team_totals': {
        // The team a line belongs to rides in outcome.description.
        const homeLines = parseLadder(outcomes.filter((o) => sameTeam(o.description, home)));
        const awayLines = parseLadder(outcomes.filter((o) => sameTeam(o.description, away)));
        if (homeLines.length || awayLines.length) out.team_totals = { home: homeLines, away: awayLines };
        else console.warn(`[sportybet] ${label} ${key}: no outcome carried a recognisable team in "description" — market skipped`);
        break;
      }
      case 'halftime_fulltime': {
        const v = parseHtFt(outcomes, home, away, unparsed);
        if (v) out.halftime_fulltime = v;
        break;
      }
    }
    warnUnparsed(label, key, unparsed);
  }
  return out;
}

async function fetchEventBundle(eventId: string, keys: readonly string[], tag: 'core' | 'extra'): Promise<EventMarkets> {
  return persistentCached<EventMarkets>(`evodds_${eventId}_${tag}`, EVENT_ODDS_CACHE_TTL_MS, async () => {
    await assertCreditBudget(keys.length); // worst case: every requested market comes back
    const url = `${ODDS_API_BASE}/sports/soccer_epl/events/${eventId}/odds/?regions=uk&markets=${keys.join(',')}&oddsFormat=decimal&apiKey=${ODDS_API_KEY}`;
    const res = await fetch(url);
    await recordUsage(res, `event ${eventId} ${tag}`);
    if (!res.ok) throw new Error(`The Odds API event odds (${tag}) responded ${res.status}`);
    const ev = (await res.json()) as OddsApiEvent;

    const returned = new Set<string>();
    for (const bm of ev.bookmakers ?? []) for (const m of bm.markets ?? []) returned.add(m.key);
    const parsed = parseEventMarkets(ev, keys);
    console.log(
      `[sportybet] event ${eventId} ${tag}: books returned [${[...returned].join(', ') || 'nothing'}] -> offering [${Object.keys(parsed).join(', ') || 'nothing'}]`
    );
    return parsed;
  });
}

/** CORE bundle (btts, double chance, draw no bet, goal ladders). <= 5 credits, cached 24h. Call when a match is opened. */
export function fetchCoreMarkets(eventId: string): Promise<EventMarkets> {
  return fetchEventBundle(eventId, CORE_MARKET_KEYS, 'core');
}

/** EXTRA bundle (1st-half BTTS / double chance, HT/FT). <= 3 credits, cached 24h. Call ONLY on an explicit "More markets" tap. */
export function fetchExtraMarkets(eventId: string): Promise<EventMarkets> {
  return fetchEventBundle(eventId, EXTRA_MARKET_KEYS, 'extra');
}

/** The EXTRA bundle if it's already been bought and is still fresh — never spends a credit. null = not fetched yet. */
export function getCachedExtraMarkets(eventId: string): Promise<EventMarkets | null> {
  return peekPersisted<EventMarkets>(`evodds_${eventId}_extra`);
}

// ── Turning EventMarkets into pick-able options (shared by the UI) ───────

export interface MarketOption {
  selection: Selection;
  point?: number;
  team?: TeamSide;
  odds: number;
}

/** Markets that actually have prices for this fixture, most popular first. */
export function availableMarkets(fixture: FixtureWithOdds, em: EventMarkets): Market[] {
  const markets: Market[] = [];
  if (fixture.h2h) markets.push('1x2');
  if (em.totals?.length) markets.push('totals');
  if (em.btts) markets.push('btts');
  if (em.double_chance) markets.push('double_chance');
  if (em.draw_no_bet) markets.push('draw_no_bet');
  if (em.team_totals && (em.team_totals.home.length || em.team_totals.away.length)) markets.push('team_totals');
  if (em.btts_h1) markets.push('btts_h1');
  if (em.double_chance_h1) markets.push('double_chance_h1');
  if (em.halftime_fulltime) markets.push('halftime_fulltime');
  return markets;
}

/** The individual selections (with their odds) a player can pick inside one market. */
export function getMarketOptions(market: Market, fixture: FixtureWithOdds, em: EventMarkets, team?: TeamSide): MarketOption[] {
  const ladder = (lines: TotalsLine[] = [], side?: TeamSide): MarketOption[] =>
    lines.flatMap((l): MarketOption[] => [
      { selection: 'over', point: l.point, team: side, odds: l.over },
      { selection: 'under', point: l.point, team: side, odds: l.under },
    ]);
  const yesNo = (v?: { yes: number; no: number }): MarketOption[] =>
    v ? [{ selection: 'yes', odds: v.yes }, { selection: 'no', odds: v.no }] : [];
  const doubleChance = (v?: Record<DoubleChanceSel, number>): MarketOption[] =>
    v ? DOUBLE_CHANCE_ORDER.map((sel): MarketOption => ({ selection: sel, odds: v[sel] })) : [];

  switch (market) {
    case '1x2':
      return fixture.h2h
        ? [
            { selection: 'home', odds: fixture.h2h.home },
            { selection: 'draw', odds: fixture.h2h.draw },
            { selection: 'away', odds: fixture.h2h.away },
          ]
        : [];
    case 'totals':
      return ladder(em.totals);
    case 'team_totals':
      return team ? ladder(em.team_totals?.[team], team) : [];
    case 'btts':
      return yesNo(em.btts);
    case 'btts_h1':
      return yesNo(em.btts_h1);
    case 'draw_no_bet':
      return em.draw_no_bet
        ? [
            { selection: 'home', odds: em.draw_no_bet.home },
            { selection: 'away', odds: em.draw_no_bet.away },
          ]
        : [];
    case 'double_chance':
      return doubleChance(em.double_chance);
    case 'double_chance_h1':
      return doubleChance(em.double_chance_h1);
    case 'halftime_fulltime':
      return HTFT_ORDER.filter((sel) => em.halftime_fulltime?.[sel] !== undefined).map(
        (sel): MarketOption => ({ selection: sel, odds: em.halftime_fulltime![sel]! })
      );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Team-name normalization & fixture/odds join
//
// football-data.org uses official names ("Arsenal FC", "AFC Bournemouth",
// "Brighton & Hove Albion FC"); The Odds API uses shorter ones ("Arsenal",
// API) uses shorter ones ("Arsenal", "Bournemouth", "Brighton and Hove
// Albion"). Never compare these with === — normalize both sides first.
// ─────────────────────────────────────────────────────────────────────────

export function normalizeTeamName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\bafc\b/g, '')
    .replace(/\bfc\b/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function sameCalendarDay(isoA: string, isoB: string): boolean {
  return new Date(isoA).toISOString().slice(0, 10) === new Date(isoB).toISOString().slice(0, 10);
}

// Only for clubs where stripping FC/AFC alone doesn't land on the name
// people actually use — either because it's a genuinely different nickname
// (Wolverhampton Wanderers -> Wolves) or because two clubs would otherwise
// collide (Manchester United AND Manchester City would both reduce to just
// "Manchester", which would make fixtures/bets ambiguous — a real bug, not
// just a style nitpick). Anything not listed here falls through to the
// FC/AFC-stripped official name, which is already fine on its own
// (Arsenal, Chelsea, Everton, Brentford, Fulham, etc.).
const CLUB_SHORT_NAME_OVERRIDES: Record<string, string> = {
  'manchester united': 'Man United',
  'manchester city': 'Man City',
  'wolverhampton wanderers': 'Wolves',
  'west ham united': 'West Ham',
  'west bromwich albion': 'West Brom',
  'sheffield united': 'Sheffield Utd',
  'sheffield wednesday': 'Sheffield Wed',
  'nottingham forest': "Nott'm Forest",
  'newcastle united': 'Newcastle',
  'leeds united': 'Leeds',
  'leicester city': 'Leicester',
  'norwich city': 'Norwich',
  'stoke city': 'Stoke',
  'swansea city': 'Swansea',
  'cardiff city': 'Cardiff',
  'ipswich town': 'Ipswich',
  'luton town': 'Luton',
  'coventry city': 'Coventry',
  'tottenham hotspur': 'Tottenham',
  'brighton hove albion': 'Brighton',
  'birmingham city': 'Birmingham',
  'queens park rangers': 'QPR',
  'wigan athletic': 'Wigan',
  'blackburn rovers': 'Blackburn',
  'preston north end': 'Preston',
  'huddersfield town': 'Huddersfield',
  'derby county': 'Derby',
};

/**
 * Short, casual display name for a club — "Tottenham" not "Tottenham
 * Hotspur FC", "Brighton" not "Brighton & Hove Albion FC". DISPLAY ONLY:
 * call this at render time; never store its output. Settlement and coupon
 * matching always run on the full official name (leg.homeTeam/awayTeam,
 * FixtureWithOdds.homeTeam/awayTeam) via normalizeTeamName above — shortening
 * those in place would silently break the join against football-data.org's
 * results by settlement time.
 */
export function shortClubName(officialName: string): string {
  const stripped = officialName
    .replace(/^AFC\s+/i, '')
    .replace(/\s+(AFC|FC)$/i, '')
    .trim();
  const key = stripped.toLowerCase().replace(/&/g, '').replace(/\s+/g, ' ').trim();
  return CLUB_SHORT_NAME_OVERRIDES[key] || stripped;
}

export function joinFixturesWithOdds(fixtures: FootballDataMatch[], tips: OddsTip[]): FixtureWithOdds[] {
  return fixtures.map((fx) => {
    const kickoff = fx.utcDate; // already ISO UTC — football-data.org needs no date parsing
    const home = normalizeTeamName(fx.homeTeam.name);
    const away = normalizeTeamName(fx.awayTeam.name);
    const tip = tips.find(
      (t) =>
        normalizeTeamName(t.homeTeam) === home &&
        normalizeTeamName(t.awayTeam) === away &&
        sameCalendarDay(t.commenceTime, kickoff)
    );

    return {
      eventId: tip?.eventId ?? null,
      homeTeam: fx.homeTeam.name,
      awayTeam: fx.awayTeam.name,
      kickoff,
      matchday: fx.matchday,
      h2h: tip?.h2h ?? null,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Coupon math
// ─────────────────────────────────────────────────────────────────────────

/**
 * Product of every non-voided leg's odds. A coupon where every leg ends up
 * voided naturally resolves to 1x (i.e. a stake refund) — that's intentional,
 * not a bug: there's nothing left to have won or lost.
 */
export function computeCombinedOdds(legs: Leg[]): number {
  return legs.filter((l) => l.status !== 'voided').reduce((acc, l) => acc * l.oddsAtPlacement, 1);
}

export function computePotentialPayout(stake: number, legs: Leg[]): number {
  return Math.round(stake * computeCombinedOdds(legs) * 100) / 100;
}

// ─────────────────────────────────────────────────────────────────────────
// Placing a coupon
// ─────────────────────────────────────────────────────────────────────────

export interface PlaceCouponPick {
  homeTeam: string;
  awayTeam: string;
  kickoff: string;
  market: Market;
  selection: Selection;
  point?: number; // required for 'totals' / 'team_totals' — the over/under line
  team?: TeamSide; // required for 'team_totals'
  odds: number;
}

export type PlaceCouponResult =
  | { success: true; coupon: Coupon }
  | {
      success: false;
      reason: 'invalid_stake' | 'too_many_legs' | 'duplicate_match' | 'insufficient_funds' | 'no_legs' | 'betting_closed';
    };

export async function placeCoupon(userId: string, stake: number, picks: PlaceCouponPick[]): Promise<PlaceCouponResult> {
  const uid = cleanJid(userId);
  if (!picks.length) return { success: false, reason: 'no_legs' };
  if (picks.length > MAX_LEGS_PER_COUPON) return { success: false, reason: 'too_many_legs' };
  if (!Number.isFinite(stake) || stake < MIN_STAKE || stake > MAX_STAKE) {
    return { success: false, reason: 'invalid_stake' };
  }

  const matchKeys = picks.map((p) => `${normalizeTeamName(p.homeTeam)}|${normalizeTeamName(p.awayTeam)}`);
  if (new Set(matchKeys).size !== matchKeys.length) return { success: false, reason: 'duplicate_match' };

  // Pre-match only: refuse anything at/after the cutoff, checked BEFORE any coins move. This is
  // also what keeps the 1st-half markets from ever being bettable once the match is under way.
  const now = Date.now();
  if (picks.some((p) => new Date(p.kickoff).getTime() - now < BETTING_CUTOFF_MS)) {
    return { success: false, reason: 'betting_closed' };
  }

  const legCount = picks.length;
  const { success } = await deductCoins(uid, stake, {
    type: 'sportybet',
    note: `Sportybet coupon stake (${legCount} leg${legCount > 1 ? 's' : ''})`,
  });
  if (!success) return { success: false, reason: 'insufficient_funds' };

  await contributeToJackpot(stake);
  await recordHouseActivity(stake, 0);

  const legs: Leg[] = picks.map((p) => ({
    id: `leg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    homeTeam: p.homeTeam,
    awayTeam: p.awayTeam,
    kickoff: p.kickoff,
    market: p.market,
    selection: p.selection,
    point: p.point,
    team: p.team,
    oddsAtPlacement: p.odds,
    status: 'pending',
  }));

  const coupon: Coupon = {
    id: `cp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    userId: uid,
    stake,
    legs,
    combinedOdds: computeCombinedOdds(legs),
    potentialPayout: computePotentialPayout(stake, legs),
    status: 'pending',
    placedAt: Date.now(),
  };

  const existing: Coupon[] = (await couponsByUser.get(uid)) || [];
  existing.unshift(coupon);
  if (existing.length > MAX_COUPONS_PER_USER) existing.length = MAX_COUPONS_PER_USER;
  await couponsByUser.set(uid, existing);

  return { success: true, coupon };
}

// ─────────────────────────────────────────────────────────────────────────
// Reading coupons back (for the "My Bets" screen)
// ─────────────────────────────────────────────────────────────────────────

export async function getUserCoupons(userId: string): Promise<Coupon[]> {
  return (await couponsByUser.get(cleanJid(userId))) || [];
}

export async function getCoupon(userId: string, couponId: string): Promise<Coupon | null> {
  const list = await getUserCoupons(userId);
  return list.find((c) => c.id === couponId) || null;
}

// ─────────────────────────────────────────────────────────────────────────
// Settlement — call this from a scheduled poll (same schedules/cron pattern
// as forex's background watcher). Fetches the full season match list once per pass and
// checks it against every leg still pending, across every user.
// ─────────────────────────────────────────────────────────────────────────

const HALF_TIME_MARKETS: ReadonlySet<Market> = new Set<Market>(['btts_h1', 'double_chance_h1', 'halftime_fulltime']);

/** '1' home ahead, '2' away ahead, 'x' level. */
function resultCode(home: number, away: number): '1' | 'x' | '2' {
  return home > away ? '1' : home < away ? '2' : 'x';
}

function doubleChanceWins(selection: Selection, home: number, away: number): boolean {
  const r = resultCode(home, away);
  if (selection === '1x') return r !== '2';
  if (selection === 'x2') return r !== '1';
  return r !== 'x'; // '12'
}

/** Over/under on a line. A whole-number line landing exactly on it is a push -> the leg is voided (stake stays in the coupon at 1.00). */
function settleLine(total: number, point: number, selection: Selection): 'won' | 'lost' | 'void' {
  if (total === point) return 'void';
  return (selection === 'over') === (total > point) ? 'won' : 'lost';
}

/**
 * Resolves one leg against its match, given the leg's own market — 1x2 uses
 * football-data.org's score.winner directly; every other market is computed
 * from score.fullTime (and score.halfTime for the 1st-half markets), no
 * separate data source needed. Returns null while the match still has nothing
 * decided yet — including a half-time market whose half-time score hasn't been
 * recorded, which is left pending rather than guessed.
 *
 * Void rules: draw no bet on a draw; a whole-number over/under line landing
 * exactly on the line; postponed/suspended/cancelled matches. A voided leg
 * drops out of the combined odds exactly like a postponed match already does.
 */
export function resolveLegResult(leg: Leg, match: FootballDataMatch): 'won' | 'lost' | 'void' | null {
  if (['POSTPONED', 'SUSPENDED', 'CANCELLED'].includes(match.status)) return 'void';
  if (match.status !== 'FINISHED') return null; // SCHEDULED / LIVE / IN_PLAY / PAUSED — still genuinely pending

  const home = match.score.fullTime.home;
  const away = match.score.fullTime.away;
  if (home === null || away === null) return null; // FINISHED but no score recorded yet — leave pending rather than guess

  let htHome: number | null = null;
  let htAway: number | null = null;
  if (HALF_TIME_MARKETS.has(leg.market)) {
    htHome = match.score.halfTime?.home ?? null;
    htAway = match.score.halfTime?.away ?? null;
    if (htHome === null || htAway === null) return null;
  }

  switch (leg.market) {
    case '1x2':
      if (match.score.winner === 'HOME_TEAM') return leg.selection === 'home' ? 'won' : 'lost';
      if (match.score.winner === 'AWAY_TEAM') return leg.selection === 'away' ? 'won' : 'lost';
      if (match.score.winner === 'DRAW') return leg.selection === 'draw' ? 'won' : 'lost';
      return null; // unrecognized winner value — leave pending rather than guess

    case 'totals':
      return settleLine(home + away, leg.point ?? 2.5, leg.selection);

    case 'team_totals':
      if (!leg.team) return null; // can't tell whose goals — leave pending rather than guess
      return settleLine(leg.team === 'home' ? home : away, leg.point ?? 1.5, leg.selection);

    case 'btts':
      return (leg.selection === 'yes') === (home > 0 && away > 0) ? 'won' : 'lost';

    case 'btts_h1':
      return (leg.selection === 'yes') === (htHome! > 0 && htAway! > 0) ? 'won' : 'lost';

    case 'draw_no_bet':
      if (home === away) return 'void';
      return (leg.selection === 'home') === (home > away) ? 'won' : 'lost';

    case 'double_chance':
      return doubleChanceWins(leg.selection, home, away) ? 'won' : 'lost';

    case 'double_chance_h1':
      return doubleChanceWins(leg.selection, htHome!, htAway!) ? 'won' : 'lost';

    case 'halftime_fulltime': {
      const [ht, ft] = leg.selection.split('/');
      return resultCode(htHome!, htAway!) === ht && resultCode(home, away) === ft ? 'won' : 'lost';
    }

    default:
      return null; // a market this build doesn't know how to settle — leave pending rather than guess
  }
}

/** "2 - 1", plus the half-time score for 1st-half markets so My Bets shows what the leg was judged on. */
function formatFinalScore(leg: Leg, match: FootballDataMatch): string {
  const base = `${match.score.fullTime.home} - ${match.score.fullTime.away}`;
  const ht = match.score.halfTime;
  if (HALF_TIME_MARKETS.has(leg.market) && ht && ht.home !== null && ht.away !== null) return `${base}, HT ${ht.home} - ${ht.away}`;
  return base;
}

/**
 * One settlement pass at a time. Safe to call from several places (the built-in
 * poller below AND any scheduler you already have): an overlapping call returns
 * straight away instead of racing the running pass and double-crediting a win.
 */
let settlementInFlight = false;

export async function pollAndSettleCoupons(): Promise<{ couponsChecked: number; couponsSettled: number }> {
  if (settlementInFlight) return { couponsChecked: 0, couponsSettled: 0 };
  settlementInFlight = true;
  try {
    return await runSettlementPass();
  } finally {
    settlementInFlight = false;
  }
}

const SETTLEMENT_POLL_MS = 5 * 60_000;

/**
 * Starts the background settlement loop (idempotent — calling it twice, or after
 * a hot reload, never starts a second timer). Runs one pass immediately so
 * anything that finished while the bot was offline settles on startup.
 * Costs football-data.org calls only (the season list is cached for 60s);
 * it never touches The Odds API credits.
 */
export function startCouponSettlementPoller(intervalMs: number = SETTLEMENT_POLL_MS): void {
  const g = globalThis as any;
  if (g.__sportybetSettlementTimer) return;

  const tick = async () => {
    try {
      const { couponsChecked, couponsSettled } = await pollAndSettleCoupons();
      if (couponsSettled > 0) console.log(`[sportybet] settlement: ${couponsSettled} settled of ${couponsChecked} pending coupon(s)`);
    } catch (err) {
      console.error('[sportybet] settlement poll failed:', err);
    }
  };

  g.__sportybetSettlementTimer = setInterval(tick, intervalMs);
  g.__sportybetSettlementTimer.unref?.();
  void tick();
}

async function runSettlementPass(): Promise<{ couponsChecked: number; couponsSettled: number }> {
  const [allUsers, seasonMatches] = await Promise.all([
    couponsByUser.getAll() as Promise<Record<string, Coupon[]>>,
    fetchAllSeasonMatches(),
  ]);

  let couponsChecked = 0;
  let couponsSettled = 0;

  for (const [userId, coupons] of Object.entries(allUsers)) {
    let userChanged = false;

    for (const coupon of coupons) {
      if (coupon.status !== 'pending') continue;
      couponsChecked++;

      let legsChanged = false;
      for (const leg of coupon.legs) {
        if (leg.status !== 'pending') continue;
        const home = normalizeTeamName(leg.homeTeam);
        const away = normalizeTeamName(leg.awayTeam);
        const match = seasonMatches.find(
          (m) => normalizeTeamName(m.homeTeam.name) === home && normalizeTeamName(m.awayTeam.name) === away
        );
        if (!match) continue; // not in this payload — try again next poll

        const result = resolveLegResult(leg, match);
        if (result === null) continue; // still genuinely pending
        leg.status = result === 'void' ? 'voided' : result; // 'won' | 'lost' | 'voided'
        // A finished match shows its score even on a voided leg (draw no bet on a draw, a pushed line).
        // A postponed/cancelled match has no score to show.
        if (match.status === 'FINISHED' && match.score.fullTime.home !== null) leg.finalScore = formatFinalScore(leg, match);
        legsChanged = true;
      }

      if (!legsChanged) continue;
      userChanged = true;

      const hasLostLeg = coupon.legs.some((l) => l.status === 'lost');
      const allDecided = coupon.legs.every((l) => l.status !== 'pending');

      if (hasLostLeg) {
        // Accumulator dies the moment one leg loses — no need to wait on the rest.
        coupon.status = 'lost';
        coupon.settledAt = Date.now();
        couponsSettled++;
      } else if (allDecided) {
        coupon.combinedOdds = computeCombinedOdds(coupon.legs);
        coupon.potentialPayout = computePotentialPayout(coupon.stake, coupon.legs);
        let payout = 0;
        try {
          const pool = await getJackpotPool();
          const settled = settleWin(coupon.potentialPayout, pool); // floor-protected, same as every other game
          payout = settled.payout;
          await deductFromJackpot(payout);
          await recordHouseActivity(0, payout);
          await addCoins(userId, payout, {
            type: 'sportybet',
            note:
              `Sportybet coupon ${coupon.id} won (${coupon.legs.length} leg${coupon.legs.length > 1 ? 's' : ''})` +
              (settled.capped ? ' — capped, the bank could not cover the full payout' : ''),
          });
          coupon.status = 'won';
          coupon.actualPayout = payout;
          coupon.settledAt = Date.now();
          couponsSettled++;
        } catch (err) {
          // Compensate the pool for whatever was actually drawn out (the
          // capped amount, not the raw potentialPayout), and leave the
          // coupon 'pending' so the next poll retries — never silently
          // swallow a won coupon's credit.
          if (payout > 0) await contributeToJackpot(payout).catch(() => {});
          console.error(`[CRITICAL] sportybet payout failed for coupon ${coupon.id} (user ${userId}):`, err);
        }
      } else {
        // Some legs still pending — recompute live odds/payout so "My Bets"
        // reflects any legs that were just dropped as voided.
        coupon.combinedOdds = computeCombinedOdds(coupon.legs);
        coupon.potentialPayout = computePotentialPayout(coupon.stake, coupon.legs);
      }
    }

    if (userChanged) await couponsByUser.set(userId, coupons);
  }

  return { couponsChecked, couponsSettled };
}

// ─────────────────────────────────────────────────────────────────────────
// Display formatting — text only, no socket calls. plugins/sportybet.ts
// sends whatever this returns.
// ─────────────────────────────────────────────────────────────────────────

const LEG_EMOJI: Record<LegStatus, string> = {
  pending: '⏳',
  won: '✅',
  lost: '❌',
  voided: '🚫',
};

const COUPON_EMOJI: Record<CouponStatus, string> = {
  pending: '🟡',
  won: '🟢',
  lost: '🔴',
};

/** Short side name for a 1/x/2 code — "Arsenal", "Draw", "Man City". */
function sideName(code: string, home: string, away: string): string {
  return code === '1' ? home : code === '2' ? away : 'Draw';
}

function doubleChanceLabel(selection: Selection, home: string, away: string): string {
  if (selection === '1x') return `${home} or Draw`;
  if (selection === 'x2') return `Draw or ${away}`;
  return `${home} or ${away}`;
}

/** Shared with plugins/sportybet.ts's slip preview so a leg reads the same way everywhere. */
export function legPickLabel(leg: {
  market: Market;
  selection: Selection;
  homeTeam: string;
  awayTeam: string;
  point?: number;
  team?: TeamSide;
}): string {
  const home = shortClubName(leg.homeTeam);
  const away = shortClubName(leg.awayTeam);
  const overUnder = `${leg.selection === 'over' ? 'Over' : 'Under'} ${leg.point}`;

  switch (leg.market) {
    case '1x2':
      return leg.selection === 'home' ? home : leg.selection === 'away' ? away : 'Draw';
    case 'totals':
      return overUnder;
    case 'team_totals':
      return `${leg.team === 'away' ? away : home} ${overUnder}`;
    case 'btts':
      return leg.selection === 'yes' ? 'BTTS: Yes' : 'BTTS: No';
    case 'btts_h1':
      return leg.selection === 'yes' ? '1H BTTS: Yes' : '1H BTTS: No';
    case 'draw_no_bet':
      return `${leg.selection === 'home' ? home : away} (Draw No Bet)`;
    case 'double_chance':
      return doubleChanceLabel(leg.selection, home, away);
    case 'double_chance_h1':
      return `1H ${doubleChanceLabel(leg.selection, home, away)}`;
    case 'halftime_fulltime': {
      const [ht, ft] = leg.selection.split('/');
      return `HT ${sideName(ht, home, away)} · FT ${sideName(ft, home, away)}`;
    }
    default:
      return String(leg.selection);
  }
}

export function formatCoupon(coupon: Coupon): string {
  const lines = coupon.legs.map((leg) => {
    const pick = legPickLabel(leg);
    const score = leg.finalScore ? ` (${leg.finalScore})` : '';
    return `${LEG_EMOJI[leg.status]} ${shortClubName(leg.homeTeam)} vs ${shortClubName(leg.awayTeam)} — ${pick} @ ${leg.oddsAtPlacement}${score}`;
  });

  const wasCapped = coupon.status === 'won' && coupon.actualPayout !== undefined && coupon.actualPayout < coupon.potentialPayout;
  const payoutLine =
    coupon.status === 'won'
      ? `Payout: ${formatNumber(coupon.actualPayout ?? coupon.potentialPayout)} coins` +
        (wasCapped ? ` _(capped from ${formatNumber(coupon.potentialPayout)} — the bank couldn't cover the full amount)_` : '')
      : `Potential payout: ${formatNumber(coupon.potentialPayout)} coins`;

  return [
    `🎟️ *Coupon ${coupon.id.slice(-6).toUpperCase()}* ${COUPON_EMOJI[coupon.status]} ${coupon.status.toUpperCase()}`,
    ...lines,
    ``,
    `Stake: ${formatNumber(coupon.stake)} coins`,
    `Combined odds: ${coupon.combinedOdds.toFixed(2)}x`,
    payoutLine,
  ].join('\n');
}