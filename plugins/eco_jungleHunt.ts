// @ts-nocheck
import { deductCoins, addCoins, getWallet, withEconomyGuard, formatNumber } from '../lib/economy.js';
import {
  spinGridForTier, renderGrid,
  contributeToJackpot, getJackpotPool, resolveSpinOutcome,
  awardJackpotShare, awardFullJackpot
} from '../lib/slotMachine.js';
import { cleanJid } from '../lib/isOwner.js';

export const command = 'slots';
export const aliases = ['slot', 'jungle', 'junglehunt'];
export const category = 'economy-games';
export const cooldown = 3000;

const ALLOWED_BETS = [5, 10, 20, 50, 100];

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
        `_Land 🦁🦁🐯 for a slice, 🦁🦁🦁 takes it ALL._`,
      ...channelInfo
    }, { quoted: message });
  }

  const deducted = await deductCoins(userId, bet, { type: 'slots' });
  if (!deducted.success) {
    return sock.sendMessage(chatId, { text: "❌ You don't have enough coins for that bet.", ...channelInfo }, { quoted: message });
  }

  await contributeToJackpot(bet);

  const newPool = await getJackpotPool();
  const economyPressure = Math.max(0.8, Math.min(1.2, 1 + (newPool - 500) / 10000));
  const outcome = resolveSpinOutcome(bet, economyPressure);
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

  if (outcome.tier === 'lose') {
    winText = `\n\n😬 No win this spin. Better luck next time!`;
  } else if (outcome.tier === 'mega') {
    const totalWin = await awardJackpotShare();
    await addCoins(userId, totalWin, { type: 'slots' });
    banner = WIN_BANNERS.mega;
    winText = `\n\n🦁🦁🐯 *MEGA WIN!* You snagged a slice of the jackpot: *${formatNumber(totalWin)} coins*!`;
  } else if (outcome.tier === 'superMega') {
    const totalWin = await awardFullJackpot();
    await addCoins(userId, totalWin, { type: 'slots' });
    banner = WIN_BANNERS.superMega;
    winText = `\n\n🦁🦁🦁 *SUPER MEGA — JACKPOT!!* You just won the ENTIRE pool: *${formatNumber(totalWin)} coins*!`;
  } else if (outcome.tier === 'big') {
    const totalWin = Math.round(bet * outcome.multiplier);
    await addCoins(userId, totalWin, { type: 'slots' });
    banner = WIN_BANNERS.big;
    winText = `\n\n🎉 *${outcome.label}!* Won *${formatNumber(totalWin)} coins* (${outcome.multiplier}x your bet)!`;
  } else {
    const totalWin = Math.round(bet * outcome.multiplier);
    await addCoins(userId, totalWin, { type: 'slots' });
    winText = `\n\n🎉 *${outcome.label}!* Won *${formatNumber(totalWin)} coins* (${outcome.multiplier}x your bet)!`;
  }

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