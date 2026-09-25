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
 * 2. Confirm MALVIN_API_KEY below matches however you're already sourcing
 *    the key for the tiktok/exitfeedback Malvin calls elsewhere in the repo.
 */

import { createStore } from './pluginStore.js';
import { getWallet, addCoins, deductCoins, formatNumber } from './economy.js';
import { cleanJid } from './isOwner.js';

// ─────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────

const MALVIN_BASE = 'https://api.malvin.gleeze.com/api/sports';
const MALVIN_API_KEY = process.env.MALVIN_API_KEY || '';

export const MIN_STAKE = 10;
export const MAX_STAKE = 5000;
export const MAX_LEGS_PER_COUPON = 10;

// ─────────────────────────────────────────────────────────────────────────
// Raw API shapes (as returned by the three Malvin endpoints)
// ─────────────────────────────────────────────────────────────────────────

interface UpcomingMatch {
  matchday: number;
  date: string; // "10/10/2026, 11:30:00 AM" — already UTC, US-locale formatted
  homeTeam: string; // official name, e.g. "Arsenal FC"
  awayTeam: string;
  status: string; // "TIMED" for everything this endpoint returns
}

interface OddsTip {
  event: string;
  homeTeam: string; // short name, e.g. "Arsenal"
  awayTeam: string;
  commenceTime: string; // ISO 8601 UTC
  bookmakers: number;
  bestOdds: Array<{ name: string; price: number }>; // team name or "Draw" -> decimal odds
}

interface SeasonMatch {
  matchday: number;
  status: string; // "FINISHED" confirmed; TIMED/IN_PLAY/POSTPONED/etc. expected but unconfirmed
  homeTeam: string; // official name, same convention as UpcomingMatch
  awayTeam: string;
  score?: string; // "3 - 0", present once played
  winner?: string; // homeTeam name | awayTeam name | "Draw", present once FINISHED
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
  status: CouponStatus;
  placedAt: number;
  settledAt?: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────

const root = createStore('sportybet');
const couponsByUser = root.table('couponsByUser'); // userId -> Coupon[]
const reservePool = root.table('reservePool'); // 'balance' -> number

const MAX_COUPONS_PER_USER = 100;

// ─────────────────────────────────────────────────────────────────────────
// Reserve pool — funded by every stake at placement, drained by every
// payout. Mirrors economy.ts's feePool pattern. Real bookmaker odds already
// carry the bookmaker's margin, so unlike the slot games this pool needs no
// custom RTP tuning — it's just the bank coupons settle against.
// ─────────────────────────────────────────────────────────────────────────

export async function getReserveBalance(): Promise<number> {
  return (await reservePool.get('balance')) || 0;
}

async function contributeToReserve(amount: number): Promise<number> {
  if (amount <= 0) return getReserveBalance();
  const updated = (await getReserveBalance()) + amount;
  await reservePool.set('balance', updated);
  return updated;
}

async function deductFromReserve(amount: number): Promise<number> {
  if (amount <= 0) return getReserveBalance();
  const updated = (await getReserveBalance()) - amount;
  await reservePool.set('balance', updated);
  if (updated < 0) {
    // Allowed — a long-shot accumulator can hit before enough stakes have
    // flowed in, same as slotMachine's emergency RTP tier. Never block the
    // payout over this; just make it loud.
    console.error(`[CRITICAL] sportybet reserve pool went negative (${updated}) after a payout of ${amount}`);
  }
  return updated;
}

// ─────────────────────────────────────────────────────────────────────────
// Malvin API clients
// ─────────────────────────────────────────────────────────────────────────

async function malvinPost<T>(path: string): Promise<T> {
  const url = `${MALVIN_BASE}${path}${path.includes('?') ? '&' : '?'}apikey=${MALVIN_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`Malvin API ${path} responded ${res.status}`);
  const json = await res.json();
  if (!json.status) throw new Error(`Malvin API ${path} returned status:false`);
  return json.data as T;
}

/** Bettable fixture list — light payload, already filtered to future games. */
export async function fetchUpcomingFixtures(): Promise<UpcomingMatch[]> {
  const data = await malvinPost<{ competition: string; total: number; matches: UpcomingMatch[] }>('/epl/upcoming');
  return data.matches;
}

/** Odds for whatever fixtures the odds provider currently covers. */
export async function fetchOddsTips(): Promise<OddsTip[]> {
  const data = await malvinPost<{ source: string; total: number; tips: OddsTip[] }>('/betting/odds');
  return data.tips;
}

/** Full-season match list (past/live/scheduled) — the settlement source of truth. */
export async function fetchAllSeasonMatches(): Promise<SeasonMatch[]> {
  const data = await malvinPost<{ competition: string; total: number; matches: SeasonMatch[] }>('/epl/matches');
  return data.matches;
}

// ─────────────────────────────────────────────────────────────────────────
// Team-name normalization & fixture/odds join
//
// /epl/upcoming and /epl/matches use official names ("Arsenal FC",
// "AFC Bournemouth", "Brighton & Hove Albion FC"); /betting/odds (The Odds
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

/** Parses /epl/upcoming's "10/10/2026, 11:30:00 AM" (already UTC) into an ISO string. */
function parseUpcomingDate(date: string): string {
  const [datePart, timePart] = date.split(', ');
  const [month, day, year] = datePart.split('/').map(Number);
  const d = new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00Z`);
  const match = timePart?.match(/(\d+):(\d+):(\d+)\s*(AM|PM)/i);
  if (match) {
    const [, h, m, s, ampm] = match;
    let hours = Number(h) % 12;
    if (ampm.toUpperCase() === 'PM') hours += 12;
    d.setUTCHours(hours, Number(m), Number(s));
  }
  return d.toISOString();
}

