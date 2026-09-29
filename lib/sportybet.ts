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
// The Odds API's free tier is a flat 500 CREDITS/month instead (cost = markets
// x regions per call) — sized here for the 3-market state (h2h+totals+btts,
// 1 region = 3 credits/call): 4 calls/day x 3 credits x 30 days = 360/month,
// safe under budget with room for manual testing. Odds don't need to be
// fresher than this for a pre-match-only game anyway.
const FIXTURES_CACHE_TTL_MS = 60_000;
const SEASON_MATCHES_CACHE_TTL_MS = 60_000;
const ODDS_CACHE_TTL_MS = 6 * 60 * 60_000;

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
  totals: { point: number; over: number; under: number } | null; // best over/under at whichever line most bookmakers quote
}

// ─────────────────────────────────────────────────────────────────────────
// Domain types
// ─────────────────────────────────────────────────────────────────────────

export type Market = '1x2' | 'totals' | 'btts';
export type Selection = 'home' | 'draw' | 'away' | 'over' | 'under' | 'yes' | 'no';
export type LegStatus = 'pending' | 'won' | 'lost' | 'voided';
export type CouponStatus = 'pending' | 'won' | 'lost';

export interface FixtureWithOdds {
  eventId: string | null; // null if no Odds API match was found for this fixture yet
  homeTeam: string; // official name — carried through to settlement
  awayTeam: string;
  kickoff: string; // ISO 8601 UTC
  matchday: number;
  h2h: { home: number; draw: number; away: number } | null;
  totals: { point: number; over: number; under: number } | null;
}

export interface Leg {
  id: string;
  homeTeam: string;
  awayTeam: string;
  kickoff: string;
  market: Market;
  selection: Selection;
  point?: number; // only for 'totals' — the over/under line, e.g. 2.5
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
// The raw response is one array entry per fixture, each with its own list of
// UK bookmakers, each bookmaker carrying its own markets/outcomes — nothing
// is pre-aggregated. fetchOddsTips below is us picking the best (highest) price
// per outcome across every bookmaker ourselves.
//
// One real quirk this confirmed from a live pull: exchange bookmakers
// (Betfair Exchange, Smarkets) carry a SECOND market, "h2h_lay" — the price
// to bet AGAINST an outcome, not for it. One live sample had a Nottingham
// Forest "h2h_lay" price of 80.0 against every normal bookmaker's ~5.0-5.75
// — picking a "best" price without filtering to key === 'h2h' specifically
// would have handed out a wildly wrong payout multiplier. Never touch
// h2h_lay (or any *_lay market) here.
// ─────────────────────────────────────────────────────────────────────────

interface OddsApiOutcome {
  name: string; // team name, "Draw", or (for future markets) "Over"/"Under"/"Yes"/"No"
  price: number;
  point?: number; // present on line-based markets like totals, e.g. 2.5 for Over/Under 2.5
}

interface OddsApiMarket {
  key: string; // 'h2h' is what we want; 'h2h_lay' must be excluded — see note above
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

async function fetchOddsApiEvents(markets: string): Promise<OddsApiEvent[]> {
  const url = `${ODDS_API_BASE}/sports/soccer_epl/odds/?regions=uk&markets=${markets}&oddsFormat=decimal&apiKey=${ODDS_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`The Odds API responded ${res.status}`);
  return (await res.json()) as OddsApiEvent[];
}

/** Best (highest) UK price for h2h (1X2) and totals (over/under), across every bookmaker offering each. */
export async function fetchOddsTips(): Promise<OddsTip[]> {
  return cached('sportybet:odds', ODDS_CACHE_TTL_MS, async () => {
    const events = await fetchOddsApiEvents('h2h,totals');
    return events.map((ev): OddsTip => {
      const bestH2h = new Map<string, number>(); // outcome name -> best price seen
      const totalsByPoint = new Map<number, { overPrices: number[]; underPrices: number[] }>();
      let bookmakerCount = 0;

      for (const bm of ev.bookmakers) {
        let sawThisBookmaker = false;

        const h2h = bm.markets.find((m) => m.key === 'h2h'); // exactly 'h2h' — never 'h2h_lay'
        if (h2h) {
          sawThisBookmaker = true;
          for (const outcome of h2h.outcomes) {
            const current = bestH2h.get(outcome.name);
            if (current === undefined || outcome.price > current) bestH2h.set(outcome.name, outcome.price);
          }
        }

        const totals = bm.markets.find((m) => m.key === 'totals');
        if (totals) {
          sawThisBookmaker = true;
          for (const outcome of totals.outcomes) {
            if (outcome.point === undefined) continue;
            const bucket = totalsByPoint.get(outcome.point) || { overPrices: [], underPrices: [] };
            if (outcome.name === 'Over') bucket.overPrices.push(outcome.price);
            else if (outcome.name === 'Under') bucket.underPrices.push(outcome.price);
            totalsByPoint.set(outcome.point, bucket);
          }
        }

        if (sawThisBookmaker) bookmakerCount++;
      }

      // Bookmakers occasionally disagree on the over/under line itself — go
      // with whichever point line the most bookmakers actually quoted.
      let totals: OddsTip['totals'] = null;
      let bestQuoteCount = 0;
      for (const [point, bucket] of totalsByPoint) {
        const quoteCount = bucket.overPrices.length + bucket.underPrices.length;
        if (quoteCount > bestQuoteCount && bucket.overPrices.length && bucket.underPrices.length) {
          bestQuoteCount = quoteCount;
          totals = { point, over: Math.max(...bucket.overPrices), under: Math.max(...bucket.underPrices) };
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
        totals,
      };
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────
// BTTS — fetched lazily, per event, only once a player actually opens a
// specific match. The Odds API doesn't return btts on the bulk /odds call;
// it needs the per-event endpoint, and coverage varies by bookmaker/event,
// so this checks availability (1 credit) before ever spending a second
// credit on the odds themselves. Cached per event so backing out and back
// in during the same betting session doesn't re-spend credits.
// ─────────────────────────────────────────────────────────────────────────

const BTTS_CACHE_TTL_MS = 30 * 60_000;

interface OddsApiEventMarketsResponse {
  bookmakers: Array<{ markets: Array<{ key: string }> }>;
}

async function fetchAvailableMarketKeys(eventId: string): Promise<Set<string>> {
  return cached(`sportybet:markets:${eventId}`, BTTS_CACHE_TTL_MS, async () => {
    const url = `${ODDS_API_BASE}/sports/soccer_epl/events/${eventId}/markets?regions=uk&apiKey=${ODDS_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`The Odds API event-markets responded ${res.status}`);
    const data = (await res.json()) as OddsApiEventMarketsResponse;
    const keys = new Set<string>();
    for (const bm of data.bookmakers ?? []) {
      for (const m of bm.markets ?? []) keys.add(m.key);
    }
    return keys;
  });
}

