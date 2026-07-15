// @ts-nocheck
/***
 * plugins/eco_admin.ts
 *
 * Single owner-only command with subcommands, so admins don't need to
 * memorize a dozen separate command names. Reachable two ways — this
 * plugin's own `!ecoadmin` command, and `!eco settings` / `!eco admin`
 * (see plugins/eco_dashboard.ts, which imports and calls `handler` directly):
 *
 *   ecoadmin addcoins @user 500
 *   ecoadmin removecoins @user 500
 *   ecoadmin addgroqcoins @user 10
 *   ecoadmin removegroqcoins @user 10
 *   ecoadmin reset @user
 *   ecoadmin settings                     -> show current settings
 *   ecoadmin settings workMin 100          -> update a setting
 */
import { addCoins, deductCoins, addGroqCoins, deductGroqCoins, resetWallet, getSettings, updateSettings, formatNumber, syncIdentity, getWallet } from '../lib/economy.js';
import { extractTargetId } from '../lib/resolveTarget.js';
import config from '../config.js';

export const command = 'ecoadmin';
export const category = 'economy-admin';
export const ownerOnly = true;
export const cooldown = 2000;

const prefix = config.prefix;

export async function handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, channelInfo } = context;
  const sub = (args[0] || '').toLowerCase();

  const reply = (text: string, mentions: string[] = []) =>
    sock.sendMessage(chatId, { text, mentions, ...channelInfo }, { quoted: message });

  const targetId = extractTargetId(message, args);
  const amount = parseInt(args.find(a => /^\d+$/.test(a)) || '', 10);

  // Admin actions target another user's wallet — sync whatever contact info
  // the bot already has cached for them, so the wallet stays recognizable.
  if (targetId) void syncIdentity(targetId, sock);

  // Tag a wallet's mention with its recognized name/phone, e.g. "@234...
  // (Alex · 2348012345678)", so admins aren't just staring at raw JIDs.
  const tag = (w: { name?: string | null; phone?: string | null } | null | undefined) =>
    w?.name ? ` (${w.name}${w.phone ? ` · ${w.phone}` : ''})` : '';

  switch (sub) {
    case 'addcoins': {
      if (!targetId || !amount) return reply(`⚠️ Usage: *${prefix}eco settings addcoins @user <amount>*`);
      const wallet = await addCoins(targetId, amount);
      return reply(`✅ Gave *${formatNumber(amount)} coins* to @${targetId}${tag(wallet)}. New balance: ${formatNumber(wallet.coins)}.`, [`${targetId}@s.whatsapp.net`]);
    }
    case 'removecoins': {
      if (!targetId || !amount) return reply(`⚠️ Usage: *${prefix}eco settings removecoins @user <amount>*`);
      const result = await deductCoins(targetId, amount);
      if (!result.success) return reply(`❌ @${targetId}${tag(result.wallet)} doesn't have that many coins.`, [`${targetId}@s.whatsapp.net`]);
      return reply(`✅ Removed *${formatNumber(amount)} coins* from @${targetId}${tag(result.wallet)}. New balance: ${formatNumber(result.wallet.coins)}.`, [`${targetId}@s.whatsapp.net`]);
    }
    case 'addgroqcoins': {
      if (!targetId || !amount) return reply(`⚠️ Usage: *${prefix}eco settings addgroqcoins @user <amount>*`);
      const wallet = await addGroqCoins(targetId, amount);
      return reply(`✅ Gave *${formatNumber(amount)} Groq Coins* 💲 to @${targetId}${tag(wallet)}. New balance: ${formatNumber(wallet.groqCoins)}.`, [`${targetId}@s.whatsapp.net`]);
    }
    case 'removegroqcoins': {
      if (!targetId || !amount) return reply(`⚠️ Usage: *${prefix}eco settings removegroqcoins @user <amount>*`);
      const result = await deductGroqCoins(targetId, amount);
      if (!result.success) return reply(`❌ @${targetId}${tag(result.wallet)} doesn't have that many Groq Coins.`, [`${targetId}@s.whatsapp.net`]);
      return reply(`✅ Removed *${formatNumber(amount)} Groq Coins* from @${targetId}${tag(result.wallet)}. New balance: ${formatNumber(result.wallet.groqCoins)}.`, [`${targetId}@s.whatsapp.net`]);
    }
    case 'reset': {
      if (!targetId) return reply(`⚠️ Usage: *${prefix}eco settings reset @user*`);
      const priorWallet = await getWallet(targetId);
      await resetWallet(targetId);
      return reply(`♻️ Wallet reset for @${targetId}${tag(priorWallet)}.`, [`${targetId}@s.whatsapp.net`]);
    }
    case 'settings':      // legacy alias — kept so `!ecoadmin settings` still works standalone
    case 'config': {
      const key = args[1];
      const value = args[2];

      // top3Rewards is a 3-slot array — trying to set it with a single
      // scalar value (or worse, raw JSON typed into WhatsApp) is exactly
      // the pain point this command is meant to avoid. Point people at the
      // dedicated subcommand instead.
      if (key && key.toLowerCase() === 'top3rewards') {
        return reply(`⚠️ Use *${prefix}eco settings top3rewards <1st> <2nd> <3rd>* instead — e.g. *${prefix}eco settings top3rewards 300 200 100*`);
      }

      if (key && value !== undefined) {
        const parsed = isNaN(Number(value)) ? value : Number(value);
        const updated = await updateSettings({ [key]: parsed } as any);
        return reply(`✅ Updated *${key}* → ${JSON.stringify((updated as any)[key])}`);
      }

      const settings = await getSettings();
      const [gold, silver, bronze] = settings.top3Rewards;
      const settingsText =
        `⚙️ *Current economy settings* ⚙️\n\n` +
        `💰 Coins per Groq Coin: ${formatNumber(settings.coinsPerGroqCoin)}\n` +
        `💲 Groq Coin withdraw threshold: ${formatNumber(settings.groqCoinWithdrawThreshold)}\n` +
        `💼 Work payout: ${formatNumber(settings.workMin)}–${formatNumber(settings.workMax)} coins\n` +
        `⏱️ Work cooldown: ${Math.round(settings.workCooldownMs / 60000)} min\n` +
        `🏆 Top-3 leaderboard payout: 🥇 ${formatNumber(gold)} · 🥈 ${formatNumber(silver)} · 🥉 ${formatNumber(bronze)} coins/day\n` +
        `🔁 Exchange fee: ${settings.exchangeFeePercent}%\n` +
        `⚠️ Fine amount: ${formatNumber(settings.fineAmount)} coins\n` +
        `🔒 Economy group: ${settings.economyGroupId || 'unrestricted (any chat)'}\n\n` +
        `🔧 *Change a setting:*\n` +
        `*${prefix}eco settings <key> <value>* — e.g. *${prefix}eco settings workMin 100*\n` +
        `*${prefix}eco settings top3rewards <1st> <2nd> <3rd>*\n` +
        `*${prefix}eco settings setgroup* / *unsetgroup*`;
      return reply(settingsText);
    }
    case 'top3rewards': {
      const rewards = args.slice(1, 4).map(Number);
      if (rewards.length !== 3 || rewards.some(n => isNaN(n) || n < 0)) {
        return reply(`⚠️ Usage: *${prefix}eco settings top3rewards <1st> <2nd> <3rd>*\nExample: *${prefix}eco settings top3rewards 300 200 100*`);
      }
      const updated = await updateSettings({ top3Rewards: rewards as [number, number, number] });
      const [gold, silver, bronze] = updated.top3Rewards;
      return reply(`✅ Top-3 leaderboard rewards set to: 🥇 ${formatNumber(gold)} · 🥈 ${formatNumber(silver)} · 🥉 ${formatNumber(bronze)} coins/day`);
    }
    case 'setgroup': {
      if (!chatId.endsWith('@g.us')) {
        return reply(`⚠️ Run *${prefix}eco settings setgroup* from inside the group you want the economy restricted to.`);
      }
      await updateSettings({ economyGroupId: chatId });
      return reply(`✅ Economy is now restricted to *this group* (${chatId}).`);
    }
    case 'unsetgroup': {
      await updateSettings({ economyGroupId: null });
      return reply('✅ Economy is now unrestricted — commands will work in any chat.');
    }
    default:
      return reply(
        `⚙️ *Economy admin settings* ⚙️\n\n` +
        `*${prefix}eco settings addcoins @user <amount>*\n` +
        `*${prefix}eco settings removecoins @user <amount>*\n` +
        `*${prefix}eco settings addgroqcoins @user <amount>*\n` +
        `*${prefix}eco settings removegroqcoins @user <amount>*\n` +
        `*${prefix}eco settings reset @user*\n` +
        `*${prefix}eco settings setgroup*       (run inside the group to restrict economy to it)\n` +
        `*${prefix}eco settings unsetgroup*     (remove the restriction)\n` +
        `*${prefix}eco settings top3rewards <1st> <2nd> <3rd>*\n` +
        `*${prefix}eco settings config*\n` +
        `*${prefix}eco settings config <key> <value>*`
      );
  }
}