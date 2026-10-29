// @ts-nocheck
/***
 * lib/market.ts
 *
 * Black-market shop + robbery rules. Pure game logic — no WhatsApp / sock
 * code — so the market menu, the inventory screen and the rob command all go
 * through the same safe paths (same split as lib/bankLedger.ts).
 *
 * ── Money model ──────────────────────────────────────────────────────────
 * Wallet coins stay in lib/economy.ts (addCoins / deductCoins, so every move
 * lands in the transaction ledger and loan garnishment still applies).
 * Items + cooldown state live HERE, in the 'market' store, one record per
 * member. Coins that leave circulation (bail, shop purchases) are paid into
 * the jackpot pool via contributeToJackpot(), the same sink bets use.
 *
 * ── Rob rules ────────────────────────────────────────────────────────────
 *  1. Robber needs >= BAIL coins in their wallet, always (it's the bail).
 *  2. Robber must not be on cooldown (no gun: 5 min after every attempt;
 *     gun: its round count, then a 3 min reload).
 *  3. Victim with an empty wallet is "too broke" — no attempt is consumed.
 *  4. Roll: BASE_SUCCESS (70%), MASK_SUCCESS (90%) with an active mask.
 *       - fail    -> caught: BAIL coins leave the robber's wallet -> jackpot.
 *       - success -> if the victim has live protection, the attempt only
 *                    damages its life bar (gun-dependent). Once the bar hits
 *                    zero the protection is gone and the NEXT attempt lands.
 *                 -> otherwise the robber takes 70% of the victim's wallet,
 *                    rounded down to an even number.
 *
 * ── Concurrency ──────────────────────────────────────────────────────────
 * Buying and robbing are multi-step (read state -> move coins -> write state)
 * so both run under an in-process per-user lock (robbery locks robber AND
 * victim, always in sorted order so two people robbing each other can't
 * deadlock). Wallet writes themselves still go through economy.ts's own
 * store-level locking.
 */
import { createStore } from './pluginStore.js';
import { getWallet, addCoins, deductCoins } from './economy.js';
import { contributeToJackpot } from './slotMachine.js';

const root = createStore('market');
const inventoryTbl = root.table('inventory'); // userId -> Inventory

// ── Tunables ─────────────────────────────────────────────────────────────────

export const MARKET_CONFIG = {
  BAIL: 20,                    // also the minimum wallet needed to attempt a robbery
  BASE_SUCCESS: 0.70,
  MASK_SUCCESS: 0.90,
  STEAL_PERCENT: 0.70,
  NO_GUN_COOLDOWN_MS: 5 * 60_000,
  RELOAD_MS: 3 * 60_000,
  NO_GUN_DAMAGE: 10,           // life-bar damage to a protection when robbing without a gun
  SHOP_REVENUE_TO_JACKPOT: true, // shop purchases are paid into the reserve (set false to burn them)
};

const DAY = 24 * 60 * 60_000;

export type ItemKind = 'protection' | 'mask' | 'gun';

export interface ShopItem {
  id: string;
  kind: ItemKind;
  name: string;
  emoji: string;
  price: number;
  durationMs?: number;   // protection, mask
  life?: number;         // protection: life-bar size
  successRate?: number;  // mask
  rounds?: number;       // gun: attempts before the reload cooldown
  damage?: number;       // gun: life-bar damage dealt to a protection per attempt
}

// Edit prices / stats freely — nothing else hard-codes them.
export const ITEMS: Record<string, ShopItem> = {
  bodyguard: { id: 'bodyguard', kind: 'protection', name: 'Bodyguard',       emoji: '🕴️', price: 150,  durationMs: 2 * DAY, life: 100 },
  police:    { id: 'police',    kind: 'protection', name: 'Police Escort',   emoji: '🚔', price: 400,  durationMs: 4 * DAY, life: 250 },
  military:  { id: 'military',  kind: 'protection', name: 'Military Escort', emoji: '🪖', price: 1000, durationMs: 7 * DAY, life: 600 },

  mask:      { id: 'mask',      kind: 'mask',       name: 'Mask',            emoji: '🎭', price: 100,  durationMs: 2 * DAY, successRate: MARKET_CONFIG.MASK_SUCCESS },

  pistol:    { id: 'pistol',    kind: 'gun',        name: 'Pistol',          emoji: '🔫', price: 200,  rounds: 3, damage: 20 },
  rifle:     { id: 'rifle',     kind: 'gun',        name: 'Rifle',           emoji: '🎯', price: 500,  rounds: 5, damage: 45 },
  assault:   { id: 'assault',   kind: 'gun',        name: 'Assault Rifle',   emoji: '💥', price: 1200, rounds: 8, damage: 90 },
};

