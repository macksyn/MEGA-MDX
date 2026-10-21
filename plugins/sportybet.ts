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
 *
 * Edit slip: any slip (built here or loaded from a booking code) can have games removed, or a game's
 * selection changed (same match, any market/outcome) before it's placed — like a real betslip.
 *
 * Cash out: on a pending coupon, "Cash out" prices the coupon with fresh odds (see lib/sportybet.ts for the
 * maths and why it's pre-match only) and, on confirm, closes it for that amount. The offer is re-priced the
 * moment the player confirms; if it dropped, they're shown the new amount instead of being paid it silently.
 *
 * Owner dashboard: `.sportybet stats` (owner only) shows live usage for both APIs — Odds API credits per key
 * (remaining, used, pace, projected run-out, where they went) and football-data.org calls per token against
 * its 10/minute limit — plus a 14-day history. "Owner" means the bot owner or a sudo user (lib/isOwner).
 *
 * Share: a placed bet's slip has a Share button (right after placing, and under My Bets). A booking code is only
 * made — and only shown — when the player taps it; nothing prints a code by itself, so a bet stays private until
 * its owner chooses to share it. Others load a code with `<prefix>sportybet <code>`, which re-prices the picks at
 * today's odds and lets them bet their own stake.

 */
import { withEconomyGuard, formatNumber, getWallet } from '../lib/economy.js';
import { promptMenu, promptAmount } from '../lib/buttonSession.js';
import isOwnerOrSudo, { cleanJid } from '../lib/isOwner.js';
import config from '../config.js';
import {
  fetchUpcomingFixtures,
  fetchOddsTips,
  fetchAllLeaguesSeasonMatches,
  startCouponSettlementPoller,
  LEAGUES,
  DEFAULT_LEAGUE,
  getLeague,
  scoreAfter90,
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
  createBookingCode,
  getBookingCode,
  parseBookingCode,
  bookingLookupBlockedFor,
  noteFailedBookingLookup,
  repriceBookingLegs,
  getUserCoupons,
  getCoupon,
  getCashOutQuote,
  cashOutCoupon,
  getUsageReport,
  isCashOutOpen,
  formatCoupon,
  legPickLabel,
  MIN_STAKE,
  MAX_STAKE,
  MAX_LEGS_PER_COUPON,
  BETTING_CUTOFF_MS,
  type LeagueId,
  type FixtureWithOdds,
  type PlaceCouponPick,
  type BookingDropReason,
  type Market,
  type MarketOption,
  type EventMarkets,
  type TeamSide,
  type Coupon,
  type CashOutQuote,
  type UsageReport,
  type OddsDay,
  type FdDay,
} from '../lib/sportybet.js';

// Settles finished matches onto coupons in the background (every 5 min, plus once on
// startup). Remove this line if you already schedule pollAndSettleCoupons() elsewhere.
startCouponSettlementPoller();

export const command = 'sportybet';
export const aliases = ['bet', 'sb'];
export const category = 'economy-games';
export const cooldown = 3000;

/** The command prefix users actually type (config.prefix), so every "send .sportybet CODE" hint is right even if PREFIXES changes. */
const PREFIX = config.prefix || '.';

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

const BOOKING_DROP_REASON: Record<BookingDropReason, string> = {
  started: 'match has started or betting has closed',
  unavailable: 'no odds available for this match right now',
  market_unavailable: 'that market is no longer offered',
  budget: "prices couldn't be loaded right now — try again later",
};

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

const COUPON_LIST_EMOJI: Record<Coupon['status'], string> = { pending: '🟡', won: '🟢', lost: '🔴', cashed_out: '💸' };

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
  await runCouponActions(sock, message, chatId, userId, channelInfo, placed.coupon.id, { only: ['share'], cancelLabel: 'Done', text: 'Your bet is in.' });
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
  picks: PlaceCouponPick[],
  titleOverride?: string
) {
  const canAddMore = picks.length < MAX_LEGS_PER_COUPON && joined.some((f) => !picks.some((p) => sameMatch(p, f)));
  const options = [];
  if (canAddMore) options.push({ label: '➕ Add another match', value: 'more' });
  options.push({ label: '✏️ Edit slip', value: 'edit', description: 'Remove or change games' });
  options.push({ label: '💰 Place this bet', value: 'stake' });

  const result = await promptMenu(sock, message, chatId, userId, {
    title: titleOverride ?? `✅ Added (${picks.length} leg${picks.length > 1 ? 's' : ''} so far)`,
    text: buildSlipPreview(picks),
    options,
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  if (result.value === 'edit') return runEditSlip(sock, message, chatId, userId, channelInfo, joined, picks, titleOverride);

  const outcome =
    result.value === 'more'
      ? await runLeaguePicker(sock, message, chatId, userId, channelInfo, joined, picks)
      : await runStakeEntry(sock, message, chatId, userId, channelInfo, picks);

  if (outcome === 'back') return runAddOrStake(sock, message, chatId, userId, channelInfo, joined, picks, titleOverride);
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
  team?: TeamSide,
  slot?: number // set when this pick REPLACES the one at that position in the slip (Edit slip → Change selection)
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
    league: fixture.league,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    kickoff: fixture.kickoff,
    market,
    selection: chosen.selection,
    point: chosen.point,
    team: chosen.team,
    odds: chosen.odds,
  };

  const next = slot === undefined ? [...picks, newPick] : [...picks.slice(0, slot), newPick, ...picks.slice(slot)]; // a changed pick keeps its place
  const outcome = await runAddOrStake(sock, message, chatId, userId, channelInfo, joined, next, slot === undefined ? undefined : '✏️ Selection changed');
  if (outcome === 'back') {
    return runSelectionPicker(sock, message, chatId, userId, channelInfo, joined, picks, fixture, market, em, team, slot);
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
  em: EventMarkets,
  slot?: number
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

  const outcome = await runSelectionPicker(sock, message, chatId, userId, channelInfo, joined, picks, fixture, 'team_totals', em, result.value as TeamSide, slot);
  if (outcome === 'back') return runTeamTotalsPicker(sock, message, chatId, userId, channelInfo, joined, picks, fixture, em, slot);
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
  fixture: FixtureWithOdds,
  slot?: number
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
      core = await fetchCoreMarkets(fixture.eventId, fixture.league);
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
      const fetched = await fetchExtraMarkets(fixture.eventId!, fixture.league);
      if (!Object.keys(fetched).length) {
        await sock.sendMessage(chatId, { text: 'ℹ️ No extra markets are listed for this match.', ...channelInfo }, { quoted: message });
      }
    } catch (err) {
      console.warn('[sportybet] extra markets failed:', err instanceof Error ? err.message : err);
      await sock.sendMessage(chatId, { text: '⚠️ Could not load more markets right now.', ...channelInfo }, { quoted: message });
    }
    return runMarketPicker(sock, message, chatId, userId, channelInfo, joined, picks, fixture, slot);
  }

  const market = result.value as Market;
  const outcome =
    market === 'team_totals'
      ? await runTeamTotalsPicker(sock, message, chatId, userId, channelInfo, joined, picks, fixture, em, slot)
      : await runSelectionPicker(sock, message, chatId, userId, channelInfo, joined, picks, fixture, market, em, undefined, slot);
  if (outcome === 'back') return runMarketPicker(sock, message, chatId, userId, channelInfo, joined, picks, fixture, slot);
  return outcome;
}

