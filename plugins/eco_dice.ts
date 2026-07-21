// @ts-nocheck
/***
 * plugins/eco_dice.ts
 *
 * Number‑guessing game (2–12).
 *   • Correct guess → 6× your bet
 *   • Close guess (off by 1) → bet refunded
 *   • Wrong guess → bet forfeited
 *
 * The outcome is decided by the slot‑machine engine (pressure, grace, pity, RTP cap).
 * Dice emojis are cosmetic and always sum to the result.
 *
 * Usage: .dice <amount> <guess>
 */
import { deductCoins, addCoins, getWallet, formatNumber, withEconomyGuard } from '../lib/economy.js';
import {
  contributeToJackpot,
  getJackpotPool,
  resolveNumberGuessOutcome,
  settleWin,
  deductFromJackpot,
  getEconomyPressure,
  incrementAndGetSpins,
  getConsecutiveLosses,
  resetConsecutiveLosses,
  incrementConsecutiveLosses,
  getConsecutiveWins,
  resetConsecutiveWins,
  incrementConsecutiveWins,
  recordHouseActivity,
  recordPlayerActivity
} from '../lib/slotMachine.js';
import { cleanJid } from '../lib/isOwner.js';

export const command = 'dice';
export const aliases = ['guess'];
export const category = 'economy-games';
export const cooldown = 3000;

const DICE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

/** return two dice faces that sum to the given number (2–12) */
function dicePairForSum(sum: number): [string, string] {
  // pick a random valid combination
  const combos: [number, number][] = [];
  for (let d1 = 1; d1 <= 6; d1++) {
    const d2 = sum - d1;
    if (d2 >= 1 && d2 <= 6) combos.push([d1, d2]);
  }
  const pair = combos[Math.floor(Math.random() * combos.length)];
  return [DICE_FACES[pair[0] - 1], DICE_FACES[pair[1] - 1]];
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, senderId, channelInfo } = context;
  const userId = cleanJid(senderId);

  if (args.length < 2) {
    return sock.sendMessage(chatId, {
      text:
        `🎲 *NUMBER GUESS* 🎲\n\n` +
        `Usage: *.dice <amount> <guess>*\n` +
        `Guess a number from *2* to *12*.\n\n` +
        `✅ Correct → 6× your bet\n` +
        `🔹 Close (off by 1) → bet refunded\n` +
        `❌ Wrong → bet forfeited`,
      ...channelInfo
    }, { quoted: message });
  }

  const amount = parseInt(args[0], 10);
  if (!amount || amount <= 0) {
    return sock.sendMessage(chatId, { text: '❌ Please enter a valid positive amount.', ...channelInfo }, { quoted: message });
  }

  const guess = parseInt(args[1], 10);
  if (!guess || guess < 2 || guess > 12) {
    return sock.sendMessage(chatId, { text: '❌ Guess must be a whole number between 2 and 12.', ...channelInfo }, { quoted: message });
  }

  // 1. deduct stake
  const deducted = await deductCoins(userId, amount, { type: 'dice' });
  if (!deducted.success) {
    return sock.sendMessage(chatId, { text: '❌ You don\'t have that many coins.', ...channelInfo }, { quoted: message });
  }

  // 2. stake goes to the bank
  await contributeToJackpot(amount);

  // 3. get current economy state
  const pool = await getJackpotPool();
  const economyPressure = await getEconomyPressure(pool);

  // 4. increment spin count and get consecutive losses
  const spinsPlayed = await incrementAndGetSpins(userId);
  const consecutiveLosses = await getConsecutiveLosses(userId);

  // 5. resolve the outcome
  const outcome = resolveNumberGuessOutcome(
    amount,
    guess,
    economyPressure,
    spinsPlayed,
    consecutiveLosses,
    pool
  );

  const sent = await sock.sendMessage(chatId, {
    text: `🎲 *NUMBER GUESS* 🎲\n\nRolling dice …`,
    ...channelInfo
  }, { quoted: message });

  await delay(700);

  // 6. process win / tie / loss
  let resultText: string;
  let finalBalance: number;

  if (outcome.outcome === 'win') {
    const rawWin = Math.round(amount * 6);
    const settled = settleWin(rawWin, pool);
    await addCoins(userId, settled.payout, { type: 'dice' });
    await deductFromJackpot(settled.payout);
    // update streaks
    await resetConsecutiveLosses(userId);
    await incrementConsecutiveWins(userId);

    const wallet = await getWallet(userId);
    finalBalance = wallet.coins;
    resultText = settled.capped
      ? `✅ *Correct!* The bank couldn't cover the full 6×, so you won *${formatNumber(settled.payout)} coins* instead.`
      : `✅ *Correct!* You won *${formatNumber(settled.payout)} coins* (6× your bet)!`;
  } else if (outcome.outcome === 'tie') {
    // refund
    await addCoins(userId, amount, { type: 'dice', note: 'close guess refund' });
    await deductFromJackpot(amount);
    // tie breaks loss streak
    await resetConsecutiveLosses(userId);
    // (do not increment win streak, but keep it)

    const wallet = await getWallet(userId);
    finalBalance = wallet.coins;
    resultText = `🔹 *Close!* Your bet of *${formatNumber(amount)} coins* has been refunded.`;
  } else {
    // loss – stake stays banked
    await incrementConsecutiveLosses(userId);
    await resetConsecutiveWins(userId);

    const wallet = await getWallet(userId);
    finalBalance = wallet.coins;
    resultText = `❌ *Wrong.* You lost *${formatNumber(amount)} coins*. Better luck next time!`;
  }

  // 7. record house and player stats
  const payout = outcome.outcome === 'win' ? Math.round(amount * 6) : (outcome.outcome === 'tie' ? amount : 0);
  await recordHouseActivity(amount, payout);
  await recordPlayerActivity(userId, amount, payout);

  // 8. build the dice display
  const [die1, die2] = dicePairForSum(outcome.resultNumber);
  const display = `${die1} ${die2}  =  ${outcome.resultNumber}`;

  // 9. final message
  await sock.sendMessage(chatId, {
    text:
      `🎲 *NUMBER GUESS* 🎲\n\n` +
      `${display}\n\n` +
      `Your guess: *${guess}*\n` +
      `${resultText}\n\n` +
      `💵 Bet: ${formatNumber(amount)} coins  |  💰 Bal: ${formatNumber(finalBalance)} coins`,
    edit: sent.key,
    ...channelInfo
  }, { quoted: message });
}

export const handler = withEconomyGuard(_handler);