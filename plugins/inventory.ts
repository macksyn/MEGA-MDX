// @ts-nocheck
/***
 * plugins/inventory.ts
 *
 * {prefix}inventory — what you own: protection + its life bar, mask time
 * left, guns (and which is equipped), and your reload / cooldown status.
 * Equip a different gun straight from the menu.
 */
import { withEconomyGuard } from '../lib/economy.js';
import { cleanJid } from '../lib/isOwner.js';
import config from '../config.js';
import { runApp, type BankCtx } from '../lib/bankUi.js';
import { MARKET_SCREENS } from '../lib/marketUi.js';

export const command = 'inventory';
export const aliases = ['inv', 'bag', 'backpack'];
export const category = 'economy';
export const cooldown = 3000;

const PREFIX = config.prefix || '.';

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, senderId, channelInfo } = context;
  const ctx: BankCtx & { fallbackHint?: string } = {
    sock, message, chatId, channelInfo,
    userId: cleanJid(senderId),
    fallbackHint: `Menu buttons are unavailable right now — try *${PREFIX}inventory* again in a moment.`,
  };
  return runApp(ctx, MARKET_SCREENS, 'inventoryRoot');
}

export const handler = withEconomyGuard(_handler);
export const usage = `${PREFIX}inventory — your protection, mask and guns.`;
