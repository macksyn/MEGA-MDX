// @ts-nocheck
/***
 * plugins/globalTrader.ts – UI layer for Global Trader.
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
  buyLicense,
  renewLicense,
  getMarketPrice,
  getPendingEvents,
  resolveEvent,
  getEventCost,
  getEventDescription,
  EVENT_TYPES,
  getEventsStatusBlock,
  getEventsDetailBlock,
  CLEARING_AGENT_DEFS,
  WAREHOUSE_DEFS,
  getEquipment,
  buyEquipment,
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
  const events = await getEventsStatusBlock();

  const result = await promptMenu(sock, message, chatId, userId, {
    title: '🌍 GLOBAL TRADER',
    subtitle: `${rank.emoji} Rank: ${rank.label}  ·  💰 ${formatNumber(wallet.coins)} coins${events ? `\n${events}` : ''}`,
    text: 'What would you like to do?',
    options: [
      { label: 'Source Goods', value: 'source', description: 'Buy from a supplier country' },
      { label: 'My Shipments', value: 'shipments', description: 'Track everything in transit' },
      { label: 'Sell / Market', value: 'sell', description: 'Cash out cleared goods' },
      { label: 'License & Rank', value: 'license', description: 'Check expiry, renew, view rank' },
      { label: 'Upgrades', value: 'upgrades', description: 'Clearing Agent & Warehouse tiers' },
      { label: 'Wallet', value: 'wallet' },
      { label: 'Market Conditions', value: 'conditions', description: events ? '⚡ Active events affecting trade' : 'All quiet right now' },
    ],
    cancelLabel: 'Exit',
  });

  if (result.cancelled || result.timedOut) return;

  let outcome: any;
  switch (result.value) {
    case 'source':     outcome = await runSourceMenu(sock, message, chatId, userId); break;
    case 'shipments':  outcome = await runShipmentsMenu(sock, message, chatId, userId); break;
    case 'sell':       outcome = await runSellMenu(sock, message, chatId, userId); break;
    case 'license':    outcome = await runLicenseMenu(sock, message, chatId, userId); break;
    case 'upgrades':   outcome = await runUpgradesMenu(sock, message, chatId, userId); break;
    case 'wallet':     await sendWalletCard(sock, chatId, userId); outcome = 'back'; break;
    case 'conditions': await sendMarketConditions(sock, chatId); outcome = 'back'; break;
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
      description: `${good.label} (${formatNumber(good.baseCost)} coins/unit) · ${stock.remaining}/${stock.cap} left today\n     ${good.traitLine}`,
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
    title: `🚢 ${country.emoji} ${country.label} · Choose Carrier`,
    text: 'Select a shipping company:',
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
  const freight = FREIGHT_TIERS.find(f => f.key === freightKey);

  const options = QUANTITY_PRESETS
    .filter(q => q <= stock.remaining)
    .map(q => {
      const containers = Math.ceil(q / country.containerCapacity);
      const freightCost = Math.round(country.baseFreightFee * freight.costMult * containers);
      return {
        label: `${q} units`,
        value: String(q),
        description: `${containers} container${containers > 1 ? 's' : ''} · ${formatNumber(freightCost)} freight`,
      };
    });

  if (!options.length) {
    await sock.sendMessage(chatId, {
      text: `${header()}\n❌ Not enough stock left today for ${country.label}.\n_Try again after tomorrow's reset._`,
    });
    return;
  }

  const result = await promptMenu(sock, message, chatId, userId, {
    title: `📦 ${country.label} · Quantity`,
    subtitle: `Stock left today: ${stock.remaining}/${stock.cap}  ·  1 container = ${country.containerCapacity} units`,
    text: 'How many units?',
    options,
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  const qty = parseInt(result.value, 10);

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
      `Qty: ${qty}  ·  Carrier: ${freight.label}  ·  ${s.containersUsed} container${s.containersUsed > 1 ? 's' : ''}\n` +
      `${DIVIDER}\n` +
      `Goods: ${formatNumber(s.goodsCost)}  +  Freight: ${formatNumber(s.freightCost)}\n` +
      `${deltaLine(-s.totalCost)}\n` +
      `ETA: ${s.etaLabel}\n\n` +
      `_Track it anytime from the main menu → My Shipments_`,
  });
}

// ── Shipments with Event Handling ──────────────────────────────────

async function runShipmentsMenu(sock: any, message: any, chatId: string, userId: string) {
  const shipments = await getActiveShipments(userId);

  if (!shipments.length) {
    await sock.sendMessage(chatId, {
      text: `${header()}\n_No active shipments._\n\n_Use *Source Goods* from the main menu to start one._`,
    });
    return;
  }

  // BUG FIX: this used to intercept BEFORE rendering anything — if any
  // in-transit shipment had a pending event, the player couldn't see their
  // tracker at all until they resolved it, and skipping via "0" left it
  // pending forever, permanently re-blocking the screen on every visit.
  // Now the tracker always renders; a pending event just shows as a flag
  // on that shipment's card, and picking that shipment surfaces the event.
  const pendingByShipment = new Map<string, string>();
  for (const s of shipments) {
    if (s.status === 'in_transit') {
      const pending = getPendingEvents(s);
      if (pending.length > 0) pendingByShipment.set(s.id, pending[0]);
    }
  }

  const cards = await Promise.all(shipments.map(async s => {
    const p = await getShipmentProgress(s);
    const emoji = STAGE_EMOJI[p.stage] || '📦';
    const bar = progressBar(p.pct, 100);
    const hasEvent = pendingByShipment.has(s.id);
    const clearHint = p.stage === 'awaiting_clearance' ? `\n_Ready — pick this shipment below to clear it_` : '';
    const eventHint = hasEvent ? `\n⚠️ _Action needed — pick this shipment below_` : '';
    return `📦 #${s.id} — ${s.goodLabel} (${s.countryLabel})\n${emoji} ${p.label}\n${bar}  ${p.pct}%${clearHint}${eventHint}`;
  }));

  const options = shipments.map(s => ({
    label: `#${s.id} — ${s.goodLabel}${pendingByShipment.has(s.id) ? ' ⚠️' : ''}`,
    value: s.id,
  }));

  const equip = await getEquipment(userId);
  const activeCount = shipments.filter(s => s.stage === 'in_transit' || s.stage === 'awaiting_clearance' || s.stage === 'cleared_unsold').length;

  const result = await promptMenu(sock, message, chatId, userId, {
    title: '🚛 GLOBAL TRADER · Shipments',
    subtitle: `Warehouse: ${activeCount}/${equip.warehouse.capacity} slots used`,
    text: cards.join(`\n${DIVIDER}\n`) + `\n\nSelect a shipment for actions:`,
    options,
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  const chosen = shipments.find(s => s.id === result.value);

  let outcome: any;
  if (pendingByShipment.has(chosen.id)) {
    const handled = await runEventMenu(sock, message, chatId, userId, chosen, pendingByShipment.get(chosen.id)!);
    outcome = 'back'; // whether resolved or skipped, return to the tracker — never eject to main menu
    void handled;
  } else {
    const progress = await getShipmentProgress(chosen);
    if (progress.stage === 'awaiting_clearance') {
      outcome = await runClearMenu(sock, message, chatId, userId, chosen);
    } else {
      await sock.sendMessage(chatId, {
        text: `${header()}\n📦 #${chosen.id} is still ${progress.label.toLowerCase()}. Nothing to do yet — check back later.`,
      });
      outcome = 'back';
    }
  }

  if (outcome === 'back') return runShipmentsMenu(sock, message, chatId, userId);
  return outcome;
}

// ── Event Menu ───────────────────────────────────────────────────────

async function runEventMenu(sock: any, message: any, chatId: string, userId: string, shipment: any, eventType: string) {
  const cost = getEventCost(shipment, eventType);
  const description = getEventDescription(shipment, eventType);

  const result = await promptMenu(sock, message, chatId, userId, {
    title: `⚠️ Shipment #${shipment.id} Event`,
    subtitle: `${shipment.goodLabel} (${shipment.countryLabel})`,
    text: description,
    options: [
      { label: 'Pay', value: 'pay', description: `Spend ${formatNumber(cost)} to resolve` },
      { label: 'Decline', value: 'decline', description: 'Accept the consequences' },
    ],
    cancelLabel: 'Decide later',
  });

  if (result.cancelled || result.timedOut) return false;

  const resolution = await resolveEvent(userId, shipment.id, eventType, result.value);
  if (!resolution.success) {
    await sock.sendMessage(chatId, { text: `${header()}\n❌ ${resolution.reason}` });
    return false;
  }

  await sock.sendMessage(chatId, {
    text: `${header()}\n${resolution.outcome}`,
  });
  return true;
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
    return;
  }

  const renewalMsg = clearResult.renewalSucceeded
    ? `✅ License renewed (forced)\n${deltaLine(-clearResult.forcedRenewalCost)}`
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

  const events = await getEventsStatusBlock();
  const result = await promptMenu(sock, message, chatId, userId, {
    title: '🏪 GLOBAL TRADER · Sell',
    subtitle: events || undefined,
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
      const isRestricted = !!(hub.bannedGoods && hub.bannedGoods.includes(good.key));
      const price = await getMarketPrice(good.key, hub.key);
      if (isRestricted) {
        const bonusPrice = Math.round(price * good.blackMarketPriceBonus);
        const bonusGross = Math.round(bonusPrice * shipment.qty * (shipment.quality || 1));
        const seizurePct = Math.round(good.blackMarketSeizureChance * 100);
        return {
          label: `${hub.label} ⚠️ black market`,
          value: hub.key,
          description: `Restricted here — ~${seizurePct}% confiscation risk, but ${formatNumber(bonusGross)} gross if it clears`,
        };
      }
      const gross = Math.round(price * shipment.qty * (shipment.quality || 1));
      const desc = `${hub.courierRequired ? `🚚 ${hub.courierName} fee incl.` : '🛳 port'} · ${formatNumber(price)}/unit → ${formatNumber(gross)} gross`;
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
      `${header()}\n${sale.blackMarket ? '⚠️ Black-market sale — ' : ''}Sold: ${shipment.goodLabel} → ${sale.hubLabel}\n${DIVIDER}\n` +
      `${sale.courierNote ? `🚚 _${sale.courierNote}_\n` : ''}` +
      `${sale.qty} × ${formatNumber(sale.unitPrice)} = ${formatNumber(sale.gross)}\n` +
      `${deltaLine(sale.gross)}\n\n` +
      `Cost basis: ${formatNumber(sale.costBasis)}` +
      `${sale.holdingFee ? `\n_warehouse storage: -${formatNumber(sale.holdingFee)}_` : ''}\n` +
      `Profit: ${deltaLine(sale.profit)} (${sale.marginPct > 0 ? '+' : ''}${sale.marginPct}%)` +
      lossNote,
  });
}

// ── License Menu ────────────────────────────────────────────────────

async function runLicenseMenu(sock: any, message: any, chatId: string, userId: string) {
  const rank = await getPlayerRank(userId);
  const licenses = await getLicenseStatus(userId);

  const lines = licenses.map(l => {
    const status = l.hasLicense
      ? l.isValid
        ? `✅ valid`
        : `❌ expired`
      : `⭕ no license`;
    const eligibility = l.isEligible ? '' : ' 🔒 (not yet unlocked)';
    return `${l.tierLabel}\n  Countries: ${l.countries}\n  Cost: ${formatNumber(l.cost)} · ${status}${eligibility}`;
  }).join('\n' + DIVIDER + '\n');

  const result = await promptMenu(sock, message, chatId, userId, {
    title: '🪪 GLOBAL TRADER · License',
    subtitle: `${rank.emoji} Rank: ${rank.label}`,
    text: `${lines}\n\nWhat next?`,
    options: [
      { label: 'Buy / Renew license', value: 'buy', description: 'Purchase or extend a license for your rank tier' },
      { label: 'View rank progress', value: 'rank' },
    ],
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut) return;

  if (result.value === 'rank') {
    let nextInfo = '';
    if (rank.nextThreshold !== null) {
      nextInfo = `\n\nNext rank: *${rank.nextThreshold ? formatNumber(rank.nextThreshold) : 'unlocked'}* net profit`;
      if (rank.nextVolumeThreshold && rank.nextMinNetProfitForVolume) {
        nextInfo += `\n_or ${formatNumber(rank.nextVolumeThreshold)} volume + ${formatNumber(rank.nextMinNetProfitForVolume)} net profit_`;
      }
    }
    await sock.sendMessage(chatId, {
      text: `${header()}\n${rank.emoji} Rank: *${rank.label}*\nNet profit: ${formatNumber(rank.lifetimeNetProfit)}\nTrading volume: ${formatNumber(rank.lifetimeTradingVolume)}${nextInfo}`,
    });
    return runLicenseMenu(sock, message, chatId, userId);
  }

  if (result.value === 'buy') {
    const eligibleTiers = licenses.filter(l => l.isEligible);
    const validKeys = new Set(licenses.filter(l => l.isValid).map(l => l.tierKey));

    if (!eligibleTiers.length) {
      await sock.sendMessage(chatId, {
        text: `${header()}\n🔒 You haven't unlocked any license tiers yet. Keep trading!`,
      });
      return runLicenseMenu(sock, message, chatId, userId);
    }

    const pick = await promptMenu(sock, message, chatId, userId, {
      title: '🪪 Buy / Renew license',
      text: 'Choose a license tier to buy or renew:',
      options: eligibleTiers.map(l => {
        const status = l.hasLicense ? (l.isValid ? '✅ valid' : '⚠️ expired – renew') : '⭕ buy new';
        return {
          label: l.tierLabel,
          value: l.tierKey,
          description: `${status} · ${formatNumber(l.cost)} coins · ${l.countries}`,
        };
      }),
      cancelLabel: 'Back',
    });

    if (pick.cancelled) return runLicenseMenu(sock, message, chatId, userId);
    if (pick.timedOut || !pick.value) return;

    const tier = licenses.find(l => l.tierKey === pick.value);
    if (!tier) return;

    const action = tier.hasLicense && tier.isValid
      ? await renewLicense(userId, pick.value as any, false)
      : await buyLicense(userId, pick.value as any);

    await sock.sendMessage(chatId, {
      text: action.success
        ? `${header()}\n✅ ${tier.tierLabel} ${tier.hasLicense ? 'renewed' : 'bought'}! Expires in 7 days.\n${deltaLine(-action.cost!)}`
        : `${header()}\n❌ ${action.reason}`,
    });
    return runLicenseMenu(sock, message, chatId, userId);
  }
}

// ── Upgrades: Clearing Agent & Warehouse ────────────────────────────────
// This entire section was missing from the last build — restoring it here,
// same numbered-menu + back-nav pattern as everywhere else.

async function runUpgradesMenu(sock: any, message: any, chatId: string, userId: string) {
  const equip = await getEquipment(userId);

  const result = await promptMenu(sock, message, chatId, userId, {
    title: '🛠️ GLOBAL TRADER · Upgrades',
    subtitle: `Agent: ${equip.agent.displayName}  ·  Warehouse: ${equip.warehouse.displayName}`,
    text: 'What do you want to upgrade?',
    options: [
      { label: 'Clearing Agent', value: 'agent', description: 'Better bribe odds, smaller fines if seized' },
      { label: 'Warehouse', value: 'warehouse', description: 'More concurrent shipments, slower spoilage, cheaper holding fees' },
    ],
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  const outcome = result.value === 'agent'
    ? await runAgentShop(sock, message, chatId, userId, equip)
    : await runWarehouseShop(sock, message, chatId, userId, equip);

  if (outcome === 'back') return runUpgradesMenu(sock, message, chatId, userId);
  return outcome;
}

async function runAgentShop(sock: any, message: any, chatId: string, userId: string, equip: any) {
  const options = CLEARING_AGENT_DEFS.map(a => ({
    label: a.displayName,
    value: a.tier,
    description: a.cost === 0
      ? `FREE · +${Math.round(a.bribeSuccessBonus * 100)}% bribe odds`
      : `${formatNumber(a.cost)} coins · +${Math.round(a.bribeSuccessBonus * 100)}% bribe odds · fine -${Math.round(a.fineMultReduction * 100)}%`,
  }));

  const result = await promptMenu(sock, message, chatId, userId, {
    title: '🕵️ Clearing Agent',
    subtitle: `Currently: ${equip.agent.displayName}`,
    text: 'Pick a tier to equip:',
    options,
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  if (result.value === equip.tiers.clearingAgent) {
    await sock.sendMessage(chatId, { text: `${header()}\n_Already equipped._` });
    return runAgentShop(sock, message, chatId, userId, equip);
  }

  const purchase = await buyEquipment(userId, 'clearingAgent', result.value);
  if (!purchase.success) {
    await sock.sendMessage(chatId, { text: `${header()}\n❌ ${purchase.reason}` });
    return runAgentShop(sock, message, chatId, userId, await getEquipment(userId));
  }

  await sock.sendMessage(chatId, {
    text: `${header()}\n✅ Equipped *${purchase.def.displayName}*!\n${deltaLine(-purchase.def.cost)}`,
  });
}

async function runWarehouseShop(sock: any, message: any, chatId: string, userId: string, equip: any) {
  const options = WAREHOUSE_DEFS.map(w => ({
    label: w.displayName,
    value: w.tier,
    description: w.cost === 0
      ? `FREE · ${w.capacity} concurrent · ${w.freeHoldingDays}d free storage`
      : `${formatNumber(w.cost)} coins · ${w.capacity} concurrent · ${w.freeHoldingDays}d free storage`,
  }));

  const result = await promptMenu(sock, message, chatId, userId, {
    title: '🏭 Warehouse',
    subtitle: `Currently: ${equip.warehouse.displayName}`,
    text: 'Pick a tier to equip:',
    options,
    cancelLabel: 'Back',
  });

  if (result.cancelled) return 'back';
  if (result.timedOut || !result.value) return;

  if (result.value === equip.tiers.warehouse) {
    await sock.sendMessage(chatId, { text: `${header()}\n_Already equipped._` });
    return runWarehouseShop(sock, message, chatId, userId, equip);
  }

  const purchase = await buyEquipment(userId, 'warehouse', result.value);
  if (!purchase.success) {
    await sock.sendMessage(chatId, { text: `${header()}\n❌ ${purchase.reason}` });
    return runWarehouseShop(sock, message, chatId, userId, await getEquipment(userId));
  }

  await sock.sendMessage(chatId, {
    text: `${header()}\n✅ Equipped *${purchase.def.displayName}*!\n${deltaLine(-purchase.def.cost)}`,
  });
}

// ── Wallet ────────────────────────────────────────────────────────────

async function sendWalletCard(sock: any, chatId: string, userId: string) {
  const wallet = await getWallet(userId);
  return sock.sendMessage(chatId, {
    text: `${header()}\n💰 Coins: *${formatNumber(wallet.coins)}*\n💎 Groq Coins: *${formatNumber(wallet.groqCoins)}*`,
  });
}

async function sendMarketConditions(sock: any, chatId: string) {
  const detail = await getEventsDetailBlock();
  return sock.sendMessage(chatId, {
    text: `${header('📊 Market Conditions')}\n${detail}`,
  });
}

// ── Entry point ──────────────────────────────────────────────────────

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, senderId } = context;
  const userId = cleanJid(senderId);
  return runMainMenu(sock, message, chatId, userId);
}

export const handler = withEconomyGuard(_handler);