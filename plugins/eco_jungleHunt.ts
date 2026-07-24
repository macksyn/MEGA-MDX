// @ts-nocheck
import { deductCoins, addCoins, getWallet, withEconomyGuard, formatNumber } from '../lib/economy.js';
import {
  spinGridForTier, renderGrid,
  contributeToJackpot, getJackpotPool, resolveSpinOutcome, settleWin, getEconomyPressure,
  incrementAndGetSpins, getTodayProfit, recordHouseActivity, deductFromJackpot,
  getConsecutiveLosses, incrementConsecutiveLosses, resetConsecutiveLosses,
  recordPlayerActivity, recordPlayerJackpot
} from '../lib/slotMachine.js';
import { cleanJid } from '../lib/isOwner.js';

export const command = 'slots';
export const aliases = ['slot', 'jungle', 'junglehunt'];
export const category = 'economy-games';
export const cooldown = 3000;

// Configured exactly to 5, 20, 50, and 100 coin options
const ALLOWED_BETS = [5, 20, 50, 100];

const SPIN_FRAMES = ['▰▱▱▱▱', '▰▰▱▱▱', '▰▰▰▱▱', '▰▰▰▰▱', '▰▰▰▰▰'];
const SPIN_FRAME_DELAY_MS = 550;
const INITIAL_DELAY_MS = 1200; // show first frame longer
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const WIN_BANNERS: Record<string, string> = {
  big:       '『 🎉 Ｂ Ｉ Ｇ　Ｗ Ｉ Ｎ ！ 🎉 』',
  mega:      '『 🔥 Ｍ Ｅ Ｇ Ａ　Ｗ Ｉ Ｎ ！ 🔥 』',
  superMega: '『 👑 Ｓ Ｕ Ｐ Ｅ Ｒ　Ｍ Ｅ Ｇ Ａ　Ｗ Ｉ Ｎ ！ ！ 👑 』',
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));


async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, senderId, channelInfo } = context;
  const userId = cleanJid(senderId);

  const bet = parseInt(args[0], 10);
  if (!ALLOWED_BETS.includes(bet)) {
    const pool = await getJackpotPool();
    return sock.sendMessage(chatId, {
      text:
        `🎰 *JUNGLE HUNT* 🎰\n\n` +
        `Usage: *.jungle <bet>*\n` +
        `Allowed bets: ${ALLOWED_BETS.map(b => `*${b}*`).join(', ')} coins\n\n` +
        `👑 Jackpot pool: *${formatNumber(pool)} coins* 👑\n` +
        `_Land 🦁🦁🐯 for a Mega win, 🦁🦁🦁 for a Super Mega jackpot payout!_`,
      ...channelInfo
    }, { quoted: message });
  }

  const deducted = await deductCoins(userId, bet, { type: 'slots' });
  if (!deducted.success) {
    return sock.sendMessage(chatId, { text: "❌ You don't have enough coins for that bet.", ...channelInfo }, { quoted: message });
  }

  // Increment their personal spin count
  const spinsPlayed = await incrementAndGetSpins(userId);
  await contributeToJackpot(bet);

  // Retrieve economic metric points
  const newPool = await getJackpotPool();
  const todayProfit = await getTodayProfit();
  const economyPressure = await getEconomyPressure(newPool);
  const consecutiveLosses = await getConsecutiveLosses(userId);

  // Resolve spin tier and payout multiplier synchronously using real-time stats
  const outcome = resolveSpinOutcome(bet, economyPressure, spinsPlayed, todayProfit, newPool, consecutiveLosses);
  const grid = spinGridForTier(outcome.tier);

  // Send initial frame
  let sent = await sock.sendMessage(chatId, {
    text: `🎰 *JUNGLE HUNT* 🎰\n\n🎰 Spinning${SPIN_FRAMES[0]}`,
    ...channelInfo
  }, { quoted: message });

  // Wait extra before first edit
  await delay(INITIAL_DELAY_MS);

  // Animate the rest
