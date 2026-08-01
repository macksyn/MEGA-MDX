// @ts-nocheck
/***
 * plugins/oceanSlots.ts
 *
 * Ocean Hunt – WhatsApp Command Handler.
 * Commands: .ocean <bet> [shallow|deep|reef]
 *           .ocean shop
 *           .ocean buy <type> <tier>
 *
 * Features:
 * - Spinning animation with staged captions
 * - Poetic one‑line narration
 * - Card-style result summary with quality stars, win/loss deltas, and
 *   Big/Mega/Super Mega/Jackpot banners
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

// ── Visual language ─────────────────────────────────────────────────────
// A small set of shared building blocks so every screen (help, shop, spin,
// result) reads as one consistent "card" instead of a wall of text.

const DIVIDER = '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈';

function header(subtitle?: string): string {
  return `🌊 *OCEAN HUNT* 🌊${subtitle ? `\n${subtitle}` : ''}\n${DIVIDER}`;
}

/** Cosmetic progress bar, e.g. for the jackpot pool. Purely visual. */
function progressBar(value: number, max: number, size = 10): string {
  const filled = Math.max(0, Math.min(size, Math.round((value / max) * size)));
  return '▰'.repeat(filled) + '▱'.repeat(size - filled);
}

const JACKPOT_BAR_MAX = JACKPOT_SEED * 6;

const STATE_EMOJI: Record<string, string> = {
  calm: '🌊', rich: '🐟', storm: '⛈️', deep_current: '🌊⬇️',
  migration: '🐠', treasure_tide: '💎', dangerous: '🦈', breeding: '🐣',
};

const QUALITY_STARS: Record<string, string> = {
  damaged: '★☆☆☆☆',
  common: '★★☆☆☆',
  healthy: '★★★☆☆',
  premium: '★★★★☆',
  legendary: '★★★★★',
};

const STRATEGY_EMOJI: Record<Strategy, string> = {
  shallow: '🛟',
  reef: '⚖️',
  deep: '🌊',
};

function deltaLine(amount: number): string {
  if (amount > 0) return `▲ *+${formatNumber(amount)}* coins`;
  if (amount < 0) return `▼ *-${formatNumber(Math.abs(amount))}* coins`;
  return `• No change`;
}

async function oceanStatusBlock(): Promise<string> {
  const state = await getCurrentOceanState();
  const vol = await getVolatilityLevel();
  const events = await getActiveEvents();
  const eventLine = events.length
    ? `⚡ ${events.map(e => `${e.emoji} *${e.name}*`).join('   ')}`
    : '';
  const lines = [
    `${STATE_EMOJI[state.name] || '🌊'} *${state.name.replace('_', ' ').toUpperCase()}*   ·   🌀 Volatility: *${vol.toUpperCase()}*`,
  ];
  if (eventLine) lines.push(eventLine);
  return lines.join('\n');
}

