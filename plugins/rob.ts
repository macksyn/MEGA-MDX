// @ts-nocheck
/***
 * plugins/rob.ts
 *
 * {prefix}rob @member — try to rob coins out of another member's wallet.
 * Aim it by @mentioning them, replying to one of their messages, or typing
 * their phone number. All rules (20-coin bail, 70% odds / 90% masked,
 * protection life bars, gun rounds, cooldowns, jackpot) live in lib/market.ts.
 */
import { withEconomyGuard, getWallet, formatNumber } from '../lib/economy.js';
import { cleanJid } from '../lib/isOwner.js';
import config from '../config.js';
import { attemptRob, MARKET_CONFIG, fmtDuration, lifeBar } from '../lib/market.js';

export const command = 'rob';
export const aliases = ['steal', 'mug'];
export const category = 'economy';
export const cooldown = 2000;

const PREFIX = config.prefix || '.';
const fmt = formatNumber;
const { BAIL } = MARKET_CONFIG;

/** Raw JID (domain intact, so WhatsApp renders the @mention) of who the robber is aiming at. */
function resolveTargetJid(message: any, args: string[]): string | null {
  const m = message?.message;
  const info = m?.extendedTextMessage?.contextInfo || m?.imageMessage?.contextInfo || m?.videoMessage?.contextInfo;
  const mentioned = info?.mentionedJid?.[0];
  if (mentioned) return mentioned;
  if (info?.quotedMessage && info?.participant) return info.participant;
  const digits = args.map(a => a.replace(/[^\d]/g, '')).find(d => d.length >= 7 && d.length <= 15);
  return digits ? `${digits}@s.whatsapp.net` : null;
}

const tag = (jid: string) => `@${jid.split('@')[0].split(':')[0]}`;

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, senderId, channelInfo } = context;
  const send = (text: string, mentions: string[] = []) =>
    sock.sendMessage(chatId, { text, mentions, ...channelInfo }, { quoted: message });

  const robberId = cleanJid(senderId);
  const targetJid = resolveTargetJid(message, args);
  if (!targetJid) {
    return send(`🔫 Who are you robbing?\n\nUsage: *${PREFIX}rob @member* — or reply to their message with *${PREFIX}rob*.`);
  }

  const victimId = cleanJid(targetJid);
  if (victimId === robberId) return send(`🤨 You can't rob yourself.`);
  if (sock.user?.id && victimId === cleanJid(sock.user.id)) return send(`🤖 Nice try. The bot's wallet is off-limits.`);

  const victimWallet = await getWallet(victimId);
  const victimJid = victimWallet.jid || targetJid; // stored raw JID mentions reliably; fall back to what we were given
  const v = tag(victimJid);
  const r = await attemptRob(robberId, victimId);

  if (!r.ok) {
    switch (r.reason) {
      case 'poor':
        return send(`❌ Not enough coins. You need at least *${BAIL} coins* in your wallet to rob — that's your bail if the police catch you. You have *${fmt(r.coins)}*.`);
      case 'cooldown':
        return send(r.reloading
          ? `🔫 Your *${r.gun.name}* is reloading — ready in *${fmtDuration(r.remainingMs)}*.`
          : `⏳ Lay low for a bit — you can rob again in *${fmtDuration(r.remainingMs)}*.${r.gun ? '' : `\n_A gun gets you several attempts before a cooldown (see ${PREFIX}market)._`}`);
      case 'self':
        return send(`🤨 You can't rob yourself.`);
      default:
        return send(`⚠️ The heist went sideways and nothing was taken. Try again in a moment.`);
    }
  }

  if (r.outcome === 'victim_broke') {
    return send(`😂 ${v} is too broke — their wallet is empty. Not worth the risk.`, [victimJid]);
  }

  // Shared footer: odds used + the robber's gun / cooldown state.
  const footer = [
    `🎲 Odds: ${Math.round(r.successRate * 100)}%${r.masked ? ' 🎭' : ''}`,
    r.cooldownMs
      ? `⏳ ${r.gun ? `Reloading ${r.gun.name}` : 'Laying low'}: ${fmtDuration(r.cooldownMs)}`
      : `${r.gun.emoji} ${r.gun.name}: ${r.roundsLeft}/${r.gun.rounds} rounds left`,
  ].join('  ·  ');

  if (r.outcome === 'caught') {
    return send(
      `🚨 *BUSTED!* The police caught you trying to rob ${v}.\n\n` +
      (r.bail > 0
        ? `🚔 Bail: *-${fmt(r.bail)} coins* → paid to the bank reserve\n`
        : `🚔 You were let off with a warning.\n`) +
      `👛 Wallet: *${fmt(r.coinsAfter)}*\n\n${footer}`,
      [victimJid]
    );
  }

  if (r.outcome === 'blocked') {
    const hit = `${r.protectionName}`;
    return send(
      `🛡️ ${v}'s *${hit}* took the hit and stopped you cold!\n\n` +
      `💥 Damage: *-${r.damage}*\n` +
      `❤️ ${lifeBar(r.lifeLeft, r.lifeMax)} ${r.lifeLeft}/${r.lifeMax}\n` +
      (r.broken ? `\n💀 *${hit} is down!* ${v} is unprotected — the next attempt goes through.\n` : ``) +
      `\n${footer}`,
      [victimJid]
    );
  }

  // success
  return send(
    `💰 *ROBBERY SUCCESSFUL!*\n\n` +
    `You robbed ${v} and got away with *${fmt(r.stolen)} coins*!\n` +
    `👛 Wallet: *${fmt(r.coinsAfter)}*\n\n${footer}`,
    [victimJid]
  );
}

export const handler = withEconomyGuard(_handler);
export const usage = `${PREFIX}rob @member — rob a member's wallet (needs ${BAIL}+ coins for bail). Or reply to them with ${PREFIX}rob.`;
