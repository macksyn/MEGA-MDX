// @ts-nocheck
/***
 * plugins/globalTrader.ts
 *
 * Global Trader – WhatsApp Trading Game, Menu Layer.
 *
 * Mirrors two existing patterns rather than inventing a third:
 *   - Visual language (header/divider/progressBar/deltaLine) from
 *     plugins/oceanSlots.ts.
 *   - Numbered menu navigation from lib/menuSession.ts's promptMenu(),
 *     same primitive antilink.ts uses.
 *
 * Every decision in this file — including quantity — is a numbered pick.
 * No freeform text input anywhere, since quantities are fixed presets
 * (5/10/20/50/70/100) rather than typed amounts.
 *
 * ── "0 = Back" navigation ────────────────────────────────────────────
 * menuSession.ts already lets a menu customize what "0" means via
 * `cancelLabel` (it renders "0️⃣ {cancelLabel}", still resolves
 * result.cancelled = true either way) — no changes needed to the shared
 * library. Every submenu here passes cancelLabel: 'Back' and, on
 * result.cancelled, returns the sentinel string 'back' to its caller.
 * The caller, on receiving 'back' from a child it invoked, simply
 * re-invokes itself (recursion = redisplay), which walks the player up
 * exactly one menu level per "0" press. Only the root main menu uses
 * cancelLabel: 'Exit', since there's no level above it to return to.
 *
 * NOTE: this file is UI/navigation only. It assumes a lib/globalTraderEconomy.js
 * module (shipments, market board, licenses, stock) shaped like
 * lib/economy.ts / lib/oceanSlotMachine.ts — referenced here by the calls
 * it would need to expose, so the menu tree can be reviewed before that
 * module is built.
 */

import { promptMenu } from '../lib/menuSession.js';
import { getWallet, formatNumber, withEconomyGuard } from '../lib/economy.js';
import { cleanJid } from '../lib/isOwner.js';
import {
  COUNTRIES,
  FREIGHT_TIERS,
  GOODS,                    // new goods registry
  getPlayerRank,
  getStockLevel,
  getActiveShipments,
  getShipmentProgress,
  sourceShipment,
  clearShipment,
  sellGoods,
  getLicenseStatus,
  renewLicense,
} from '../lib/globalTraderEconomy.js';

export const command = 'global';
export const aliases = ['trader', 'gt', 'trade', 'port', 'portking', 'pk'];
export const category = 'economy-games';
export const cooldown = 3000;

// ── Visual language (matches oceanSlots.ts) ─────────────────────────────
const DIVIDER = '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈';

function header(subtitle?: string): string {
  return `🌍 *GLOBAL TRADER* 🌍${subtitle ? `\n${subtitle}` : ''}\n${DIVIDER}`;
}

function progressBar(value: number, max: number, size = 10): string {
  const filled = Math.max(0, Math.min(size, Math.round((value / max) * size)));
  return '▰'.repeat(filled) + '▱'.repeat(size - filled);
}

function deltaLine(amount: number): string {
  if (amount > 0) return `▲ *+${formatNumber(amount)}* coins`;
  if (amount < 0) return `▼ *-${formatNumber(Math.abs(amount))}* coins`;
  return `• No change`;
}

const STAGE_EMOJI: Record<string, string> = {
  order_placed: '📝', payment: '💰', documents: '📄', loading: '📦',
  departed: '🚢', in_transit: '🌊', approaching: '🧭', arrived: '⚓',
  awaiting_clearance: '🛃',
};

const QUANTITY_PRESETS = [5, 10, 20, 50, 70, 100];

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Root menu ─────────────────────────────────────────────────────────

async function runMainMenu(sock: any, message: any, chatId: string, userId: string) {
  const wallet = await getWallet(userId);
  const rank = await getPlayerRank(userId);

  const result = await promptMenu(sock, message, chatId, userId, {
    title: '🌍 GLOBAL TRADER',
    subtitle: `Rank: ${rank.label}  ·  💰 ${formatNumber(wallet.coins)} coins`,
    text: 'What would you like to do?',
    options: [
      { label: 'Source Goods', value: 'source', description: 'Buy from a supplier country' },
      { label: 'My Shipments', value: 'shipments', description: 'Track everything in transit' },
      { label: 'Sell / Market', value: 'sell', description: 'Cash out cleared goods' },
      { label: 'License & Rank', value: 'license', description: 'Check expiry, renew, view rank' },
      { label: 'Wallet', value: 'wallet' },
    ],
    cancelLabel: 'Exit',
  });

  if (result.cancelled || result.timedOut) return;

  let outcome: any;
  switch (result.value) {
    case 'source':    outcome = await runSourceMenu(sock, message, chatId, userId); break;
    case 'shipments': outcome = await runShipmentsMenu(sock, message, chatId, userId); break;
    case 'sell':      outcome = await runSellMenu(sock, message, chatId, userId); break;
    case 'license':   outcome = await runLicenseMenu(sock, message, chatId, userId); break;
    case 'wallet':    await sendWalletCard(sock, chatId, userId); outcome = 'back'; break;
  }

  if (outcome === 'back') return runMainMenu(sock, message, chatId, userId);
}

