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
  event: string;
  homeTeam: string; // short name, e.g. "Arsenal"
  awayTeam: string;
  commenceTime: string; // ISO 8601 UTC
  bookmakers: number;
  bestOdds: Array<{ name: string; price: number }>; // team name or "Draw" -> decimal odds
}

// ─────────────────────────────────────────────────────────────────────────
// Domain types
// ─────────────────────────────────────────────────────────────────────────

export type Selection = 'home' | 'draw' | 'away';
export type LegStatus = 'pending' | 'won' | 'lost' | 'voided';
export type CouponStatus = 'pending' | 'won' | 'lost';

export interface FixtureWithOdds {
  homeTeam: string; // official name — carried through to settlement
  awayTeam: string;
  kickoff: string; // ISO 8601 UTC
  matchday: number;
  odds: { home: number; draw: number; away: number } | null; // null if no odds match found yet
}

export interface Leg {
  id: string;
  homeTeam: string;
  awayTeam: string;
  kickoff: string;
  selection: Selection;
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
// is pre-aggregated. bestOdds below is US picking the best (highest) price
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

/** Best (highest) UK price for each h2h (1X2) outcome, across every bookmaker that offers it. */
export async function fetchOddsTips(): Promise<OddsTip[]> {
  return cached('sportybet:odds', ODDS_CACHE_TTL_MS, async () => {
    const events = await fetchOddsApiEvents('h2h');
    return events.map((ev): OddsTip => {
      const best = new Map<string, number>(); // outcome name -> best price seen
      let bookmakerCount = 0;
      for (const bm of ev.bookmakers) {
        const h2h = bm.markets.find((m) => m.key === 'h2h'); // exactly 'h2h' — never 'h2h_lay'
        if (!h2h) continue;
        bookmakerCount++;
        for (const outcome of h2h.outcomes) {
          const current = best.get(outcome.name);
          if (current === undefined || outcome.price > current) best.set(outcome.name, outcome.price);
        }
      }
      return {
        event: `${ev.home_team} vs ${ev.away_team}`,
        homeTeam: ev.home_team,
        awayTeam: ev.away_team,
        commenceTime: ev.commence_time,
        bookmakers: bookmakerCount,
        bestOdds: Array.from(best.entries()).map(([name, price]) => ({ name, price })),
      };
    });
  });
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

    let odds: FixtureWithOdds['odds'] = null;
    if (tip) {
      const homeOdds = tip.bestOdds.find((o) => normalizeTeamName(o.name) === home)?.price;
      const awayOdds = tip.bestOdds.find((o) => normalizeTeamName(o.name) === away)?.price;
      const drawOdds = tip.bestOdds.find((o) => o.name.toLowerCase() === 'draw')?.price;
      if (homeOdds && awayOdds && drawOdds) odds = { home: homeOdds, draw: drawOdds, away: awayOdds };
    }

    return { homeTeam: fx.homeTeam.name, awayTeam: fx.awayTeam.name, kickoff, matchday: fx.matchday, odds };
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
  selection: Selection;
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
    selection: p.selection,
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

function resultOf(match: FootballDataMatch): Selection | 'void' | null {
  if (match.status === 'FINISHED') {
    if (match.score.winner === 'HOME_TEAM') return 'home';
    if (match.score.winner === 'AWAY_TEAM') return 'away';
    if (match.score.winner === 'DRAW') return 'draw';
    return null; // FINISHED but no winner recorded yet — leave pending rather than guess
  }
  if (['POSTPONED', 'SUSPENDED', 'CANCELLED'].includes(match.status)) return 'void';
  return null; // SCHEDULED / LIVE / IN_PLAY / PAUSED — still genuinely pending
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

        const result = resultOf(match);
        if (result === null) continue; // still genuinely pending
        if (result === 'void') {
          leg.status = 'voided';
        } else {
          leg.status = result === leg.selection ? 'won' : 'lost';
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

export function formatCoupon(coupon: Coupon): string {
  const lines = coupon.legs.map((leg) => {
    const pick = leg.selection === 'home' ? leg.homeTeam : leg.selection === 'away' ? leg.awayTeam : 'Draw';
    const score = leg.finalScore ? ` (${leg.finalScore})` : '';
    return `${LEG_EMOJI[leg.status]} ${leg.homeTeam} vs ${leg.awayTeam} — ${pick} @ ${leg.oddsAtPlacement}${score}`;
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