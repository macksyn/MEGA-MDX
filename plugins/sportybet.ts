// @ts-nocheck
/***
 * plugins/sportybet.ts
 *
 * Virtual Premier League sportsbook. All match data, odds joining, coupon
 * math, and settlement live in lib/sportybet.ts — this file is purely the
 * button-menu UI and command wiring, same split as economy.ts/eco_balance.ts
 * and slotMachine.ts/eco_jackpot.ts.
 *
 * Navigation follows the exact pattern proven in globalTrader.ts: every
 * screen is its own function; every promptMenu below it uses
 * cancelLabel: 'Back' (only the top-level main menu uses 'Exit'); a
 * cancelled prompt returns the string 'back'; and the CALLER decides what
 * "back" means by re-invoking itself:
 *
 *   const outcome = await runChildScreen(...);
 *   if (outcome === 'back') return runThisScreen(...same args...);
 *   return outcome;
 *
 * A coupon can hold more than one leg (accumulator: all legs must win,
 * odds multiply), one leg per match. Markets: Match Winner, Total Goals
 * (ladder of lines), Both Teams to Score, Double Chance, Draw No Bet and Team
 * Goals (ladder per team), plus — behind a "More markets" button — the 1st-half
 * markets (BTTS, Double Chance) and Half-time/Full-time. Only markets the odds
 * provider actually prices for a match are ever shown. Prices for everything
 * beyond Match Winner are fetched when a match is OPENED (core) or when "More
 * markets" is tapped (extra), never for the whole fixture list — that's what
 * keeps the 500-credit month intact. Settlement itself runs elsewhere on a
 * schedule (pollAndSettleCoupons in lib/sportybet.ts) — this file only ever
 * reads/displays coupon state.
 */
import { withEconomyGuard, formatNumber, getWallet } from '../lib/economy.js';
import { promptMenu, promptAmount } from '../lib/buttonSession.js';
import { cleanJid } from '../lib/isOwner.js';
import {
  fetchUpcomingFixtures,
  fetchOddsTips,
  fetchAllSeasonMatches,
  startCouponSettlementPoller,
  fetchCoreMarkets,
  fetchExtraMarkets,
  getCachedExtraMarkets,
  availableMarkets,
  getMarketOptions,
  isCreditBudgetError,
  joinFixturesWithOdds,
  normalizeTeamName,
  shortClubName,
  computePotentialPayout,
  placeCoupon,
  getUserCoupons,
  formatCoupon,
  legPickLabel,
  MIN_STAKE,
  MAX_STAKE,
  MAX_LEGS_PER_COUPON,
  BETTING_CUTOFF_MS,
  type FixtureWithOdds,
  type PlaceCouponPick,
  type Market,
  type MarketOption,
  type EventMarkets,
  type TeamSide,
  type Coupon,
} from '../lib/sportybet.js';

// Settles finished matches onto coupons in the background (every 5 min, plus once on
// startup). Remove this line if you already schedule pollAndSettleCoupons() elsewhere.
startCouponSettlementPoller();

export const command = 'sportybet';
export const aliases = ['bet', 'sb'];
export const category = 'economy-games';
export const cooldown = 3000;

const WAT_OFFSET_MS = 60 * 60 * 1000; // Nigeria is UTC+1 year-round, no DST

function formatKickoff(iso: string): string {
  const d = new Date(new Date(iso).getTime() + WAT_OFFSET_MS);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hours24 = d.getUTCHours();
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const ampm = hours24 < 12 ? 'AM' : 'PM';
  const mins = String(d.getUTCMinutes()).padStart(2, '0');
  return `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${d.getUTCDate()} · ${hours12}:${mins} ${ampm} WAT`;
}

