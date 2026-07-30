// @ts-nocheck
/***
 * plugins/oceanSlots.ts
 *
 * Ocean Hunt – WhatsApp Command Handler.
 * Commands: .ocean <bet> [shallow|deep|reef]
 *           .ocean shop
 *           .ocean buy <type> <tier>
 */

import { deductCoins, addCoins, getWallet, withEconomyGuard, formatNumber, EQUIPMENT_DEFS, getEquipmentDefs, buyEquipment, equipEquipment } from '../lib/economy.js';
import {
  resolveExpedition,
  contributeToJackpot,
  getJackpotPool,
  deductFromJackpot,
  incrementAndGetSpins,
  getConsecutiveLosses,
  incrementConsecutiveLosses,
  resetConsecutiveLosses,
  recordHouseActivity,
  recordPlayerActivity,
  recordPlayerJackpot,
  settleWin,
  JACKPOT_SEED,
} from '../lib/oceanSlotMachine.js';
import {
  getCurrentOceanState,
  getConditionSummary,
  getVolatilityLevel,
  getActiveEvents,
} from '../lib/oceanEcosystem.js';
import { validateExpedition, recordExpeditionOutcome } from '../lib/antiExploit.js';
import { cleanJid } from '../lib/isOwner.js';

export const command = 'oceanslots';
export const aliases = ['ocean', 'oslots', 'oceanhunt', 'fishhunt'];
export const category = 'economy-games';
export const cooldown = 3000;

