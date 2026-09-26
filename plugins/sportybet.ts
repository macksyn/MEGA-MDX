// @ts-nocheck
/***
 * plugins/sportybet.ts
 *
 * Virtual Premier League sportsbook. All match data, odds joining, coupon
 * math, and settlement live in lib/sportybet.ts — this file is purely the
 * button-menu UI and command wiring, same split as economy.ts/eco_balance.ts
 * and slotMachine.ts/eco_jackpot.ts.
 *
 * Flow: !sportybet opens a menu (Place a Bet / My Bets / Fixtures &
 * Results). Placing a bet is a loop — pick a fixture, pick Home/Draw/Away,
 * then choose to add another match or stake what you've got — because a
 * coupon can hold more than one leg (accumulator: all legs must win).
 * Settlement itself runs elsewhere on a schedule (pollAndSettleCoupons in
 * lib/sportybet.ts) — this file only ever reads/displays coupon state.
 */
import { withEconomyGuard, formatNumber, getWallet } from '../lib/economy.js';
import { promptMenu, promptAmount } from '../lib/buttonSession.js';
import { cleanJid } from '../lib/isOwner.js';
import {
  fetchUpcomingFixtures,
  fetchOddsTips,
  fetchAllSeasonMatches,
  joinFixturesWithOdds,
  normalizeTeamName,
  computePotentialPayout,
  placeCoupon,
  getUserCoupons,
  formatCoupon,
  MIN_STAKE,
  MAX_STAKE,
  MAX_LEGS_PER_COUPON,
  type FixtureWithOdds,
  type PlaceCouponPick,
  type Selection,
  type Coupon,
} from '../lib/sportybet.js';

export const command = 'sportybet';
export const aliases = ['bet', 'sb', 'sporty'];
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

function selectionLabel(pick: { homeTeam: string; awayTeam: string; selection: Selection }): string {
  return pick.selection === 'home' ? pick.homeTeam : pick.selection === 'away' ? pick.awayTeam : 'Draw';
}

