// @ts-nocheck
/***
 * plugins/forex.ts
 *
 * Forex – WhatsApp Command Handler (Phase 1: instant rounds).
 * Commands: .forex <pair> <bet> <call|put>
 *           .forex menu   — guided, type-a-number menu (no syntax to memorize)
 *           .forex prices | .forex market
 *           .forex profile | .forex stats
 *           .forex help | .forex guide
 *
 * Pair, bet, and direction can be given in any order — `.forex buy eurusd 20`
 * works the same as `.forex eurusd 20 call`.
 */

import { deductGroqCoins, addGroqCoins, getWallet, withEconomyGuard, formatNumber } from '../lib/economy.js';
import {
  resolveRound,
  getBankPool,
  contributeToBank,
  deductFromBank,
  incrementAndGetRounds,
  recordPlayerActivity,
  recordHouseActivity,
  getPlayerProfile,
  FOREX_SEED,
  Direction,
} from '../lib/forexGame.js';
import { getMarketSnapshot, getPairQuote, PAIRS } from '../lib/forexMarket.js';
import { validateForexRound, recordForexOutcome } from '../lib/forexAntiExploit.js';
import { promptMenu } from '../lib/menuSession.js';
import { cleanJid } from '../lib/isOwner.js';

export const command = 'forex';
export const aliases = ['fx', 'forextrade'];
export const category = 'economy-games';
export const cooldown = 3000;

const ALLOWED_BETS = [5, 20, 50, 100];

const PAIR_ALIASES: Record<string, string> = {
  eurusd: 'EURUSD', 'eur/usd': 'EURUSD', eur: 'EURUSD',
  gbpusd: 'GBPUSD', 'gbp/usd': 'GBPUSD', gbp: 'GBPUSD',
  usdjpy: 'USDJPY', 'usd/jpy': 'USDJPY', jpy: 'USDJPY',
  audusd: 'AUDUSD', 'aud/usd': 'AUDUSD', aud: 'AUDUSD',
};
const CALL_ALIASES = new Set(['call', 'buy', 'up', 'long']);
const PUT_ALIASES = new Set(['put', 'sell', 'down', 'short']);

// ── Visual language (kept minimal & distinct from Ocean Hunt — a trading
// ticker calls for a different feel than a fishing trip) ────────────────

const DIVIDER = '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈';
function header(): string {
  return `💹 *FOREX* 💹\n${DIVIDER}`;
}

const REGIME_EMOJI: Record<string, string> = {
  ranging: '📏', trending_bull: '📈', trending_bear: '📉',
  volatile: '⚡', flash_crash: '🔻', rally: '🚀',
};

function deltaLine(amount: number): string {
  if (amount > 0) return `▲ *+${formatNumber(amount)}* Groq Coins`;
  if (amount < 0) return `▼ *-${formatNumber(Math.abs(amount))}* Groq Coins`;
  return `• No change`;
}

function fmtPrice(price: number, decimals: number): string {
  return price.toFixed(decimals);
}

/** Cosmetic progress bar — same visual language as Ocean Hunt's jackpot bar. */
function progressBar(value: number, max: number, size = 10): string {
  const filled = Math.max(0, Math.min(size, Math.round((value / max) * size)));
  return '▰'.repeat(filled) + '▱'.repeat(size - filled);
}
const BANK_BAR_MAX = FOREX_SEED * 6;

/** Turns the net pip move into an at-a-glance gauge against the tier
 *  thresholds (6 / 15 / 30 / 55), so a win/loss/scratch reads visually
 *  instead of as a bare number. Direction of the fill shows which side of
 *  zero (the spread line) the move landed on. */
const TIER_GAUGE_MAX = 55;
function pipGauge(netPips: number, size = 10): string {
  if (netPips <= 0) {
    const bite = Math.max(0, Math.min(size, Math.round((Math.abs(netPips) / TIER_GAUGE_MAX) * size)));
    return '◈'.repeat(bite) + '▱'.repeat(size - bite);
  }
  const fill = Math.max(1, Math.min(size, Math.round((netPips / TIER_GAUGE_MAX) * size)));
  return '▰'.repeat(fill) + '▱'.repeat(size - fill);
}