function formatDateShort(ts: number): string {
  const d = new Date(ts);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function marketLabel(market: Market): string {
  switch (market) {
    case '1x2':
      return 'Match Winner';
    case 'totals':
      return 'Total Goals';
    case 'team_totals':
      return 'Team Goals';
    case 'btts':
      return 'Both Teams to Score';
    case 'btts_h1':
      return '1st Half — Both Teams to Score';
    case 'draw_no_bet':
      return "Draw No Bet — stake back if it's a draw";
    case 'double_chance':
      return 'Double Chance';
    case 'double_chance_h1':
      return '1st Half — Double Chance';
    case 'halftime_fulltime':
      return 'Half-time / Full-time — pick both results';
  }
}

const MARKET_MENU_LABEL: Record<Market, string> = {
  '1x2': '⚽ Match Winner',
  totals: '🥅 Total Goals',
  btts: '🎯 Both Teams to Score',
  double_chance: '🛡️ Double Chance',
  draw_no_bet: '🔁 Draw No Bet',
  team_totals: '🏟️ Team Goals',
  btts_h1: '🎯 1st Half BTTS',
  double_chance_h1: '🛡️ 1st Half Double Chance',
  halftime_fulltime: '⏱️ Half-time / Full-time',
};

function buildSlipPreview(picks: PlaceCouponPick[]): string {
  return picks.map((p, i) => `${i + 1}. ${shortClubName(p.homeTeam)} vs ${shortClubName(p.awayTeam)} — ${legPickLabel(p)} @ ${p.odds}`).join('\n');
}

function sameMatch(pick: { homeTeam: string; awayTeam: string }, fixture: { homeTeam: string; awayTeam: string }): boolean {
  return (
    normalizeTeamName(pick.homeTeam) === normalizeTeamName(fixture.homeTeam) &&
    normalizeTeamName(pick.awayTeam) === normalizeTeamName(fixture.awayTeam)
  );
}

function placeCouponErrorMessage(reason: string): string {
  switch (reason) {
    case 'invalid_stake':
      return `Stake must be between ${formatNumber(MIN_STAKE)} and ${formatNumber(MAX_STAKE)} coins.`;
    case 'too_many_legs':
      return `A coupon can hold at most ${MAX_LEGS_PER_COUPON} legs.`;
    case 'duplicate_match':
      return `You can't pick the same match twice in one coupon.`;
    case 'insufficient_funds':
      return `You don't have enough coins for that stake.`;
    case 'no_legs':
      return `No matches were picked.`;
    case 'betting_closed':
      return `Betting has closed on one of those matches — it's about to kick off or already has.`;
    default:
      return `Something went wrong placing that bet — try again.`;
  }
}

const COUPON_LIST_EMOJI: Record<Coupon['status'], string> = { pending: '🟡', won: '🟢', lost: '🔴' };

// ─────────────────────────────────────────────────────────────────────────
// Place a Bet — a chain of screens: fixture -> market -> selection ->
// add-or-stake -> stake -> confirm. Each function owns exactly one prompt;
// 'back' always bubbles exactly one screen up, resolved by the caller.
// ─────────────────────────────────────────────────────────────────────────

async function runConfirm(sock: any, message: any, chatId: string, userId: string, channelInfo: any, picks: PlaceCouponPick[], stake: number) {
  const potentialPayout = computePotentialPayout(stake, picks.map((p) => ({ status: 'pending' as const, oddsAtPlacement: p.odds })));

  const result = await promptMenu(sock, message, chatId, userId, {
    title: '🧾 Confirm your bet',
    text: `${buildSlipPreview(picks)}\n\nStake: ${formatNumber(stake)} coins\nPotential payout: ${formatNumber(potentialPayout)} coins`,
    options: [{ label: '✅ Confirm', value: 'confirm' }],
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  const placed = await placeCoupon(userId, stake, picks);
  if (!placed.success) {
    await sock.sendMessage(chatId, { text: `❌ ${placeCouponErrorMessage(placed.reason)}`, ...channelInfo }, { quoted: message });
    return;
  }
  await sock.sendMessage(chatId, { text: `🎉 Bet placed!\n\n${formatCoupon(placed.coupon)}`, ...channelInfo }, { quoted: message });
}

async function runStakeEntry(sock: any, message: any, chatId: string, userId: string, channelInfo: any, picks: PlaceCouponPick[]) {
  const wallet = await getWallet(userId);
  const maxStake = Math.min(MAX_STAKE, wallet.coins);

  if (maxStake < MIN_STAKE) {
    await sock.sendMessage(
      chatId,
      { text: `❌ You need at least ${formatNumber(MIN_STAKE)} coins to place a bet. Your balance: ${formatNumber(wallet.coins)}.`, ...channelInfo },
      { quoted: message }
    );
    return;
  }

  const result = await promptAmount(sock, message, chatId, userId, {
    title: '💰 Enter your stake',
    text: `${buildSlipPreview(picks)}\n\nYour balance: ${formatNumber(wallet.coins)} coins`,
    min: MIN_STAKE,
    max: maxStake,
  });

  // promptAmount has no button — typing "cancel" plays the same role "Back" does elsewhere here.
  if (result.cancelled) return 'back';
  if (result.timedOut) {
    await sock.sendMessage(chatId, { text: '⌛ Bet slip expired.', ...channelInfo }, { quoted: message });
    return;
  }

  const outcome = await runConfirm(sock, message, chatId, userId, channelInfo, picks, result.value);
  if (outcome === 'back') return runStakeEntry(sock, message, chatId, userId, channelInfo, picks);
  return outcome;
}

async function runAddOrStake(
  sock: any,
  message: any,
  chatId: string,
  userId: string,
  channelInfo: any,
  joined: FixtureWithOdds[],
  picks: PlaceCouponPick[]
) {
  const canAddMore = picks.length < MAX_LEGS_PER_COUPON && joined.some((f) => !picks.some((p) => sameMatch(p, f)));
  const options = [];
  if (canAddMore) options.push({ label: '➕ Add another match', value: 'more' });
  options.push({ label: '💰 Place this bet', value: 'stake' });

  const result = await promptMenu(sock, message, chatId, userId, {
    title: `✅ Added (${picks.length} leg${picks.length > 1 ? 's' : ''} so far)`,
    text: buildSlipPreview(picks),
    options,
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  const outcome =
    result.value === 'more'
      ? await runFixturePicker(sock, message, chatId, userId, channelInfo, joined, picks)
      : await runStakeEntry(sock, message, chatId, userId, channelInfo, picks);

  if (outcome === 'back') return runAddOrStake(sock, message, chatId, userId, channelInfo, joined, picks);
  return outcome;
}

/** Button text for one selection inside a market. Over/under rows read "Over 2.5"; the price goes in the description. */
function optionLabel(market: Market, o: MarketOption, fixture: FixtureWithOdds): string {
  const home = shortClubName(fixture.homeTeam);
  const away = shortClubName(fixture.awayTeam);

  switch (market) {
    case '1x2':
      return o.selection === 'home' ? `🏠 ${home}` : o.selection === 'away' ? `✈️ ${away}` : '🤝 Draw';
    case 'draw_no_bet':
      return o.selection === 'home' ? `🏠 ${home}` : `✈️ ${away}`;
    case 'totals':
    case 'team_totals':
      return `${o.selection === 'over' ? '⬆️ Over' : '⬇️ Under'} ${o.point}`;
    case 'btts':
    case 'btts_h1':
      return o.selection === 'yes' ? '✅ Yes' : '❌ No';
    case 'double_chance':
    case 'double_chance_h1':
      // The "1st half" part is already in the screen title, so label it as a plain double chance.
      return `🛡️ ${legPickLabel({ market: 'double_chance', selection: o.selection, homeTeam: fixture.homeTeam, awayTeam: fixture.awayTeam })}`;
    case 'halftime_fulltime': {
      const [ht, ft] = String(o.selection).split('/');
      const side = (c: string) => (c === '1' ? home : c === '2' ? away : 'Draw');
      return `⏱️ ${side(ht)} / ${side(ft)}`;
    }
  }
}

async function runSelectionPicker(
  sock: any,
  message: any,
  chatId: string,
  userId: string,
  channelInfo: any,
  joined: FixtureWithOdds[],
  picks: PlaceCouponPick[],
  fixture: FixtureWithOdds,
  market: Market,
  em: EventMarkets,
  team?: TeamSide
) {
  const opts = getMarketOptions(market, fixture, em, team);
  if (!opts.length) return 'back'; // nothing priced here after all — step back rather than show an empty menu

  const textLines = [marketLabel(market)];
  if (market === 'team_totals' && team) {
    textLines.push(`${shortClubName(team === 'home' ? fixture.homeTeam : fixture.awayTeam)} goals`);
  }
  if (market === 'halftime_fulltime') textLines.push('First name = leading at half-time, second = winning at full-time.');

  const result = await promptMenu(sock, message, chatId, userId, {
    title: `${shortClubName(fixture.homeTeam)} vs ${shortClubName(fixture.awayTeam)}`,
    text: textLines.join('\n'),
    options: opts.map((o, i) => ({
      label: optionLabel(market, o, fixture),
      value: String(i),
      description: `@ ${o.odds}`,
    })),
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  const chosen = opts[Number(result.value)];
  if (!chosen) return;

  const newPick: PlaceCouponPick = {
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    kickoff: fixture.kickoff,
    market,
    selection: chosen.selection,
    point: chosen.point,
    team: chosen.team,
    odds: chosen.odds,
  };

  const outcome = await runAddOrStake(sock, message, chatId, userId, channelInfo, joined, [...picks, newPick]);
  if (outcome === 'back') {
    return runSelectionPicker(sock, message, chatId, userId, channelInfo, joined, picks, fixture, market, em, team);
  }
  return outcome;
}

/** Team Goals needs one extra hop: which team's goals are we betting on? */
async function runTeamTotalsPicker(
  sock: any,
  message: any,
  chatId: string,
  userId: string,
  channelInfo: any,
  joined: FixtureWithOdds[],
  picks: PlaceCouponPick[],
  fixture: FixtureWithOdds,
  em: EventMarkets
) {
  const options: { label: string; value: string; description?: string }[] = [];
  if (em.team_totals?.home.length) options.push({ label: `🏠 ${shortClubName(fixture.homeTeam)}`, value: 'home', description: 'Goals scored by this team' });
  if (em.team_totals?.away.length) options.push({ label: `✈️ ${shortClubName(fixture.awayTeam)}`, value: 'away', description: 'Goals scored by this team' });

  const result = await promptMenu(sock, message, chatId, userId, {
    title: `${shortClubName(fixture.homeTeam)} vs ${shortClubName(fixture.awayTeam)}`,
    text: "Which team's goals?",
    options,
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  const outcome = await runSelectionPicker(sock, message, chatId, userId, channelInfo, joined, picks, fixture, 'team_totals', em, result.value as TeamSide);
  if (outcome === 'back') return runTeamTotalsPicker(sock, message, chatId, userId, channelInfo, joined, picks, fixture, em);
  return outcome;
}

async function runMarketPicker(
  sock: any,
  message: any,
  chatId: string,
  userId: string,
  channelInfo: any,
  joined: FixtureWithOdds[],
  picks: PlaceCouponPick[],
  fixture: FixtureWithOdds
) {
  // Prices beyond 1X2 are bought here, for THIS match only, and cached for 24h
  // (so Back / re-opening is free). Core markets load automatically; the extra
  // 1st-half / HT-FT bundle only loads when the player taps "More markets".
  let core: EventMarkets = {};
  let coreLoaded = false;
  let paused = false;
  let extra: EventMarkets | null = null;

  if (fixture.eventId) {
    try {
      core = await fetchCoreMarkets(fixture.eventId);
      coreLoaded = true;
    } catch (err) {
      if (isCreditBudgetError(err)) paused = true;
      console.warn('[sportybet] extra markets unavailable for this match:', err instanceof Error ? err.message : err);
    }
    extra = await getCachedExtraMarkets(fixture.eventId);
  }

  const em: EventMarkets = { ...core, ...(extra ?? {}) };
  const options: { label: string; value: string; description?: string }[] = availableMarkets(fixture, em).map((m) => ({
    label: MARKET_MENU_LABEL[m],
    value: m,
    description: m === 'totals' && em.totals?.length ? `Lines ${em.totals[0].point}–${em.totals[em.totals.length - 1].point}` : undefined,
  }));

  if (fixture.eventId && coreLoaded && extra === null) {
    options.push({ label: '➕ More markets', value: 'more', description: '1st half & half-time/full-time' });
  }

  const result = await promptMenu(sock, message, chatId, userId, {
    title: `${shortClubName(fixture.homeTeam)} vs ${shortClubName(fixture.awayTeam)}`,
    text: `${formatKickoff(fixture.kickoff)}\nPick a market to bet on.${paused ? '\n\nℹ️ Extra markets are unavailable right now.' : ''}`,
    options,
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  if (result.value === 'more') {
    try {
      const fetched = await fetchExtraMarkets(fixture.eventId!);
      if (!Object.keys(fetched).length) {
        await sock.sendMessage(chatId, { text: 'ℹ️ No extra markets are listed for this match.', ...channelInfo }, { quoted: message });
      }
    } catch (err) {
      console.warn('[sportybet] extra markets failed:', err instanceof Error ? err.message : err);
      await sock.sendMessage(chatId, { text: '⚠️ Could not load more markets right now.', ...channelInfo }, { quoted: message });
    }
    return runMarketPicker(sock, message, chatId, userId, channelInfo, joined, picks, fixture);
  }

  const market = result.value as Market;
  const outcome =
    market === 'team_totals'
      ? await runTeamTotalsPicker(sock, message, chatId, userId, channelInfo, joined, picks, fixture, em)
      : await runSelectionPicker(sock, message, chatId, userId, channelInfo, joined, picks, fixture, market, em);
  if (outcome === 'back') return runMarketPicker(sock, message, chatId, userId, channelInfo, joined, picks, fixture);
  return outcome;
}

async function runFixturePicker(
  sock: any,
  message: any,
  chatId: string,
  userId: string,
  channelInfo: any,
  joined: FixtureWithOdds[],
  picks: PlaceCouponPick[]
) {
  const remaining = joined.filter((f) => !picks.some((p) => sameMatch(p, f)));

  if (!remaining.length) {
    // every bettable fixture is already in the slip — nothing left to add
    const outcome = await runStakeEntry(sock, message, chatId, userId, channelInfo, picks);
    if (outcome === 'back') return runFixturePicker(sock, message, chatId, userId, channelInfo, joined, picks);
    return outcome;
  }

  const page = remaining.slice(0, 10); // proven ceiling for the single_select path (Global Trader's max was 10)
  const more = remaining.length - page.length;

  const result = await promptMenu(sock, message, chatId, userId, {
    title: picks.length ? `⚽ Add another match (${picks.length}/${MAX_LEGS_PER_COUPON} picked)` : '⚽ Pick a match',
    text: more > 0 ? `Showing the next ${page.length} of ${remaining.length} fixtures.` : 'Choose a fixture to bet on.',
    options: page.map((f, i) => ({ label: `${shortClubName(f.homeTeam)} vs ${shortClubName(f.awayTeam)}`, value: String(i), description: formatKickoff(f.kickoff) })),
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  const fixture = page[Number(result.value)];
  const outcome = await runMarketPicker(sock, message, chatId, userId, channelInfo, joined, picks, fixture);
  if (outcome === 'back') return runFixturePicker(sock, message, chatId, userId, channelInfo, joined, picks);
  return outcome;
}

async function runPlaceBet(sock: any, message: any, chatId: string, userId: string, channelInfo: any) {
  await sock.sendMessage(chatId, { text: '⏳ Pulling the latest fixtures and odds...', ...channelInfo }, { quoted: message });

  let fixtures, tips;
  try {
    [fixtures, tips] = await Promise.all([fetchUpcomingFixtures(), fetchOddsTips()]);
  } catch (err) {
    console.error('[sportybet] failed to load fixtures/odds:', err);
    await sock.sendMessage(
      chatId,
      { text: '⚠️ Could not reach the odds service right now — try again shortly.', ...channelInfo },
      { quoted: message }
    );
    return;
  }

  // Pre-match only: hide anything already inside the betting cutoff (same rule placeCoupon enforces).
  const cutoff = Date.now() + BETTING_CUTOFF_MS;
  const joined = joinFixturesWithOdds(fixtures, tips).filter((f) => f.h2h && new Date(f.kickoff).getTime() > cutoff);
  if (!joined.length) {
    await sock.sendMessage(
      chatId,
      { text: '📭 No odds are available for any upcoming fixtures right now.', ...channelInfo },
      { quoted: message }
    );
    return;
  }

  return runFixturePicker(sock, message, chatId, userId, channelInfo, joined, []);
}

// ─────────────────────────────────────────────────────────────────────────
// My Bets
// ─────────────────────────────────────────────────────────────────────────

async function runMyBets(sock: any, message: any, chatId: string, userId: string, channelInfo: any) {
  const coupons = await getUserCoupons(userId);
  if (!coupons.length) {
    await sock.sendMessage(
      chatId,
      { text: '📭 You have no coupons yet. Try *Place a Bet* from the menu.', ...channelInfo },
      { quoted: message }
    );
    return;
  }

  const page = coupons.slice(0, 10); // getUserCoupons returns newest-first

  const result = await promptMenu(sock, message, chatId, userId, {
    title: '🎫 My Bets',
    text: `You have ${coupons.length} coupon${coupons.length > 1 ? 's' : ''}. Showing the ${page.length} most recent.`,
    options: page.map((c) => ({
      label: `${COUPON_LIST_EMOJI[c.status]} ${c.legs.length}-leg · ${formatNumber(c.stake)} coins`,
      value: c.id,
      description: `${c.status.toUpperCase()} · placed ${formatDateShort(c.placedAt)}`,
    })),
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  const coupon = page.find((c) => c.id === result.value);
  if (!coupon) return;

  await sock.sendMessage(chatId, { text: formatCoupon(coupon), ...channelInfo }, { quoted: message });
}

// ─────────────────────────────────────────────────────────────────────────
// Fixtures & Results
// ─────────────────────────────────────────────────────────────────────────

// ── BEGIN scoreboard ─────────────────────────────────────────────────────
// Text "scoreboard" in the style of a sports app: a TODAY banner pinned on
// top (always present — "No match Today" when empty), then matches grouped
// under date headers with a match count. Each date's matches sit in a
// monospace block so team names flank a centred score/kick-off time, with
// the status ("Ended" / "LIVE" / "HT") on a small line above the score.
//
// Everything is grouped by the WAT calendar day (UTC+1) so a late kick-off
// never lands under the wrong date for Nigerian players.

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Roughly how many matches each feed shows (the last date group is always shown whole). */
const FEED_MATCH_TARGET = 10;
/** Longest club name drawn in a row — keeps each line narrow enough not to wrap on a phone. */
const MAX_NAME_WIDTH = 14;
const RULE = '━━━━━━━━━━━━━━━━━━━━';

type FeedState = 'upcoming' | 'live' | 'halftime' | 'ended' | 'off';

interface FeedRow {
  home: string;
  away: string;
  slot: string; // centre column: score, or kick-off time
  label?: string; // small status line above the slot
}

/** WAT calendar day as "YYYY-MM-DD" — safe to compare as strings. */
function watDayKey(ts: number): string {
  return new Date(ts + WAT_OFFSET_MS).toISOString().slice(0, 10);
}

/** 24-hour WAT clock, e.g. "19:30". */
function formatClock(iso: string): string {
  const d = new Date(new Date(iso).getTime() + WAT_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** "Saturday, 03 October" (with "Tomorrow · " / "Yesterday · " in front where it applies). */
function dayHeading(key: string, todayKey: string): string {
  const d = new Date(`${key}T00:00:00Z`);
  const diffDays = Math.round((d.getTime() - new Date(`${todayKey}T00:00:00Z`).getTime()) / 86_400_000);
  const base = `${DAY_NAMES[d.getUTCDay()]}, ${String(d.getUTCDate()).padStart(2, '0')} ${MONTH_NAMES[d.getUTCMonth()]}`;
  if (diffDays === 1) return `Tomorrow · ${base}`;
  if (diffDays === -1) return `Yesterday · ${base}`;
  return base;
}

function matchCount(n: number): string {
  return `${n} ${n === 1 ? 'Match' : 'Matches'}`;
}

/** Collapses football-data.org's many statuses into the five this view cares about. */
function feedState(status: string): FeedState {
  switch (status) {
    case 'FINISHED':
    case 'AWARDED':
      return 'ended';
    case 'IN_PLAY':
    case 'LIVE':
      return 'live';
    case 'PAUSED':
      return 'halftime';
    case 'SCHEDULED':
    case 'TIMED':
      return 'upcoming';
    default:
      return 'off'; // POSTPONED / SUSPENDED / CANCELLED
  }
}

function clip(name: string): string {
  return name.length > MAX_NAME_WIDTH ? `${name.slice(0, MAX_NAME_WIDTH - 1)}…` : name;
}

function center(text: string, width: number): string {
  const total = Math.max(0, width - text.length);
  const left = Math.floor(total / 2);
  return ' '.repeat(left) + text + ' '.repeat(total - left);
}

function toFeedRow(m: any): FeedRow {
  const home = clip(shortClubName(m.homeTeam.name));
  const away = clip(shortClubName(m.awayTeam.name));
  const score = `${m.score?.fullTime?.home ?? 0} - ${m.score?.fullTime?.away ?? 0}`;

  switch (feedState(m.status)) {
    case 'ended':
      return { home, away, slot: score, label: 'Ended' };
    case 'live':
      return { home, away, slot: score, label: 'LIVE' };
    case 'halftime':
      return { home, away, slot: score, label: 'HT' };
    case 'upcoming':
      return { home, away, slot: formatClock(m.utcDate) };
    default: {
      const label = m.status === 'POSTPONED' ? 'Postponed' : m.status === 'SUSPENDED' ? 'Suspended' : m.status === 'CANCELLED' ? 'Cancelled' : 'Off';
      return { home, away, slot: 'vs', label };
    }
  }
}

/** One monospace block for a date: home name right-aligned, away name left-aligned, score in the middle. */
function renderRows(rows: FeedRow[]): string {
  const colW = Math.max(...rows.flatMap((r) => [r.home.length, r.away.length]));
  const slotW = Math.max(5, ...rows.map((r) => r.slot.length));
  const lines: string[] = [];

  for (const r of rows) {
    if (r.label) {
      const pad = Math.max(0, colW + 1 + Math.floor((slotW - r.label.length) / 2));
      lines.push(' '.repeat(pad) + r.label);
    }
    lines.push(`${r.home.padStart(colW)} ${center(r.slot, slotW)} ${r.away}`);
    lines.push('');
  }
  lines.pop(); // drop the trailing spacer
  return '```\n' + lines.join('\n') + '\n```';
}

/** The TODAY banner — visually different from the plain date headers below it, and never skipped. */
function renderToday(todayKey: string, todays: any[]): string {
  const hasLive = todays.some((m) => ['live', 'halftime'].includes(feedState(m.status)));
  const sub = dayHeading(todayKey, todayKey);
  const head = `${RULE}\n${hasLive ? '🔴' : '🔥'} *TODAY* · _${sub}${todays.length ? ` · ${matchCount(todays.length)}` : ''}_\n${RULE}`;
  if (!todays.length) return `${head}\n📭 No match Today`;
  return `${head}\n${renderRows(todays.map(toFeedRow))}`;
}

function renderDay(key: string, todayKey: string, matches: any[]): string {
  return `📆 *${dayHeading(key, todayKey)}* _(${matchCount(matches.length)})_\n${renderRows(matches.map(toFeedRow))}`;
}

/**
 * Builds the whole message. TODAY (every match kicking off today, whatever its
 * state) is always on top. Below it: 'upcoming' lists the next dates soonest-first,
 * 'results' lists finished dates newest-first.
 */
function buildFeedText(allMatches: any[], mode: 'upcoming' | 'results', now: number = Date.now()): string {
  const todayKey = watDayKey(now);

  const byDay = new Map<string, any[]>();
  for (const m of allMatches) {
    const key = watDayKey(new Date(m.utcDate).getTime());
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(m);
  }
  for (const list of byDay.values()) list.sort((a, b) => new Date(a.utcDate).getTime() - new Date(b.utcDate).getTime());

  const keys = [...byDay.keys()].filter((k) => (mode === 'upcoming' ? k > todayKey : k < todayKey)).sort();
  if (mode === 'results') keys.reverse();

  const keep = (m: any) => {
    const state = feedState(m.status);
    return mode === 'upcoming' ? state === 'upcoming' || state === 'off' : state === 'ended';
  };

  const sections: string[] = [];
  let count = 0;
  for (const key of keys) {
    const dayMatches = byDay.get(key)!.filter(keep);
    if (!dayMatches.length) continue;
    sections.push(renderDay(key, todayKey, dayMatches));
    count += dayMatches.length;
    if (count >= FEED_MATCH_TARGET) break;
  }

  const title = mode === 'upcoming' ? '📆 Upcoming Fixtures' : '🏁 Recent Results';
  const body = sections.length ? sections.join('\n\n') : mode === 'upcoming' ? '_No upcoming fixtures found._' : '_No finished matches yet._';
  const footer = mode === 'upcoming' ? '\n\n🕒 _Kick-off times are in WAT_' : '';

  return `⚽ *PREMIER LEAGUE*\n_${title}_\n\n${renderToday(todayKey, byDay.get(todayKey) ?? [])}\n\n${body}${footer}`;
}
// ── END scoreboard ───────────────────────────────────────────────────────

async function runFixtures(sock: any, message: any, chatId: string, userId: string, channelInfo: any) {
  const result = await promptMenu(sock, message, chatId, userId, {
    title: '📅 Fixtures & Results',
    text: 'What would you like to see?',
    options: [
      { label: '📆 Upcoming Fixtures', value: 'upcoming' },
      { label: '🏁 Recent Results', value: 'results' },
    ],
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  // One cached full-season call feeds both views AND the TODAY banner, so
  // live / finished-today / kicking-off-today matches are all covered.
  let matches;
  try {
    matches = await fetchAllSeasonMatches();
  } catch (err) {
    console.error('[sportybet] failed to load fixtures/results:', err);
    return sock.sendMessage(chatId, { text: '⚠️ Could not reach the fixtures service right now.', ...channelInfo }, { quoted: message });
  }

  const mode = result.value === 'upcoming' ? 'upcoming' : 'results';
  return sock.sendMessage(chatId, { text: buildFeedText(matches, mode), ...channelInfo }, { quoted: message });
}

// ─────────────────────────────────────────────────────────────────────────
// Entry point — the only screen with an Exit button; everywhere deeper uses Back.
// ─────────────────────────────────────────────────────────────────────────

async function runMainMenu(sock: any, message: any, chatId: string, userId: string, channelInfo: any) {
  const result = await promptMenu(sock, message, chatId, userId, {
    title: '⚽ SPORTYBET',
    text: 'Virtual Premier League betting — real odds, your coins.',
    options: [
      { label: '💰 Place a Bet', value: 'place' },
      { label: '🎫 My Bets', value: 'mybets' },
      { label: '📅 Fixtures & Results', value: 'fixtures' },
    ],
    cancelLabel: 'Exit',
  });

  if (result.cancelled || result.timedOut) return;

  let outcome;
  switch (result.value) {
    case 'place':
      outcome = await runPlaceBet(sock, message, chatId, userId, channelInfo);
      break;
    case 'mybets':
      outcome = await runMyBets(sock, message, chatId, userId, channelInfo);
      break;
    case 'fixtures':
      outcome = await runFixtures(sock, message, chatId, userId, channelInfo);
      break;
  }

  if (outcome === 'back') return runMainMenu(sock, message, chatId, userId, channelInfo);
}

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, senderId, channelInfo } = context;
  const userId = cleanJid(senderId);

  const shortcut = (args[0] || '').toLowerCase();
  if (shortcut === 'mybets' || shortcut === 'bets') {
    const outcome = await runMyBets(sock, message, chatId, userId, channelInfo);
    if (outcome === 'back') return runMainMenu(sock, message, chatId, userId, channelInfo);
    return;
  }
  if (shortcut === 'fixtures' || shortcut === 'fx') {
    const outcome = await runFixtures(sock, message, chatId, userId, channelInfo);
    if (outcome === 'back') return runMainMenu(sock, message, chatId, userId, channelInfo);
    return;
  }

  return runMainMenu(sock, message, chatId, userId, channelInfo);
}

export const handler = withEconomyGuard(_handler);