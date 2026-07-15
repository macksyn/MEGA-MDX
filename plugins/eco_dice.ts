// @ts-nocheck
/***
 * plugins/eco_dice.ts
 *
 * Simplest of the three gambling games — no guess needed, just a bet.
 * resolveDiceOutcome() (lib/slotMachine.ts) is the single source of truth
 * for win/tie/lose, same pattern as slots/coinflip: the dice faces shown
 * are cosmetic, the outcome is resolved first.
 *
 *   win  -> 1.9x your bet
 *   tie  -> bet refunded, no gain/loss
 *   lose -> bet forfeited
 *
 * Usage: .dice <amount>
 */
import { deductCoins, addCoins, getWallet, formatNumber, withEconomyGuard } from '../lib/economy.js';
import { contributeToJackpot, getJackpotPool, resolveDiceOutcome } from '../lib/slotMachine.js';
import { cleanJid } from '../lib/isOwner.js';

export const command = 'dice';
export const aliases = ['roll'];
export const category = 'economy-games';
export const cooldown = 3000;

const DICE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
const randomFace = () => DICE_FACES[Math.floor(Math.random() * DICE_FACES.length)];
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, senderId, channelInfo } = context;
  const userId = cleanJid(senderId);

  const amount = parseInt(args[0], 10);
  if (!amount || amount <= 0) {
    return sock.sendMessage(chatId, {
      text:
        `🎲 *DICE ROLL* 🎲\n\n` +
        `Usage: *!dice <amount>*\n\n` +
        `🎉 Win: 1.9x your bet\n` +
        `🤝 Tie: bet refunded\n` +
        `😬 Lose: bet forfeited`,
      ...channelInfo
    }, { quoted: message });
  }

  const deducted = await deductCoins(userId, amount, { type: 'dice' });
  if (!deducted.success) {
    return sock.sendMessage(chatId, { text: "❌ You don't have that many coins.", ...channelInfo }, { quoted: message });
  }

  await contributeToJackpot(amount);

  const pool = await getJackpotPool();
  const economyPressure = Math.max(0.85, Math.min(1.15, 1 + (pool - 500) / 10000));
  const outcome = resolveDiceOutcome(amount, economyPressure);

  const sent = await sock.sendMessage(chatId, {
    text: `🎲 *DICE ROLL* 🎲\n\nRolling ${randomFace()} ${randomFace()} ...`,
    ...channelInfo
  }, { quoted: message });

  await delay(700);

  let resultText: string;
  let finalBalance: number;

  if (outcome.tie) {
    await addCoins(userId, amount, { type: 'dice', note: 'tie refund' });
    const wallet = await getWallet(userId);
    finalBalance = wallet.coins;
    resultText = `🤝 *Tie!* Your bet of *${formatNumber(amount)} coins* was refunded.`;
  } else if (outcome.win) {
    const payout = Math.round(amount * outcome.multiplier);
    await addCoins(userId, payout, { type: 'dice' });
    const wallet = await getWallet(userId);
    finalBalance = wallet.coins;
    resultText = `🎉 *${outcome.label}!* Won *${formatNumber(payout)} coins* (${outcome.multiplier}x your bet)!`;
  } else {
    finalBalance = deducted.wallet.coins;
    resultText = `😬 *${outcome.label}.* You lost *${formatNumber(amount)} coins*. Better luck next time!`;
  }

  await sock.sendMessage(chatId, {
    text:
      `🎲 *DICE ROLL* 🎲\n\n` +
      `${randomFace()}   ${randomFace()}\n\n` +
      resultText +
      `\n\n💵 Bet: ${formatNumber(amount)} coins  |  💰 Bal: ${formatNumber(finalBalance)} coins`,
    edit: sent.key,
    ...channelInfo
  }, { quoted: message });
}

export const handler = withEconomyGuard(_handler);
