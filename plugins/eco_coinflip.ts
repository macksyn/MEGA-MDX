// @ts-nocheck
import { deductCoins, addCoins, getWallet, formatNumber, withEconomyGuard } from '../lib/economy.js';
import { contributeToJackpot, getJackpotPool, resolveCoinflipOutcome, settleWin, deductFromJackpot, getEconomyPressure, recordHouseActivity } from '../lib/slotMachine.js';
import { cleanJid } from '../lib/isOwner.js';

export const command = 'coinflip';
export const aliases = ['cf'];
export const category = 'economy-games';
export const cooldown = 3000;

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, senderId, channelInfo } = context;
  const userId = cleanJid(senderId);

  const amount = parseInt(args[0], 10);
  const guess = (args[1] || '').toLowerCase();

  if (!amount || amount <= 0 || !['heads', 'tails'].includes(guess)) {
    return sock.sendMessage(chatId, {
      text: `⚠️ Usage: *!coinflip <amount> <heads|tails>*`,
      ...channelInfo
    }, { quoted: message });
  }

  const deducted = await deductCoins(userId, amount, { type: 'coinflip' });
  if (!deducted.success) {
    return sock.sendMessage(chatId, { text: "❌ You don't have that many coins.", ...channelInfo }, { quoted: message });
  }

  // The full stake becomes real bank capital the instant it's wagered.
  await contributeToJackpot(amount);

  // Pressure is driven by the REAL bank: solvency (protects the floor) + house mood.
  const pool = await getJackpotPool();
  const economyPressure = await getEconomyPressure(pool);
  // spinsPlayed/consecutiveLosses aren't tracked for coinflip yet, so beginner
  // boost and the pity timer stay inert here for now — only pressure + the RTP
  // ceiling are live. `pool` is what lets the ceiling actually detect a critical
  // solvency state and tighten automatically.
  const outcome = resolveCoinflipOutcome(amount, economyPressure, 100, 0, pool);
  const result = outcome.win ? guess : (guess === 'heads' ? 'tails' : 'heads');

  if (outcome.win) {
    const rawWin = Math.round(amount * outcome.multiplier);
    const settled = settleWin(rawWin, pool);
    await addCoins(userId, settled.payout, { type: 'coinflip' });
    await deductFromJackpot(settled.payout); // Every payout is paid out of the real bank, never minted
    await recordHouseActivity(amount, settled.payout); // Feeds the bank's daily wagered/paid stats shown in !jackpot

    const updatedWallet = await getWallet(userId);
    const cappedNote = settled.capped ? ` _(bank couldn't cover the full amount, capped this win)_` : '';
    return sock.sendMessage(chatId, {
      text: `🪙 The coin landed on *${result}*! ${outcome.label} *${formatNumber(settled.payout)} coins*!${cappedNote}\n\n💵 Bet: ${formatNumber(amount)} coins  |  💰 Bal: ${formatNumber(updatedWallet.coins)} coins`,
      ...channelInfo
    }, { quoted: message });
  }

  // The stake is already banked via contributeToJackpot() above — nothing further to settle.
  await recordHouseActivity(amount, 0); // Feeds the bank's daily wagered/paid stats shown in !jackpot
  await sock.sendMessage(chatId, {
    text: `🪙 The coin landed on *${result}*. ${outcome.label} *${formatNumber(amount)} coins*. Better luck next time!\n\n💵 Bet: ${formatNumber(amount)} coins  |  💰 Bal: ${formatNumber(deducted.wallet.coins)} coins`,
    ...channelInfo
  }, { quoted: message });
}

export const handler = withEconomyGuard(_handler);