export function listItems(...kinds: ItemKind[]): ShopItem[] {
  return Object.values(ITEMS).filter(i => kinds.includes(i.kind));
}

// ── Formatting helpers (shared by the UI and the rob command) ───────────────

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function lifeBar(life: number, max: number, size = 10): string {
  const filled = max > 0 ? Math.max(0, Math.min(size, Math.ceil((life / max) * size))) : 0;
  return `${'█'.repeat(filled)}${'░'.repeat(size - filled)}`;
}

/**
 * 70% of the wallet, rounded DOWN to an even number. A wallet so small that
 * the even-rounded cut is 0 (1–2 coins) is taken whole, so a victim can
 * always actually be emptied ("until their wallet is empty").
 */
export function evenSteal(coins: number): number {
  if (coins <= 0) return 0;
  const raw = Math.floor(coins * MARKET_CONFIG.STEAL_PERCENT);
  const even = raw - (raw % 2);
  return even > 0 ? even : coins;
}

// ── Per-user locks ───────────────────────────────────────────────────────────

const lockTails = new Map<string, Promise<void>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = lockTails.get(key) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const tail = prev.then(() => gate);
  lockTails.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (lockTails.get(key) === tail) lockTails.delete(key);
  }
}

async function withLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  const sorted = [...new Set(keys)].sort();
  const run = (i: number): Promise<T> => (i >= sorted.length ? fn() : withLock(sorted[i], () => run(i + 1)));
  return run(0);
}

// ── Inventory ────────────────────────────────────────────────────────────────

export interface ActiveProtection {
  itemId: string;
  expiresAt: number;
  life: number;
  maxLife: number;
}

export interface Inventory {
  protection: ActiveProtection | null;
  maskUntil: number;        // 0 = no mask; otherwise epoch ms it expires
  guns: string[];           // owned gun ids (guns are permanent)
  equippedGun: string | null;
  fired: number;            // rounds used in the current magazine
  cooldownUntil: number;    // robbery cooldown (no-gun wait, or gun reload) ends at this time
}

const emptyInventory = (): Inventory => ({
  protection: null, maskUntil: 0, guns: [], equippedGun: null, fired: 0, cooldownUntil: 0,
});

function normalize(raw: any): Inventory {
  const inv: Inventory = { ...emptyInventory(), ...(raw || {}) };
  inv.guns = (Array.isArray(inv.guns) ? inv.guns : []).filter(id => ITEMS[id]?.kind === 'gun');
  if (inv.equippedGun && !inv.guns.includes(inv.equippedGun)) inv.equippedGun = inv.guns[0] || null;
  return inv;
}

/** The member's protection if it is still alive and unexpired, else null. */
export function activeProtection(inv: Inventory, now = Date.now()): ActiveProtection | null {
  const p = inv.protection;
  return p && p.expiresAt > now && p.life > 0 ? p : null;
}

export function hasMask(inv: Inventory, now = Date.now()): boolean {
  return inv.maskUntil > now;
}

export async function getInventory(userId: string): Promise<Inventory> {
  return normalize(await inventoryTbl.get(userId));
}

async function mutateInventory(userId: string, mutator: (inv: Inventory) => void): Promise<Inventory> {
  return inventoryTbl.mutate(userId, (cur: any) => {
    const inv = normalize(cur);
    mutator(inv);
    return inv;
  });
}

// ── Buying ───────────────────────────────────────────────────────────────────

export type BuyResult =
  | { ok: true; item: ShopItem; coinsLeft: number }
  | { ok: false; reason: 'unknown_item' }
  | { ok: false; reason: 'already_protected'; current: ActiveProtection }
  | { ok: false; reason: 'already_owned' }
  | { ok: false; reason: 'insufficient_funds'; coins: number }
  | { ok: false; reason: 'store_error' };

function grants(inv: Inventory, item: ShopItem, now: number): boolean {
  if (item.kind === 'protection') return inv.protection?.itemId === item.id && inv.protection.expiresAt > now;
  if (item.kind === 'mask') return inv.maskUntil > now;
  return inv.guns.includes(item.id);
}