function buildSlipPreview(picks: PlaceCouponPick[]): string {
  return picks.map((p, i) => `${i + 1}. ${p.homeTeam} vs ${p.awayTeam} — ${selectionLabel(p)} @ ${p.odds}`).join('\n');
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
// Place a Bet — loops: pick fixture -> pick selection -> add another or stake
// ─────────────────────────────────────────────────────────────────────────

async function runPlaceBetFlow(sock: any, message: any, chatId: string, userId: string, channelInfo: any) {
  await sock.sendMessage(chatId, { text: '⏳ Pulling the latest fixtures and odds...', ...channelInfo }, { quoted: message });

  let fixtures, tips;
  try {
    [fixtures, tips] = await Promise.all([fetchUpcomingFixtures(), fetchOddsTips()]);
  } catch (err) {
    console.error('[sportybet] failed to load fixtures/odds:', err);
    return sock.sendMessage(
      chatId,
      { text: '⚠️ Could not reach the odds service right now — try again shortly.', ...channelInfo },
      { quoted: message }
    );
  }

  const joined = joinFixturesWithOdds(fixtures, tips).filter((f) => f.odds);
  if (!joined.length) {
    return sock.sendMessage(
      chatId,
      { text: '📭 No odds are available for any upcoming fixtures right now.', ...channelInfo },
      { quoted: message }
    );
  }

  const picks: PlaceCouponPick[] = [];

  while (true) {
    const remaining = joined.filter((f) => !picks.some((p) => sameMatch(p, f)));
    if (!remaining.length) break;

    const page = remaining.slice(0, 10); // proven ceiling for the single_select path (Global Trader's max was 10)
    const more = remaining.length - page.length;

    const fixtureResult = await promptMenu(sock, message, chatId, userId, {
      title: picks.length ? `⚽ Add another match (${picks.length}/${MAX_LEGS_PER_COUPON} picked)` : '⚽ Pick a match',
      text: more > 0 ? `Showing the next ${page.length} of ${remaining.length} fixtures.` : 'Choose a fixture to bet on.',
      options: page.map((f: FixtureWithOdds, i: number) => ({
        label: `${f.homeTeam} vs ${f.awayTeam}`,
        value: String(i),
        description: formatKickoff(f.kickoff),
      })),
    });

    if (fixtureResult.cancelled || fixtureResult.timedOut) {
      if (!picks.length) return;
      break; // they've got at least one leg — fall through to staking what they have
    }

    const fixture = page[Number(fixtureResult.value)];

    const selResult = await promptMenu(sock, message, chatId, userId, {
      title: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
      text: formatKickoff(fixture.kickoff),
      options: [
        { label: `🏠 ${fixture.homeTeam}`, value: 'home', description: `@ ${fixture.odds.home}` },
        { label: '🤝 Draw', value: 'draw', description: `@ ${fixture.odds.draw}` },
        { label: `✈️ ${fixture.awayTeam}`, value: 'away', description: `@ ${fixture.odds.away}` },
      ],
    });

    if (selResult.cancelled || selResult.timedOut) {
      if (!picks.length) return;
      break;
    }

    const selection = selResult.value as Selection;
    picks.push({
      homeTeam: fixture.homeTeam,
      awayTeam: fixture.awayTeam,
      kickoff: fixture.kickoff,
      selection,
      odds: fixture.odds[selection],
    });

    if (picks.length >= MAX_LEGS_PER_COUPON) break;

    const againResult = await promptMenu(sock, message, chatId, userId, {
      title: `✅ Added (${picks.length} leg${picks.length > 1 ? 's' : ''} so far)`,
      text: buildSlipPreview(picks),
      options: [
        { label: '➕ Add another match', value: 'more' },
        { label: '💰 Place this bet', value: 'stake' },
      ],
    });

    if (againResult.cancelled || againResult.timedOut) break; // treat as "done adding, go stake"
    if (againResult.value === 'stake') break;
    // else 'more' -> loop continues
  }

  if (!picks.length) return;

  const wallet = await getWallet(userId);
  const maxStake = Math.min(MAX_STAKE, wallet.coins);

  if (maxStake < MIN_STAKE) {
    return sock.sendMessage(
      chatId,
      {
        text: `❌ You need at least ${formatNumber(MIN_STAKE)} coins to place a bet. Your balance: ${formatNumber(wallet.coins)}.`,
        ...channelInfo,
      },
      { quoted: message }
    );
  }

  const stakeResult = await promptAmount(sock, message, chatId, userId, {
    title: '💰 Enter your stake',
    text: `${buildSlipPreview(picks)}\n\nYour balance: ${formatNumber(wallet.coins)} coins`,
    min: MIN_STAKE,
    max: maxStake,
  });

  if (stakeResult.cancelled || stakeResult.timedOut) {
    return sock.sendMessage(
      chatId,
      { text: stakeResult.timedOut ? '⌛ Bet slip expired.' : '❌ Bet cancelled.', ...channelInfo },
      { quoted: message }
    );
  }

  const stake = stakeResult.value;
  const potentialPayout = computePotentialPayout(
    stake,
    picks.map((p) => ({ status: 'pending' as const, oddsAtPlacement: p.odds }))
  );

  const confirmResult = await promptMenu(sock, message, chatId, userId, {
    title: '🧾 Confirm your bet',
    text: `${buildSlipPreview(picks)}\n\nStake: ${formatNumber(stake)} coins\nPotential payout: ${formatNumber(potentialPayout)} coins`,
    options: [{ label: '✅ Confirm', value: 'confirm' }],
  });

  if (confirmResult.cancelled || confirmResult.timedOut || confirmResult.value !== 'confirm') {
    return sock.sendMessage(chatId, { text: '❌ Bet cancelled — no coins were deducted.', ...channelInfo }, { quoted: message });
  }

  const result = await placeCoupon(userId, stake, picks);

  if (!result.success) {
    return sock.sendMessage(chatId, { text: `❌ ${placeCouponErrorMessage(result.reason)}`, ...channelInfo }, { quoted: message });
  }

  await sock.sendMessage(chatId, { text: `🎉 Bet placed!\n\n${formatCoupon(result.coupon)}`, ...channelInfo }, { quoted: message });
}

// ─────────────────────────────────────────────────────────────────────────
// My Bets
// ─────────────────────────────────────────────────────────────────────────

async function runMyBetsFlow(sock: any, message: any, chatId: string, userId: string, channelInfo: any) {
  const coupons = await getUserCoupons(userId);
  if (!coupons.length) {
    return sock.sendMessage(
      chatId,
      { text: '📭 You have no coupons yet. Try *Place a Bet* from the menu.', ...channelInfo },
      { quoted: message }
    );
  }

  const page = coupons.slice(0, 10); // getUserCoupons returns newest-first

  const listResult = await promptMenu(sock, message, chatId, userId, {
    title: '🎫 My Bets',
    text: `You have ${coupons.length} coupon${coupons.length > 1 ? 's' : ''}. Showing the ${page.length} most recent.`,
    options: page.map((c) => ({
      label: `${COUPON_LIST_EMOJI[c.status]} ${c.legs.length}-leg · ${formatNumber(c.stake)} coins`,
      value: c.id,
      description: `${c.status.toUpperCase()} · placed ${formatDateShort(c.placedAt)}`,
    })),
  });

  if (listResult.cancelled || listResult.timedOut) return;

  const coupon = page.find((c) => c.id === listResult.value);
  if (!coupon) return;

  await sock.sendMessage(chatId, { text: formatCoupon(coupon), ...channelInfo }, { quoted: message });
}

// ─────────────────────────────────────────────────────────────────────────
// Fixtures & Results
// ─────────────────────────────────────────────────────────────────────────

async function runFixturesFlow(sock: any, message: any, chatId: string, userId: string, channelInfo: any) {
  const modeResult = await promptMenu(sock, message, chatId, userId, {
    title: '📅 Fixtures & Results',
    text: 'What would you like to see?',
    options: [
      { label: '📆 Upcoming Fixtures', value: 'upcoming' },
      { label: '🏁 Recent Results', value: 'results' },
    ],
  });

  if (modeResult.cancelled || modeResult.timedOut) return;

  if (modeResult.value === 'upcoming') {
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
// Entry point
// ─────────────────────────────────────────────────────────────────────────

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, senderId, channelInfo } = context;
  const userId = cleanJid(senderId);

  const shortcut = (args[0] || '').toLowerCase();
  if (shortcut === 'mybets' || shortcut === 'bets') return runMyBetsFlow(sock, message, chatId, userId, channelInfo);
  if (shortcut === 'fixtures' || shortcut === 'fx') return runFixturesFlow(sock, message, chatId, userId, channelInfo);

  const menuResult = await promptMenu(sock, message, chatId, userId, {
    title: '⚽ SPORTYBET',
    text: 'Virtual Premier League betting — real odds, your coins.',
    options: [
      { label: '💰 Place a Bet', value: 'place' },
      { label: '🎫 My Bets', value: 'mybets' },
      { label: '📅 Fixtures & Results', value: 'fixtures' },
    ],
  });

  if (menuResult.cancelled || menuResult.timedOut) return;

  if (menuResult.value === 'place') return runPlaceBetFlow(sock, message, chatId, userId, channelInfo);
  if (menuResult.value === 'mybets') return runMyBetsFlow(sock, message, chatId, userId, channelInfo);
  if (menuResult.value === 'fixtures') return runFixturesFlow(sock, message, chatId, userId, channelInfo);
}

export const handler = withEconomyGuard(_handler);