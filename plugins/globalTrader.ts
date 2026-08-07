// @ts-nocheck
/***
 * plugins/globalTrader.ts – UI with in‑transit event handling.
 */

import { promptMenu } from '../lib/menuSession.js';
import { getWallet, formatNumber, withEconomyGuard } from '../lib/economy.js';
import { cleanJid } from '../lib/isOwner.js';
import {
  COUNTRIES,
  FREIGHT_TIERS,
  GOODS,
  HUBS,
  getPlayerRank,
  getStockLevel,
  getActiveShipments,
  getShipmentProgress,
  sourceShipment,
  clearShipment,
  sellGoods,
  getLicenseStatus,
  renewLicense,
  getMarketPrice,
  getPendingEvents,
  resolveEvent,
  EVENT_CONFIG,
  EVENT_TYPES,
} from '../lib/globalTraderEconomy.js';

export const command = 'global';
export const aliases = ['trader', 'gt', 'trade', 'port', 'portking', 'pk'];
export const category = 'economy-games';
export const cooldown = 3000;

// ── Visual language ─────────────────────────────────────────────────

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

// ── Source Goods ─────────────────────────────────────────────────────

async function runSourceMenu(sock: any, message: any, chatId: string, userId: string) {
  const rank = await getPlayerRank(userId);
  const unlocked = COUNTRIES.filter(c => rank.unlockedCountries.includes(c.key));

  const options = await Promise.all(unlocked.map(async c => {
    const stock = await getStockLevel(c.key);
    const good = GOODS[c.goodKey];
    return {
      label: `${c.emoji} ${c.label}`,
      value: c.key,
      description: `${good.label} (${formatNumber(good.baseCost)} coins/unit) · ${stock.remaining}/${stock.cap} left today`,
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
}

// ── Shipments with Event Handling ──────────────────────────────────

async function runShipmentsMenu(sock: any, message: any, chatId: string, userId: string) {
  // First, get all active shipments and check for pending events
  const shipments = await getActiveShipments(userId);

  if (!shipments.length) {
    await sock.sendMessage(chatId, {
      text: `${header()}\n_No active shipments._\n\n_Use *Source Goods* from the main menu to start one._`,
    });
    return;
  }

  // Find any shipment with pending events (in‑transit)
  for (const s of shipments) {
    if (s.status === 'in_transit') {
      const pending = getPendingEvents(s);
      if (pending.length > 0) {
        // Handle the first event
        const handled = await runEventMenu(sock, message, chatId, userId, s, pending[0]);
        if (handled) {
          // After handling, re‑enter this function to show the updated list
          return runShipmentsMenu(sock, message, chatId, userId);
        } else {
          // Player cancelled or timed out – just go back to main menu
          return 'back';
        }
      }
    }
  }

  // No pending events – show the shipment list
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

// ── Event Menu ───────────────────────────────────────────────────────

async function runEventMenu(sock: any, message: any, chatId: string, userId: string, shipment: any, eventType: string) {
  const config = EVENT_CONFIG[eventType];
  if (!config) return false;

  const result = await promptMenu(sock, message, chatId, userId, {
    title: `⚠️ Shipment #${shipment.id} Event`,
    subtitle: `${shipment.goodLabel} (${shipment.countryLabel})`,
    text: `${config.description}\n\nCost: ${formatNumber(config.cost)} coins`,
    options: [
      { label: 'Pay', value: 'pay', description: `Spend ${formatNumber(config.cost)} to resolve` },
      { label: 'Decline', value: 'decline', description: 'Accept the consequences' },
    ],
    cancelLabel: 'Skip for now',
  });

  if (result.cancelled || result.timedOut) return false; // player wants to skip

  const resolution = await resolveEvent(userId, shipment.id, eventType, result.value);
  if (!resolution.success) {
    await sock.sendMessage(chatId, { text: `${header()}\n❌ ${resolution.reason}` });
    return false;
  }

  await sock.sendMessage(chatId, {
    text: `${header()}\n${resolution.outcome}`,
  });
  return true; // event handled, continue
}

// ── Customs Clearance ──────────────────────────────────────────────

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

  const renewalMsg = clearResult.renewalSucceeded
    ? `✅ License renewed (forced)`
    : `⚠️ License renewal failed — you must renew manually.`;
  await sock.sendMessage(chatId, {
    text:
      `🚨 SEIZED\n${DIVIDER}\n` +
      `${header()}\n#${shipment.id} — ${shipment.goodLabel}\n${DIVIDER}\n` +
      `❌ License expired — goods confiscated.\n` +
      `${deltaLine(-clearResult.fine)} (fine)\n` +
      `${renewalMsg}\n` +
      `⏳ Release in ${clearResult.holdHours}h after processing.`,
    edit: sent.key,
  });
}

// ── Sell Menu ───────────────────────────────────────────────────────

async function runSellMenu(sock: any, message: any, chatId: string, userId: string) {
  const sellable = (await getActiveShipments(userId)).filter(s => s.stage === 'cleared_unsold');

  if (!sellable.length) {
    await sock.sendMessage(chatId, { text: `${header()}\n_Nothing cleared and ready to sell right now._` });
    return;
  }

  const options = await Promise.all(sellable.map(async s => {
    const price = await getMarketPrice(s.goodKey, 'lagos');
    const gross = Math.round(price * s.qty * (s.quality || 1));
    return {
      label: `#${s.id} — ${s.goodLabel} (${s.qty})`,
      value: s.id,
      description: `Est. @Lagos: ${formatNumber(price)}/unit → ${formatNumber(gross)} gross`,
    };
  }));

  const result = await promptMenu(sock, message, chatId, userId, {
    title: '🏪 GLOBAL TRADER · Sell',
    text: 'Which shipment are you selling?',
    options,
    cancelLabel: 'Back',
  });
  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  const shipment = sellable.find(s => s.id === result.value);
  const good = GOODS[shipment.goodKey];

  const hubOptions = await Promise.all(
    HUBS.map(async hub => {
      const price = await getMarketPrice(good.key, hub.key);
      const gross = Math.round(price * shipment.qty * (shipment.quality || 1));
      const desc = `${hub.courierRequired ? '🚚 courier fee incl.' : '🛳 port'} · ${formatNumber(price)}/unit → ${formatNumber(gross)} gross`;
      return { label: hub.label, value: hub.key, description: desc };
    })
  );

  const hubResult = await promptMenu(sock, message, chatId, userId, {
    title: `🏪 Sell #${shipment.id}`,
    text: 'Where?',
    options: hubOptions,
    cancelLabel: 'Back',
  });
  if (hubResult.cancelled) return runSellMenu(sock, message, chatId, userId);
  if (hubResult.timedOut || !hubResult.value) return;

  const sale = await sellGoods(userId, shipment.id, hubResult.value, shipment.qty);
  if (!sale.success) {
    await sock.sendMessage(chatId, { text: `${header()}\n❌ ${sale.reason}` });
    return;
  }

  let lossNote = '';
  if (sale.qty < shipment.qty) {
    lossNote = `\n_Note: ${shipment.qty - sale.qty} units lost to spoilage/courier – cost included in basis._`;
  }
  await sock.sendMessage(chatId, {
    text:
      `${header()}\nSold: ${shipment.goodLabel} → ${sale.hubLabel}\n${DIVIDER}\n` +
      `${sale.qty} × ${formatNumber(sale.unitPrice)} = ${formatNumber(sale.gross)}\n` +
      `${deltaLine(sale.gross)}\n\n` +
      `Cost basis: ${formatNumber(sale.costBasis)}\n` +
      `Profit: ${deltaLine(sale.profit)} (${sale.marginPct > 0 ? '+' : ''}${sale.marginPct}%)` +
      lossNote,
  });
}

// ── License Menu ────────────────────────────────────────────────────

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
      { label: 'Buy new license', value: 'buy', description: 'Purchase a license for an unlocked country' },
      { label: 'Renew a license', value: 'renew', description: 'Extend an existing license' },
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
    return runLicenseMenu(sock, message, chatId, userId);
  }

  if (result.value === 'buy') {
    const unlockedCountries = COUNTRIES.filter(c => rank.unlockedCountries.includes(c.key));
    const validKeys = new Set(
      licenses.filter(l => l.expiresAt > Date.now()).map(l => l.countryKey)
    );
    const buyable = unlockedCountries.filter(c => !validKeys.has(c.key));

    if (!buyable.length) {
      await sock.sendMessage(chatId, {
        text: `${header()}\n✅ You already have valid licenses for all your unlocked countries.`,
      });
      return runLicenseMenu(sock, message, chatId, userId);
    }

    const pick = await promptMenu(sock, message, chatId, userId, {
      title: '🪪 Buy new license',
      text: 'Choose a country to buy a 7‑day license for:',
      options: buyable.map(c => ({
        label: `${c.emoji} ${c.label}`,
        value: c.key,
        description: `Cost: ${formatNumber(c.licenseRenewCost)} coins`,
      })),
      cancelLabel: 'Back',
    });

    if (pick.cancelled) return runLicenseMenu(sock, message, chatId, userId);
    if (pick.timedOut || !pick.value) return;

    const bought = await renewLicense(userId, pick.value, false);
    await sock.sendMessage(chatId, {
      text: bought.success
        ? `${header()}\n✅ License for ${pick.value} bought! Expires in 7 days.\n${deltaLine(-bought.cost)}`
        : `${header()}\n❌ ${bought.reason}`,
    });
    return runLicenseMenu(sock, message, chatId, userId);
  }

  if (result.value === 'renew') {
    if (!licenses.length) {
      await sock.sendMessage(chatId, { text: `${header()}\n_No licenses to renew yet._` });
      return runLicenseMenu(sock, message, chatId, userId);
    }
    const pick = await promptMenu(sock, message, chatId, userId, {
      title: '🪪 Renew which license?',
      text: 'Pick a country:',
      options: licenses.map(l => ({
        label: l.countryLabel,
        value: l.countryKey,
        description: `Cost: ${formatNumber(l.renewCost)} coins`,
      })),
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