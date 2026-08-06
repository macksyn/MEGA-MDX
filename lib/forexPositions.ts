// @ts-nocheck
/***
 * lib/forexPositions.ts
 *
 * Phase 2 — persistent leveraged positions on top of the Phase 1 market/
 * game engines. Pure logic + storage only; no message sending and no
 * `sock` dependency, same separation as forexGame.ts — the plugin's
 * schedule handler owns turning what happens here into WhatsApp messages.
 *
 * ── Why this is a different cost model from Phase 1's instant rounds ────
 * Phase 1 rounds are option-style: one spread cost at entry, resolved
 * instantly. Positions here are closer to real leveraged/CFD trading:
 * the spread is crossed TWICE (once opening, once closing), and an open
 * position accrues a funding fee the longer it's held — both standard for
 * real leveraged trading, and both necessary here: without an exit-spread
 * cost, a position with zero net price movement would show a free
 * break-even, which doesn't hold up once funding is layered in either.
 *
 * ── Liquidation model ────────────────────────────────────────────────
 * LIQUIDATION_THRESHOLD (90%) means a position auto-closes once floating
 * losses would consume 90% of its CURRENT margin (funding-reduced, not the
 * original stake) — so the house is protected before a loss could ever
 * exceed what the player actually has backing the position. Funding fees
 * eating margin directly brings the liquidation point closer over time,
 * which is realistic: less cushion left the longer you hold.
 *
 * ── Honest caveat, same as forexGame.ts's payout curve ───────────────
 * FUNDING_FEE_RATE_PER_HOUR below is a first-pass number, not derived from
 * a simulation the way the Phase 1 payout curve was. At 25x leverage a
 * position's `size` is huge relative to its margin, so funding alone can
 * meaningfully erode a maxed-leverage position over a day or two even with
 * flat price action — that's arguably realistic (high leverage SHOULD be
 * expensive to hold) but needs real playtesting before you trust the exact
 * number. It's isolated in one constant specifically so it's easy to retune.
 */

import { createStore } from './pluginStore.js';
import { getPairQuote, PAIRS } from './forexMarket.js';
import {
  getBankPool,
  contributeToBank,
  deductFromBank,
  settleWin,
  recordPlayerActivity,
  recordHouseActivity,
  Direction,
} from './forexGame.js';

// Root store, not a .table() sub-store — matches the confirmed-working
// pattern from your scheduler plugin (createStore(...).getAll()), since
// this module needs to enumerate all open positions and I don't have
// confirmation that .getAll() is available on a .table() sub-store too.
const positionStore = createStore('forexpositions');

export const ALLOWED_LEVERAGE = [1, 2, 5, 10, 15, 25];
export const ALLOWED_MARGINS = [5, 20, 50, 100];
export const MAX_LEVERAGE = 25;
export const LIQUIDATION_THRESHOLD = 0.90;

// See file header — first-pass, needs playtesting.
const FUNDING_FEE_RATE_PER_HOUR = 0.0005; // 0.05% of notional size, per hour held

export type PositionStatus = 'open' | 'closed';
export type CloseReason = 'manual' | 'liquidation' | 'stop_loss' | 'take_profit';

export interface ForexPosition {
  id: string;
  userId: string;
  chatId: string;
  pair: string;
  direction: Direction;
  margin: number;          // current, funding-reduced
  originalMargin: number;  // fixed at open, for display/stats
  leverage: number;
  size: number;             // originalMargin * leverage, fixed at open
  entryPrice: number;
  entryMid: number;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: number;
  lastFundingAt: number;
  status: PositionStatus;
  // populated only once closed:
  closedAt?: number;
  closePrice?: number;
  closeReason?: CloseReason;
  pnl?: number;
  payout?: number;
}

export interface CloseResult {
  position: ForexPosition;
  pnl: number;
  payout: number;
  closePrice: number;
  reason: CloseReason;
  fundingCharged: number;
}

// ── RNG for ids ─────────────────────────────────────────────────────
function generateId(): string {
  return Math.random().toString(36).slice(2, 6) + Math.random().toString(36).slice(2, 6);
}

