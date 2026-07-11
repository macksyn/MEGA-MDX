// @ts-nocheck
import { deductCoins, addCoins, getWallet, formatNumber, withEconomyGuard } from '../lib/economy.js';
import { contributeToJackpot, resolveCoinflipOutcome } from '../lib/slotMachine.js';
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

  const deducted = await deductCoins(userId, amount);
  if (!deducted.success) {
    return sock.sendMessage(chatId, { text: "❌ You don't have that many coins.", ...channelInfo }, { quoted: message });
  }

  await contributeToJackpot(amount);

  const newPool = Math.max(500, amount * 10);
  const economyPressure = Math.max(0.85, Math.min(1.15, 1 + (newPool - 500) / 10000));
  const outcome = resolveCoinflipOutcome(amount, economyPressure);
  const result = outcome.win ? guess : (guess === 'heads' ? 'tails' : 'heads');

  const wallet = await getWallet(userId);
  if (outcome.win) {
    const payout = Math.round(amount * outcome.multiplier);
    await addCoins(userId, payout);
    const updatedWallet = await getWallet(userId);
    return sock.sendMessage(chatId, {
      text: `🪙 The coin landed on *${result}*! ${outcome.label} *${formatNumber(payout)} coins*!\n\n💵 Bet: ${formatNumber(bet)} coins  |  💰 Bal: ${formatNumber(newPool)} coins`,
      ...channelInfo
    }, { quoted: message });
  }

  await sock.sendMessage(chatId, {
    text: `🪙 The coin landed on *${result}*. ${outcome.label} *${formatNumber(amount)} coins*. Better luck next time!\n\n💵 Bet: ${formatNumber(bet)} coins  |  💰 Bal: ${formatNumber(newPool)} coins`,
    ...channelInfo
  }, { quoted: message });
}

export const handler = withEconomyGuard(_handler);