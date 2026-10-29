// @ts-nocheck
/***
 * plugins/market.ts
 *
 * {prefix}market — the black market as a button-menu app: browse Rob
 * Protection (bodyguards / escorts) and Robber Gear (masks / guns), buy with
 * wallet coins, and check your inventory. Items, prices and rules live in
 * lib/market.ts; screens in lib/marketUi.ts.
 *
 *   {prefix}market              opens the menu
 *   {prefix}market inventory    jumps straight to your inventory
 */
import { withEconomyGuard } from '../lib/economy.js';
import { cleanJid } from '../lib/isOwner.js';
import config from '../config.js';
import { runApp, type BankCtx } from '../lib/bankUi.js';
import { MARKET_SCREENS } from '../lib/marketUi.js';

export const command = 'market';
export const aliases = ['shop', 'store', 'blackmarket'];
export const category = 'economy';
export const cooldown = 3000;

const PREFIX = config.prefix || '.';

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, senderId, channelInfo } = context;
  const sub = (args[0] || '').toLowerCase();
  const start = sub.startsWith('inv') || sub === 'bag' ? 'inventoryRoot' : 'home';
  const ctx: BankCtx & { fallbackHint?: string } = {
    sock, message, chatId, channelInfo,
    userId: cleanJid(senderId),
    fallbackHint: `Menu buttons are unavailable right now — try *${PREFIX}market* again in a moment.`,
  };
  return runApp(ctx, MARKET_SCREENS, start);
}

export const handler = withEconomyGuard(_handler);
export const usage = `${PREFIX}market — opens the black market. ${PREFIX}market inventory — your items.`;
