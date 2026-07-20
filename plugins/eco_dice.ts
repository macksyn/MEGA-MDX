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
import { contributeToJackpot, getJackpotPool, resolveDiceOutcome, settleWin, deductFromJackpot, getEconomyPressure } from '../lib/slotMachine.js';
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

  // The full stake becomes real bank capital the instant it's wagered.
  await contributeToJackpot(amount);

  const pool = await getJackpotPool();
  const economyPressure = await getEconomyPressure(pool);
  // spinsPlayed/consecutiveLosses aren't tracked for dice yet, so beginner boost
  // and the pity timer stay inert here for now — only pressure + the RTP ceiling
  // are live. `pool` is what lets the ceiling detect a critical solvency state.
  const outcome = resolveDiceOutcome(amount, economyPressure, 100, 0, pool);

  const sent = await sock.sendMessage(chatId, {
    text: `🎲 *DICE ROLL* 🎲\n\nRolling ${randomFace()} ${randomFace()} ...`,
    ...channelInfo
  }, { quoted: message });

  await delay(700);

  let resultText: string;
  let finalBalance: number;

  if (outcome.tie) {
    // Stake was already banked by contributeToJackpot() above — refunding it means
    // pulling that same amount back out so the pool nets to zero for this spin.
    await addCoins(userId, amount, { type: 'dice', note: 'tie refund' });
    await deductFromJackpot(amount);
    const wallet = await getWallet(userId);
    finalBalance = wallet.coins;
    resultText = `🤝 *Tie!* Your bet of *${formatNumber(amount)} coins* was refunded.`;
  } else if (outcome.win) {
    const rawWin = Math.round(amount * outcome.multiplier);
    const settled = settleWin(rawWin, pool);
    await addCoins(userId, settled.payout, { type: 'dice' });
    await deductFromJackpot(settled.payout); // Every payout is paid out of the real bank, never minted
    const wallet = await getWallet(userId);
    finalBalance = wallet.coins;
    resultText = settled.capped
      ? `🎉 *${outcome.label}!* The bank couldn't cover the full amount, so you won *${formatNumber(settled.payout)} coins* instead of the usual ${outcome.multiplier}x.`
      : `🎉 *${outcome.label}!* Won *${formatNumber(settled.payout)} coins* (${outcome.multiplier}x your bet)!`;
  } else {
    // Loss — the stake is already banked via contributeToJackpot() above.
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