async function fetchBttsOdds(eventId: string): Promise<{ yes: number; no: number } | null> {
  return cached(`sportybet:btts:${eventId}`, BTTS_CACHE_TTL_MS, async () => {
    const url = `${ODDS_API_BASE}/sports/soccer_epl/events/${eventId}/odds/?regions=uk&markets=btts&oddsFormat=decimal&apiKey=${ODDS_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`The Odds API BTTS odds responded ${res.status}`);
    const ev = (await res.json()) as OddsApiEvent;
    let yes: number | undefined;
    let no: number | undefined;
    for (const bm of ev.bookmakers ?? []) {
      const btts = bm.markets.find((m) => m.key === 'btts');
      if (!btts) continue;
      for (const outcome of btts.outcomes) {
        if (outcome.name === 'Yes' && (yes === undefined || outcome.price > yes)) yes = outcome.price;
        if (outcome.name === 'No' && (no === undefined || outcome.price > no)) no = outcome.price;
      }
    }
    return yes !== undefined && no !== undefined ? { yes, no } : null;
  });
}

/**
 * Call this after a player picks a specific match, not for every fixture in
 * a browsing list — it costs 1 credit to check, plus 1 more only if BTTS
 * turns out to actually be listed for this event.
 */
export async function fetchBttsIfAvailable(eventId: string): Promise<{ yes: number; no: number } | null> {
  const keys = await fetchAvailableMarketKeys(eventId);
  if (!keys.has('btts')) return null;
  return fetchBttsOdds(eventId);
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
  'hull city': 'Hull',
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
      totals: tip?.totals ?? null,
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
  point?: number; // required for 'totals' — the over/under line
  odds: number;
}

export type PlaceCouponResult =
  | { success: true; coupon: Coupon }
  | {
      success: false;
      reason: 'invalid_stake' | 'too_many_legs' | 'duplicate_match' | 'insufficient_funds' | 'no_legs';
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

/**
 * Resolves one leg against its match, given the leg's own market — 1x2 uses
 * football-data.org's score.winner directly; totals and btts are computed
 * from the same score.fullTime goals, no separate data source needed for
 * either. Returns null while the match still has nothing decided yet.
 */
function resolveLegResult(leg: Leg, match: FootballDataMatch): 'won' | 'lost' | 'void' | null {
  if (['POSTPONED', 'SUSPENDED', 'CANCELLED'].includes(match.status)) return 'void';
  if (match.status !== 'FINISHED') return null; // SCHEDULED / LIVE / IN_PLAY / PAUSED — still genuinely pending

  const home = match.score.fullTime.home;
  const away = match.score.fullTime.away;
  if (home === null || away === null) return null; // FINISHED but no score recorded yet — leave pending rather than guess

  if (leg.market === '1x2') {
    if (match.score.winner === 'HOME_TEAM') return leg.selection === 'home' ? 'won' : 'lost';
    if (match.score.winner === 'AWAY_TEAM') return leg.selection === 'away' ? 'won' : 'lost';
    if (match.score.winner === 'DRAW') return leg.selection === 'draw' ? 'won' : 'lost';
    return null; // unrecognized winner value — leave pending rather than guess
  }

  if (leg.market === 'totals') {
    const point = leg.point ?? 2.5;
    const isOver = home + away > point;
    return (leg.selection === 'over') === isOver ? 'won' : 'lost';
  }

  // btts
  const bothScored = home > 0 && away > 0;
  return (leg.selection === 'yes') === bothScored ? 'won' : 'lost';
}

export async function pollAndSettleCoupons(): Promise<{ couponsChecked: number; couponsSettled: number }> {
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
        if (result === 'void') {
          leg.status = 'voided';
        } else {
          leg.status = result; // 'won' | 'lost'
          leg.finalScore = `${match.score.fullTime.home} - ${match.score.fullTime.away}`;
        }
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

/** Shared with plugins/sportybet.ts's slip preview so a leg reads the same way everywhere. */
export function legPickLabel(leg: { market: Market; selection: Selection; homeTeam: string; awayTeam: string; point?: number }): string {
  if (leg.market === '1x2') {
    return leg.selection === 'home' ? shortClubName(leg.homeTeam) : leg.selection === 'away' ? shortClubName(leg.awayTeam) : 'Draw';
  }
  if (leg.market === 'totals') return `${leg.selection === 'over' ? 'Over' : 'Under'} ${leg.point}`;
  return leg.selection === 'yes' ? 'BTTS: Yes' : 'BTTS: No';
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
