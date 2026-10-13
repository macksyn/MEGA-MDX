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
 * 2. Set FOOTBALL_DATA_API_TOKEN and ODDS_API_KEY in your environment. Each accepts
 *    SEVERAL keys separated by commas (FOOTBALL_DATA_API_TOKEN=tokenA,tokenB) —
 *    calls rotate / fail over between them automatically (see "API key pools").
 *    Malvin is no longer used anywhere in this file — fixtures/results come
 *    straight from football-data.org (Malvin's /epl/upcoming and
 *    /epl/matches turned out to be stuck serving stale matchday 1-2 data),
 *    and odds come straight from The Odds API (richer market access than
 *    Malvin's h2h-only wrapper allowed).
 */

import { createHash } from 'node:crypto';
import { createStore } from './pluginStore.js';
import { getWallet, addCoins, deductCoins, formatNumber } from './economy.js';
import { cleanJid } from './isOwner.js';
import { getJackpotPool, contributeToJackpot, deductFromJackpot, settleWin, recordHouseActivity } from './slotMachine.js';

// ─────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────

const FOOTBALL_DATA_BASE = 'https://api.football-data.org/v4';
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

// ── API key pools ────────────────────────────────────────────────────────
// Keys live in the environment, never in source (source gets committed to git). Each variable takes
// one key or a comma/space-separated list; the plural names ODDS_API_KEYS /
// FOOTBALL_DATA_API_TOKENS work too. With several keys:
//   football-data.org .... calls round-robin across the tokens (each has its own 10/min limit)
//                          and a 429 / 403 instantly retries on the next token.
//   The Odds API ......... the key with the most credits left is used first; a key that runs out
//                          (or is invalid) is skipped and the next one takes over. Each key keeps
//                          its own ODDS_CREDIT_RESERVE for the bulk list.
function parseKeyList(...raw: (string | undefined)[]): string[] {
  return [...new Set(raw.flatMap((r) => (r ?? '').split(/[\s,;]+/)).map((k) => k.trim()).filter(Boolean))];
}

const FOOTBALL_DATA_TOKENS = parseKeyList(process.env.FOOTBALL_DATA_API_TOKEN, process.env.FOOTBALL_DATA_API_TOKENS);
const ODDS_API_KEYS = parseKeyList(process.env.ODDS_API_KEY, process.env.ODDS_API_KEYS);
console.log(`[sportybet] ${FOOTBALL_DATA_TOKENS.length} football-data token(s), ${ODDS_API_KEYS.length} Odds API key(s) configured`);

/** Last 4 characters only — enough to tell keys apart in logs without leaking one. */
const keyTag = (key: string): string => `…${key.slice(-4)}`;

// football-data.org's limit is per-minute (10/min), so a short cache is plenty.
//
// The Odds API's free tier is a flat 500 CREDITS/month instead. What a call costs:
//   bulk  /sports/{sport_key}/odds ....... markets x regions   (one call PER LEAGUE)
//   event /events/{id}/odds .............. UNIQUE MARKETS ACTUALLY RETURNED x regions
//   event /events/{id}/markets ........... 1  (no longer used — see below)
// Because the event endpoint only bills for markets that come back, asking for
// a market the UK books don't list is free. That makes the old per-match
// "/markets availability check" (1 credit) pure waste: we just request the
// bundle and see what's returned.
//
// Spend plan (1 region = uk):
//   bulk h2h, 12h cache, PER LEAGUE ...... <= 2 calls/day x 1 credit  = <= 60/month/league
//   CORE bundle (<= 5 markets) ........... <= 5 credits per match, once per 24h,
//                                          only when a player opens that match
//   EXTRA bundle (<= 3 markets) .......... <= 3 credits per match, only if a player
//                                          taps "More markets"
//   reserve .............................. 40 credits per-match fetches never touch
// ~38 matches a month PER LEAGUE, so even if every one is opened (and half also tap
// "More markets") that's roughly 38x5 + 19x3 = ~250 per league, plus <= 60 bulk each.
// With three leagues the worst case (everything opened) can exceed 500 — which is what
// ODDS_CREDIT_RESERVE is for: per-match fetches simply stop (players keep 1X2 + the
// bulk list) while the account is within the reserve of empty, instead of overspending.
// All odds caches are also persisted to the plugin store, so a bot restart
// never re-buys odds that are still fresh.
const FIXTURES_CACHE_TTL_MS = 60_000;
const SEASON_MATCHES_CACHE_TTL_MS = 60_000;
const ODDS_CACHE_TTL_MS = 12 * 60 * 60_000; // bulk h2h, per league
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
// Leagues — add a league here and every flow (fixtures, odds, betting,
// settlement, the league pickers) picks it up. `footballDataCode` is the
// football-data.org competition code, `oddsSportKey` is The Odds API sport key.
// ─────────────────────────────────────────────────────────────────────────

export type LeagueId = 'PL' | 'PD' | 'CL';

export interface LeagueInfo {
  id: LeagueId;
  name: string;
  flag: string;
  footballDataCode: string;
  oddsSportKey: string;
}

export const LEAGUES: readonly LeagueInfo[] = [
  {
    id: 'PL',
    name: 'Premier League',
    flag: '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}', // England flag (swap for '⚽' if it shows as a black flag on an old phone)
    footballDataCode: 'PL',
    oddsSportKey: 'soccer_epl',
  },
  {
    id: 'PD',
    name: 'La Liga',
    flag: '\u{1F1EA}\u{1F1F8}', // Spain flag
    footballDataCode: 'PD', // football-data.org calls La Liga "Primera Division"
    oddsSportKey: 'soccer_spain_la_liga',
  },
  {
    id: 'CL',
    name: 'Champions League',
    flag: '\u{1F3C6}', // trophy
    footballDataCode: 'CL',
    oddsSportKey: 'soccer_uefa_champs_league',
  },
];

/** Coupons placed before La Liga existed carry no league — they are Premier League. */
export const DEFAULT_LEAGUE: LeagueId = 'PL';

export function getLeague(id: LeagueId | undefined | null): LeagueInfo {
  return LEAGUES.find((l) => l.id === (id ?? DEFAULT_LEAGUE)) ?? LEAGUES[0];
}

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

/** A match as returned by football-data.org's /v4/competitions/{code}/matches. */
interface FootballDataMatch {
  id: number;
  /** Not part of football-data.org's payload — stamped on by our fetchers so every match knows its league. */
  league?: LeagueId;
  utcDate: string; // ISO 8601 UTC
  status: string; // SCHEDULED | LIVE | IN_PLAY | PAUSED | FINISHED | POSTPONED | SUSPENDED | CANCELLED
  matchday: number;
  homeTeam: FootballDataTeam;
  awayTeam: FootballDataTeam;
  score: {
    winner: 'HOME_TEAM' | 'AWAY_TEAM' | 'DRAW' | null;
    /**
     * Knockout matches only: how the match ended. REGULAR = 90 min; EXTRA_TIME = 120 min;
     * PENALTY_SHOOTOUT = after a shootout. NOTE fullTime then INCLUDES extra time (and the
     * shootout), and `winner` is whoever went through — neither is the 90-minute result
     * these markets are priced on, so settlement reads regularTime instead (see scoreAfter90).
     */
    duration?: 'REGULAR' | 'EXTRA_TIME' | 'PENALTY_SHOOTOUT';
    regularTime?: { home: number | null; away: number | null };
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
  league: LeagueId;
  eventId: string | null; // null if no Odds API match was found for this fixture yet
  homeTeam: string; // official name — carried through to settlement
  awayTeam: string;
  kickoff: string; // ISO 8601 UTC
  matchday: number;
  h2h: { home: number; draw: number; away: number } | null;
}

export interface Leg {
  id: string;
  /** Missing on coupons placed before La Liga was added — treat as DEFAULT_LEAGUE. */
  league?: LeagueId;
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
const bookingCodesTable = root.table!('bookingCodes'); // booking code -> BookingCode

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

const fdCooldownUntil = new Map<string, number>(); // token -> epoch ms it's rate-limited until
let fdNext = 0;

async function footballDataGet<T>(path: string): Promise<T> {
  const tokens = FOOTBALL_DATA_TOKENS.length ? FOOTBALL_DATA_TOKENS : ['']; // no token = football-data's anonymous tier
  const start = fdNext++ % tokens.length; // round-robin, so the load (and the 10/min limit) is shared
  let lastStatus = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[(start + i) % tokens.length];
    // Skip a token that's cooling down after a 429 — unless it's the only one left to try.
    if ((fdCooldownUntil.get(token) ?? 0) > Date.now() && i < tokens.length - 1) continue;

    const res = await fetch(`${FOOTBALL_DATA_BASE}${path}`, { headers: { 'X-Auth-Token': token } });
    if (res.ok) return (await res.json()) as T;

    lastStatus = res.status;
    if (res.status === 429) {
      // football-data says how many seconds until the per-minute window resets
      const wait = Number(res.headers.get('x-requestcounter-reset') ?? res.headers.get('retry-after')) || 60;
      fdCooldownUntil.set(token, Date.now() + wait * 1000);
      console.warn(`[sportybet] football-data token ${keyTag(token)} rate-limited for ${wait}s — trying the next token`);
      continue;
    }
    if (res.status === 403) {
      console.warn(`[sportybet] football-data token ${keyTag(token)} may not access ${path} (403) — trying the next token`);
      continue;
    }
    break; // 400 / 404 / 5xx — another token won't change the answer
  }
  throw new Error(`football-data.org ${path} responded ${lastStatus}`);
}

/**
 * Future knockout rounds (Champions League) are listed before the teams are known — their
 * team names come back null. Every name-based step downstream would choke on those, so
 * they're dropped until the draw is made.
 */
function teamsKnown(m: FootballDataMatch): boolean {
  return !!m.homeTeam?.name && !!m.awayTeam?.name;
}

/** Bettable fixture list — not-yet-played matches of ONE league. */
export async function fetchUpcomingFixtures(league: LeagueId = DEFAULT_LEAGUE): Promise<FootballDataMatch[]> {
  const info = getLeague(league);
  return cached(`sportybet:upcoming:${info.id}`, FIXTURES_CACHE_TTL_MS, async () => {
    const data = await footballDataGet<FootballDataMatchesResponse>(`/competitions/${info.footballDataCode}/matches?status=SCHEDULED`);
    return data.matches.filter(teamsKnown).map((m): FootballDataMatch => ({ ...m, league: info.id }));
  });
}

/** Full-season match list (past/live/scheduled) of ONE league. */
export async function fetchAllSeasonMatches(league: LeagueId = DEFAULT_LEAGUE): Promise<FootballDataMatch[]> {
  const info = getLeague(league);
  return cached(`sportybet:season:${info.id}`, SEASON_MATCHES_CACHE_TTL_MS, async () => {
    const data = await footballDataGet<FootballDataMatchesResponse>(`/competitions/${info.footballDataCode}/matches`);
    return data.matches.filter(teamsKnown).map((m): FootballDataMatch => ({ ...m, league: info.id }));
  });
}

/**
 * Season matches for EVERY league, each stamped with its league — the settlement
 * source of truth and the Fixtures & Results feed. One league failing (rate limit,
 * a plan that doesn't cover it) never blanks the others; it's logged and skipped.
 * Only throws when every league failed.
 */
export async function fetchAllLeaguesSeasonMatches(): Promise<FootballDataMatch[]> {
  const results = await Promise.allSettled(LEAGUES.map((l) => fetchAllSeasonMatches(l.id)));
  const out: FootballDataMatch[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') out.push(...r.value);
    else console.error(`[sportybet] ${LEAGUES[i].name} season fetch failed:`, r.reason);
  });
  if (results.every((r) => r.status === 'rejected')) throw new Error('football-data.org: every league fetch failed');
  return out;
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
const oddsMetaTable = root.table!('oddsApiMeta'); // 'usage_<key hash>' -> { remaining, at }

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

// ── Per-key credit tracking ──────────────────────────────────────────────
// Each key's remaining credits come from The Odds API's own response headers. They're stored in the
// plugin store under a one-way hash of the key (never the key itself) so a restart still knows which
// key is nearly empty.

interface OddsKeyState {
  remaining?: number;
  at?: number; // when `remaining` was last read
  disabled?: boolean; // rejected as invalid this run — skipped until the bot restarts
}

const oddsKeyState = new Map<string, OddsKeyState>(); // keyed by the key itself (memory only)
const oddsKeyId = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 10);

async function loadOddsKeyState(key: string): Promise<OddsKeyState> {
  let st = oddsKeyState.get(key);
  if (st) return st;
  st = {};
  try {
    const stored = (await oddsMetaTable.get(`usage_${oddsKeyId(key)}`)) as { remaining?: number; at?: number } | null | undefined;
    if (stored && typeof stored.remaining === 'number') st = { remaining: stored.remaining, at: stored.at };
  } catch {
    /* no record yet — unknown */
  }
  oddsKeyState.set(key, st);
  return st;
}

/** Credits left on one key, or null if unknown / too old to trust (a new month may have reset it). */
async function oddsKeyRemaining(key: string): Promise<number | null> {
  const st = await loadOddsKeyState(key);
  if (typeof st.remaining !== 'number') return null;
  // A nearly-empty key is re-probed daily (a failed probe is free); a healthy one weekly.
  const staleAfter = st.remaining <= ODDS_CREDIT_RESERVE ? 24 * 60 * 60_000 : 7 * 24 * 60 * 60_000;
  if (st.at && Date.now() - st.at > staleAfter) return null;
  return st.remaining;
}

async function setOddsKeyRemaining(key: string, remaining: number): Promise<void> {
  const st = await loadOddsKeyState(key);
  st.remaining = remaining;
  st.at = Date.now();
  try {
    await oddsMetaTable.set(`usage_${oddsKeyId(key)}`, { remaining, at: st.at });
  } catch {
    /* best effort */
  }
}

/** Reads The Odds API's own usage headers after every call, logs the real cost, and remembers what's left on THAT key. */
async function recordUsage(res: Response, label: string, key: string): Promise<void> {
  const rawRemaining = res.headers.get('x-requests-remaining');
  const rawLast = res.headers.get('x-requests-last');
  // Number(null) is 0 — only trust a header that is actually present.
  const remaining = rawRemaining !== null && rawRemaining.trim() !== '' ? Number(rawRemaining) : NaN;
  const last = rawLast !== null && rawLast.trim() !== '' ? Number(rawLast) : NaN;

  if (Number.isFinite(remaining)) await setOddsKeyRemaining(key, remaining);
  console.log(
    `[sportybet] odds-api ${label} [key ${keyTag(key)}]: cost=${Number.isFinite(last) ? last : '?'} remaining=${Number.isFinite(remaining) ? remaining : '?'}`
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

/**
 * Keys that can afford this call, richest first. Per-match fetches additionally leave
 * ODDS_CREDIT_RESERVE on the key so the bulk fixture list keeps working; the bulk call may use it.
 * A key whose balance is unknown (never used / stale) counts as full, so it gets probed.
 */
async function eligibleOddsKeys(worstCaseCost: number, respectReserve: boolean): Promise<string[]> {
  const usable: { key: string; remaining: number | null }[] = [];
  for (const key of ODDS_API_KEYS) {
    if ((await loadOddsKeyState(key)).disabled) continue;
    const remaining = await oddsKeyRemaining(key);
    if (remaining !== null && remaining - worstCaseCost < (respectReserve ? ODDS_CREDIT_RESERVE : 0)) continue;
    usable.push({ key, remaining });
  }
  usable.sort((a, b) => (b.remaining ?? Infinity) - (a.remaining ?? Infinity));
  return usable.map((u) => u.key);
}

/** After a non-OK reply: should the next key be tried ('next'), or is the answer final whatever key we use ('fatal')? */
async function classifyOddsFailure(res: Response, key: string): Promise<'next' | 'fatal'> {
  let code = '';
  try {
    code = String(((await res.clone().json()) as { error_code?: string })?.error_code ?? '');
  } catch {
    /* body wasn't JSON */
  }

  if (code === 'OUT_OF_USAGE_CREDITS') {
    await setOddsKeyRemaining(key, 0);
    console.warn(`[sportybet] Odds API key ${keyTag(key)} is out of credits — switching to the next key`);
    return 'next';
  }
  if (res.status === 401 || res.status === 403) {
    (await loadOddsKeyState(key)).disabled = true;
    console.error(`[sportybet] Odds API key ${keyTag(key)} was rejected (${res.status} ${code || 'no code'}) — disabled until restart, trying the next key`);
    return 'next';
  }
  if (res.status === 429) {
    console.warn(`[sportybet] Odds API key ${keyTag(key)} hit the frequency limit — trying the next key`);
    return 'next';
  }
  return 'fatal'; // 404 unknown sport / event, 422 bad market… — a different key gets the same answer
}

/**
 * Every Odds API request goes through here: picks the best key that can afford it and fails over to
 * the next one when a key is out of credits, invalid or rate-limited. Returns the final Response —
 * callers still check `res.ok` for errors that no key can fix.
 */
async function oddsApiFetch(path: string, query: string, label: string, opts: { worstCaseCost: number; respectReserve: boolean }): Promise<Response> {
  if (!ODDS_API_KEYS.length) throw new Error('No Odds API key configured — set ODDS_API_KEY in the environment');

  const keys = await eligibleOddsKeys(opts.worstCaseCost, opts.respectReserve);
  if (!keys.length) {
    const why = `no Odds API key has enough credits (${ODDS_API_KEYS.length} configured, reserve ${ODDS_CREDIT_RESERVE})`;
    if (opts.respectReserve) throw new CreditBudgetError(`${why} — per-match fetch skipped`);
    throw new Error(`The Odds API: ${why}`);
  }

  let last: Response | null = null;
  for (const key of keys) {
    const res = await fetch(`${ODDS_API_BASE}${path}?${query}&apiKey=${key}`);
    await recordUsage(res, label, key);
    if (res.ok) return res;
    last = res;
    if ((await classifyOddsFailure(res, key)) === 'fatal') return res;
  }
  return last!; // every key failed in a way another key could have fixed — the caller reports the last status
}

// ── Bulk h2h (1 credit) ──────────────────────────────────────────────────

async function fetchOddsApiEvents(markets: string, league: LeagueId): Promise<OddsApiEvent[]> {
  const sportKey = getLeague(league).oddsSportKey;
  const res = await oddsApiFetch(`/sports/${sportKey}/odds/`, `regions=uk&markets=${markets}&oddsFormat=decimal`, `bulk ${sportKey} ${markets}`, {
    worstCaseCost: 1, // h2h x 1 region
    respectReserve: false,
  });
  if (!res.ok) throw new Error(`The Odds API responded ${res.status}`);
  return (await res.json()) as OddsApiEvent[];
}

/** Best (highest) UK price for h2h (1X2), across every bookmaker offering it. */
export async function fetchOddsTips(league: LeagueId = DEFAULT_LEAGUE): Promise<OddsTip[]> {
  // The Premier League keeps its original cache key so a restart right after this upgrade doesn't re-buy fresh odds.
  const cacheKey = league === DEFAULT_LEAGUE ? 'bulk_h2h' : `bulk_h2h_${league}`;
  return persistentCached<OddsTip[]>(cacheKey, ODDS_CACHE_TTL_MS, async () => {
    const events = await fetchOddsApiEvents('h2h', league);
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

async function fetchEventBundle(eventId: string, keys: readonly string[], tag: 'core' | 'extra', league: LeagueId): Promise<EventMarkets> {
  return persistentCached<EventMarkets>(`evodds_${eventId}_${tag}`, EVENT_ODDS_CACHE_TTL_MS, async () => {
    const res = await oddsApiFetch(
      `/sports/${getLeague(league).oddsSportKey}/events/${eventId}/odds/`,
      `regions=uk&markets=${keys.join(',')}&oddsFormat=decimal`,
      `event ${eventId} ${tag}`,
      { worstCaseCost: keys.length, respectReserve: true } // worst case: every requested market comes back
    );
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
export function fetchCoreMarkets(eventId: string, league: LeagueId = DEFAULT_LEAGUE): Promise<EventMarkets> {
  return fetchEventBundle(eventId, CORE_MARKET_KEYS, 'core', league);
}

/** EXTRA bundle (1st-half BTTS / double chance, HT/FT). <= 3 credits, cached 24h. Call ONLY on an explicit "More markets" tap. */
export function fetchExtraMarkets(eventId: string, league: LeagueId = DEFAULT_LEAGUE): Promise<EventMarkets> {
  return fetchEventBundle(eventId, EXTRA_MARKET_KEYS, 'extra', league);
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

/** Atlético -> Atletico, Alavés -> Alaves, München -> Munchen, and the letters NFD can't split (Bodø -> Bodo). */
function foldDiacritics(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ø/gi, (c) => (c === 'Ø' ? 'O' : 'o'))
    .replace(/æ/gi, (c) => (c === 'Æ' ? 'Ae' : 'ae'))
    .replace(/ß/g, 'ss')
    .replace(/ł/gi, (c) => (c === 'Ł' ? 'L' : 'l'))
    .replace(/đ/gi, (c) => (c === 'Đ' ? 'D' : 'd'))
    .replace(/ı/g, 'i');
}

export function normalizeTeamName(name: string): string {
  return foldDiacritics(name)
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
  // La Liga (keys are accent-free, after FC/CF stripping)
  'club atletico de madrid': 'Atlético', // "Atlético Madrid" would be 15 chars — one too wide for the fixtures feed
  'athletic club': 'Athletic Club',
  'ca osasuna': 'Osasuna',
  'rcd espanyol de barcelona': 'Espanyol',
  'rayo vallecano de madrid': 'Rayo Vallecano',
  'deportivo alaves': 'Alavés',
  'levante ud': 'Levante',
  'rc celta de vigo': 'Celta Vigo',
  'rcd mallorca': 'Mallorca',
  'real betis balompie': 'Real Betis',
  'real sociedad de futbol': 'Real Sociedad',
  'ud las palmas': 'Las Palmas',
  'cd leganes': 'Leganés',
  'real valladolid': 'Valladolid',
  'rc deportivo la coruna': 'Deportivo',
  'real racing club de santander': 'Racing Santander',
  // Champions League (keys are accent-free, after FC/AFC/CF stripping)
  'paris saint-germain': 'PSG',
  'bayern munchen': 'Bayern Munich',
  'internazionale milano': 'Inter Milan',
  'ssc napoli': 'Napoli',
  'atalanta bc': 'Atalanta',
  'as roma': 'Roma',
  'borussia dortmund': 'Dortmund',
  'bayer 04 leverkusen': 'Leverkusen',
  'eintracht frankfurt': 'Frankfurt',
  'vfb stuttgart': 'Stuttgart',
  'sporting clube de portugal': 'Sporting CP',
  'sl benfica': 'Benfica',
  'feyenoord rotterdam': 'Feyenoord',
  'club brugge kv': 'Club Brugge',
  'royale union saint-gilloise': 'Union SG',
  'galatasaray sk': 'Galatasaray',
  'fenerbahce sk': 'Fenerbahçe',
  'fk bodo/glimt': 'Bodø/Glimt',
  'qarabag fk': 'Qarabağ',
  'olympique de marseille': 'Marseille',
  'olympique lyonnais': 'Lyon',
  'as monaco': 'Monaco',
  'losc lille': 'Lille',
  'sc braga': 'Braga',
  'sk slavia praha': 'Slavia Praha',
  'ac sparta praha': 'Sparta Praha',
  'sk sturm graz': 'Sturm Graz',
  'bsc young boys': 'Young Boys',
  'fk crvena zvezda': 'Red Star',
  'celtic': 'Celtic',
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
    .replace(/^(AFC|FC)\s+/i, '')
    .replace(/\s+(AFC|FC|CF)$/i, '')
    .trim();
  const key = foldDiacritics(stripped)
    .toLowerCase()
    .replace(/&/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return CLUB_SHORT_NAME_OVERRIDES[key] || stripped;
}

// ── Fixture <-> odds name matching ───────────────────────────────────────
//
// football-data.org and The Odds API name clubs differently, and La Liga makes
// it much worse than the Premier League: "Club Atlético de Madrid" vs
// "Atlético Madrid", "RCD Espanyol de Barcelona" vs "Espanyol", "Athletic
// Club" vs "Athletic Bilbao". So the join compares NAME TOKENS, not strings:
// drop the legal-form noise (FC, CF, RCD, de, club...), then two names match
// when one's tokens are all inside the other's. An exact token match always
// wins over a subset match. Same-ish names can't cross-match by accident
// because BOTH teams and the match day must agree — and the join only ever
// compares ONE league's fixtures against that league's odds.
// This only bridges the two APIs; settlement and coupon identity still use
// football-data.org's official names, which are compared exactly.

const TEAM_NOISE_TOKENS = new Set(['afc', 'fc', 'cf', 'ud', 'cd', 'rcd', 'rc', 'sd', 'ca', 'sc', 'club', 'de', 'balompie', 'futbol', 'and']);

/** Nicknames the odds feed may use that share no token with the official name (normalised form -> normalised official). */
const TEAM_NAME_ALIASES: Record<string, string> = {
  wolves: 'wolverhampton wanderers',
  spurs: 'tottenham hotspur',
  'man utd': 'manchester united',
  'man united': 'manchester united',
  'man city': 'manchester city',
  'nottm forest': 'nottingham forest',
  'nott m forest': 'nottingham forest',
  // Champions League clubs — the odds feed uses English / short forms the official names don't contain
  'inter milan': 'internazionale milano',
  'bayern munich': 'bayern munchen',
  psg: 'paris saint germain',
  'sporting cp': 'sporting clube de portugal',
  lyon: 'olympique lyonnais',
  'slavia prague': 'slavia praha',
  'red star belgrade': 'crvena zvezda',
  'union st gilloise': 'union saint gilloise',
  'atletico de madrid': 'atletico madrid',
};

function teamTokens(name: string): Set<string> {
  const norm = normalizeTeamName(name);
  const canon = TEAM_NAME_ALIASES[norm] ?? norm;
  return new Set(canon.split(' ').filter((t) => t && !TEAM_NOISE_TOKENS.has(t)));
}

/** 2 = identical token sets, 1 = one is contained in the other, 0 = different clubs. */
function teamMatchScore(a: string, b: string): 0 | 1 | 2 {
  const ta = teamTokens(a);
  const tb = teamTokens(b);
  if (!ta.size || !tb.size) return 0;
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  if (![...small].every((t) => big.has(t))) return 0;
  return ta.size === tb.size ? 2 : 1;
}

/** football-data.org gives every club an official `name` AND a casual `shortName` ("Inter", "Bayern") — either may be what the odds feed echoes. */
function teamScoreVsOdds(team: FootballDataTeam, oddsName: string): 0 | 1 | 2 {
  const byName = teamMatchScore(team.name, oddsName);
  const byShort = team.shortName ? teamMatchScore(team.shortName, oddsName) : 0;
  return Math.max(byName, byShort) as 0 | 1 | 2;
}

const warnedNoOdds = new Set<string>();

function findTip(fx: FootballDataMatch, tips: OddsTip[]): OddsTip | undefined {
  let best: OddsTip | undefined;
  let bestScore = 0;
  for (const t of tips) {
    if (!sameCalendarDay(t.commenceTime, fx.utcDate)) continue;
    const h = teamScoreVsOdds(fx.homeTeam, t.homeTeam);
    const a = teamScoreVsOdds(fx.awayTeam, t.awayTeam);
    if (!h || !a) continue;
    if (h + a > bestScore) {
      best = t;
      bestScore = h + a;
    }
  }
  return best;
}

export function joinFixturesWithOdds(fixtures: FootballDataMatch[], tips: OddsTip[], league: LeagueId = DEFAULT_LEAGUE): FixtureWithOdds[] {
  return fixtures.map((fx) => {
    const kickoff = fx.utcDate; // already ISO UTC — football-data.org needs no date parsing
    const tip = findTip(fx, tips);

    // Odds are normally listed ~1-2 weeks out: a fixture inside that window with NO match
    // is almost always a naming gap between the two APIs — say so once, with both names.
    const soon = new Date(kickoff).getTime() - Date.now() < 7 * 24 * 60 * 60_000;
    const warnKey = `${fx.homeTeam.name}|${fx.awayTeam.name}`;
    if (!tip && tips.length && soon && !warnedNoOdds.has(warnKey)) {
      warnedNoOdds.add(warnKey);
      console.warn(
        `[sportybet] no odds match for ${fx.homeTeam.name} vs ${fx.awayTeam.name} (${kickoff.slice(0, 10)}). ` +
          `Odds feed names that day: ${tips.filter((t) => sameCalendarDay(t.commenceTime, kickoff)).map((t) => `${t.homeTeam} v ${t.awayTeam}`).join('; ') || 'none'}`
      );
    }

    return {
      league: fx.league ?? league,
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
  league?: LeagueId;
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
    league: p.league ?? DEFAULT_LEAGUE,
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
// Booking codes — share a slip, anyone loads it and bets their own stake
//
// A code stands for the SELECTIONS only (which match, which market, which pick) —
// never a stake and never a price. Loading re-prices every selection against today's
// odds, so a code can't be used to lock in an old, better price. The code is derived from
// the selections themselves (a hash), so the same slip always gets the same code no matter
// who shares it or in what order the legs were added. Records are tiny and de-duplicated
// that way, so nothing needs pruning yet.
// ─────────────────────────────────────────────────────────────────────────

export interface BookingLeg {
  league: LeagueId;
  homeTeam: string; // official football-data.org names — what fixtures and settlement use
  awayTeam: string;
  kickoff: string;
  market: Market;
  selection: Selection;
  point?: number;
  team?: TeamSide;
  /** The price when the code was made — only used to show "odds changed" on load, never to place a bet. */
  odds: number;
}

export interface BookingCode {
  code: string;
  key: string; // canonical form of the selections — detects hash collisions
  legs: BookingLeg[];
  createdBy: string;
  createdAt: number;
}

/** 31 characters: no I, L, O, 0 or 1 — nothing to misread when a code is typed from a screenshot. */
const BOOKING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const BOOKING_CODE_LENGTH = 6;

function toBookingLeg(item: PlaceCouponPick | Leg): BookingLeg {
  return {
    league: item.league ?? DEFAULT_LEAGUE,
    homeTeam: item.homeTeam,
    awayTeam: item.awayTeam,
    kickoff: item.kickoff,
    market: item.market,
    selection: item.selection,
    point: item.point,
    team: item.team,
    odds: 'oddsAtPlacement' in item ? item.oddsAtPlacement : item.odds,
  };
}

/** Order-independent identity of a slip: which picks, ignoring prices. */
function bookingKey(legs: BookingLeg[]): string {
  return legs
    .map((l) => [l.league, normalizeTeamName(l.homeTeam), normalizeTeamName(l.awayTeam), l.market, l.selection, l.point ?? '', l.team ?? ''].join('|'))
    .sort()
    .join(';');
}

function bookingCodeFor(key: string, salt: number): string {
  const digest = createHash('sha256').update(`${key}#${salt}`).digest();
  let code = '';
  for (let i = 0; i < BOOKING_CODE_LENGTH; i++) code += BOOKING_ALPHABET[digest[i] % BOOKING_ALPHABET.length];
  return code;
}

/** Makes (or re-finds) the booking code for a slip — works on picks being built or on a placed coupon's legs. */
export async function createBookingCode(userId: string, items: (PlaceCouponPick | Leg)[]): Promise<string> {
  const legs = items.map(toBookingLeg);
  if (!legs.length) throw new Error('createBookingCode: nothing to share');
  const key = bookingKey(legs);

  for (let salt = 0; salt < 20; salt++) {
    const code = bookingCodeFor(key, salt);
    const existing = (await bookingCodesTable.get(code)) as BookingCode | null | undefined;
    if (existing && existing.key !== key) continue; // that code already belongs to a different slip — next salt
    const record: BookingCode = { code, key, legs, createdBy: existing?.createdBy ?? cleanJid(userId), createdAt: Date.now() };
    await bookingCodesTable.set(code, record);
    return code;
  }
  throw new Error('createBookingCode: could not find a free code');
}

/** Cleans what a player typed ("k7m-2qx", " K7M2QX ") into a code, or null if it can't be one. */
export function parseBookingCode(raw: string): string | null {
  const code = String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return code.length === BOOKING_CODE_LENGTH && [...code].every((c) => BOOKING_ALPHABET.includes(c)) ? code : null;
}

export async function getBookingCode(raw: string): Promise<BookingCode | null> {
  const code = parseBookingCode(raw);
  if (!code) return null;
  return ((await bookingCodesTable.get(code)) as BookingCode | null | undefined) ?? null;
}

export type BookingDropReason = 'started' | 'unavailable' | 'market_unavailable' | 'budget';

export interface RepricedSlip {
  /** Selections that can be bet on right now, at TODAY's odds; `was` is the price when the code was made. */
  loaded: { pick: PlaceCouponPick; was: number }[];
  dropped: { leg: BookingLeg; reason: BookingDropReason }[];
}

const EXTRA_ONLY_MARKETS: readonly Market[] = ['btts_h1', 'double_chance_h1', 'halftime_fulltime'];

/**
 * Turns a code's selections back into bettable picks: each is matched to a fixture that can still
 * be bet on, then re-priced from the live odds. A selection that can't be loaded (match started,
 * no odds, market no longer offered, or no credit budget to price it) is reported in `dropped`
 * instead of being silently lost. `joined` should come from the same loader as "Place a Bet".
 */
export async function repriceBookingLegs(legs: BookingLeg[], joined: FixtureWithOdds[]): Promise<RepricedSlip> {
  const loaded: RepricedSlip['loaded'] = [];
  const dropped: RepricedSlip['dropped'] = [];
  const marketsByEvent = new Map<string, EventMarkets>();
  const extraLoaded = new Set<string>();
  const seenMatches = new Set<string>();

  for (const leg of legs) {
    const home = normalizeTeamName(leg.homeTeam);
    const away = normalizeTeamName(leg.awayTeam);
    const matchKey = `${leg.league}|${home}|${away}`;
    if (seenMatches.has(matchKey)) continue; // a coupon holds one leg per match
    seenMatches.add(matchKey);

    const fixture = joined.find((f) => f.league === leg.league && normalizeTeamName(f.homeTeam) === home && normalizeTeamName(f.awayTeam) === away);
    if (!fixture) {
      const started = new Date(leg.kickoff).getTime() - Date.now() < BETTING_CUTOFF_MS;
      dropped.push({ leg, reason: started ? 'started' : 'unavailable' });
      continue;
    }

    let em: EventMarkets = {};
    if (leg.market !== '1x2') {
      if (!fixture.eventId) {
        dropped.push({ leg, reason: 'market_unavailable' });
        continue;
      }
      try {
        const id = fixture.eventId;
        if (!marketsByEvent.has(id)) marketsByEvent.set(id, await fetchCoreMarkets(id, fixture.league)); // cached 24h — the first loader pays, everyone after is free
        em = marketsByEvent.get(id)!;
        if (EXTRA_ONLY_MARKETS.includes(leg.market) && !extraLoaded.has(id)) {
          const extra = (await getCachedExtraMarkets(id)) ?? (await fetchExtraMarkets(id, fixture.league));
          em = { ...em, ...extra };
          marketsByEvent.set(id, em);
          extraLoaded.add(id);
        }
      } catch (err) {
        dropped.push({ leg, reason: isCreditBudgetError(err) ? 'budget' : 'market_unavailable' });
        continue;
      }
    }

    const option = getMarketOptions(leg.market, fixture, em, leg.team).find(
      (o) => o.selection === leg.selection && (o.point ?? null) === (leg.point ?? null) && (o.team ?? null) === (leg.team ?? null)
    );
    if (!option) {
      dropped.push({ leg, reason: 'market_unavailable' });
      continue;
    }

    loaded.push({
      was: leg.odds,
      pick: {
        league: fixture.league,
        homeTeam: fixture.homeTeam,
        awayTeam: fixture.awayTeam,
        kickoff: fixture.kickoff, // the fixture's CURRENT kick-off, in case the match was moved
        market: leg.market,
        selection: option.selection,
        point: option.point,
        team: option.team,
        odds: option.odds,
      },
    });
  }

  return { loaded, dropped };
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
/**
 * The score these markets settle on: goals after 90 minutes (+ stoppage time).
 * Domestic league games: just fullTime. A knockout match that went to extra time or
 * penalties: regularTime, because fullTime includes extra time and the shootout.
 * Returns nulls (=> leg stays pending) rather than guessing if regularTime is missing.
 */
export function scoreAfter90(match: FootballDataMatch): { home: number | null; away: number | null } {
  const duration = match.score.duration;
  if (duration && duration !== 'REGULAR') {
    const reg = match.score.regularTime;
    if (reg && reg.home !== null && reg.home !== undefined && reg.away !== null && reg.away !== undefined) return { home: reg.home, away: reg.away };
    console.warn(`[sportybet] ${match.homeTeam.name} v ${match.awayTeam.name} went to ${duration} but the API sent no regularTime — leaving its legs pending`);
    return { home: null, away: null };
  }
  return { home: match.score.fullTime.home, away: match.score.fullTime.away };
}

export function resolveLegResult(leg: Leg, match: FootballDataMatch): 'won' | 'lost' | 'void' | null {
  if (['POSTPONED', 'SUSPENDED', 'CANCELLED'].includes(match.status)) return 'void';
  if (match.status !== 'FINISHED') return null; // SCHEDULED / LIVE / IN_PLAY / PAUSED — still genuinely pending

  const { home, away } = scoreAfter90(match);
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
      // After extra time / penalties `winner` is who went through, not the 90-minute result.
      if (match.score.duration && match.score.duration !== 'REGULAR') {
        return resultCode(home, away) === (leg.selection === 'home' ? '1' : leg.selection === 'away' ? '2' : 'x') ? 'won' : 'lost';
      }
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
  const reg = scoreAfter90(match);
  const decidedAfter90 = match.score.duration && match.score.duration !== 'REGULAR';
  const base = `${reg.home} - ${reg.away}${decidedAfter90 ? ' after 90 min' : ''}`;
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
    fetchAllLeaguesSeasonMatches(),
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
        const legLeague = leg.league ?? DEFAULT_LEAGUE; // pre-La-Liga coupons have no league: Premier League
        const match = seasonMatches.find(
          (m) =>
            (m.league ?? DEFAULT_LEAGUE) === legLeague &&
            normalizeTeamName(m.homeTeam.name) === home &&
            normalizeTeamName(m.awayTeam.name) === away
        );
        if (!match) continue; // not in this payload (or that league's fetch failed this pass) — try again next poll

        const result = resolveLegResult(leg, match);
        if (result === null) continue; // still genuinely pending
        leg.status = result === 'void' ? 'voided' : result; // 'won' | 'lost' | 'voided'
        // A finished match shows its score even on a voided leg (draw no bet on a draw, a pushed line).
        // A postponed/cancelled match has no score to show.
        if (match.status === 'FINISHED' && scoreAfter90(match).home !== null) leg.finalScore = formatFinalScore(leg, match);
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
  // A single-league coupon needs no tag; once it mixes leagues, each leg gets its league's flag.
  const mixedLeagues = new Set(coupon.legs.map((l) => l.league ?? DEFAULT_LEAGUE)).size > 1;
  const lines = coupon.legs.map((leg) => {
    const pick = legPickLabel(leg);
    const score = leg.finalScore ? ` (${leg.finalScore})` : '';
    const flag = mixedLeagues ? `${getLeague(leg.league).flag} ` : '';
    return `${LEG_EMOJI[leg.status]} ${flag}${shortClubName(leg.homeTeam)} vs ${shortClubName(leg.awayTeam)} — ${pick} @ ${leg.oddsAtPlacement}${score}`;
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