export async function buyItem(userId: string, itemId: string): Promise<BuyResult> {
  const item = ITEMS[itemId];
  if (!item) return { ok: false, reason: 'unknown_item' };

  return withLock(userId, async () => {
    const now = Date.now();
    const before = await getInventory(userId);

    if (item.kind === 'protection') {
      const current = activeProtection(before, now);
      if (current) return { ok: false, reason: 'already_protected', current };
    }
    if (item.kind === 'gun' && before.guns.includes(item.id)) return { ok: false, reason: 'already_owned' };

    const paid = await deductCoins(userId, item.price, { type: 'shop', note: `bought ${item.name}` });
    if (!paid.success) return { ok: false, reason: 'insufficient_funds', coins: paid.wallet.coins };

    try {
      await mutateInventory(userId, (inv) => {
        if (item.kind === 'protection') {
          inv.protection = { itemId: item.id, expiresAt: now + item.durationMs!, life: item.life!, maxLife: item.life! };
        } else if (item.kind === 'mask') {
          inv.maskUntil = Math.max(inv.maskUntil, now) + item.durationMs!; // buying again while active extends it
        } else {
          inv.guns.push(item.id);
          const equipped = inv.equippedGun ? ITEMS[inv.equippedGun] : null;
          if (!equipped || (item.damage! > (equipped.damage || 0))) inv.equippedGun = item.id; // auto-equip upgrades
        }
      });
      // pluginStore.set() swallows adapter errors — read it back so a silently
      // failed write can never keep the coins AND lose the item.
      if (!grants(await getInventory(userId), item, now)) throw new Error('inventory write did not persist');
    } catch (err: any) {
      console.error(`[market] grant failed after payment (user=${userId} item=${item.id}):`, err?.message || err);
      try {
        await addCoins(userId, item.price, { type: 'shop_refund', note: `refund: ${item.name} could not be delivered` });
      } catch (refundErr: any) {
        console.error(`[market] CRITICAL: refund ALSO failed (user=${userId} amount=${item.price}) — needs manual reconciliation:`, refundErr?.message || refundErr);
      }
      return { ok: false, reason: 'store_error' };
    }

    if (MARKET_CONFIG.SHOP_REVENUE_TO_JACKPOT) {
      await contributeToJackpot(item.price).catch((e: any) => console.error('[market] jackpot contribution failed:', e?.message || e));
    }
    return { ok: true, item, coinsLeft: paid.wallet.coins };
  });
}

export async function equipGun(userId: string, gunId: string): Promise<{ ok: boolean; gun?: ShopItem }> {
  const gun = ITEMS[gunId];
  if (!gun || gun.kind !== 'gun') return { ok: false };
  return withLock(userId, async () => {
    const inv = await getInventory(userId);
    if (!inv.guns.includes(gunId)) return { ok: false };
    await mutateInventory(userId, (i) => { i.equippedGun = gunId; });
    return { ok: true, gun };
  });
}

// ── Robbery ──────────────────────────────────────────────────────────────────

export interface RobContext {
  gun: ShopItem | null;
  masked: boolean;
  successRate: number;
  roundsLeft: number | null;  // null when the attempt triggered a cooldown (or no gun)
  cooldownMs: number;         // cooldown applied by this attempt (0 if none)
}

export type RobResult =
  | { ok: false; reason: 'self' }
  | { ok: false; reason: 'error' }
  | { ok: false; reason: 'poor'; coins: number }
  | { ok: false; reason: 'cooldown'; remainingMs: number; gun: ShopItem | null; reloading: boolean }
  | { ok: true; outcome: 'victim_broke' }
  | ({ ok: true; outcome: 'caught'; bail: number; coinsAfter: number } & RobContext)
  | ({ ok: true; outcome: 'blocked'; protectionName: string; damage: number; lifeLeft: number; lifeMax: number; broken: boolean } & RobContext)
  | ({ ok: true; outcome: 'success'; stolen: number; coinsAfter: number } & RobContext);