// ── Animation stages ──────────────────────────────────────────────────
const SPIN_STAGES = [
  { bar: '🌊▫️▫️▫️▫️', caption: 'Casting your line...' },
  { bar: '🌊🎣▫️▫️▫️', caption: 'Line hits the water...' },
  { bar: '🌊🎣〰️▫️▫️', caption: 'Something stirs below...' },
  { bar: '🌊🎣〰️🐟▫️', caption: "You feel a tug!" },
  { bar: '🌊🎣〰️🐟✨', caption: 'Reeling it in...' },
];
const SPIN_FRAME_DELAY_MS = 550;

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, senderId, channelInfo } = context;
  const userId = cleanJid(senderId);

  // ── Shop command ──────────────────────────────────────────────────
  if (args[0] === 'shop') {
    const wallet = await getWallet(userId);
    const equip = wallet.equipment;
    const types = [
      { key: 'boat', label: 'BOATS', emoji: '🚤' },
      { key: 'net', label: 'NETS', emoji: '🕸️' },
      { key: 'bait', label: 'BAIT', emoji: '🪱' },
    ] as const;

    let text = `${header()}\n`;
    for (const { key: type, label, emoji } of types) {
      text += `${emoji} *${label}*\n`;
      const defs = getEquipmentDefs(type);
      for (const def of defs) {
        const owned = (equip[type] === def.tier);
        const price = def.cost === 0 ? 'FREE' : `${formatNumber(def.cost)} coins`;
        const mods = def.modifiers;
        const modText = [];
        if (mods.emptyMod) modText.push(`empty ${Math.round((1 - mods.emptyMod) * 100)}%↓`);
        if (mods.predatorMod) modText.push(`predator ${Math.round((1 - mods.predatorMod) * 100)}%↓`);
        if (mods.rarityShift) modText.push(`rarity +${Math.round(mods.rarityShift * 100)}%`);
        if (mods.treasureMod) modText.push(`treasure +${Math.round((mods.treasureMod - 1) * 100)}%`);
        if (mods.jackpotMod) modText.push(`jackpot +${Math.round((mods.jackpotMod - 1) * 100)}%`);
        if (mods.qualityBoost) modText.push(`quality +${Math.round(mods.qualityBoost * 100)}%`);

        const bullet = owned ? '✅' : '▫️';
        text += ` ${bullet} *${def.displayName}* — ${price}\n`;
        if (modText.length) text += `     ↳ _${modText.join(' · ')}_\n`;
        if (owned) text += `     ↳ _currently equipped_\n`;
      }
      text += `${DIVIDER}\n`;
    }
    text += `🛒 \`.ocean buy <type> <tier>\`\n   _e.g. .ocean buy boat speedBoat_`;
    return sock.sendMessage(chatId, { text, ...channelInfo }, { quoted: message });
  }

  // ── Buy command ──────────────────────────────────────────────────
  if (args[0] === 'buy' && args[1] && args[2]) {
    const type = args[1] as 'boat' | 'net' | 'bait';
    const tier = args[2];
    const result = await buyEquipment(userId, type, tier);
    if (result.success) {
      await equipEquipment(userId, type, tier);
      return sock.sendMessage(chatId, {
        text: `${header()}\n✅ Bought and equipped *${tier}*!\n_Time to put it to work — \`.ocean <bet>\`_`,
        ...channelInfo,
      }, { quoted: message });
    } else {
      return sock.sendMessage(chatId, {
        text: `${header()}\n❌ ${result.reason || 'Failed to buy equipment.'}`,
        ...channelInfo,
      }, { quoted: message });
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
    const statusBlock = await oceanStatusBlock();

    return sock.sendMessage(chatId, {
      text:
        `${header()}\n` +
        `${statusBlock}\n` +
        `💎 Jackpot Pool  ${progressBar(pool, JACKPOT_BAR_MAX)}  ${formatNumber(pool)} coins\n` +
        `${DIVIDER}\n` +
        `🎣 *HOW TO PLAY*\n` +
        `\`.ocean <bet> [strategy]\`\n\n` +
        `  Bets       ${ALLOWED_BETS.map(b => `*${b}*`).join(' · ')}\n` +
        `  🛟 shallow   safer, smaller catches\n` +
        `  ⚖️ reef      balanced _(default)_\n` +
        `  🌊 deep      riskier, bigger catches\n` +
        `${DIVIDER}\n` +
        `🛍️ \`.ocean shop\` — gear up your boat, net & bait\n\n` +
        `_Choose your strategy and cast your line!_`,
      ...channelInfo,
    }, { quoted: message });
  }

  // ── Anti-Exploit Validation ────────────────────────────────────
  const consecutiveLosses = await getConsecutiveLosses(userId);
  const { allowed, reason } = await validateExpedition(userId, bet, strategy, consecutiveLosses);
  if (!allowed) {
    return sock.sendMessage(chatId, {
      text: `${header()}\n❌ ${reason || 'Expedition blocked.'}`,
      ...channelInfo,
    }, { quoted: message });
  }

  // ── Deduct bet ─────────────────────────────────────────────────
  const deducted = await deductCoins(userId, bet, { type: 'slots' });
  if (!deducted.success) {
    return sock.sendMessage(chatId, {
      text: `${header()}\n❌ You don't have enough coins for that bet.`,
      ...channelInfo,
    }, { quoted: message });
  }

  // ── Add bet to jackpot pool ──────────────────────────────────
  await contributeToJackpot(bet);
  const pool = await getJackpotPool();

  // ── Player stats ──────────────────────────────────────────────
  const expeditions = await incrementAndGetSpins(userId);

  // ── Start animation ────────────────────────────────────────────
  const sent = await sock.sendMessage(chatId, {
    text: `${header()}\n${SPIN_STAGES[0].caption}\n\n${SPIN_STAGES[0].bar}`,
    ...channelInfo,
  }, { quoted: message });

  for (let i = 1; i < SPIN_STAGES.length; i++) {
    await delay(SPIN_FRAME_DELAY_MS);
    await sock.sendMessage(chatId, {
      text: `${header()}\n${SPIN_STAGES[i].caption}\n\n${SPIN_STAGES[i].bar}`,
      edit: sent.key,
      ...channelInfo,
    });
  }
  await delay(SPIN_FRAME_DELAY_MS);

  // ── Resolve expedition ────────────────────────────────────────
  const outcome = await resolveExpedition(
    userId,
    bet,
    strategy,
    pool,
    consecutiveLosses,
    expeditions
  );

  // ── Handle outcome & calculate result ────────────────────────
  let winAmount = outcome.winAmount;
  let catchLine = '';   // e.g. "🐋 Legendary Swordfish  ★★★★★"
  let resultLine = '';  // the win/loss delta line

  let predatorExtraLoss = 0;
  if (outcome.type === 'predator') {
    if (winAmount < 0) {
      const extraLoss = Math.abs(winAmount);
      const lossResult = await deductCoins(userId, extraLoss, { type: 'slots', note: 'predator loss' });
      if (lossResult.success) {
        // The bite is a real loss for the player — it becomes real bank
        // capital the same way the original bet did, instead of vanishing
        // from the economy untracked.
        await contributeToJackpot(extraLoss);
        predatorExtraLoss = extraLoss;
      } else {
        winAmount = 0;
      }
    }
    await incrementConsecutiveLosses(userId);
    resultLine = deltaLine(winAmount);
  } else if (outcome.type === 'empty') {
    await incrementConsecutiveLosses(userId);
    resultLine = `• Nothing caught this time.`;
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
      const winNote = capped ? '\n_(payout capped — jackpot reserve is low)_' : '';

      if (outcome.type === 'fish') {
        const stars = outcome.quality ? ` ${QUALITY_STARS[outcome.quality] || ''}` : '';
        catchLine = `${outcome.emoji} *${outcome.outcomeLabel}*${stars}`;
      } else if (outcome.type === 'treasure') {
        catchLine = `${outcome.emoji} *Treasure Chest*`;
      } else if (outcome.type === 'jackpot') {
        catchLine = `${outcome.emoji} *Leviathan Jackpot*`;
      }

      resultLine = `${deltaLine(actualWin)}${winNote}`;
      if (outcome.type === 'jackpot') {
        await recordPlayerJackpot(userId);
      }
    } else {
      resultLine = `• No gain this time.`;
    }
  }

  // ── Record activity ────────────────────────────────────────────
  await recordHouseActivity(bet + predatorExtraLoss, Math.max(0, winAmount));
  await recordPlayerActivity(userId, bet + predatorExtraLoss, Math.max(0, winAmount));
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

  // ── Build final message ─────────────────────────────────────────
  const statusBlock = await oceanStatusBlock();

  // Get poetic narration – first sentence only
  const poetic = outcome.narration.split('.')[0] + '.';

  const banner = outcome.bannerText ? `${outcome.bannerText}\n${DIVIDER}\n` : '';
  const catchBlock = catchLine ? `${catchLine}\n` : '';

  const messageText =
    `${banner}` +
    `${header()}\n` +
    `${statusBlock}\n` +
    `🎣 Strategy: *${strategy.toUpperCase()}* ${STRATEGY_EMOJI[strategy]}   Bet: *${formatNumber(bet)}* coins\n` +
    `${DIVIDER}\n` +
    `${catchBlock}` +
    `_${poetic}_\n\n` +
    `${resultLine}\n` +
    `${DIVIDER}\n` +
    `💰 Balance: *${formatNumber(wallet.coins)}* coins`;

  await sock.sendMessage(chatId, {
    text: messageText,
    edit: sent.key,
    ...channelInfo,
  }, { quoted: message });
}

export const handler = withEconomyGuard(_handler);