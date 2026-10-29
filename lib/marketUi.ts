// @ts-nocheck
/***
 * lib/marketUi.ts
 *
 * Screens for the black market and the member inventory, run by the same
 * navigation router the bank uses (lib/bankUi.ts -> runApp). Each screen is
 * just view() + select(); Back and Cancel are appended automatically.
 *
 *   home -> protection | gear | inventory
 *   protection / gear -> confirm (pick an item) -> receipt, back to the list
 *   inventory -> equip a gun (stays on the screen)
 *
 * 'inventoryRoot' is the same screen for when it is the FIRST screen opened
 * (the `inventory` command): it adds an "Open Market" button, because a
 * root screen has no Back button and a menu can't be sent with no options.
 */
import type { Screen, ScreenView, Nav } from './bankUi.js';
import { formatNumber, getWallet } from './economy.js';
import {
  ITEMS, MARKET_CONFIG, listItems, getInventory, activeProtection, hasMask,
  buyItem, equipGun, fmtDuration, lifeBar, type ShopItem,
} from './market.js';

const fmt = formatNumber;
const RULE = '━━━━━━━━━━━━━━';
const pct = (n: number) => `${Math.round(n * 100)}%`;
const days = (ms: number) => `${Math.round(ms / 86_400_000)}d`;

function shortInfo(i: ShopItem): string {
  if (i.kind === 'protection') return `${days(i.durationMs!)} · ${i.life} HP`;
  if (i.kind === 'mask') return `${pct(i.successRate!)} success · ${days(i.durationMs!)}`;
  return `${i.rounds} rounds · ${i.damage} dmg`;
}

function longInfo(i: ShopItem): string {
  if (i.kind === 'protection') {
    return `Guards you for *${days(i.durationMs!)}*. Every robbery attempt drains its life bar (*${i.life} HP*) — too many attempts and it dies early. Once it's down, the next attempt gets through.`;
  }
  if (i.kind === 'mask') {
    return `Raises your robbery success from *${pct(MARKET_CONFIG.BASE_SUCCESS)}* to *${pct(i.successRate!)}* (fewer arrests) for *${days(i.durationMs!)}*. Buying again extends it.`;
  }
  return `*${i.rounds} rounds* per magazine, then a *${fmtDuration(MARKET_CONFIG.RELOAD_MS)}* reload. Each attempt on a protected target deals *${i.damage}* damage to their life bar. Yours to keep.`;
}

async function walletLine(userId: string): Promise<string> {
  return `Wallet: ${fmt((await getWallet(userId)).coins)} coins`;
}

// ── Home ─────────────────────────────────────────────────────────────────────

const home: Screen = {
  async view(ctx): Promise<ScreenView> {
    const inv = await getInventory(ctx.userId);
    const prot = activeProtection(inv);
    const status = [
      prot ? `🛡️ ${ITEMS[prot.itemId].name} · ${fmtDuration(prot.expiresAt - Date.now())} left` : `🛡️ Unprotected`,
      hasMask(inv) ? `🎭 Masked · ${fmtDuration(inv.maskUntil - Date.now())} left` : null,
    ].filter(Boolean).join('\n');
    return {
      title: '🛒 BLACK MARKET',
      subtitle: await walletLine(ctx.userId),
      text: `${status}\n${RULE}\nWhat are you shopping for?`,
      options: [
        { label: '🛡️ Rob Protection', value: 'protection', description: 'Bodyguards & escorts' },
        { label: '🎭 Robber Gear', value: 'gear', description: 'Masks & guns' },
        { label: '🎒 My Inventory', value: 'inventory', description: 'What you own' },
      ],
    };
  },
  async select(value): Promise<Nav> {
    return { go: value };
  },
};

// ── Catalogs ─────────────────────────────────────────────────────────────────

function catalog(title: string, text: string, ...kinds): Screen {
  return {
    async view(ctx): Promise<ScreenView> {
      return {
        title,
        subtitle: await walletLine(ctx.userId),
        text,
        options: listItems(...kinds).map(i => ({
          label: `${i.emoji} ${i.name} · ${fmt(i.price)}`,
          value: i.id,
          description: shortInfo(i),
        })),
      };
    },
    async select(value): Promise<Nav> {
      return { go: 'confirm', params: { itemId: value } };
    },
  };
}

const protection = catalog('🛡️ PROTECTION', 'Hire protection against robbers. Higher tiers last longer and take more hits.', 'protection');
const gear = catalog('🎭 ROBBER GEAR', `Masks cut your arrest risk. Guns give you rounds before a reload, and hurt protections. Base success is ${pct(MARKET_CONFIG.BASE_SUCCESS)}; with no gun you wait ${fmtDuration(MARKET_CONFIG.NO_GUN_COOLDOWN_MS)} between attempts.`, 'mask', 'gun');