export async function attemptRob(robberId: string, victimId: string, rng: () => number = Math.random): Promise<RobResult> {
  if (robberId === victimId) return { ok: false, reason: 'self' };
  const { BAIL, BASE_SUCCESS, MASK_SUCCESS, NO_GUN_COOLDOWN_MS, RELOAD_MS, NO_GUN_DAMAGE } = MARKET_CONFIG;

  return withLocks([robberId, victimId], async (): Promise<RobResult> => {
    const now = Date.now();

    // 1) Bail money — always required.
    const robberWallet = await getWallet(robberId);
    if (robberWallet.coins < BAIL) return { ok: false, reason: 'poor', coins: robberWallet.coins };

    // 2) Cooldown / reload.
    const robberInv = await getInventory(robberId);
    const gun = robberInv.equippedGun ? ITEMS[robberInv.equippedGun] : null;
    if (robberInv.cooldownUntil > now) {
      return { ok: false, reason: 'cooldown', remainingMs: robberInv.cooldownUntil - now, gun, reloading: !!gun };
    }
    if (gun && robberInv.fired >= gun.rounds!) {
      // Swapped to a smaller magazine than the rounds already fired — reload now.
      await mutateInventory(robberId, (i) => { i.cooldownUntil = now + RELOAD_MS; i.fired = 0; });
      return { ok: false, reason: 'cooldown', remainingMs: RELOAD_MS, gun, reloading: true };
    }

    // 3) Nothing to steal -> "too broke", and no attempt is consumed.
    if ((await getWallet(victimId)).coins <= 0) return { ok: true, outcome: 'victim_broke' };

    // 4) The attempt is spent from here on, win or lose.
    const fired = robberInv.fired + 1;
    let cooldownMs = 0;
    let roundsLeft: number | null = null;
    if (!gun) cooldownMs = NO_GUN_COOLDOWN_MS;
    else if (fired >= gun.rounds!) cooldownMs = RELOAD_MS;
    else roundsLeft = gun.rounds! - fired;

    await mutateInventory(robberId, (i) => {
      if (cooldownMs) { i.cooldownUntil = now + cooldownMs; i.fired = 0; }
      else i.fired = fired;
    });

    const masked = hasMask(robberInv, now);
    const successRate = masked ? MASK_SUCCESS : BASE_SUCCESS;
    const ctx: RobContext = { gun, masked, successRate, roundsLeft, cooldownMs };

    // 5) Caught -> bail leaves the wallet immediately and goes to the jackpot.
    if (!(rng() < successRate)) {
      const paid = await deductCoins(robberId, BAIL, { type: 'rob_bail', counterpartyId: victimId, note: 'caught robbing — bail paid to the reserve' });
      if (paid.success) {
        await contributeToJackpot(BAIL).catch((e: any) => console.error('[market] bail -> jackpot failed:', e?.message || e));
      }
      return { ok: true, outcome: 'caught', bail: paid.success ? BAIL : 0, coinsAfter: paid.wallet.coins, ...ctx };
    }

    // 6) Success vs. a protected victim: the attempt hits the life bar instead.
    const victimInv = await getInventory(victimId);
    if (activeProtection(victimInv, now)) {
      const damage = gun ? gun.damage! : NO_GUN_DAMAGE;
      let absorbed = false, before = 0, after = 0, broken = false, protectionId = '';
      await mutateInventory(victimId, (i) => {
        const p = i.protection;
        if (!p || p.expiresAt <= now || p.life <= 0) return; // changed under us
        absorbed = true;
        protectionId = p.itemId;
        before = p.life;
        p.life = Math.max(0, p.life - damage);
        after = p.life;
        if (p.life <= 0) { i.protection = null; broken = true; }
      });
      if (absorbed) {
        return {
          ok: true, outcome: 'blocked',
          protectionName: ITEMS[protectionId]?.name || 'Protection',
          damage: before - after, lifeLeft: after, lifeMax: victimInv.protection!.maxLife, broken, ...ctx,
        };
      }
    }

    // 7) Success vs. an unprotected victim: take 70% (even) of the wallet.
    for (let tries = 0; tries < 2; tries++) {
      const fresh = (await getWallet(victimId)).coins;
      const amount = evenSteal(fresh);
      if (amount <= 0) return { ok: true, outcome: 'victim_broke' };

      const taken = await deductCoins(victimId, amount, { type: 'rob_loss', counterpartyId: robberId, note: 'robbed' });
      if (!taken.success) continue; // they spent coins mid-robbery — re-read and retry once

      try {
        const saved = await addCoins(robberId, amount, { type: 'rob_win', counterpartyId: victimId, note: 'robbery' });
        return { ok: true, outcome: 'success', stolen: amount, coinsAfter: saved.coins, ...ctx };
      } catch (err: any) {
        console.error(`[market] rob credit failed after debit (robber=${robberId} victim=${victimId} amount=${amount}):`, err?.message || err);
        try {
          await addCoins(victimId, amount, { type: 'rob_refund', counterpartyId: robberId, note: 'auto-refund: robbery credit failed' });
        } catch (refundErr: any) {
          console.error(`[market] CRITICAL: rob refund ALSO failed (victim=${victimId} amount=${amount}) — needs manual reconciliation:`, refundErr?.message || refundErr);
        }
        return { ok: false, reason: 'error' };
      }
    }
    return { ok: true, outcome: 'victim_broke' };
  });
}