// ── Core math ─────────────────────────────────────────────────────────

function computeExitPrice(position: ForexPosition, quote: { bid: number; ask: number }): number {
  // Closing crosses the spread again: sell at bid to close a long, buy at
  // ask to close a short — same as entry, just inverted.
  return position.direction === 'call' ? quote.bid : quote.ask;
}

function computeFloatingPnL(position: ForexPosition, quote: { bid: number; ask: number }): number {
  const exitPrice = computeExitPrice(position, quote);
  const pctChange = (exitPrice - position.entryPrice) / position.entryPrice;
  const directional = position.direction === 'call' ? pctChange : -pctChange;
  return position.size * directional;
}

/** Mutates position.margin in place. Safe to call multiple times in quick
 *  succession — it only charges for elapsed time since lastFundingAt, so a
 *  second call moments later charges ~0 rather than double-billing. */
function accrueFunding(position: ForexPosition, now: number): number {
  const elapsedHours = (now - position.lastFundingAt) / 3_600_000;
  if (elapsedHours <= 0) return 0;
  const fee = position.size * FUNDING_FEE_RATE_PER_HOUR * elapsedHours;
  position.margin = Math.max(0, position.margin - fee);
  position.lastFundingAt = now;
  return fee;
}

// ── CRUD ──────────────────────────────────────────────────────────────

export async function openPosition(
  userId: string,
  chatId: string,
  pair: string,
  direction: Direction,
  margin: number,
  leverage: number
): Promise<{ success: boolean; position?: ForexPosition; reason?: string }> {
  if (!PAIRS[pair]) return { success: false, reason: 'invalid_pair' };
  if (!ALLOWED_MARGINS.includes(margin)) return { success: false, reason: 'invalid_margin' };
  if (!ALLOWED_LEVERAGE.includes(leverage)) return { success: false, reason: 'invalid_leverage' };

  const quote = await getPairQuote(pair);
  const entryPrice = direction === 'call' ? quote.ask : quote.bid;
  const size = margin * leverage;
  const now = Date.now();

  const position: ForexPosition = {
    id: generateId(),
    userId, chatId, pair, direction,
    margin, originalMargin: margin, leverage, size,
    entryPrice, entryMid: quote.mid,
    stopLoss: null, takeProfit: null,
    openedAt: now, lastFundingAt: now,
    status: 'open',
  };

  await positionStore.set(position.id, position);
  await contributeToBank(margin); // margin is now at-risk capital, same invariant as Phase 1's bet
  return { success: true, position };
}

export async function getPosition(id: string): Promise<ForexPosition | null> {
  const p = (await positionStore.get(id)) as ForexPosition | undefined;
  return p && p.status === 'open' ? p : null;
}

export async function getOpenPositions(userId: string): Promise<ForexPosition[]> {
  const all = (await positionStore.getAll()) as Record<string, ForexPosition>;
  return Object.values(all || {}).filter(p => p.userId === userId && p.status === 'open');
}

async function getAllOpenPositions(): Promise<ForexPosition[]> {
  const all = (await positionStore.getAll()) as Record<string, ForexPosition>;
  return Object.values(all || {}).filter(p => p.status === 'open');
}

export async function setStopLoss(id: string, userId: string, price: number): Promise<{ success: boolean; reason?: string }> {
  const position = await getPosition(id);
  if (!position) return { success: false, reason: 'not_found' };
  if (position.userId !== userId) return { success: false, reason: 'not_owner' };
  const validSide = position.direction === 'call' ? price < position.entryPrice : price > position.entryPrice;
  if (!validSide) return { success: false, reason: 'wrong_side' };
  position.stopLoss = price;
  await positionStore.set(id, position);
  return { success: true };
}

export async function setTakeProfit(id: string, userId: string, price: number): Promise<{ success: boolean; reason?: string }> {
  const position = await getPosition(id);
  if (!position) return { success: false, reason: 'not_found' };
  if (position.userId !== userId) return { success: false, reason: 'not_owner' };
  const validSide = position.direction === 'call' ? price > position.entryPrice : price < position.entryPrice;
  if (!validSide) return { success: false, reason: 'wrong_side' };
  position.takeProfit = price;
  await positionStore.set(id, position);
  return { success: true };
}