// ── Confirm + buy ────────────────────────────────────────────────────────────

const confirm: Screen = {
  async view(ctx, params): Promise<ScreenView> {
    const item = ITEMS[params?.itemId];
    if (!item) throw new Error(`unknown market item "${params?.itemId}"`);
    return {
      title: `${item.emoji} ${item.name}`.slice(0, 24),
      subtitle: await walletLine(ctx.userId),
      text: `${longInfo(item)}\n${RULE}\nPrice: *${fmt(item.price)} coins*`,
      options: [{ label: `✅ Buy for ${fmt(item.price)}`, value: 'buy' }],
    };
  },
  async select(value, ctx, params): Promise<Nav> {
    if (value !== 'buy') return { back: true };
    const r = await buyItem(ctx.userId, params.itemId);
    if (r.ok) {
      const extra = r.item.kind === 'gun' ? `\nEquip it from *My Inventory* if you own more than one.` : '';
      return { back: true, notice: `✅ Bought ${r.item.emoji} *${r.item.name}* for ${fmt(r.item.price)} coins. Balance: *${fmt(r.coinsLeft)}*${extra}` };
    }
    switch (r.reason) {
      case 'insufficient_funds':
        return { back: true, notice: `❌ Not enough coins — you have *${fmt(r.coins)}*.` };
      case 'already_protected':
        return { back: true, notice: `❌ You're already protected by *${ITEMS[r.current.itemId].name}* (${fmtDuration(r.current.expiresAt - Date.now())} left). Wait for it to run out or fall.` };
      case 'already_owned':
        return { back: true, notice: `❌ You already own the *${ITEMS[params.itemId].name}*.` };
      default:
        return { back: true, notice: `⚠️ Couldn't complete that purchase. You weren't charged — try again.` };
    }
  },
};

// ── Inventory ────────────────────────────────────────────────────────────────

function inventory(withMarketLink: boolean): Screen {
  return {
    async view(ctx): Promise<ScreenView> {
      const now = Date.now();
      const inv = await getInventory(ctx.userId);
      const prot = activeProtection(inv, now);
      const lines: string[] = [];

      if (prot) {
        const def = ITEMS[prot.itemId];
        lines.push(`🛡️ *${def.name}* · ${fmtDuration(prot.expiresAt - now)} left`);
        lines.push(`❤️ ${lifeBar(prot.life, prot.maxLife)} ${prot.life}/${prot.maxLife}`);
      } else {
        lines.push(`🛡️ No protection — you can be robbed.`);
      }

      lines.push(hasMask(inv, now) ? `🎭 *Mask* · ${fmtDuration(inv.maskUntil - now)} left` : `🎭 No mask`);

      if (inv.guns.length) {
        lines.push('', `*Guns*`);
        for (const id of inv.guns) {
          const g = ITEMS[id];
          lines.push(`${g.emoji} ${g.name} · ${g.rounds} rounds · ${g.damage} dmg${id === inv.equippedGun ? '  ✅ equipped' : ''}`);
        }
      } else {
        lines.push(`🔫 No gun`);
      }

      const gun = inv.equippedGun ? ITEMS[inv.equippedGun] : null;
      if (inv.cooldownUntil > now) {
        lines.push('', `⏳ ${gun ? 'Reloading' : 'Laying low'}: ${fmtDuration(inv.cooldownUntil - now)}`);
      } else if (gun) {
        lines.push('', `🔫 Ready: ${Math.max(0, gun.rounds! - inv.fired)}/${gun.rounds} rounds`);
      } else {
        lines.push('', `✅ Ready to rob`);
      }

      const options = inv.guns
        .filter(id => id !== inv.equippedGun)
        .map(id => ({ label: `${ITEMS[id].emoji} Equip ${ITEMS[id].name}`, value: `equip:${id}`, description: `${ITEMS[id].rounds} rounds · ${ITEMS[id].damage} dmg` }));
      if (withMarketLink) options.push({ label: '🛒 Open Market', value: 'market', description: 'Buy protection & gear' });

      return { title: '🎒 INVENTORY', subtitle: await walletLine(ctx.userId), text: lines.join('\n'), options };
    },
    async select(value, ctx): Promise<Nav> {
      if (value === 'market') return { go: 'home' };
      if (value.startsWith('equip:')) {
        const r = await equipGun(ctx.userId, value.slice(6));
        return r.ok ? { stay: true, notice: `✅ Equipped ${r.gun!.emoji} *${r.gun!.name}*.` } : { stay: true, notice: `❌ You don't own that gun.` };
      }
      return { stay: true };
    },
  };
}

export const MARKET_SCREENS: Record<string, Screen> = {
  home, protection, gear, confirm,
  inventory: inventory(false),
  inventoryRoot: inventory(true),
};
