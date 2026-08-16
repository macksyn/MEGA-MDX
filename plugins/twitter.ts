import type { BotContext } from '../types.js';
import axios from 'axios';

const API_KEY = 'xbps-install-Syu';
const API_BASE_URL = 'https://api.qasimdev.dpdns.org/api/twitter/download';

export default {
  command: 'twitter',
  aliases: ['xtweet', 'tweetdl', 'twitterdl'],
  category: 'download',
  description: 'Download media (video or image) from X/Twitter post',
  usage: '.twitter <Tweet URL>',

  async handler(sock: any, message: any, args: any, context: BotContext) {
    const chatId = context.chatId || message.key.remoteJid;
    const url = args?.[0];

    if (!url) {
      return await sock.sendMessage(chatId, { text: 'Please provide a Twitter/X URL.\nExample: .twitter https://x.com/i/status/2002054360428167305' }, { quoted: message });
    }

    try {
      const apiUrl = `${API_BASE_URL}?url=${encodeURIComponent(url)}&apiKey=${API_KEY}`;
      const { data } = await axios.get(apiUrl, { timeout: 10000 });

      if (!data?.success || !data.data?.media?.length) {
        return await sock.sendMessage(chatId, { text: '❌ No media found for this Tweet.' }, { quoted: message });
      }

      const tweet = data.data;
      const caption = `
📝 @${tweet.authorUsername} (${tweet.authorName})
📅 ${tweet.date}
❤️ Likes: ${tweet.likes} | 🔁 Retweets: ${tweet.retweets} | 💬 Replies: ${tweet.replies}

💬 ${tweet.text}
      `.trim();

      for (const mediaItem of tweet.media) {
        if (mediaItem.type === 'video') {
          await sock.sendMessage(chatId, { video: { url: mediaItem.url }, caption: caption }, { quoted: message });
        } else if (mediaItem.type === 'image') {
          await sock.sendMessage(chatId, { image: { url: mediaItem.url }, caption: caption }, { quoted: message });
        }
      }

    } catch(error: any) {
      console.error('Twitter plugin error:', error);

      if (error.code === 'ECONNABORTED') {
        await sock.sendMessage(chatId, { text: '❌ Request timed out. The API may be slow or unreachable.' }, { quoted: message });
      } else {
        await sock.sendMessage(chatId, { text: '❌ Failed to fetch Twitter/X media.' }, { quoted: message });
      }
    }
  }
};