async function marketBoardText(): Promise<string> {
  const snap = await getMarketSnapshot();
  const pool = await getBankPool();
  const eventLine = snap.activeEvent
    ? `⚡ ${snap.activeEvent.emoji} *${snap.activeEvent.name}* — ${snap.activeEvent.description}\n`
    : '';
  let lines =
    `${REGIME_EMOJI[snap.regime] || '📏'} *${snap.regimeLabel}*\n${eventLine}` +
    `🏦 Bank  ${progressBar(pool, BANK_BAR_MAX)}  ${formatNumber(pool)} Groq Coins\n` +
    `${DIVIDER}\n`;
  for (const q of snap.quotes) {
    const pad = q.display.padEnd(8, ' ');
    lines += ` ${pad} ${fmtPrice(q.bid, q.decimals)} / ${fmtPrice(q.ask, q.decimals)}   _(${q.spreadPips.toFixed(1)}p spread)_\n`;
  }
  return lines;
}

function helpText(): string {
  return (
    `${header()}\n` +
    `*THE FULL GUIDE — start here if you're new*\n` +
    `${DIVIDER}\n` +
    `💱 *TRADES IN GROQ COINS, NOT COINS*\n` +
    `Forex is staked in *Groq Coins* — the same currency\n` +
    `you use for withdrawals, not your everyday coins.\n\n` +
    `Groq Coins aren't self-converted — a member has to\n` +
    `run \`.exchange <coins> @you\` (spending *their* coins\n` +
    `to grow *your* Groq Coins). Ask around, then check\n` +
    `\`.exchange owed\` to see who owes you one back.\n` +
    `${DIVIDER}\n` +
    `📖 *COMMANDS*\n` +
    ` \`.forex <pair> <bet> <call|put>\`  — place a trade\n` +
    ` \`.forex menu\`  — guided menu, no syntax to remember\n` +
    ` \`.forex prices\`  — check the live board, no bet needed\n` +
    ` \`.forex profile\`  — your rounds, staked, won & RTP\n` +
    ` \`.forex help\`  — this guide\n\n` +
    `_Pair, bet & direction can be in any order —_\n` +
    `_\`.forex eurusd 20 call\` = \`.forex buy eurusd 20\`_\n` +
    `${DIVIDER}\n` +
    `💱 *PAIRS*\n` +
    ` EUR/USD · GBP/USD · USD/JPY · AUD/USD\n` +
    `_Not real-time prices — a self-contained simulated_\n` +
    `_market. EUR/USD, GBP/USD & AUD/USD tend to move_\n` +
    `_together; USD/JPY tends to move the opposite way —_\n` +
    `_watching that relationship is part of the strategy._\n` +
    `${DIVIDER}\n` +
    `📈📉 *DIRECTION*\n` +
    ` 📈 price will RISE  →  call · buy · up · long\n` +
    ` 📉 price will FALL  →  put · sell · down · short\n` +
    `${DIVIDER}\n` +
    `⚙️ *HOW A ROUND WORKS*\n` +
    `1️⃣ You bet & pick a direction.\n` +
    `2️⃣ Your order fills — buying costs slightly above\n` +
    `    mid-price, selling slightly below it. That gap is\n` +
    `    the *spread* (shown on the price board) — the one\n` +
    `    fixed cost of every trade, win or lose.\n` +
    `3️⃣ The market moves while your position is open.\n` +
    `4️⃣ Position closes, result revealed.\n\n` +
    `❌ *Wrong call* — price moved against you, lose stake\n` +
    `➖ *Scratch* — right call, but too small to clear the\n` +
    `    spread. Full stake refunded, no win no loss.\n` +
    `✅ *Win* — right call *and* cleared the spread. Payout\n` +
    `    scales with how big the move was.\n` +
    `${DIVIDER}\n` +
    `🏆 *WIN TIERS* — bigger move, bigger multiplier\n` +
    ` Move             small win, no banner\n` +
    ` 🎉 BIG MOVE!      moderate\n` +
    ` 🔥 MEGA MOVE!     large\n` +
    ` 💥 SUPER MEGA MOVE!  very large\n` +
    ` 🌊 MARKET SURGE!  extreme, needs volatile conditions\n\n` +
    `_Mega+ tiers are rare in calm markets — they mostly_\n` +
    `_show up during volatile conditions or news events,_\n` +
    `_just like real forex._\n` +
    `${DIVIDER}\n` +
    `🌍 *MARKET CONDITIONS* — check \`.forex prices\` anytime\n` +
    ` 📏 Ranging     calm, choppy sideways\n` +
    ` 📈 Risk-On Rally   broad drift up on majors\n` +
    ` 📉 Dollar Strength  broad drift down on majors\n` +
    ` ⚡ Choppy & Volatile  bigger swings, bigger tiers\n` +
    ` 🔻 Flash Crash / 🚀 Short Squeeze  rare, short, wild\n\n` +
    `⚡ *News events* (rate decisions, jobs data, inflation,_\n` +
    `_geopolitics) spike volatility and can gap the price —_\n` +
    `_shown on the board when active. Your best shot at a_\n` +
    `_Mega Move or better._\n` +
    `${DIVIDER}\n` +
    `ℹ️ *GOOD TO KNOW*\n` +
    `• Staked & paid in *Groq Coins*, separate from your\n` +
    `  everyday coin balance — a member sends you Groq\n` +
    `  Coins via \`.exchange <coins> @you\`, not self-service.\n` +
    `• The edge here isn't a hidden odds table — it's the\n` +
    `  spread, same as a real broker. The market decides\n` +
    `  your result, nothing is secretly weighted.\n` +
    `• Fair-use limits apply on trades per hour/day, plus\n` +
    `  automated checks against bet-pattern abuse. A\n` +
    `  "temporarily restricted" message clears on its own.\n` +
    `• This is instant-round trading only for now — no open\n` +
    `  positions, leverage, or stop-loss/take-profit yet.\n\n` +
    `_Ready? \`.forex eurusd 20 call\`_`
  );
}

