// @ts-nocheck
/***
 * plugins/oceanSlots.ts
 *
 * WhatsApp/Socket controller plugin for the Ocean Hunt themed slot machine.
 * Features customizable frames, animations, and independent jackpot pools.
 */

import { deductCoins, addCoins, getWallet, withEconomyGuard, formatNumber } from '../lib/economy.js';
import {
  spinGridForTier, renderGrid,
  contributeToJackpot, getJackpotPool, resolveSpinOutcome, resolveJackpotPayout,
  incrementAndGetSpins, getTodayProfit, recordHouseActivity, deductFromJackpot,
  getConsecutiveLosses, incrementConsecutiveLosses, resetConsecutiveLosses,
  recordPlayerActivity, recordPlayerJackpot
} from '../lib/oceanSlotMachine.js';
import { cleanJid } from '../lib/isOwner.js';

export const command = 'oceanslots';
export const aliases = ['ocean', 'oslots', 'oceanhunt', 'fishhunt'];
export const category = 'economy-games';
export const cooldown = 3000;

// Supported wager sizes matching your calibrated system
const ALLOWED_BETS = [5, 20, 50, 100];

const SPIN_FRAMES = ['🌊░░░░', '🌊🌊░░░', '🌊🌊🌊░░', '🌊🌊🌊🌊░', '🌊🌊🌊🌊🌊'];
const SPIN_FRAME_DELAY_MS = 550;

const WIN_BANNERS: Record<string, string> = {
  big:       '『 🌊 Ｂ Ｉ Ｇ　Ｃ Ａ Ｔ Ｃ Ｈ ！ 🌊 』',
  mega:      '『 🦈 Ｍ Ｅ Ｇ Ａ　Ｃ Ａ Ｔ Ｃ Ｈ ！ 🦈 』',
  superMega: '『 🐋 Ｔ Ｈ Ｅ　Ｇ Ｒ Ｅ Ａ Ｔ　Ｗ Ｈ Ａ Ｌ Ｅ ！ 🐋 』',
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
        `🐠 *OCEAN HUNT* 🐠\n\n` +
        `Usage: *.ocean <bet>*\n` +
        `Allowed bets: ${ALLOWED_BETS.map(b => `*${b}*`).join(', ')} coins\n\n` +
        `👑 Ocean Jackpot: *${formatNumber(pool)} coins* 👑\n` +
        `_Land 🐋🐋🦈 for a Mega catch, 🐋🐋🐋 for a Super Mega payout!_`,
      ...channelInfo
    }, { quoted: message });
  }

  // Deduct stakes cleanly
  const deducted = await deductCoins(userId, bet, { type: 'slots' });
  if (!deducted.success) {
    return sock.sendMessage(chatId, { text: "❌ You don't have enough coins in your wallet.", ...channelInfo }, { quoted: message });
  }

  // Increment player's spin count
  const spinsPlayed = await incrementAndGetSpins(userId);
  // Grow the dedicated ocean jackpot
  await contributeToJackpot(bet);

  const newPool = await getJackpotPool();
  const todayProfit = await getTodayProfit();
  const economyPressure = Math.max(0.8, Math.min(1.2, 1 + (newPool - 500) / 10000));
  const consecutiveLosses = await getConsecutiveLosses(userId);

  // Resolve outcome based on dynamic tracking
  const outcome = resolveSpinOutcome(bet, economyPressure, spinsPlayed, todayProfit, newPool, consecutiveLosses);
  const grid = spinGridForTier(outcome.tier);

  // Send initial spinning animation frame
  const sent = await sock.sendMessage(chatId, {
    text: `🐠 *OCEAN HUNT* 🐠\n\n🌊 Bubbling... ${SPIN_FRAMES[0]}`,
    ...channelInfo
  }, { quoted: message });

  // Loop through fluid aquatic frames
  for (let i = 1; i < SPIN_FRAMES.length; i++) {
    await delay(SPIN_FRAME_DELAY_MS);
    await sock.sendMessage(chatId, {
      text: `🐠 *OCEAN HUNT* 🐠\n\n🐟 Swimming deep...\n\n${SPIN_FRAMES[i]}`,
      edit: sent.key,
      ...channelInfo
    });
  }
  await delay(SPIN_FRAME_DELAY_MS);

  let winText = '';
  let banner = '';
  let totalWin = Math.round(bet * outcome.multiplier);

  if (outcome.tier === 'lose') {
    await incrementConsecutiveLosses(userId);
    winText = `\n\n😬 Splashed! No luck on this dive. Better luck next time!`;
  } else if (outcome.tier === 'mega' || outcome.tier === 'superMega') {
    await resetConsecutiveLosses(userId);
    await recordPlayerJackpot(userId);
    const payout = resolveJackpotPayout(outcome.tier, bet, outcome.multiplier, newPool);
    totalWin = payout.totalWin;

    await addCoins(userId, totalWin, { type: 'slots' });
    if (payout.fromPool) {
      await deductFromJackpot(totalWin);
    }

    if (outcome.tier === 'mega') {
      banner = WIN_BANNERS.mega;
      winText = payout.downgraded
        ? `\n\n🐋🐋🦈 *MEGA CATCH!* The jackpot pool was running low, so you still reel in a solid *${payout.multiplier}x* — *${formatNumber(totalWin)} coins*!`
        : `\n\n🐋🐋🦈 *MEGA CATCH!* You got a *${payout.multiplier}x* multiplier! Reeled in *${formatNumber(totalWin)} coins*!`;
    } else {
      banner = WIN_BANNERS.superMega;
      winText = payout.downgraded
        ? `\n\n🐋🐋🐋 *GREAT WHITE WHALE!!* The ocean vault couldn't cover the full jackpot, but you still haul in *${payout.multiplier}x* — *${formatNumber(totalWin)} coins*!`
        : `\n\n🐋🐋🐋 *GREAT WHITE WHALE!!* Epic *${payout.multiplier}x* jackpot hit! Reeled in *${formatNumber(totalWin)} coins*!`;
    }
  } else if (outcome.tier === 'big') {
    await resetConsecutiveLosses(userId);
    await addCoins(userId, totalWin, { type: 'slots' });
    banner = WIN_BANNERS.big;
    winText = `\n\n🎉 *${outcome.label}!* Reeled in *${formatNumber(totalWin)} coins* (${outcome.multiplier}x your bet)!`;
  } else {
    // recover30 / recover70 / double / triple are still partial or full recoveries —
    // only a genuine 'lose' should build the streak.
    await resetConsecutiveLosses(userId);
    await addCoins(userId, totalWin, { type: 'slots' });
    winText = `\n\n🎉 *${outcome.label}!* Reeled in *${formatNumber(totalWin)} coins* (${outcome.multiplier}x your bet)!`;
  }

  // Log today's results to the daily profit table
  await recordHouseActivity(bet, totalWin);
  // Log this player's lifetime bet/payout totals (feeds getPlayerProfile's RTP/average stake)
  await recordPlayerActivity(userId, bet, totalWin);

  const wallet = await getWallet(userId);

  await sock.sendMessage(chatId, {
    text:
      `🐠 *OCEAN HUNT* 🐠\n\n` +
      (banner ? `${banner}\n\n` : '') +
      renderGrid(grid) +
      winText +
      `\n\n💶 Bet: ${formatNumber(bet)} coins  |  💰 Bal: ${formatNumber(wallet.coins)} coins`,
    edit: sent.key,
    ...channelInfo
  }, { quoted: message });
}

export const handler = withEconomyGuard(_handler);