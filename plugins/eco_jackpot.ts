// @ts-nocheck
import { withEconomyGuard, formatNumber } from '../lib/economy.js';
import { getJackpotPool } from '../lib/slotMachine.js';

export const command = 'jackpot';
export const aliases = ['pot'];
export const category = 'economy-games';
export const cooldown = 3000;

async function _handler(sock: any, message: any, _args: string[], context: any) {
  const { chatId, channelInfo } = context;
  const pool = await getJackpotPool();

  await sock.sendMessage(chatId, {
    text:
      `👑 *JUNGLE HUNT JACKPOT* 👑\n\n` +
      `Current pool: *${formatNumber(pool)} coins*\n\n` +
      `Play *!slots <5|20|50|100>* — land 🦁🦁🐯 (Mega) for a slice, or 🦁🦁🦁 (Super Mega) to take the WHOLE pool!\n` +
      `_Every bet on !slots, !coinflip and !dice feeds this pool._`,
    ...channelInfo
  }, { quoted: message });
}

export const handler = withEconomyGuard(_handler);