// ── Parsing helpers ───────────────────────────────────────────────────

function parseOrder(args: string[]): { pair?: string; bet?: number; direction?: Direction; error?: string } {
  let pair: string | undefined;
  let bet: number | undefined;
  let direction: Direction | undefined;

  for (const raw of args) {
    const token = raw.toLowerCase();
    if (!pair && PAIR_ALIASES[token]) {
      pair = PAIR_ALIASES[token];
      continue;
    }
    if (!direction && CALL_ALIASES.has(token)) { direction = 'call'; continue; }
    if (!direction && PUT_ALIASES.has(token)) { direction = 'put'; continue; }
    if (bet === undefined) {
      const n = parseInt(raw, 10);
      if (!isNaN(n)) { bet = n; continue; }
    }
  }
  return { pair, bet, direction };
}

// ── Trade execution — shared by the typed-command path and the menu path ──

async function executeTrade(sock: any, message: any, context: any, pair: string, bet: number, direction: Direction) {
  const { chatId, senderId, channelInfo } = context;
  const userId = cleanJid(senderId);

  // ── Anti-Exploit Validation ────────────────────────────────────
  const { allowed, reason } = await validateForexRound(userId, bet, pair, direction);
  if (!allowed) {
    return sock.sendMessage(chatId, {
      text: `${header()}\n❌ ${reason || 'Order blocked.'}`,
      ...channelInfo,
    }, { quoted: message });
  }

  // ── Deduct stake (Groq Coins, not everyday coins) ───────────────
  const deducted = await deductGroqCoins(userId, bet, { type: 'forex' });
  if (!deducted.success) {
    return sock.sendMessage(chatId, {
      text: `${header()}\n❌ You don't have enough Groq Coins for that trade.\n_Ask a member to run \`.exchange <coins> @you\` — check \`.exchange owed\` too._`,
      ...channelInfo,
    }, { quoted: message });
  }

  await contributeToBank(bet);
  const pool = await getBankPool();
  await incrementAndGetRounds(userId);

  const preQuote = await getPairQuote(pair);
  const cfg = PAIRS[pair];
  const dirLabel = direction === 'call' ? 'CALL 📈' : 'PUT 📉';
  const entryPreview = direction === 'call' ? preQuote.ask : preQuote.bid;

  // ── Ticking animation ────────────────────────────────────────────
  const TICKER_STAGES = [
    { spark: '▁▁▁▁▁', caption: 'Placing order...' },
    { spark: '▂▁▃▁▂', caption: 'Order filled. Market moving...' },
    { spark: '▂▃▁▄▂', caption: 'Watching the tape...' },
    { spark: '▃▅▂▄▃', caption: 'Volatility ticking...' },
    { spark: '▅▃▆▄▇', caption: 'Closing the position...' },
  ];
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const orderLine = `${cfg.display}  ${dirLabel}   Bet: *${formatNumber(bet)}* Groq Coins\nEntry ≈ ${fmtPrice(entryPreview, cfg.decimals)}`;

  const sent = await sock.sendMessage(chatId, {
    text: `${header()}\n${orderLine}\n\n${TICKER_STAGES[0].caption}\n${TICKER_STAGES[0].spark}`,
    ...channelInfo,
  }, { quoted: message });

  for (let i = 1; i < TICKER_STAGES.length; i++) {
    await delay(500);
    await sock.sendMessage(chatId, {
      text: `${header()}\n${orderLine}\n\n${TICKER_STAGES[i].caption}\n${TICKER_STAGES[i].spark}`,
      edit: sent.key,
      ...channelInfo,
    });
  }
  await delay(500);

  // ── Resolve round ──────────────────────────────────────────────
  const result = await resolveRound(pair, bet, direction, pool);

  if (result.winAmount > 0) {
    await addGroqCoins(userId, result.winAmount, { type: 'forex' });
    await deductFromBank(result.winAmount);
  }

  await recordHouseActivity(bet, Math.max(0, result.outcome === 'loss' ? 0 : result.winAmount));
  await recordPlayerActivity(userId, bet, result.winAmount);
  await recordForexOutcome(userId, bet, pair, direction, result.outcome, result.winAmount);

  let outcomeLine: string;
  if (result.outcome === 'loss') {
    outcomeLine = `❌ Wrong call — the market moved against you.\n${deltaLine(-bet)}`;
  } else if (result.outcome === 'scratch') {
    outcomeLine = `➖ Right call, but the move didn't clear the spread.\n_Stake refunded._`;
  } else {
    const cappedNote = result.capped ? '\n_(payout capped — bank reserve is low)_' : '';
    outcomeLine = `${deltaLine(result.winAmount)}${cappedNote}`;
  }

  const banner = result.bannerText ? `${result.bannerText}\n${DIVIDER}\n` : '';
  const eventLine = result.eventName ? `⚡ *${result.eventName}*\n` : '';
  const wallet = await getWallet(userId);

  const finalText =
    `${banner}` +
    `${header()}\n` +
    `${result.regimeEmoji} *${result.regimeLabel}*\n` +
    `${eventLine}` +
    `${DIVIDER}\n` +
    `${cfg.display}  ${dirLabel}   Bet: *${formatNumber(bet)}* Groq Coins\n` +
    `Entry: ${fmtPrice(result.entryPrice, result.decimals)}   Exit: ${fmtPrice(result.exitPrice, result.decimals)}\n` +
    `${pipGauge(result.netPips)}\n` +
    `Move: ${result.directionalPips >= 0 ? '+' : ''}${result.directionalPips.toFixed(1)}p   Spread: ${result.spreadPips.toFixed(1)}p   Net: ${result.netPips >= 0 ? '+' : ''}${result.netPips.toFixed(1)}p\n` +
    `${DIVIDER}\n` +
    `${outcomeLine}\n` +
    `${DIVIDER}\n` +
    `💰 Balance: *${formatNumber(wallet.groqCoins)}* Groq Coins`;

  await sock.sendMessage(chatId, {
    text: finalText,
    edit: sent.key,
    ...channelInfo,
  }, { quoted: message });
}

