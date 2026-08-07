import type { BotContext } from '../types.js';
import axios from 'axios';

const AXIOS_DEFAULTS = {
  timeout: 60000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': 'application/json, text/plain, */*'
  }
};

export default {
  command: 'facebook',
  aliases: ['fb', 'fbdl'],
  category: 'download',
  description: 'Download Facebook videos',
  usage: '.fb <facebook video link>',

  async handler(sock: any, message: any, args: any, context: BotContext) {
    const chatId = context.chatId || message.key.remoteJid;
    const url =
      args.join(' ') ||
      message.message?.conversation ||
      message.message?.extendedTextMessage?.text;

    try {
      if (!url) {
        return await sock.sendMessage(chatId, { text: '📘 *Facebook Downloader*\n\nUsage:\n.fb <facebook video link>' }, { quoted: message });
      }

      if (!/facebook\.com|fb\.watch/i.test(url)) {
        return await sock.sendMessage(
          chatId,
          { text: '❌ Invalid Facebook link.\nPlease send a valid Facebook video URL.' },
          { quoted: message }
        );
      }

      if (!context.silent) {
        await sock.sendMessage(chatId, {
          react: { text: '🔄', key: message.key }
        });
      }

      // 新 API 端点
      const apiUrl = `https://jawad-tech.vercel.app/downloader?url=${encodeURIComponent(url)}`;

      const res = await axios.get(apiUrl, AXIOS_DEFAULTS);

      // 新 API 响应结构: { status, creator, platform, result: [{ quality, type, url }], metadata }
      const videos = res?.data?.result;
      if (!res?.data?.status || !Array.isArray(videos) || !videos.length) {
        throw new Error('No downloadable video found');
      }

      // 按质量排序：HD > SD > 其他
      const qualityRank: Record<string, number> = { 'HD': 3, '720p': 2, 'SD': 1 };
      const sorted = videos.sort((a, b) => {
        const rankA = qualityRank[a.quality] || 0;
        const rankB = qualityRank[b.quality] || 0;
        return rankB - rankA;
      });

      const selected = sorted[0];
      const videoUrl = selected.url.startsWith('http')
        ? selected.url
        : `https://jawad-tech.vercel.app${selected.url}`;

      const caption = `📘 *Facebook Downloader*
🎞 Quality: *${selected.quality || 'Unknown'}*

> 📥 *_Groq™_*`;

      await sock.sendMessage(chatId, { video: { url: videoUrl }, mimetype: 'video/mp4', caption }, { quoted: message });

    } catch(err: any) {
      console.error('Facebook downloader error:', err);
      await sock.sendMessage(
        chatId,
        { text: '❌ Failed to download Facebook video. Please try again later.' },
        { quoted: message });
    }
  }
};