// @ts-nocheck
import { convertCoinsToGroqCoins, getSettings, formatNumber, withEconomyGuard } from '../lib/economy.js';
import { cleanJid } from '../lib/isOwner.js';

export const command = 'exchange';
export const aliases = ['convert'];
export const category = 'economy';
export const cooldown = 3000;

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, senderId, channelInfo } = context;
  const userId = cleanJid(senderId);
  const settings = await getSettings();

  const amount = parseInt(args[0], 10);
  if (!amount || amount <= 0) {
    return sock.sendMessage(chatId, {
      text: `⚠️ Usage: *.exchange <coins>*\n\n_Rate: ${formatNumber(settings.coinsPerGroqCoin)} coins = 1 Groq Coin 💲_`,
      ...channelInfo
    }, { quoted: message });
  }

  const result = await convertCoinsToGroqCoins(userId, amount);

  if (!result.success) {
    const reasonText = result.reason === 'below_minimum'
      ? `You need at least ${formatNumber(settings.coinsPerGroqCoin)} coins to convert into 1 Groq Coin.`
      : "You don't have enough coins for that.";
    return sock.sendMessage(chatId, { text: `❌ ${reasonText}`, ...channelInfo }, { quoted: message });
  }

  await sock.sendMessage(chatId, {
    text: `♻️ Converted coins into *${formatNumber(result.groqCoinsGained)} Groq Coins* 💲!\n\n_Groq Coins are the scarce currency — save up ${formatNumber(settings.groqCoinWithdrawThreshold)}+ to request a real payout with *!withdraw*._`,
    ...channelInfo
  }, { quoted: message });
}

export const handler = withEconomyGuard(_handler);