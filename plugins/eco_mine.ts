// @ts-nocheck
/***
 * plugins/eco_mine.ts
 *
 * !mine — mints a fresh batch of coins (same idea as !work — nothing is
 * drawn from the existing bank) and splits it between the caller's wallet
 * and the jackpot pool (default 50/50, via mineMinerCutPercent in
 * lib/economy.ts). Every successful mine both pays the miner AND grows the
 * same reserve that backs !slots/!coinflip/!dice and the loan pool — see
 * doMine() in lib/economy.ts for the split math.
 */
import { withEconomyGuard, doMine, formatNumber } from '../lib/economy.js';
import { cleanJid } from '../lib/isOwner.js';

export const command = 'mine';
export const aliases = ['dig'];
export const category = 'economy-games';
export const cooldown = 3000;

function formatDuration(ms: number): string {
  const totalMin = Math.max(1, Math.round(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, channelInfo, senderId } = context;
  const userId = cleanJid(senderId);

  const result = await doMine(userId);

  if (!result.success) {
    // on_cooldown — the only failure mode; minting never requires bank funds
    return sock.sendMessage(chatId, {
      text: `⛏️ Your rig's still cooling down. Try again in *${formatDuration(result.remainingMs)}*.`,
      ...channelInfo
    }, { quoted: message });
  }

  await sock.sendMessage(chatId, {
    text:
      `⛏️ *MINING RESULT* ⛏️\n\n` +
      `You mined *${formatNumber(result.minted)} coins* total.\n\n` +
      `💰 Your cut: *${formatNumber(result.minerShare)} coins*\n` +
      `🏦 Sent to the jackpot: *${formatNumber(result.jackpotShare)} coins*\n\n` +
      `_Check *.reserve* to see the bank grow._`,
    ...channelInfo
  }, { quoted: message });
}

export const handler = withEconomyGuard(_handler);