// ── Source Goods: country -> freight -> quantity -> confirm ────────────

async function runSourceMenu(sock: any, message: any, chatId: string, userId: string) {
  const rank = await getPlayerRank(userId);
  const unlocked = COUNTRIES.filter(c => rank.unlockedCountries.includes(c.key));

  const options = await Promise.all(unlocked.map(async c => {
    const stock = await getStockLevel(c.key);
    const good = GOODS[c.goodKey];
    return {
      label: `${c.emoji} ${c.label}`,
      value: c.key,
      description: `${good.label} · ${good.baseCost} · ${stock.remaining}/${stock.cap} left today`,
    };
  }));

  const locked = COUNTRIES.length - unlocked.length;
  const result = await promptMenu(sock, message, chatId, userId, {
    title: '📦 GLOBAL TRADER · Source',
    subtitle: locked ? `${locked} more country(s) unlock at higher rank` : undefined,
    text: 'Pick a country to source from:',
    options,
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  const country = COUNTRIES.find(c => c.key === result.value);
  const outcome = await runFreightMenu(sock, message, chatId, userId, country);
  if (outcome === 'back') return runSourceMenu(sock, message, chatId, userId);
  return outcome;
}

async function runFreightMenu(sock: any, message: any, chatId: string, userId: string, country: any) {
  const rank = await getPlayerRank(userId);

  const options = FREIGHT_TIERS
    .filter(f => rank.unlockedFreight.includes(f.key))
    .map(f => ({
      label: f.label,
      value: f.key,
      description: `~${Math.round(country.distanceHrs / f.speedMult)}h · ${f.costMult}x freight cost`,
    }));

  const result = await promptMenu(sock, message, chatId, userId, {
    title: `🚢 ${country.emoji} ${country.label} · Freight`,
    text: 'Choose a shipping line:',
    options,
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  const outcome = await runQuantityMenu(sock, message, chatId, userId, country, result.value);
  if (outcome === 'back') return runFreightMenu(sock, message, chatId, userId, country);
  return outcome;
}

async function runQuantityMenu(sock: any, message: any, chatId: string, userId: string, country: any, freightKey: string) {
  const stock = await getStockLevel(country.key);
  const options = QUANTITY_PRESETS
    .filter(q => q <= stock.remaining)
    .map(q => ({ label: `${q} units`, value: String(q) }));

  if (!options.length) {
    await sock.sendMessage(chatId, {
      text: `${header()}\n❌ Not enough stock left today for ${country.label}.\n_Try again after tomorrow's reset._`,
    });
    return;
  }

  const result = await promptMenu(sock, message, chatId, userId, {
    title: `📦 ${country.label} · Quantity`,
    subtitle: `Stock left today: ${stock.remaining}/${stock.cap}`,
    text: 'How many units?',
    options,
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  const qty = parseInt(result.value, 10);
  const freight = FREIGHT_TIERS.find(f => f.key === freightKey);

  const purchase = await sourceShipment(userId, country.key, freightKey, qty);
  if (!purchase.success) {
    await sock.sendMessage(chatId, { text: `${header()}\n❌ ${purchase.reason || 'Could not source that shipment.'}` });
    return;
  }

  const s = purchase.shipment;
  await sock.sendMessage(chatId, {
    text:
      `📝 ORDER PLACED\n${DIVIDER}\n` +
      `${header()}\n` +
      `#${s.id} — ${country.goodLabel} (${country.label})\n` +
      `Qty: ${qty}  ·  Freight: ${freight.label}\n` +
      `${DIVIDER}\n` +
      `${deltaLine(-s.totalCost)}\n` +
      `ETA: ${s.etaLabel}\n\n` +
      `_Track it anytime from the main menu → My Shipments_`,
  });
  // Terminal action — no auto-loop back, player picks their next step via .global
}

// ── My Shipments: live tracker card ─────────────────────────────────────

async function runShipmentsMenu(sock: any, message: any, chatId: string, userId: string) {
  const shipments = await getActiveShipments(userId);

  if (!shipments.length) {
    await sock.sendMessage(chatId, {
      text: `${header()}\n_No active shipments._\n\n_Use *Source Goods* from the main menu to start one._`,
    });
    return;
  }

  const cards = await Promise.all(shipments.map(async s => {
    const p = await getShipmentProgress(s);
    const emoji = STAGE_EMOJI[p.stage] || '📦';
    const bar = progressBar(p.pct, 100);
    const clearHint = p.stage === 'awaiting_clearance' ? `\n_Ready — pick this shipment below to clear it_` : '';
    return `📦 #${s.id} — ${s.goodLabel} (${s.countryLabel})\n${emoji} ${p.label}\n${bar}  ${p.pct}%${clearHint}`;
  }));

  const options = shipments.map(s => ({ label: `#${s.id} — ${s.goodLabel}`, value: s.id }));

  const result = await promptMenu(sock, message, chatId, userId, {
    title: '🚛 GLOBAL TRADER · Shipments',
    text: cards.join(`\n${DIVIDER}\n`) + `\n\nSelect a shipment for actions:`,
    options,
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  const chosen = shipments.find(s => s.id === result.value);
  const progress = await getShipmentProgress(chosen);

  let outcome: any;
  if (progress.stage === 'awaiting_clearance') {
    outcome = await runClearMenu(sock, message, chatId, userId, chosen);
  } else {
    await sock.sendMessage(chatId, {
      text: `${header()}\n📦 #${chosen.id} is still ${progress.label.toLowerCase()}. Nothing to do yet — check back later.`,
    });
    outcome = 'back';
  }

  if (outcome === 'back') return runShipmentsMenu(sock, message, chatId, userId);
  return outcome;
}

// ── Customs Clearance: animated, license-gated, hidden bribe odds ───────

async function runClearMenu(sock: any, message: any, chatId: string, userId: string, shipment: any) {
  const result = await promptMenu(sock, message, chatId, userId, {
    title: `🛃 Clear #${shipment.id}`,
    subtitle: `${shipment.goodLabel} (${shipment.countryLabel})`,
    text: 'How do you want to clear it?',
    options: [
      { label: 'Clear normally', value: 'plain', description: 'Pay standard duty' },
      { label: 'Clear + bribe', value: 'bribe', description: 'Extra cost — use if your license may have lapsed' },
    ],
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  const sent = await sock.sendMessage(chatId, {
    text: `${header()}\n📋 Checking documents...\n\n▓░░░░░░░░░`,
  });
  await delay(700);
  await sock.sendMessage(chatId, {
    text: `${header()}\n🪪 Verifying license status...\n\n▓▓▓▓▓░░░░░`,
    edit: sent.key,
  });
  await delay(900);

  const clearResult = await clearShipment(userId, shipment.id, { bribe: result.value === 'bribe' });

  if (clearResult.outcome === 'cleared') {
    await sock.sendMessage(chatId, {
      text:
        `✅ CLEARED\n${DIVIDER}\n` +
        `${header()}\n#${shipment.id} — ${shipment.goodLabel}\n${DIVIDER}\n` +
        `${shipment.qty}x released.\n` +
        `${deltaLine(-clearResult.dutyPaid)}${clearResult.bribePaid ? `\n${deltaLine(-clearResult.bribePaid)} (bribe)` : ''}`,
      edit: sent.key,
    });
    return; // terminal
  }

  await sock.sendMessage(chatId, {
    text:
      `🚨 SEIZED\n${DIVIDER}\n` +
      `${header()}\n#${shipment.id} — ${shipment.goodLabel}\n${DIVIDER}\n` +
      `❌ License expired — goods confiscated.\n` +
      `${deltaLine(-clearResult.fine)} (fine + forced renewal)\n` +
      `⏳ Release in ${clearResult.holdHours}h after processing.`,
    edit: sent.key,
  });
  // terminal
}

// ── Sell / Market ─────────────────────────────────────────────────────

async function runSellMenu(sock: any, message: any, chatId: string, userId: string) {
  const sellable = (await getActiveShipments(userId)).filter(s => s.stage === 'cleared_unsold');

  if (!sellable.length) {
    await sock.sendMessage(chatId, { text: `${header()}\n_Nothing cleared and ready to sell right now._` });
    return;
  }

  const result = await promptMenu(sock, message, chatId, userId, {
    title: '🏪 GLOBAL TRADER · Sell',
    text: 'Which shipment are you selling?',
    options: sellable.map(s => ({ label: `#${s.id} — ${s.goodLabel} (${s.qty})`, value: s.id })),
    cancelLabel: 'Back',
  });
  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  const shipment = sellable.find(s => s.id === result.value);
  const hubResult = await promptMenu(sock, message, chatId, userId, {
    title: `🏪 Sell #${shipment.id}`,
    text: 'Where?',
    options: [
      { label: 'Lagos (Port)', value: 'lagos', description: 'No extra cost, no risk' },
      { label: 'Onitsha', value: 'onitsha', description: 'Road courier required' },
      { label: 'Aba', value: 'aba', description: 'Road courier required' },
      { label: 'Kano', value: 'kano', description: 'Road courier required' },
      { label: 'Port Harcourt', value: 'ph', description: 'Road courier required' },
    ],
    cancelLabel: 'Back',
  });
  if (hubResult.cancelled) return runSellMenu(sock, message, chatId, userId); // back to shipment pick
  if (hubResult.timedOut || !hubResult.value) return;

  const sale = await sellGoods(userId, shipment.id, hubResult.value, shipment.qty);
  if (!sale.success) {
    await sock.sendMessage(chatId, { text: `${header()}\n❌ ${sale.reason}` });
    return;
  }

  await sock.sendMessage(chatId, {
    text:
      `${header()}\nSold: ${shipment.goodLabel} → ${sale.hubLabel}\n${DIVIDER}\n` +
      `${sale.qty} × ${formatNumber(sale.unitPrice)} = ${formatNumber(sale.gross)}\n` +
      `${deltaLine(sale.gross)}\n\n` +
      `Cost basis: ${formatNumber(sale.costBasis)}\n` +
      `Profit: ${deltaLine(sale.profit)} (${sale.marginPct > 0 ? '+' : ''}${sale.marginPct}%)`,
  });
  // terminal
}

// ── License & Rank ───────────────────────────────────────────────────

async function runLicenseMenu(sock: any, message: any, chatId: string, userId: string) {
  const rank = await getPlayerRank(userId);
  const licenses = await getLicenseStatus(userId);

  const lines = licenses.length
    ? licenses.map(l => {
        const hrsLeft = Math.round((l.expiresAt - Date.now()) / 3600000);
        const flag = hrsLeft <= 0 ? '❌ expired' : hrsLeft < 24 ? `⚠️ ${hrsLeft}h left` : `✅ ${Math.round(hrsLeft / 24)}d left`;
        return `${l.countryLabel} — ${flag}`;
      }).join('\n')
    : '_No licenses held yet._';

  const result = await promptMenu(sock, message, chatId, userId, {
    title: '🪪 GLOBAL TRADER · License',
    subtitle: `Rank: ${rank.label}`,
    text: `${lines}\n\nWhat next?`,
    options: [
      { label: 'Renew a license', value: 'renew' },
      { label: 'View rank progress', value: 'rank' },
    ],
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut) return;

  if (result.value === 'rank') {
    await sock.sendMessage(chatId, {
      text: `${header()}\nRank: *${rank.label}*\nLifetime profit: ${formatNumber(rank.lifetimeProfit)}\nNext rank at: ${formatNumber(rank.nextThreshold)}`,
    });
    return runLicenseMenu(sock, message, chatId, userId); // redisplay after viewing
  }

  if (result.value === 'renew') {
    if (!licenses.length) {
      await sock.sendMessage(chatId, { text: `${header()}\n_No licenses to renew yet._` });
      return runLicenseMenu(sock, message, chatId, userId);
    }
    const pick = await promptMenu(sock, message, chatId, userId, {
      title: '🪪 Renew which license?',
      text: 'Pick a country:',
      options: licenses.map(l => ({ label: l.countryLabel, value: l.countryKey, description: `Cost: ${formatNumber(l.renewCost)} coins` })),
      cancelLabel: 'Back',
    });
    if (pick.cancelled) return runLicenseMenu(sock, message, chatId, userId);
    if (pick.timedOut || !pick.value) return;

    const renewed = await renewLicense(userId, pick.value);
    await sock.sendMessage(chatId, {
      text: renewed.success
        ? `${header()}\n✅ Renewed for 7 days.\n${deltaLine(-renewed.cost)}`
        : `${header()}\n❌ ${renewed.reason}`,
    });
    // terminal
  }
}

// ── Wallet ────────────────────────────────────────────────────────────

async function sendWalletCard(sock: any, chatId: string, userId: string) {
  const wallet = await getWallet(userId);
  return sock.sendMessage(chatId, {
    text: `${header()}\n💰 Coins: *${formatNumber(wallet.coins)}*\n💎 Groq Coins: *${formatNumber(wallet.groqCoins)}*`,
  });
}

// ── Entry point ──────────────────────────────────────────────────────

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, senderId } = context;
  const userId = cleanJid(senderId);
  return runMainMenu(sock, message, chatId, userId);
}

export const handler = withEconomyGuard(_handler);