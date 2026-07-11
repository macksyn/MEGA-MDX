import type { BotContext } from '../types.js';

const API_URL = 'https://api.qasimdev.dpdns.org/api/info/trends';
const API_KEY = 'xbps-install-Syu';

export default {
  command: 'trends',
  aliases: ['trend', 'trending'],
  category: 'info',
  description: 'Get trending topics from a country.',
  usage: '.trends [country-name]',

  async handler(sock: any, message: any, args: any, context: BotContext) {
    const chatId = context.chatId || message.key.remoteJid;

    try {
      const country = args.join(' ').trim() || 'Nigeria';

      const response = await fetch(`${API_URL}?country=${encodeURIComponent(country)}&apikey=${API_KEY}`);

      if (!response.ok) {
        throw new Error(`API responded with status ${response.status}`);
      }

      const json: any = await response.json();

      // API response shape: { success, data: { result: { country, result: [...] } } }
      const payload = json?.data?.result ?? json?.data ?? json;
      const trends: any[] =
        Array.isArray(payload?.result) ? payload.result :
        Array.isArray(payload) ? payload :
        null;

      let output = `*Trending topics in ${payload?.country || country}:*\n\n`;

      if (trends && trends.length) {
        trends.forEach((trend: any, i: number) => {
          const tag = trend.hastag || trend.hashtag || trend.name || trend.topic || JSON.stringify(trend);
          const tweets = trend.tweet || trend.tweets || '';
          output += `${i + 1}. ${tag}${tweets ? ` - ${tweets}` : ''}\n`;
        });
      } else {
        throw new Error('No trending data found');
      }

      await sock.sendMessage(chatId, { text: output }, { quoted: message });

    } catch (error: any) {
      console.error('Error in trendsCommand:', error);
      await sock.sendMessage(chatId, {
        text: '❌ Failed to fetch trending topics. Please try again later.'
      }, { quoted: message });
    }
  }
};
