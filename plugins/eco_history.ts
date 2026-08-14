// @ts-nocheck
/***
 * plugins/eco_history.ts
 *
 * Surfaces the transaction ledger (lib/economy.ts: logTransaction/
 * getTransactions) so balances are auditable — "I never got that
 * transfer!" now has an answer.
 *
 * The actual statement rendering (balance summary + aligned ledger table)
 * lives in lib/statement.ts so it can be reused elsewhere — see
 * plugins/eco_balance.ts, which offers the same statement as a menuSession
 * follow-up after !balance.
 *
 * Fully transparent by design: anyone can pull anyone else's statement,
 * same as !balance already lets anyone check anyone's balance. No
 * owner/sudo gate here.
 *
 * Usage:
 *   .history            -> your own last 10 transactions
 *   .history 20         -> your own last 20 (max 30)
 *   .history @user      -> anyone's history
 */
import { withEconomyGuard } from '../lib/economy.js';
import { sendStatement } from '../lib/statement.js';
import { cleanJid } from '../lib/isOwner.js';
import { extractTargetId } from '../lib/resolveTarget.js';

export const command = 'history';
export const aliases = ['statement', 'ledger'];
export const category = 'economy';
export const cooldown = 3000;

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, senderId, channelInfo } = context;
  const selfId = cleanJid(senderId);

  const mentionedTargetId = extractTargetId(message, args);
  const targetId = mentionedTargetId || selfId;
  const isSelf = targetId === selfId;

  const limitArg = parseInt(args.find(a => /^\d+$/.test(a)) || '', 10);
  const limit = Number.isFinite(limitArg) ? Math.max(1, Math.min(30, limitArg)) : 10;

  await sendStatement(sock, message, chatId, targetId, isSelf, limit, channelInfo);
}

export const handler = withEconomyGuard(_handler);