const ALLOWED_BETS = [5, 20, 50, 100];
const STRATEGIES = ['shallow', 'deep', 'reef'] as const;
type Strategy = typeof STRATEGIES[number];

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, senderId, channelInfo } = context;
  const userId = cleanJid(senderId);

  // ── Shop command ──────────────────────────────────────────────────
  if (args[0] === 'shop') {
    const wallet = await getWallet(userId);
    const equip = wallet.equipment;
    const types = ['boat', 'net', 'bait'] as const;
    let text = '🐠 *OCEAN HUNT SHOP* 🐠\n\n';
    for (const type of types) {
      text += `*${type.toUpperCase()}*\n`;
      const defs = getEquipmentDefs(type);
      for (const def of defs) {
        const owned = (equip[type] === def.tier);
        const price = def.cost === 0 ? 'FREE' : `${formatNumber(def.cost)} coins`;
        const mods = def.modifiers;
        const modText = [];
        if (mods.emptyMod) modText.push(`empty ${Math.round((1 - mods.emptyMod)*100)}% ↓`);
        if (mods.predatorMod) modText.push(`predator ${Math.round((1 - mods.predatorMod)*100)}% ↓`);
        if (mods.rarityShift) modText.push(`rarity +${Math.round(mods.rarityShift*100)}%`);
        if (mods.treasureMod) modText.push(`treasure ${Math.round((mods.treasureMod - 1)*100)}% ↑`);
        if (mods.jackpotMod) modText.push(`jackpot ${Math.round((mods.jackpotMod - 1)*100)}% ↑`);
        if (mods.qualityBoost) modText.push(`quality +${Math.round(mods.qualityBoost*100)}%`);
        const equipped = owned ? ' ✅' : '';
        text += `  ${def.displayName}${equipped}: ${price} (${modText.join(', ')})`;
        if (owned) text += ' *equipped*';
        text += '\n';
      }
      text += '\n';
    }
    text += '\n_Use `.ocean buy <type> <tier>` to purchase._\n_Example: `.ocean buy boat speedBoat`_';
    return sock.sendMessage(chatId, { text, ...channelInfo }, { quoted: message });
  }

  // ── Buy command ──────────────────────────────────────────────────
  if (args[0] === 'buy' && args[1] && args[2]) {
    const type = args[1] as 'boat' | 'net' | 'bait';
    const tier = args[2];
    const result = await buyEquipment(userId, type, tier);
    if (result.success) {
      await equipEquipment(userId, type, tier);
      return sock.sendMessage(chatId, { text: `✅ You bought and equipped *${tier}*!`, ...channelInfo }, { quoted: message });
    } else {
      return sock.sendMessage(chatId, { text: `❌ ${result.reason || 'Failed to buy equipment.'}`, ...channelInfo }, { quoted: message });
    }
  }

  // ── Parse bet and strategy ──────────────────────────────────────
  const bet = parseInt(args[0], 10);
  let strategy: Strategy = 'reef';
  if (args[1] && STRATEGIES.includes(args[1] as Strategy)) {
    strategy = args[1] as Strategy;
  }

  // ── Show help if invalid bet ──────────────────────────────────
  if (!ALLOWED_BETS.includes(bet)) {
    const pool = await getJackpotPool();
    const state = await getCurrentOceanState();
    const { mood } = await getConditionSummary();
    const vol = await getVolatilityLevel();
    const events = await getActiveEvents();
    const eventText = events.length ? events.map(e => `${e.emoji} *${e.name}*`).join('  ') : 'No active events.';

    return sock.sendMessage(chatId, {
      text:
        `🐠 *OCEAN HUNT* 🐠\n\n` +
        `Usage: *.ocean <bet> [shallow|deep|reef]*\n` +
        `Allowed bets: ${ALLOWED_BETS.map(b => `*${b}*`).join(', ')}\n` +
        `Strategies: shallow (safe), deep (risky), reef (balanced)\n\n` +
        `🌊 *${state.name.toUpperCase()}* · 🌀 Volatility: *${vol.toUpperCase()}*\n` +
        `${mood}\n` +
        `💎 Jackpot: *${formatNumber(pool)} coins*\n` +
        `⚡ Events: ${eventText}\n\n` +
        `_Choose your strategy and cast your line!_`,
      ...channelInfo,
    }, { quoted: message });
  }

  // ── Anti-Exploit Validation ────────────────────────────────────
  const consecutiveLosses = await getConsecutiveLosses(userId);
  const { allowed, reason } = await validateExpedition(userId, bet, strategy, consecutiveLosses);
  if (!allowed) {
    return sock.sendMessage(chatId, {
      text: `❌ ${reason || 'Expedition blocked.'}`,
      ...channelInfo,
    }, { quoted: message });
  }

  // ── Deduct bet ─────────────────────────────────────────────────
  const deducted = await deductCoins(userId, bet, { type: 'slots' });
  if (!deducted.success) {
    return sock.sendMessage(chatId, {
      text: '❌ You don\'t have enough coins.',
      ...channelInfo,
    }, { quoted: message });
  }

  // ── Add bet to jackpot pool ──────────────────────────────────
  await contributeToJackpot(bet);
  const pool = await getJackpotPool();

  // ── Player stats ──────────────────────────────────────────────
  const expeditions = await incrementAndGetSpins(userId);

  // ── Resolve expedition ────────────────────────────────────────
  const outcome = await resolveExpedition(
    userId,
    bet,
    strategy,
    pool,
    consecutiveLosses,
    expeditions
  );

  // ── Handle outcome ────────────────────────────────────────────
  let winAmount = outcome.winAmount;
  let finalText = '';

  if (outcome.type === 'predator') {
    if (winAmount < 0) {
      const extraLoss = Math.abs(winAmount);
      const lossResult = await deductCoins(userId, extraLoss, { type: 'slots', note: 'predator loss' });
      if (!lossResult.success) winAmount = 0;
    }
    await incrementConsecutiveLosses(userId);
    finalText = `\n\n${outcome.emoji} ${outcome.narration}`;
  } else if (outcome.type === 'empty') {
    await incrementConsecutiveLosses(userId);
    finalText = `\n\n${outcome.emoji} ${outcome.narration}`;
  } else {
    // Win: fish, treasure, jackpot
    await resetConsecutiveLosses(userId);
    if (winAmount > 0) {
      const { payout, capped } = settleWin(winAmount, pool);
      const actualWin = payout;
      if (actualWin > 0) {
        await addCoins(userId, actualWin, { type: 'slots' });
        await deductFromJackpot(actualWin);
      }
      const winNote = capped ? ' (capped due to low reserve)' : '';
      finalText = `\n\n${outcome.emoji} ${outcome.narration}${winNote}`;
      if (outcome.type === 'jackpot') {
        await recordPlayerJackpot(userId);
      }
    } else {
      finalText = `\n\n${outcome.emoji} ${outcome.narration}`;
    }
  }

  // ── Record activity ────────────────────────────────────────────
  await recordHouseActivity(bet, Math.max(0, winAmount));
  await recordPlayerActivity(userId, bet, Math.max(0, winAmount));
  await recordExpeditionOutcome(
    userId,
    bet,
    strategy,
    outcome.type,
    winAmount,
    consecutiveLosses
  );

  // ── Wallet balance ─────────────────────────────────────────────
  const wallet = await getWallet(userId);

  // ── Build message ─────────────────────────────────────────────
  const state = await getCurrentOceanState();
  const vol = await getVolatilityLevel();
  const stateEmoji: Record<string, string> = {
    calm: '🌊', rich: '🐟', storm: '⛈️', deep_current: '🌊⬇️', migration: '🐠', treasure_tide: '💎', dangerous: '🦈', breeding: '🐣'
  };
  const events = await getActiveEvents();
  const eventHeader = events.length ? events.map(e => `${e.emoji} *${e.name}*`).join('  ') : '';

  const messageText =
    `🐠 *OCEAN HUNT* 🐠\n` +
    (eventHeader ? `⚡ ${eventHeader}\n` : '') +
    `🌍 *${state.name.toUpperCase()}* ${stateEmoji[state.name] || '🌊'}  🌀${vol.toUpperCase()}\n` +
    `Strategy: *${strategy.toUpperCase()}*  Bet: ${formatNumber(bet)} coins\n` +
    `💰 Balance: ${formatNumber(wallet.coins)} coins\n\n` +
    finalText;

  await sock.sendMessage(chatId, {
    text: messageText,
    ...channelInfo,
  }, { quoted: message });
}

export const handler = withEconomyGuard(_handler);