/**
 * Edit slip: the games on the slip as a list. Tap one to change its selection or remove it; Done goes
 * back to the slip menu. Removing the last game starts a fresh slip.
 */
async function runEditSlip(
  sock: any,
  message: any,
  chatId: string,
  userId: string,
  channelInfo: any,
  joined: FixtureWithOdds[],
  picks: PlaceCouponPick[],
  titleOverride?: string
) {
  // A "Slip loaded (4 legs)" title has to follow the edits.
  const retitled = titleOverride?.replace(/\(\d+ legs?\)/, `(${picks.length} leg${picks.length === 1 ? '' : 's'})`);

  const result = await promptMenu(sock, message, chatId, userId, {
    title: '✏️ Edit slip',
    text: `${buildSlipPreview(picks)}\n\nTap a game to change its selection or remove it.`,
    options: picks.map((p, i) => ({
      label: `${i + 1}. ${shortClubName(p.homeTeam)} vs ${shortClubName(p.awayTeam)}`,
      value: String(i),
      description: `${legPickLabel(p)} @ ${p.odds}`,
    })),
    cancelLabel: '✅ Done',
  });

  if (result.cancelled) return runAddOrStake(sock, message, chatId, userId, channelInfo, joined, picks, retitled);
  if (result.timedOut || !result.value) return;

  const index = Number(result.value);
  if (!picks[index]) return runEditSlip(sock, message, chatId, userId, channelInfo, joined, picks, titleOverride);

  // Only "Back" from the game's own menu returns here to re-show THIS list. Anything else is a final answer from a
  // later screen (an edited slip, the slip menu, a placed bet) and must pass straight up — handing it to this frame
  // would bring back games the player just removed.
  const outcome = await runEditPick(sock, message, chatId, userId, channelInfo, joined, picks, index, titleOverride);
  if (outcome === 'pick-back') return runEditSlip(sock, message, chatId, userId, channelInfo, joined, picks, titleOverride);
  return outcome;
}

