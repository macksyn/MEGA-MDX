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
 * odds multiply) across three markets — Match Winner (1x2), Total Goals
 * (over/under), and Both Teams to Score (btts, only offered when the odds
 * provider actually lists it for that match). Settlement itself runs
 * elsewhere on a schedule (pollAndSettleCoupons in lib/sportybet.ts) — this
 * file only ever reads/displays coupon state.
 */
import { withEconomyGuard, formatNumber, getWallet } from '../lib/economy.js';
import { promptMenu, promptAmount } from '../lib/buttonSession.js';
import { cleanJid } from '../lib/isOwner.js';
import {
  fetchUpcomingFixtures,
  fetchOddsTips,
  fetchAllSeasonMatches,
  fetchBttsIfAvailable,
  joinFixturesWithOdds,
  normalizeTeamName,
  computePotentialPayout,
  placeCoupon,
  getUserCoupons,
  formatCoupon,
  legPickLabel,
  MIN_STAKE,
  MAX_STAKE,
  MAX_LEGS_PER_COUPON,
  type FixtureWithOdds,
  type PlaceCouponPick,
  type Market,
  type Selection,
  type Coupon,
} from '../lib/sportybet.js';

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
  if (market === '1x2') return 'Match Winner';
  if (market === 'totals') return 'Total Goals';
  return 'Both Teams to Score';
}

function buildSlipPreview(picks: PlaceCouponPick[]): string {
  return picks.map((p, i) => `${i + 1}. ${p.homeTeam} vs ${p.awayTeam} — ${legPickLabel(p)} @ ${p.odds}`).join('\n');
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
  bttsOdds: { yes: number; no: number } | null
) {
  let options: { label: string; value: string; description?: string }[];

  if (market === '1x2') {
    options = [
      { label: `🏠 ${fixture.homeTeam}`, value: 'home', description: `@ ${fixture.h2h!.home}` },
      { label: '🤝 Draw', value: 'draw', description: `@ ${fixture.h2h!.draw}` },
      { label: `✈️ ${fixture.awayTeam}`, value: 'away', description: `@ ${fixture.h2h!.away}` },
    ];
  } else if (market === 'totals') {
    options = [
      { label: `⬆️ Over ${fixture.totals!.point}`, value: 'over', description: `@ ${fixture.totals!.over}` },
      { label: `⬇️ Under ${fixture.totals!.point}`, value: 'under', description: `@ ${fixture.totals!.under}` },
    ];
  } else {
    options = [
      { label: '✅ Yes', value: 'yes', description: `@ ${bttsOdds!.yes}` },
      { label: '❌ No', value: 'no', description: `@ ${bttsOdds!.no}` },
    ];
  }

  const result = await promptMenu(sock, message, chatId, userId, {
    title: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
    text: marketLabel(market),
    options,
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  const selection = result.value as Selection;
  const odds =
    market === '1x2'
      ? fixture.h2h![selection as 'home' | 'draw' | 'away']
      : market === 'totals'
      ? fixture.totals![selection as 'over' | 'under']
      : bttsOdds![selection as 'yes' | 'no'];

  const newPick: PlaceCouponPick = {
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    kickoff: fixture.kickoff,
    market,
    selection,
    point: market === 'totals' ? fixture.totals!.point : undefined,
    odds,
  };

  const outcome = await runAddOrStake(sock, message, chatId, userId, channelInfo, joined, [...picks, newPick]);
  if (outcome === 'back') {
    return runSelectionPicker(sock, message, chatId, userId, channelInfo, joined, picks, fixture, market, bttsOdds);
  }
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
  const options: { label: string; value: Market; description?: string }[] = [{ label: '⚽ Match Winner', value: '1x2' }];
  if (fixture.totals) options.push({ label: '🥅 Total Goals', value: 'totals', description: `O/U ${fixture.totals.point}` });

  // Cheap (1 credit) availability check, only for this one match, only when
  // it's actually opened — never pre-fetched for the whole fixture list.
  let bttsOdds: { yes: number; no: number } | null = null;
  if (fixture.eventId) {
    try {
      bttsOdds = await fetchBttsIfAvailable(fixture.eventId);
    } catch (err) {
      console.error('[sportybet] BTTS availability check failed:', err);
    }
  }
  if (bttsOdds) options.push({ label: '🎯 Both Teams to Score', value: 'btts' });

  const result = await promptMenu(sock, message, chatId, userId, {
    title: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
    text: `${formatKickoff(fixture.kickoff)}\nPick a market to bet on.`,
    options,
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  const market = result.value as Market;
  const outcome = await runSelectionPicker(sock, message, chatId, userId, channelInfo, joined, picks, fixture, market, bttsOdds);
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
    options: page.map((f, i) => ({ label: `${f.homeTeam} vs ${f.awayTeam}`, value: String(i), description: formatKickoff(f.kickoff) })),
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

  const joined = joinFixturesWithOdds(fixtures, tips).filter((f) => f.h2h);
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

  if (result.value === 'upcoming') {
    let fixtures;
    try {
      fixtures = await fetchUpcomingFixtures();
    } catch (err) {
      console.error('[sportybet] failed to load fixtures:', err);
      return sock.sendMessage(chatId, { text: '⚠️ Could not reach the fixtures service right now.', ...channelInfo }, { quoted: message });
    }
    // Reuse the join purely to flatten the nested homeTeam/awayTeam objects — no odds tips needed here.
    const withKickoff = joinFixturesWithOdds(fixtures, []).slice(0, 10);
    const text = withKickoff.map((f) => `⚽ ${f.homeTeam} vs ${f.awayTeam}\n   ${formatKickoff(f.kickoff)}`).join('\n\n');
    return sock.sendMessage(
      chatId,
      { text: `📆 *Upcoming Fixtures*\n\n${text || 'No upcoming fixtures found.'}`, ...channelInfo },
      { quoted: message }
    );
  }

  let matches;
  try {
    matches = await fetchAllSeasonMatches();
  } catch (err) {
    console.error('[sportybet] failed to load results:', err);
    return sock.sendMessage(chatId, { text: '⚠️ Could not reach the results service right now.', ...channelInfo }, { quoted: message });
  }
  const finished = matches.filter((m) => m.status === 'FINISHED').slice(-10).reverse();
  const text = finished
    .map((m) => {
      const emoji = m.score.winner === 'DRAW' ? '🤝' : '⚽';
      return `${emoji} ${m.homeTeam.name} ${m.score.fullTime.home} - ${m.score.fullTime.away} ${m.awayTeam.name}`;
    })
    .join('\n');
  return sock.sendMessage(
    chatId,
    { text: `🏁 *Recent Results*\n\n${text || 'No finished matches yet.'}`, ...channelInfo },
    { quoted: message }
  );
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