for (let i = 1; i < SPIN_FRAMES.length; i++) {
  try {
    await sock.sendMessage(chatId, {
      text: `🎰 *JUNGLE HUNT* 🎰\n\n🎰 Spinning...\n\n${SPIN_FRAMES[i]}`,
      edit: sent.key,
      ...channelInfo
    });
  } catch {
    // Edit failed – send a new message instead and remember its key
    sent = await sock.sendMessage(chatId, {
      text: `🎰 *JUNGLE HUNT* 🎰\n\n🎰 Spinning...\n\n${SPIN_FRAMES[i]}`,
      ...channelInfo
    });
  }
  await delay(SPIN_FRAME_DELAY_MS);
}

  let winText = '';
  let banner = '';
  let totalWin = 0;

  if (outcome.tier === 'lose') {
    await incrementConsecutiveLosses(userId);
    // The stake was already banked by contributeToJackpot() above — nothing further to settle.
    winText = `\n\n😬 No win this spin. Better luck next time!`;
  } else {
    await resetConsecutiveLosses(userId);

    const rawWin = Math.round(bet * outcome.multiplier);
    const settled = settleWin(rawWin, newPool);
    totalWin = settled.payout;

    await addCoins(userId, totalWin, { type: 'slots' });
    await deductFromJackpot(totalWin); // Every payout is paid out of the real bank, never minted

    if (outcome.tier === 'mega' || outcome.tier === 'superMega') {
      await recordPlayerJackpot(userId);
      banner = outcome.tier === 'mega' ? WIN_BANNERS.mega : WIN_BANNERS.superMega;
      const emoji = outcome.tier === 'mega' ? '🦁🦁🐯 *MEGA WIN!*' : '🦁🦁🦁 *SUPER MEGA WIN!*';
      winText = settled.capped
        ? `\n\n${emoji} The jackpot pool couldn't cover the full payout, so this one's capped at *${formatNumber(totalWin)} coins*.`
        : `\n\n${emoji} You got a *${outcome.multiplier}x* multiplier! Won *${formatNumber(totalWin)} coins*!`;
    } else if (outcome.tier === 'big') {
      banner = WIN_BANNERS.big;
      winText = settled.capped
        ? `\n\n🎉 *${outcome.label}!* The pool couldn't cover the full amount, so you got *${formatNumber(totalWin)} coins* instead of the usual ${outcome.multiplier}x.`
        : `\n\n🎉 *${outcome.label}!* Won *${formatNumber(totalWin)} coins* (${outcome.multiplier}x your bet)!`;
    } else {
      // recover30 / recover70 / double / triple
      winText = settled.capped
        ? `\n\n🎉 *${outcome.label}!* The pool couldn't cover the full amount, so you got *${formatNumber(totalWin)} coins* instead of the usual ${outcome.multiplier}x.`
        : `\n\n🎉 *${outcome.label}!* Won *${formatNumber(totalWin)} coins* (${outcome.multiplier}x your bet)!`;
    }
  }

  // Log today's results to the daily profit table to maintain real-time adaptive metrics
  await recordHouseActivity(bet, totalWin);
  // Log this player's lifetime bet/payout totals (feeds getPlayerProfile's RTP/average stake)
  await recordPlayerActivity(userId, bet, totalWin);

  const wallet = await getWallet(userId);

  await sock.sendMessage(chatId, {
    text:
      `🎰 *JUNGLE HUNT* 🎰\n\n` +
      (banner ? `${banner}\n\n` : '') +
      renderGrid(grid) +
      winText +
      `\n\n💶 Bet: ${formatNumber(bet)} coins  |  💰 Bal: ${formatNumber(wallet.coins)} coins`,
    edit: sent.key,
    ...channelInfo
  }, { quoted: message });
}

export const handler = withEconomyGuard(_handler);