async function runEditPick(
  sock: any,
  message: any,
  chatId: string,
  userId: string,
  channelInfo: any,
  joined: FixtureWithOdds[],
  picks: PlaceCouponPick[],
  index: number,
  titleOverride?: string
) {
  const pick = picks[index];
  const fixture = joined.find((f) => f.league === (pick.league ?? DEFAULT_LEAGUE) && sameMatch(pick, f));
  const name = `${shortClubName(pick.homeTeam)} vs ${shortClubName(pick.awayTeam)}`;

  const options: { label: string; value: string; description?: string }[] = [];
  if (fixture) options.push({ label: '🔄 Change selection', value: 'change', description: 'Another market or outcome for this game' });
  options.push({ label: '🗑️ Remove this game', value: 'remove' });

  const result = await promptMenu(sock, message, chatId, userId, {
    title: `${index + 1}. ${name}`,
    text: `${legPickLabel(pick)} @ ${pick.odds}${fixture ? '' : "\n\nThis game is no longer on the odds board, so it can only be removed."}`,
    options,
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'pick-back';
  if (result.timedOut || !result.value) return;

  const rest = picks.filter((_, i) => i !== index);

  if (result.value === 'remove') {
    if (!rest.length) {
      await sock.sendMessage(chatId, { text: `🗑️ Removed ${name}. Your slip is empty — pick a match to start again.`, ...channelInfo }, { quoted: message });
      const fresh = await runLeaguePicker(sock, message, chatId, userId, channelInfo, joined, []);
      return fresh === 'back' ? undefined : fresh; // nothing left to go back to — end quietly rather than revive the removed games
    }
    await sock.sendMessage(chatId, { text: `🗑️ Removed ${name}.`, ...channelInfo }, { quoted: message });
    return runEditSlip(sock, message, chatId, userId, channelInfo, joined, rest, titleOverride);
  }

  // Change: pick the same match again from the market list; the new pick takes the old one's place.
  const outcome = await runMarketPicker(sock, message, chatId, userId, channelInfo, joined, rest, fixture!, index);
  if (outcome === 'back') return runEditPick(sock, message, chatId, userId, channelInfo, joined, picks, index, titleOverride); // backed out: nothing changed
  return outcome;
}

/**
 * Step 1 of a bet (and of every "Add another match"): which league? Only leagues that still
 * have a bettable match not already in the slip are offered, and with just one left the
 * picker is skipped. Accumulators can mix leagues freely — each leg remembers its own.
 */
async function runLeaguePicker(
  sock: any,
  message: any,
  chatId: string,
  userId: string,
  channelInfo: any,
  joined: FixtureWithOdds[],
  picks: PlaceCouponPick[]
) {
  const remaining = joined.filter((f) => !picks.some((p) => sameMatch(p, f)));
  const offered = LEAGUES.map((league) => ({ league, count: remaining.filter((f) => f.league === league.id).length })).filter((x) => x.count > 0);

  if (offered.length <= 1) return runFixturePicker(sock, message, chatId, userId, channelInfo, joined, picks, offered[0]?.league.id);

  const result = await promptMenu(sock, message, chatId, userId, {
    title: picks.length ? `⚽ Add another match (${picks.length}/${MAX_LEGS_PER_COUPON} picked)` : '⚽ Pick a league',
    text: 'Which league do you want to bet on?',
    options: offered.map(({ league, count }) => ({
      label: `${league.flag} ${league.name}`,
      value: league.id,
      description: `${count} match${count === 1 ? '' : 'es'} with odds`,
    })),
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  const outcome = await runFixturePicker(sock, message, chatId, userId, channelInfo, joined, picks, result.value as LeagueId);
  if (outcome === 'back') return runLeaguePicker(sock, message, chatId, userId, channelInfo, joined, picks);
  return outcome;
}

async function runFixturePicker(
  sock: any,
  message: any,
  chatId: string,
  userId: string,
  channelInfo: any,
  joined: FixtureWithOdds[],
  picks: PlaceCouponPick[],
  leagueId?: LeagueId
) {
  const remaining = joined.filter((f) => !picks.some((p) => sameMatch(p, f)) && (!leagueId || f.league === leagueId));

  if (!remaining.length) {
    // every bettable fixture is already in the slip — nothing left to add
    const outcome = await runStakeEntry(sock, message, chatId, userId, channelInfo, picks);
    if (outcome === 'back') return runFixturePicker(sock, message, chatId, userId, channelInfo, joined, picks, leagueId);
    return outcome;
  }

  const page = remaining.slice(0, 10); // proven ceiling for the single_select path (Global Trader's max was 10)
  const more = remaining.length - page.length;
  const league = leagueId ? getLeague(leagueId) : null;
  const tag = league ? `${league.flag} ${league.name}` : '⚽';

  const result = await promptMenu(sock, message, chatId, userId, {
    title: picks.length ? `${tag} · add another (${picks.length}/${MAX_LEGS_PER_COUPON} picked)` : `${tag} · pick a match`,
    text: more > 0 ? `Showing the next ${page.length} of ${remaining.length} fixtures.` : 'Choose a fixture to bet on.',
    options: page.map((f, i) => ({ label: `${shortClubName(f.homeTeam)} vs ${shortClubName(f.awayTeam)}`, value: String(i), description: formatKickoff(f.kickoff) })),
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  const fixture = page[Number(result.value)];
  const outcome = await runMarketPicker(sock, message, chatId, userId, channelInfo, joined, picks, fixture);
  if (outcome === 'back') return runFixturePicker(sock, message, chatId, userId, channelInfo, joined, picks, leagueId);
  return outcome;
}

/** Every league's fixtures + 1X2 odds, joined. One league failing never takes the others down. */
async function loadBettableFixtures(): Promise<{ joined: FixtureWithOdds[]; failed: string[] }> {
  const results = await Promise.allSettled(
    LEAGUES.map(async (league) => {
      const [fixtures, tips] = await Promise.all([fetchUpcomingFixtures(league.id), fetchOddsTips(league.id)]);
      return joinFixturesWithOdds(fixtures, tips, league.id);
    })
  );

  const all: FixtureWithOdds[] = [];
  const failed: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') all.push(...r.value);
    else {
      console.error(`[sportybet] failed to load ${LEAGUES[i].name} fixtures/odds:`, r.reason);
      failed.push(LEAGUES[i].name);
    }
  });

  // Pre-match only: hide anything already inside the betting cutoff (same rule placeCoupon enforces).
  const cutoff = Date.now() + BETTING_CUTOFF_MS;
  const joined = all.filter((f) => f.h2h && new Date(f.kickoff).getTime() > cutoff);
  return { joined, failed };
}

async function runPlaceBet(sock: any, message: any, chatId: string, userId: string, channelInfo: any) {
  await sock.sendMessage(chatId, { text: '⏳ Pulling the latest fixtures and odds...', ...channelInfo }, { quoted: message });

  const { joined, failed } = await loadBettableFixtures();

  if (failed.length === LEAGUES.length) {
    await sock.sendMessage(
      chatId,
      { text: '⚠️ Could not reach the odds service right now — try again shortly.', ...channelInfo },
      { quoted: message }
    );
    return;
  }
  if (failed.length) {
    await sock.sendMessage(chatId, { text: `⚠️ ${failed.join(', ')} couldn't be loaded right now — showing the rest.`, ...channelInfo }, { quoted: message });
  }

  if (!joined.length) {
    await sock.sendMessage(
      chatId,
      { text: '📭 No odds are available for any upcoming fixtures right now.', ...channelInfo },
      { quoted: message }
    );
    return;
  }

  return runLeaguePicker(sock, message, chatId, userId, channelInfo, joined, []);
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
      description: `${c.status.replace('_', ' ').toUpperCase()} · placed ${formatDateShort(c.placedAt)}`,
    })),
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  const coupon = page.find((c) => c.id === result.value);
  if (!coupon) return;

  await sock.sendMessage(chatId, { text: formatCoupon(coupon), ...channelInfo }, { quoted: message });

  const outcome = await runCouponActions(sock, message, chatId, userId, channelInfo, coupon.id);
  if (outcome === 'back') return runMyBets(sock, message, chatId, userId, channelInfo); // Back = the coupon list again
  return outcome;
}

// ─────────────────────────────────────────────────────────────────────────
// Cash out
// ─────────────────────────────────────────────────────────────────────────

/** A slip can be shared while something on it can still be bet on. */
function isShareable(coupon: Coupon): boolean {
  return coupon.status === 'pending' && coupon.legs.some((l) => new Date(l.kickoff).getTime() - Date.now() > BETTING_CUTOFF_MS);
}

/**
 * What the player can do with a coupon: Share (a bookable slip) and Cash out (while it's open). Shows only what applies,
 * and nothing at all when nothing does. `only` narrows it (right after placing a bet it's just Share).
 */
async function runCouponActions(
  sock: any,
  message: any,
  chatId: string,
  userId: string,
  channelInfo: any,
  couponId: string,
  opts: { only?: ('share' | 'cashout')[]; cancelLabel?: string; text?: string } = {}
) {
  const coupon = await getCoupon(userId, couponId);
  if (!coupon) return;

  const options: { label: string; value: string; description?: string }[] = [];
  if (isShareable(coupon) && (!opts.only || opts.only.includes('share'))) options.push({ label: '📤 Share', value: 'share' });
  if (isCashOutOpen(coupon) && (!opts.only || opts.only.includes('cashout'))) options.push({ label: '💸 Cash out', value: 'cashout', description: 'See your cash-out offer' });
  if (!options.length) return;

  const result = await promptMenu(sock, message, chatId, userId, {
    title: `🎟️ Coupon ${couponId.slice(-6).toUpperCase()}`,
    text: opts.text ?? 'What would you like to do?',
    options,
    cancelLabel: opts.cancelLabel ?? 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  if (result.value === 'share') {
    await runShareCoupon(sock, message, chatId, userId, channelInfo, coupon);
    return;
  }

  const outcome = await runCashOut(sock, message, chatId, userId, channelInfo, couponId);
  if (outcome === 'back') return runCouponActions(sock, message, chatId, userId, channelInfo, couponId, opts);
  return outcome;
}

/** The slip again, this time with its code — the only place a code is ever made or shown. */
async function runShareCoupon(sock: any, message: any, chatId: string, userId: string, channelInfo: any, coupon: Coupon) {
  try {
    const code = await createBookingCode(userId, coupon.legs);
    await sock.sendMessage(
      chatId,
      { text: `${formatCoupon(coupon)}\n\n🔗 Code: *${code}*\nBet the same selections: *${PREFIX}sportybet ${code}*`, ...channelInfo },
      { quoted: message }
    );
  } catch (err) {
    console.warn('[sportybet] could not share coupon:', err instanceof Error ? err.message : err);
    await sock.sendMessage(chatId, { text: "⚠️ Couldn't share this slip right now — try again in a moment.", ...channelInfo }, { quoted: message });
  }
}

function cashOutUnavailableMessage(reason: string): string {
  switch (reason) {
    case 'not_pending':
      return 'This coupon is already settled — there is nothing left to cash out.';
    case 'closed':
      return 'Cash out is closed — a match on this coupon is about to kick off or already has.';
    case 'too_small':
      return 'The cash-out value on this coupon is too small to offer right now.';
    default:
      return "Cash out isn't available right now — live prices couldn't be refreshed. Try again in a few minutes.";
  }
}

async function runCashOut(sock: any, message: any, chatId: string, userId: string, channelInfo: any, couponId: string) {
  const coupon = await getCoupon(userId, couponId);
  if (!coupon) {
    await sock.sendMessage(chatId, { text: '❌ Could not find that coupon.', ...channelInfo }, { quoted: message });
    return;
  }

  await sock.sendMessage(chatId, { text: '⏳ Getting your cash-out offer with live prices...', ...channelInfo }, { quoted: message });
  const quoted = await getCashOutQuote(coupon);
  if (!quoted.available) {
    await sock.sendMessage(chatId, { text: `ℹ️ ${cashOutUnavailableMessage(quoted.reason)}`, ...channelInfo }, { quoted: message });
    return;
  }
  return runCashOutOffer(sock, message, chatId, userId, channelInfo, coupon.id, quoted.quote);
}

async function runCashOutOffer(sock: any, message: any, chatId: string, userId: string, channelInfo: any, couponId: string, quote: CashOutQuote) {
  const result = await promptMenu(sock, message, chatId, userId, {
    title: `💸 Cash out · Coupon ${couponId.slice(-6).toUpperCase()}`,
    text:
      `Potential payout: ${formatNumber(quote.potentialPayout)} coins\n` +
      `Cash out now: *${formatNumber(quote.amount)} coins*\n\n` +
      `The offer follows the live odds, so it can change — it's re-checked when you confirm.`,
    options: [{ label: `💸 Cash out ${formatNumber(quote.amount)} coins`, value: 'confirm' }],
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  // Re-price right now, from the coupon as it stands right now: a leg may have settled, odds may have moved.
  const coupon = await getCoupon(userId, couponId);
  if (!coupon) return;
  const fresh = await getCashOutQuote(coupon);
  if (!fresh.available) {
    await sock.sendMessage(chatId, { text: `ℹ️ ${cashOutUnavailableMessage(fresh.reason)}`, ...channelInfo }, { quoted: message });
    return;
  }

  if (fresh.quote.amount < quote.amount) {
    // Never pay less than the amount on the button without the player agreeing to the new figure.
    await sock.sendMessage(
      chatId,
      { text: `📉 The odds moved — your offer is now *${formatNumber(fresh.quote.amount)} coins* (it was ${formatNumber(quote.amount)}).`, ...channelInfo },
      { quoted: message }
    );
    // 'back' from the lower offer goes up to the coupon menu — never back to the old, higher figure.
    return runCashOutOffer(sock, message, chatId, userId, channelInfo, couponId, fresh.quote);
  }

  const paid = await cashOutCoupon(userId, couponId, fresh.quote); // pays the fresh figure, which is never below what was shown
  if (paid.success) {
    await sock.sendMessage(
      chatId,
      { text: `✅ Cashed out *${formatNumber(paid.amount)} coins*.\n\n${formatCoupon(paid.coupon)}`, ...channelInfo },
      { quoted: message }
    );
    return;
  }

  const why: Record<string, string> = {
    not_found: 'Could not find that coupon.',
    not_pending: 'This coupon has already been settled.',
    closed: cashOutUnavailableMessage('closed'),
    changed: 'The coupon changed while you were confirming — open it and try again to see the new offer.',
    bank_cannot_cover: "The bank can't cover that cash-out right now — try again a little later.",
    payout_failed: 'Something went wrong paying that out. Your coupon is unchanged — try again.',
  };
  await sock.sendMessage(chatId, { text: `❌ ${why[paid.reason] ?? 'Cash out failed.'}`, ...channelInfo }, { quoted: message });
}

// ─────────────────────────────────────────────────────────────────────────
// Load Booking Code — re-load someone's slip at today's odds, then bet your own stake
// ─────────────────────────────────────────────────────────────────────────

async function runLoadBookingCode(sock: any, message: any, chatId: string, userId: string, channelInfo: any, rawCode?: string) {
  // From the menu there is no code yet. This chat framework only has number / button prompts, so the
  // code arrives as a command argument instead.
  if (!rawCode) {
    await sock.sendMessage(
      chatId,
      {
        text:
          '🔗 *Load a booking code*\n\n' +
          `Send *${PREFIX}sportybet <code>* — for example *${PREFIX}sportybet K7M2QX*.\n\n` +
          "You'll get the same selections at today's odds, and you choose your own stake.",
        ...channelInfo,
      },
      { quoted: message }
    );
    return;
  }

  const wait = bookingLookupBlockedFor(userId);
  if (wait > 0) {
    await sock.sendMessage(chatId, { text: `⏳ Too many codes that didn't match. Try again in ${Math.ceil(wait / 60)} min.`, ...channelInfo }, { quoted: message });
    return;
  }

  const code = parseBookingCode(rawCode);
  if (!code) {
    noteFailedBookingLookup(userId);
    await sock.sendMessage(chatId, { text: "❌ That doesn't look like a code. Codes are 6 characters, like *K7M2QX*.", ...channelInfo }, { quoted: message });
    return;
  }

  const booking = await getBookingCode(code);
  if (!booking) {
    noteFailedBookingLookup(userId);
    await sock.sendMessage(chatId, { text: `❌ Code *${code}* wasn't found. Check it and try again.`, ...channelInfo }, { quoted: message });
    return;
  }

  await sock.sendMessage(chatId, { text: `⏳ Loading code *${code}* with the latest odds...`, ...channelInfo }, { quoted: message });

  const { joined, failed } = await loadBettableFixtures();
  if (failed.length === LEAGUES.length) {
    await sock.sendMessage(chatId, { text: '⚠️ Could not reach the odds service right now — try again shortly.', ...channelInfo }, { quoted: message });
    return;
  }

  const slip = await repriceBookingLegs(booking.legs, joined);
  const name = (l: { homeTeam: string; awayTeam: string }) => `${shortClubName(l.homeTeam)} vs ${shortClubName(l.awayTeam)}`;

  if (!slip.loaded.length) {
    const why = slip.dropped.map((d) => `• ${name(d.leg)} — ${BOOKING_DROP_REASON[d.reason]}`).join('\n');
    await sock.sendMessage(chatId, { text: `❌ Nothing in code *${code}* can be bet on right now.\n\n${why}`, ...channelInfo }, { quoted: message });
    return;
  }

  // Only speak up about what's different from the code; a clean load needs one line.
  const notes: string[] = [];
  for (const { pick, was } of slip.loaded) {
    if (pick.odds !== was) notes.push(`${pick.odds > was ? '📈' : '📉'} ${name(pick)} — ${legPickLabel(pick)}: ${was} → ${pick.odds}`);
  }
  const header = `🔗 Code *${code}* — ${slip.loaded.length} of ${booking.legs.length} selection${booking.legs.length > 1 ? 's' : ''} loaded at today's odds.`;
  const parts = [header];
  if (notes.length) parts.push(`Odds changed:\n${notes.join('\n')}`);
  if (slip.dropped.length) parts.push(`⚠️ Not loaded:\n${slip.dropped.map((d) => `• ${name(d.leg)} — ${BOOKING_DROP_REASON[d.reason]}`).join('\n')}`);
  parts.push('Use ✏️ Edit slip to remove or change games before you place it.');
  await sock.sendMessage(chatId, { text: parts.join('\n\n'), ...channelInfo }, { quoted: message });

  const picks = slip.loaded.map((l) => l.pick);
  return runAddOrStake(sock, message, chatId, userId, channelInfo, joined, picks, `🔗 Slip loaded (${picks.length} leg${picks.length > 1 ? 's' : ''})`);
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
  const state = feedState(m.status);
  const duration = m.score?.duration; // knockout only: 'EXTRA_TIME' | 'PENALTY_SHOOTOUT' (absent / 'REGULAR' otherwise)

  // Finished matches show the 90-minute score — what every bet is settled on — with how it was decided.
  const reg = state === 'ended' ? scoreAfter90(m) : { home: m.score?.fullTime?.home, away: m.score?.fullTime?.away };
  const score = `${reg.home ?? 0} - ${reg.away ?? 0}`;

  switch (state) {
    case 'ended':
      return { home, away, slot: score, label: duration === 'EXTRA_TIME' ? 'Ended · AET' : duration === 'PENALTY_SHOOTOUT' ? 'Ended · Pens' : 'Ended' };
    case 'live':
      return { home, away, slot: score, label: duration === 'EXTRA_TIME' ? 'LIVE · ET' : duration === 'PENALTY_SHOOTOUT' ? 'LIVE · Pens' : 'LIVE' };
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

/** One date's matches. With showLeagues each league gets its own labelled block (the app's competition cards). */
function renderMatches(matches: any[], showLeagues: boolean): string {
  if (!showLeagues) return renderRows(matches.map(toFeedRow));
  const parts: string[] = [];
  for (const league of LEAGUES) {
    const inLeague = matches.filter((m) => (m.league ?? DEFAULT_LEAGUE) === league.id);
    if (inLeague.length) parts.push(`${league.flag} _${league.name}_\n${renderRows(inLeague.map(toFeedRow))}`);
  }
  return parts.join('\n');
}

/** The TODAY banner — visually different from the plain date headers below it, and never skipped. */
function renderToday(todayKey: string, todays: any[], showLeagues: boolean): string {
  const hasLive = todays.some((m) => ['live', 'halftime'].includes(feedState(m.status)));
  const sub = dayHeading(todayKey, todayKey);
  const head = `${RULE}\n${hasLive ? '🔴' : '🔥'} *TODAY* · _${sub}${todays.length ? ` · ${matchCount(todays.length)}` : ''}_\n${RULE}`;
  if (!todays.length) return `${head}\n📭 No match Today`;
  return `${head}\n${renderMatches(todays, showLeagues)}`;
}

function renderDay(key: string, todayKey: string, matches: any[], showLeagues: boolean): string {
  return `📆 *${dayHeading(key, todayKey)}* _(${matchCount(matches.length)})_\n${renderMatches(matches, showLeagues)}`;
}

/**
 * Builds the whole message. TODAY (every match kicking off today, whatever its
 * state) is always on top. Below it: 'upcoming' lists the next dates soonest-first,
 * 'results' lists finished dates newest-first.
 */
function buildFeedText(allMatches: any[], mode: 'upcoming' | 'results', scope: 'all' | LeagueId = 'all', now: number = Date.now()): string {
  const todayKey = watDayKey(now);
  const showLeagues = scope === 'all';
  if (!showLeagues) allMatches = allMatches.filter((m) => (m.league ?? DEFAULT_LEAGUE) === scope);

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
    sections.push(renderDay(key, todayKey, dayMatches, showLeagues));
    count += dayMatches.length;
    if (count >= FEED_MATCH_TARGET) break;
  }

  const title = mode === 'upcoming' ? '📆 Upcoming Fixtures' : '🏁 Recent Results';
  const body = sections.length ? sections.join('\n\n') : mode === 'upcoming' ? '_No upcoming fixtures found._' : '_No finished matches yet._';
  const footer = mode === 'upcoming' ? '\n\n🕒 _Kick-off times are in WAT_' : '';

  const heading = showLeagues ? '🌍 *ALL LEAGUES*' : `${getLeague(scope).flag} *${getLeague(scope).name.toUpperCase()}*`;
  return `${heading}\n_${title}_\n\n${renderToday(todayKey, byDay.get(todayKey) ?? [], showLeagues)}\n\n${body}${footer}`;
}
// ── END scoreboard ───────────────────────────────────────────────────────

async function runFixtures(sock: any, message: any, chatId: string, userId: string, channelInfo: any) {
  const view = await promptMenu(sock, message, chatId, userId, {
    title: '📅 Fixtures & Results',
    text: 'What would you like to see?',
    options: [
      { label: '📆 Upcoming Fixtures', value: 'upcoming' },
      { label: '🏁 Recent Results', value: 'results' },
    ],
    cancelLabel: 'Back',
  });

  if (view.cancelled) return 'back';
  if (view.timedOut || !view.value) return;

  const mode = view.value === 'upcoming' ? 'upcoming' : 'results';
  const outcome = await runFixturesLeague(sock, message, chatId, userId, channelInfo, mode);
  if (outcome === 'back') return runFixtures(sock, message, chatId, userId, channelInfo);
  return outcome;
}

async function runFixturesLeague(sock: any, message: any, chatId: string, userId: string, channelInfo: any, mode: 'upcoming' | 'results') {
  const pick = await promptMenu(sock, message, chatId, userId, {
    title: mode === 'upcoming' ? '📆 Upcoming Fixtures' : '🏁 Recent Results',
    text: 'Which league?',
    options: [{ label: '🌍 All Leagues', value: 'all' }, ...LEAGUES.map((l) => ({ label: `${l.flag} ${l.name}`, value: l.id }))],
    cancelLabel: 'Back',
  });

  if (pick.cancelled) return 'back';
  if (pick.timedOut || !pick.value) return;

  // One cached full-season call per league feeds the views AND the TODAY banner, so live /
  // finished-today / kicking-off-today matches are all covered.
  let matches;
  try {
    matches = await fetchAllLeaguesSeasonMatches();
  } catch (err) {
    console.error('[sportybet] failed to load fixtures/results:', err);
    return sock.sendMessage(chatId, { text: '⚠️ Could not reach the fixtures service right now.', ...channelInfo }, { quoted: message });
  }

  const scope = pick.value === 'all' ? 'all' : (pick.value as LeagueId);
  return sock.sendMessage(chatId, { text: buildFeedText(matches, mode, scope), ...channelInfo }, { quoted: message });
}


// ─────────────────────────────────────────────────────────────────────────
// Owner dashboard — API usage
// ─────────────────────────────────────────────────────────────────────────

/**
 * Who may open the dashboard: the bot owner or a sudo user, decided by the project's own helper
 * (lib/isOwner — it also resolves @lid senders through the group's participant list, which is why it needs
 * the raw sender id, the socket and the chat). Anything that goes wrong means "no".
 */
async function isStatsAdmin(sock: any, senderId: string, chatId: string): Promise<boolean> {
  try {
    return (await isOwnerOrSudo(senderId, sock, chatId)) === true;
  } catch {
    return false;
  }
}

const num = (n: number): string => Math.round(n).toLocaleString('en-US');
const bar = (fraction: number, width = 10): string => {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
};
/** "20 Oct, 15:42" in WAT. */
function formatStamp(ts: number): string {
  const d = new Date(ts + WAT_OFFSET_MS);
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()].slice(0, 3)}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function shortDate(ts: number): string {
  const d = new Date(ts + WAT_OFFSET_MS);
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()].slice(0, 3)}`;
}
function ago(ts: number | null, now: number): string {
  if (ts === null) return 'never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}
const plural = (n: number, word: string): string => `${num(n)} ${word}${n === 1 ? '' : 's'}`;

const KIND_LABEL: Record<string, string> = { bulk: 'Odds lists', event_core: 'Match markets', event_extra: 'More markets' };
const PURPOSE_LABEL: Record<string, string> = { betting: 'betting', cashout: 'cash out', booking: 'booking codes' };
const leagueName = (id: string): string => (LEAGUES.some((l) => l.id === id) ? getLeague(id as LeagueId).name : id);

/** "a 120 · b 85 · c 40", biggest first, skipping zeros. */
function breakdown(entries: Record<string, number>, label: (k: string) => string): string {
  const parts = Object.entries(entries)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${label(k)} ${num(v)}`);
  return parts.length ? parts.join(' · ') : '—';
}

function oddsSpend(label: string, d: OddsDay): string {
  return `${label}: *${plural(d.credits, 'credit')}* (${plural(d.calls, 'call')}${d.errors ? `, ${d.errors} failed` : ''})`;
}

function overviewText(r: UsageReport): string {
  const o = r.odds;
  const lines: string[] = [`📊 *Sportybet API usage*`, `_${formatStamp(r.generatedAt)} WAT_`, ''];

  // The Odds API
  lines.push(`🎯 *The Odds API* · ${plural(o.configured, 'key')}`);
  if (o.remaining !== null && o.quota) {
    lines.push(`${bar(o.remaining / o.quota)} *${num(o.remaining)} / ${num(o.quota)}* credits left (${Math.round((o.remaining / o.quota) * 100)}%)`);
  } else if (o.remaining !== null) {
    lines.push(`*${num(o.remaining)}* credits left`);
  } else {
    lines.push('No balance read yet this month — it appears after the first odds call.');
  }
  if (o.used !== null) lines.push(`Used this month: ${num(o.used)}`);
  const daysToReset = Math.ceil((r.nextReset - r.generatedAt) / 86_400_000);
  lines.push(`Resets ${shortDate(r.nextReset)} · in ${plural(daysToReset, 'day')}`);
  if (o.ratePerDay !== null && o.remaining !== null) {
    const pace = `~${num(o.ratePerDay)}/day`;
    if (o.willRunOutBeforeReset && o.runOutAt !== null) lines.push(`⚠️ Pace ${pace} → runs out around *${shortDate(o.runOutAt)}*, before the reset${o.roughEstimate ? ' (rough — early in the month)' : ''}`);
    else lines.push(`✅ Pace ${pace} → lasts past the reset${o.roughEstimate ? ' (rough — early in the month)' : ''}`);
  }
  const needAttention = o.keys.filter((k) => k.status === 'low' || k.status === 'exhausted' || k.status === 'disabled');
  for (const k of needAttention) lines.push(`⚠️ Key ${k.index} (${k.tag}): ${k.status}`);
  lines.push('');

  // football-data.org
  const f = r.fd;
  lines.push(`⚽ *football-data.org* · ${plural(Math.max(f.configured, 1), 'token')} (${f.limitPerMinute} calls/min each)`);
  lines.push(`Last minute: ${f.callsLastMinute} of ${f.limitPerMinute * Math.max(f.configured, 1)} calls`);
  lines.push(`Today: ${plural(f.today.calls, 'call')} · peak ${f.today.peakPerMinute}/min · ${f.today.rateLimited} rate-limited`);
  lines.push(`This month: ${plural(f.month.calls, 'call')} · ${f.month.rateLimited} rate-limited`);
  const cooling = f.tokens.filter((t) => t.status === 'cooling');
  lines.push(cooling.length ? `⏳ ${cooling.map((t) => `Token ${t.index} resting ${t.cooldownSeconds}s`).join(', ')}` : '✅ All tokens ready');
  lines.push('');

  lines.push(oddsSpend('Today (this bot)', o.today));
  lines.push(oddsSpend('This month (this bot)', o.month));
  if (o.cacheSavedEstimate > 0) lines.push(`🧮 The cache saved roughly *${num(o.cacheSavedEstimate)} credits* this month (estimate)`);
  lines.push('', '_Open the other pages for per-key detail, where the credits went, and the 14-day history._');
  return lines.join('\n');
}

const KEY_STATUS: Record<string, string> = {
  active: '✅ active',
  low: '⚠️ low — per-match fetches paused on this key',
  exhausted: '⛔ out of credits',
  disabled: '🚫 rejected as invalid (until restart)',
  unused: '⚪ no balance read yet this month',
};

function oddsText(r: UsageReport): string {
  const o = r.odds;
  const blocks: string[] = [`🎯 *The Odds API — per key*`, `_${formatStamp(r.generatedAt)} WAT_`];
  if (!o.keys.length) blocks.push('', 'No key is configured (set ODDS_API_KEY).');

  for (const k of o.keys) {
    const l: string[] = ['', `*Key ${k.index}* (${k.tag}) ${KEY_STATUS[k.status]}`];
    if (k.remaining !== null && k.quota) l.push(`${bar(k.remaining / k.quota)} ${num(k.remaining)} / ${num(k.quota)} left (${Math.round((k.remaining / k.quota) * 100)}%)`);
    else if (k.remaining !== null) l.push(`${num(k.remaining)} credits left`);
    if (k.used !== null) l.push(`Used this month: ${num(k.used)}${k.asOf ? ` · read ${ago(k.asOf, r.generatedAt)}` : ''}`);
    if (k.lastCall) {
      const [kind, league] = k.lastCall.label.split(' ');
      l.push(`Last call ${ago(k.lastCall.at, r.generatedAt)}: ${KIND_LABEL[kind] ?? kind} · ${leagueName(league ?? '')} · cost ${k.lastCall.cost ?? '?'}${k.lastCall.ok ? '' : ' · failed'}`);
    }
    l.push(`This bot — today: ${plural(k.today.credits, 'credit')} · month: ${plural(k.month.credits, 'credit')} (${plural(k.month.calls, 'call')})`);
    if (k.month.credits > 0) {
      l.push(`• What: ${breakdown(Object.fromEntries(Object.entries(k.month.byKind).map(([a, b]) => [a, b.credits])), (x) => KIND_LABEL[x] ?? x)}`);
      l.push(`• League: ${breakdown(k.month.byLeague, leagueName)}`);
      l.push(`• Why: ${breakdown(k.month.byPurpose, (x) => PURPOSE_LABEL[x] ?? x)}`);
    }
    blocks.push(l.join('\n'));
  }

  blocks.push('');
  const tail: string[] = [];
  if (o.remaining !== null) tail.push(`*All keys:* ${num(o.remaining)}${o.quota ? ` of ${num(o.quota)}` : ''} credits left${o.used !== null ? `, ${num(o.used)} used` : ''}`);
  if (o.ratePerDay !== null) tail.push(`Pace: ~${num(o.ratePerDay)} credits/day${o.runOutAt && o.willRunOutBeforeReset ? ` → ⚠️ empty around ${shortDate(o.runOutAt)}` : ' → fine until the reset'}`);
  tail.push(`Credits reset on ${shortDate(r.nextReset)} (assumed 00:00 UTC) · per-match fetches stop on a key at ${o.reserve} left`);
  blocks.push(tail.join('\n'));
  return blocks.join('\n');
}

function fdText(r: UsageReport): string {
  const f = r.fd;
  const blocks: string[] = [`⚽ *football-data.org — per token*`, `_${formatStamp(r.generatedAt)} WAT · limit ${f.limitPerMinute} calls/min per token_`];
  for (const t of f.tokens) {
    const status = t.status === 'cooling' ? `⏳ resting ${t.cooldownSeconds}s` : t.status === 'unused' ? '⚪ not used yet' : '✅ ready';
    const l: string[] = ['', `*Token ${t.index}* (${t.tag}) ${status}`];
    // The API's own "calls left this minute" is only meaningful for the minute it was read in.
    const api = t.availableThisMinute !== null && t.availableAt && r.generatedAt - t.availableAt < 60_000 ? ` · API says ${t.availableThisMinute} left (${ago(t.availableAt, r.generatedAt)})` : '';
    l.push(`Last minute: ${t.callsLastMinute} of ${f.limitPerMinute}${api}`);
    l.push(`Today: ${plural(t.today.calls, 'call')} · peak ${t.today.peakPerMinute}/min · ${t.today.rateLimited} rate-limited${t.today.forbidden ? ` · ${t.today.forbidden} forbidden` : ''}${t.today.errors ? ` · ${t.today.errors} errors` : ''}`);
    l.push(`Month: ${plural(t.month.calls, 'call')} · ${t.month.rateLimited} rate-limited`);
    l.push(`Last call: ${ago(t.lastCallAt, r.generatedAt)}${t.lastStatus ? ` (status ${t.lastStatus})` : ''}`);
    if (t.month.calls > 0) l.push(`• Busiest: ${breakdown(t.month.byEndpoint, (x) => x).split(' · ').slice(0, 5).join(' · ')}`);
    blocks.push(l.join('\n'));
  }
  blocks.push('', `All tokens — last minute: ${f.callsLastMinute} of ${f.limitPerMinute * f.tokens.length} · today ${num(f.today.calls)} · month ${num(f.month.calls)}`);
  return blocks.join('\n');
}

function historyText(r: UsageReport): string {
  const pad = (v: string | number, w: number): string => String(v).padStart(w);
  const rows = r.history.map((h) => {
    const label = new Date(`${h.date}T00:00:00Z`);
    const date = `${String(label.getUTCDate()).padStart(2, ' ')} ${MONTH_NAMES[label.getUTCMonth()].slice(0, 3)}`;
    return `${date}  ${pad(h.oddsCredits, 7)}  ${pad(h.oddsCalls, 5)}  ${pad(h.fdCalls, 6)}  ${pad(h.fdRateLimited, 4)}`;
  });
  const total = r.history.reduce((a, h) => ({ c: a.c + h.oddsCredits, k: a.k + h.oddsCalls, f: a.f + h.fdCalls, l: a.l + h.fdRateLimited }), { c: 0, k: 0, f: 0, l: 0 });
  return (
    `📅 *Last 14 days*\n_Days are UTC · Odds API = this bot's calls and credits_\n\n` +
    '```\n' +
    `Day      Credits  Calls  FD-calls  429s\n` +
    rows.join('\n') +
    `\nTotal   ${pad(total.c, 7)}  ${pad(total.k, 5)}  ${pad(total.f, 6)}  ${pad(total.l, 4)}\n` +
    '```'
  );
}

async function sendStatsPage(sock: any, message: any, chatId: string, channelInfo: any, page: string) {
  const report = await getUsageReport();
  const text = page === 'odds' ? oddsText(report) : page === 'fd' ? fdText(report) : page === 'history' ? historyText(report) : overviewText(report);
  await sock.sendMessage(chatId, { text, ...channelInfo }, { quoted: message });
}

async function runAdminStats(sock: any, message: any, chatId: string, userId: string, channelInfo: any) {
  const pick = await promptMenu(sock, message, chatId, userId, {
    title: '📊 API usage',
    text: 'Owner dashboard — what do you want to see?',
    options: [
      { label: '📊 Overview', value: 'overview', description: 'Both APIs at a glance' },
      { label: '🎯 Odds API keys', value: 'odds', description: 'Credits per key, pace, where they went' },
      { label: '⚽ football-data tokens', value: 'fd', description: 'Calls vs the 10/min limit' },
      { label: '📅 Last 14 days', value: 'history', description: 'Daily usage' },
    ],
    cancelLabel: 'Exit',
  });
  if (pick.cancelled || pick.timedOut || !pick.value) return;

  try {
    await sendStatsPage(sock, message, chatId, channelInfo, pick.value);
  } catch (err) {
    console.error('[sportybet] stats failed:', err);
    await sock.sendMessage(chatId, { text: '⚠️ Could not build the usage report right now.', ...channelInfo }, { quoted: message });
    return;
  }
  return runAdminStats(sock, message, chatId, userId, channelInfo); // back to the menu for the next page
}

// ─────────────────────────────────────────────────────────────────────────
// Entry point — the only screen with an Exit button; everywhere deeper uses Back.
// ─────────────────────────────────────────────────────────────────────────

async function runMainMenu(sock: any, message: any, chatId: string, userId: string, channelInfo: any) {
  const result = await promptMenu(sock, message, chatId, userId, {
    title: '⚽ SPORTYBET',
    text: 'Virtual football betting — Premier League, La Liga & Champions League. Real odds, your coins.',
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

  // Owner dashboard. `.sportybet stats` opens the menu; `.sportybet stats odds|fd|history|overview` jumps to a page.
  if (shortcut === 'stats' || shortcut === 'usage') {
    if (!(await isStatsAdmin(sock, senderId, chatId))) {
      await sock.sendMessage(chatId, { text: '🔒 The usage dashboard is for the bot owner.', ...channelInfo }, { quoted: message });
      return;
    }
    const page = (args[1] || '').toLowerCase();
    if (['overview', 'odds', 'fd', 'history'].includes(page)) {
      try {
        return await sendStatsPage(sock, message, chatId, channelInfo, page);
      } catch (err) {
        console.error('[sportybet] stats failed:', err);
        return sock.sendMessage(chatId, { text: '⚠️ Could not build the usage report right now.', ...channelInfo }, { quoted: message });
      }
    }
    return runAdminStats(sock, message, chatId, userId, channelInfo);
  }
  // `.sportybet load K7M2QX`, `.sportybet code K7M2QX`, or just `.sportybet K7M2QX`
  if (['load', 'code', 'booking', 'book'].includes(shortcut)) {
    const outcome = await runLoadBookingCode(sock, message, chatId, userId, channelInfo, args.slice(1).join(' '));
    if (outcome === 'back') return runMainMenu(sock, message, chatId, userId, channelInfo);
    return;
  }
  if (args.length === 1 && parseBookingCode(args[0])) {
    const outcome = await runLoadBookingCode(sock, message, chatId, userId, channelInfo, args[0]);
    if (outcome === 'back') return runMainMenu(sock, message, chatId, userId, channelInfo);
    return;
  }

  return runMainMenu(sock, message, chatId, userId, channelInfo);
}

export const handler = withEconomyGuard(_handler);