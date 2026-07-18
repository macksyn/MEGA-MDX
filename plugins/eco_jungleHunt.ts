// @ts-nocheck
import { deductCoins, addCoins, getWallet, withEconomyGuard, formatNumber } from '../lib/economy.js';
import {
  spinGridForTier, renderGrid,
  contributeToJackpot, getJackpotPool, resolveSpinOutcome,
  incrementAndGetSpins, getTodayProfit, recordHouseActivity, deductFromJackpot
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
  const economyPressure = Math.max(0.8, Math.min(1.2, 1 + (newPool - 500) / 10000));

  // Resolve spin tier and payout multiplier synchronously using real-time stats
  const outcome = resolveSpinOutcome(bet, economyPressure, spinsPlayed, todayProfit, newPool);
  const grid = spinGridForTier(outcome.tier);

  const sent = await sock.sendMessage(chatId, {
    text: `🎰 *JUNGLE HUNT* 🎰\n\n🎰 Spinning${SPIN_FRAMES[0]}`,
    ...channelInfo
  }, { quoted: message });

  for (let i = 1; i < SPIN_FRAMES.length; i++) {
    await delay(SPIN_FRAME_DELAY_MS);
    await sock.sendMessage(chatId, {
      text: `🎰 *JUNGLE HUNT* 🎰\n\n🎰 Spinning...\n\n${SPIN_FRAMES[i]}`,
      edit: sent.key,
      ...channelInfo
    });
  }
  await delay(SPIN_FRAME_DELAY_MS);


  let winText = '';
  let banner = '';
  const totalWin = Math.round(bet * outcome.multiplier);

  if (outcome.tier === 'lose') {
    winText = `\n\n😬 No win this spin. Better luck next time!`;
  } else if (outcome.tier === 'mega') {
    await addCoins(userId, totalWin, { type: 'slots' });
    await deductFromJackpot(totalWin); // Deduct winnings directly from the progressive jackpot pool reserve
    banner = WIN_BANNERS.mega;
    winText = `\n\n🦁🦁🐯 *MEGA WIN!* You got a *${outcome.multiplier}x* multiplier! Won *${formatNumber(totalWin)} coins*!`;
  } else if (outcome.tier === 'superMega') {
    await addCoins(userId, totalWin, { type: 'slots' });
    await deductFromJackpot(totalWin); // Deduct winnings directly from the progressive jackpot pool reserve
    banner = WIN_BANNERS.superMega;
    winText = `\n\n🦁🦁🦁 *SUPER MEGA WIN!* Epic *${outcome.multiplier}x* jackpot hit! Won *${formatNumber(totalWin)} coins*!`;
  } else if (outcome.tier === 'big') {
    await addCoins(userId, totalWin, { type: 'slots' });
    banner = WIN_BANNERS.big;
    winText = `\n\n🎉 *${outcome.label}!* Won *${formatNumber(totalWin)} coins* (${outcome.multiplier}x your bet)!`;
  } else {
    await addCoins(userId, totalWin, { type: 'slots' });
    winText = `\n\n🎉 *${outcome.label}!* Won *${formatNumber(totalWin)} coins* (${outcome.multiplier}x your bet)!`;
  }

  // Log today's results to the daily profit table to maintain real-time adaptive metrics
  await recordHouseActivity(bet, totalWin);

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