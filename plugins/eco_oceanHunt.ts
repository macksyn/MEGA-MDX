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
  contributeToJackpot, getJackpotPool, resolveSpinOutcome,
  awardJackpotShare, awardFullJackpot
} from '../lib/oceanSlotMachine.js';
import { cleanJid } from '../lib/isOwner.js';

export const command = 'oceanslots';
export const aliases = ['ocean', 'oslots', 'oceanhunt', 'fishhunt'];
export const category = 'economy-games';
export const cooldown = 3000;

// Supported wager sizes matching your calibrated system
const ALLOWED_BETS = [5, 10, 20, 50, 100];

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
        `_Land 🐋🐋🦈 for a slice, 🐋🐋🐋 takes the WHOLE ocean jackpot!_`,
      ...channelInfo
    }, { quoted: message });
  }

  // Deduct stakes cleanly
  const deducted = await deductCoins(userId, bet, { type: 'slots' });
  if (!deducted.success) {
    return sock.sendMessage(chatId, { text: "❌ You don't have enough coins in your wallet.", ...channelInfo }, { quoted: message });
  }

  // Grow the dedicated ocean jackpot
  await contributeToJackpot(bet);

  const newPool = await getJackpotPool();
  const economyPressure = Math.max(0.8, Math.min(1.2, 1 + (newPool - 500) / 10000));
  
  // Resolve outcome. (Optional: You can fetch 'spinsPlayed' from user profile DB if tracked, or leave standard)
  const outcome = resolveSpinOutcome(bet, economyPressure);
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

  if (outcome.tier === 'lose') {
    winText = `\n\n😬 Splashed! No luck on this dive. Better luck next time!`;
  } else if (outcome.tier === 'mega') {
    const totalWin = await awardJackpotShare();
    await addCoins(userId, totalWin, { type: 'slots' });
    banner = WIN_BANNERS.mega;
    winText = `\n\n🐋🐋🦈 *MEGA CATCH!* You caught a slice of the ocean jackpot: *${formatNumber(totalWin)} coins*!`;
  } else if (outcome.tier === 'superMega') {
    const totalWin = await awardFullJackpot();
    await addCoins(userId, totalWin, { type: 'slots' });
    banner = WIN_BANNERS.superMega;
    winText = `\n\n🐋🐋🐋 *GREAT WHITE WHALE!!* You captured the entire ocean jackpot: *${formatNumber(totalWin)} coins*!`;
  } else if (outcome.tier === 'big') {
    const totalWin = Math.round(bet * outcome.multiplier);
    await addCoins(userId, totalWin, { type: 'slots' });
    banner = WIN_BANNERS.big;
    winText = `\n\n🎉 *${outcome.label}!* Reeled in *${formatNumber(totalWin)} coins* (${outcome.multiplier}x your bet)!`;
  } else {
    const totalWin = Math.round(bet * outcome.multiplier);
    await addCoins(userId, totalWin, { type: 'slots' });
    winText = `\n\n🎉 *${outcome.label}!* Reeled in *${formatNumber(totalWin)} coins* (${outcome.multiplier}x your bet)!`;
  }

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