// ── Menu flow — the type-a-number alternative to memorizing syntax ────────
// Chains promptMenu() calls with plain await; each call already blocks
// until that step's reply comes in (or times out / gets cancelled), so no
// extra state machine is needed here.

async function runMenuFlow(sock: any, message: any, context: any) {
  const { chatId, senderId, channelInfo } = context;
  const userId = cleanJid(senderId);

  const action = await promptMenu(sock, message, chatId, userId, {
    title: header(),
    text: 'What would you like to do?',
    options: [
      { label: 'Place a trade', value: 'trade' },
      { label: 'Check prices', value: 'prices' },
      { label: 'My trading stats', value: 'profile' },
      { label: 'Full guide', value: 'help' },
    ],
    extra: channelInfo,
  });
  if (action.cancelled) {
    return sock.sendMessage(chatId, { text: `${header()}\n_Cancelled._`, ...channelInfo });
  }
  if (action.timedOut) {
    return sock.sendMessage(chatId, { text: `${header()}\n⌛ _Menu timed out — run \`.forex menu\` again when you're ready._`, ...channelInfo });
  }

  if (action.value === 'prices') {
    const board = await marketBoardText();
    return sock.sendMessage(chatId, { text: `${header()}\n${board}`, ...channelInfo });
  }
  if (action.value === 'help') {
    return sock.sendMessage(chatId, { text: helpText(), ...channelInfo });
  }
  if (action.value === 'profile') {
    const profile = await getPlayerProfile(userId);
    const rtpLine = profile.rounds > 0 ? `${(profile.rtp * 100).toFixed(1)}%` : '—';
    return sock.sendMessage(chatId, {
      text:
        `${header()}\n` +
        `📊 *YOUR TRADING STATS*\n\n` +
        ` Rounds        ${formatNumber(profile.rounds)}\n` +
        ` Total staked  ${formatNumber(profile.totalBet)} Groq Coins\n` +
        ` Total won     ${formatNumber(profile.totalWon)} Groq Coins\n` +
        ` Your RTP      ${rtpLine}`,
      ...channelInfo,
    });
  }

  // action.value === 'trade' — walk through pair, direction, bet.
  const pairChoice = await promptMenu(sock, message, chatId, userId, {
    title: header(),
    text: 'Which pair?',
    options: Object.values(PAIRS).map(cfg => ({ label: cfg.display, value: cfg.symbol })),
    extra: channelInfo,
  });
  if (pairChoice.cancelled) return sock.sendMessage(chatId, { text: `${header()}\n_Cancelled._`, ...channelInfo });
  if (pairChoice.timedOut) return sock.sendMessage(chatId, { text: `${header()}\n⌛ _Menu timed out._`, ...channelInfo });

  const dirChoice = await promptMenu(sock, message, chatId, userId, {
    title: header(),
    text: `${PAIRS[pairChoice.value].display} — which direction?`,
    options: [
      { label: '📈 CALL — price will rise', value: 'call' },
      { label: '📉 PUT — price will fall', value: 'put' },
    ],
    extra: channelInfo,
  });
  if (dirChoice.cancelled) return sock.sendMessage(chatId, { text: `${header()}\n_Cancelled._`, ...channelInfo });
  if (dirChoice.timedOut) return sock.sendMessage(chatId, { text: `${header()}\n⌛ _Menu timed out._`, ...channelInfo });

  const betChoice = await promptMenu(sock, message, chatId, userId, {
    title: header(),
    text: 'How many Groq Coins?',
    options: ALLOWED_BETS.map(b => ({ label: `${b} Groq Coins`, value: String(b) })),
    extra: channelInfo,
  });
  if (betChoice.cancelled) return sock.sendMessage(chatId, { text: `${header()}\n_Cancelled._`, ...channelInfo });
  if (betChoice.timedOut) return sock.sendMessage(chatId, { text: `${header()}\n⌛ _Menu timed out._`, ...channelInfo });

  await executeTrade(sock, message, context, pairChoice.value, parseInt(betChoice.value, 10), dirChoice.value as Direction);
}

