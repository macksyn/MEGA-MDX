// @ts-nocheck
/***
 * plugins/eco_admin.ts
 *
 * Single owner-only command with subcommands, so admins don't need to
 * memorize a dozen separate command names:
 *
 *   !ecoadmin addcoins @user 500
 *   !ecoadmin removecoins @user 500
 *   !ecoadmin addgroqcoins @user 10
 *   !ecoadmin removegroqcoins @user 10
 *   !ecoadmin reset @user
 *   !ecoadmin settings                     -> show current settings
 *   !ecoadmin settings dailyBase 150        -> update a setting
 */
import { addCoins, deductCoins, addGroqCoins, deductGroqCoins, resetWallet, getSettings, updateSettings, formatNumber } from '../lib/economy.js';
import { extractTargetId } from '../lib/resolveTarget.js';

export const command = 'ecoadmin';
export const category = 'economy-admin';
export const ownerOnly = true;
export const cooldown = 2000;

export async function handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, channelInfo } = context;
  const sub = (args[0] || '').toLowerCase();

  const reply = (text: string, mentions: string[] = []) =>
    sock.sendMessage(chatId, { text, mentions, ...channelInfo }, { quoted: message });

  const targetId = extractTargetId(message, args);
  const amount = parseInt(args.find(a => /^\d+$/.test(a)) || '', 10);

  switch (sub) {
    case 'addcoins': {
      if (!targetId || !amount) return reply('⚠️ Usage: *!ecoadmin addcoins @user <amount>*');
      const wallet = await addCoins(targetId, amount);
      return reply(`✅ Gave *${formatNumber(amount)} coins* to @${targetId}. New balance: ${formatNumber(wallet.coins)}.`, [`${targetId}@s.whatsapp.net`]);
    }
    case 'removecoins': {
      if (!targetId || !amount) return reply('⚠️ Usage: *!ecoadmin removecoins @user <amount>*');
      const result = await deductCoins(targetId, amount);
      if (!result.success) return reply(`❌ @${targetId} doesn't have that many coins.`, [`${targetId}@s.whatsapp.net`]);
      return reply(`✅ Removed *${formatNumber(amount)} coins* from @${targetId}. New balance: ${formatNumber(result.wallet.coins)}.`, [`${targetId}@s.whatsapp.net`]);
    }
    case 'addgroqcoins': {
      if (!targetId || !amount) return reply('⚠️ Usage: *!ecoadmin addgroqcoins @user <amount>*');
      const wallet = await addGroqCoins(targetId, amount);
      return reply(`✅ Gave *${formatNumber(amount)} Groq Coins* 💲 to @${targetId}. New balance: ${formatNumber(wallet.groqCoins)}.`, [`${targetId}@s.whatsapp.net`]);
    }
    case 'removegroqcoins': {
      if (!targetId || !amount) return reply('⚠️ Usage: *!ecoadmin removegroqcoins @user <amount>*');
      const result = await deductGroqCoins(targetId, amount);
      if (!result.success) return reply(`❌ @${targetId} doesn't have that many Groq Coins.`, [`${targetId}@s.whatsapp.net`]);
      return reply(`✅ Removed *${formatNumber(amount)} Groq Coins* from @${targetId}. New balance: ${formatNumber(result.wallet.groqCoins)}.`, [`${targetId}@s.whatsapp.net`]);
    }
    case 'reset': {
      if (!targetId) return reply('⚠️ Usage: *!ecoadmin reset @user*');
      await resetWallet(targetId);
      return reply(`♻️ Wallet reset for @${targetId}.`, [`${targetId}@s.whatsapp.net`]);
    }
    case 'settings': {
      const key = args[1];
      const value = args[2];
      if (key && value !== undefined) {
        const parsed = isNaN(Number(value)) ? value : Number(value);
        const updated = await updateSettings({ [key]: parsed } as any);
        return reply(`✅ Updated *${key}* → ${JSON.stringify((updated as any)[key])}`);
      }
      const settings = await getSettings();
      return reply(`⚙️ *Current economy settings*\n\n\`\`\`${JSON.stringify(settings, null, 2)}\`\`\``);
    }
    case 'setgroup': {
      if (!chatId.endsWith('@g.us')) {
        return reply('⚠️ Run *!ecoadmin setgroup* from inside the group you want the economy restricted to.');
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
        `⚙️ *Economy admin commands*\n\n` +
        `!ecoadmin addcoins @user <amount>\n` +
        `!ecoadmin removecoins @user <amount>\n` +
        `!ecoadmin addgroqcoins @user <amount>\n` +
        `!ecoadmin removegroqcoins @user <amount>\n` +
        `!ecoadmin reset @user\n` +
        `!ecoadmin setgroup       (run inside the group to restrict economy to it)\n` +
        `!ecoadmin unsetgroup     (remove the restriction)\n` +
        `!ecoadmin settings\n` +
        `!ecoadmin settings <key> <value>`
      );
  }
}