export function joinFixturesWithOdds(fixtures: UpcomingMatch[], tips: OddsTip[]): FixtureWithOdds[] {
  return fixtures.map((fx) => {
    const kickoff = parseUpcomingDate(fx.date);
    const home = normalizeTeamName(fx.homeTeam);
    const away = normalizeTeamName(fx.awayTeam);
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

    return { homeTeam: fx.homeTeam, awayTeam: fx.awayTeam, kickoff, matchday: fx.matchday, odds };
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

  await contributeToReserve(stake);

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
// as forex's background watcher). Fetches /epl/matches once per pass and
// checks it against every leg still pending, across every user.
// ─────────────────────────────────────────────────────────────────────────

function resultOf(match: SeasonMatch): Selection | 'void' | null {
  if (match.status === 'FINISHED' && match.winner) {
    if (match.winner === match.homeTeam) return 'home';
    if (match.winner === match.awayTeam) return 'away';
    if (match.winner === 'Draw') return 'draw';
    return null; // unrecognized winner value — leave pending rather than guess
  }
  if (['POSTPONED', 'CANCELLED', 'SUSPENDED'].includes(match.status)) return 'void';
  return null; // still to be played / in play — leave pending
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
          (m) => normalizeTeamName(m.homeTeam) === home && normalizeTeamName(m.awayTeam) === away
        );
        if (!match) continue; // not in this payload — try again next poll

        const result = resultOf(match);
        if (result === null) continue; // still genuinely pending
        if (result === 'void') {
          leg.status = 'voided';
        } else {
          leg.status = result === leg.selection ? 'won' : 'lost';
          leg.finalScore = match.score;
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
        try {
          await deductFromReserve(coupon.potentialPayout);
          await addCoins(userId, coupon.potentialPayout, {
            type: 'sportybet',
            note: `Sportybet coupon ${coupon.id} won (${coupon.legs.length} leg${coupon.legs.length > 1 ? 's' : ''})`,
          });
          coupon.status = 'won';
          coupon.settledAt = Date.now();
          couponsSettled++;
        } catch (err) {
          // Compensate the reserve and leave the coupon 'pending' so the next
          // poll retries the payout — never silently swallow a won coupon.
          await contributeToReserve(coupon.potentialPayout).catch(() => {});
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

  return [
    `🎟️ *Coupon ${coupon.id.slice(-6).toUpperCase()}* ${COUPON_EMOJI[coupon.status]} ${coupon.status.toUpperCase()}`,
    ...lines,
    ``,
    `Stake: ${formatNumber(coupon.stake)} coins`,
    `Combined odds: ${coupon.combinedOdds.toFixed(2)}x`,
    `${coupon.status === 'won' ? 'Payout' : 'Potential payout'}: ${formatNumber(coupon.potentialPayout)} coins`,
  ].join('\n');
}