// ── Handler ───────────────────────────────────────────────────────────

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, senderId, channelInfo } = context;
  const userId = cleanJid(senderId);

  // ── Menu (type-a-number alternative to memorizing syntax) ────────
  if (args[0] === 'menu') {
    return runMenuFlow(sock, message, context);
  }

  // ── Help / full guide ────────────────────────────────────────────
  if (args[0] === 'help' || args[0] === 'guide') {
    return sock.sendMessage(chatId, {
      text: helpText(),
      ...channelInfo,
    }, { quoted: message });
  }

  // ── Price board ────────────────────────────────────────────────
  if (args[0] === 'prices' || args[0] === 'market') {
    const board = await marketBoardText();
    return sock.sendMessage(chatId, {
      text: `${header()}\n${board}`,
      ...channelInfo,
    }, { quoted: message });
  }

  // ── Player profile ─────────────────────────────────────────────
  if (args[0] === 'profile' || args[0] === 'stats') {
    const profile = await getPlayerProfile(userId);
    const rtpLine = profile.rounds > 0 ? `${(profile.rtp * 100).toFixed(1)}%` : '—';
    return sock.sendMessage(chatId, {
      text:
        `${header()}\n` +
        `📊 *YOUR TRADING STATS*\n\n` +
        ` Rounds        ${formatNumber(profile.rounds)}\n` +
        ` Total staked  ${formatNumber(profile.totalBet)} Groq Coins\n` +
        ` Total won     ${formatNumber(profile.totalWon)} Groq Coins\n` +
        ` Your RTP      ${rtpLine}`,
      ...channelInfo,
    }, { quoted: message });
  }

  // ── Parse the order ────────────────────────────────────────────
  const { pair, bet, direction } = parseOrder(args);

  if (!pair || !bet || !direction || !ALLOWED_BETS.includes(bet)) {
    const board = await marketBoardText();
    return sock.sendMessage(chatId, {
      text:
        `${header()}\n` +
        `${board}` +
        `${DIVIDER}\n` +
        `📈 *HOW TO TRADE*\n` +
        `\`.forex <pair> <bet> <call|put>\`\n\n` +
        `  Pairs     EUR/USD · GBP/USD · USD/JPY · AUD/USD\n` +
        `  Bets      ${ALLOWED_BETS.map(b => `*${b}*`).join(' · ')} _(Groq Coins)_\n` +
        `  📈 call/buy    price will rise\n` +
        `  📉 put/sell    price will fall\n` +
        `${DIVIDER}\n` +
        `💱 No Groq Coins? Ask a member to run \`.exchange <coins> @you\`.\n` +
        `📱 \`.forex menu\` — guided menu instead of typing syntax\n` +
        `📖 \`.forex help\` — full beginner's guide\n` +
        `📈 \`.forex prices\` — check the board\n` +
        `📊 \`.forex profile\` — your trading stats\n\n` +
        `_e.g. .forex eurusd 20 call_`,
      ...channelInfo,
    }, { quoted: message });
  }

  return executeTrade(sock, message, context, pair, bet, direction);
}

export const handler = withEconomyGuard(_handler);