/** Live floating P/L for display — doesn't mutate or settle anything. */
export async function getFloatingPnL(position: ForexPosition): Promise<number> {
  const quote = await getPairQuote(position.pair);
  return computeFloatingPnL(position, quote);
}

// ── Closing (shared by manual close and the auto-close watcher) ────────

async function settleClose(position: ForexPosition, reason: CloseReason): Promise<CloseResult> {
  const quote = await getPairQuote(position.pair);
  const now = Date.now();
  const fundingCharged = accrueFunding(position, now);
  const pnl = computeFloatingPnL(position, quote);
  const closePrice = computeExitPrice(position, quote);
  const rawPayout = Math.max(0, position.margin + pnl);

  const pool = await getBankPool();
  const { payout } = settleWin(rawPayout, pool);
  if (payout > 0) await deductFromBank(payout);

  position.status = 'closed';
  position.closedAt = now;
  position.closePrice = closePrice;
  position.closeReason = reason;
  position.pnl = pnl;
  position.payout = payout;
  // Soft-close rather than delete — keeps a record, and avoids depending on
  // a delete() method I haven't confirmed exists on this store.
  await positionStore.set(position.id, position);

  await recordPlayerActivity(position.userId, position.originalMargin, payout);
  await recordHouseActivity(position.originalMargin, payout);

  return { position, pnl, payout, closePrice, reason, fundingCharged };
}

export async function closePositionManually(
  id: string,
  userId: string
): Promise<{ success: boolean; result?: CloseResult; reason?: string }> {
  const position = await getPosition(id);
  if (!position) return { success: false, reason: 'not_found' };
  if (position.userId !== userId) return { success: false, reason: 'not_owner' };
  const result = await settleClose(position, 'manual');
  return { success: true, result };
}

// ── Watcher — called on a schedule by the plugin, not from here ────────
// Pure: returns whatever auto-closed this tick so the plugin can notify.
// Positions that stay open still get their funding persisted either way.

export async function checkAllPositions(): Promise<CloseResult[]> {
  const openPositions = await getAllOpenPositions();
  if (openPositions.length === 0) return [];

  const pairsInUse = Array.from(new Set(openPositions.map(p => p.pair)));
  const quotes: Record<string, { bid: number; ask: number; mid: number }> = {};
  for (const pair of pairsInUse) {
    quotes[pair] = await getPairQuote(pair);
  }

  const closedEvents: CloseResult[] = [];
  const now = Date.now();

  for (const position of openPositions) {
    const quote = quotes[position.pair];

    // Project funding without committing yet, to decide if action's needed.
    const elapsedHours = Math.max(0, (now - position.lastFundingAt) / 3_600_000);
    const pendingFee = position.size * FUNDING_FEE_RATE_PER_HOUR * elapsedHours;
    const projectedMargin = Math.max(0, position.margin - pendingFee);

    if (projectedMargin <= 0) {
      closedEvents.push(await settleClose(position, 'liquidation'));
      continue;
    }

    const pnl = computeFloatingPnL(position, quote);
    if (pnl <= -LIQUIDATION_THRESHOLD * projectedMargin) {
      closedEvents.push(await settleClose(position, 'liquidation'));
      continue;
    }

    const closePrice = computeExitPrice(position, quote);
    if (position.stopLoss !== null) {
      const hit = position.direction === 'call' ? closePrice <= position.stopLoss : closePrice >= position.stopLoss;
      if (hit) { closedEvents.push(await settleClose(position, 'stop_loss')); continue; }
    }
    if (position.takeProfit !== null) {
      const hit = position.direction === 'call' ? closePrice >= position.takeProfit : closePrice <= position.takeProfit;
      if (hit) { closedEvents.push(await settleClose(position, 'take_profit')); continue; }
    }

    // Still open — commit the funding accrual so far and persist.
    accrueFunding(position, now);
    await positionStore.set(position.id, position);
  }

  return closedEvents;
}
