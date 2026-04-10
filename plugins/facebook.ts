import type { BotContext } from '../types.js';
import axios from 'axios';

const AXIOS_DEFAULTS = {
  timeout: 60000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': 'application/json, text/plain, */*'
  }
};

const PRIMARY_API = (url: string) =>
  `https://gtech-api-xtp1.onrender.com/api/download/fb?url=${encodeURIComponent(url)}&apikey=APIKEY`;

const FALLBACK_API = (url: string) =>
  `https://api.malvin.gleeze.com/download/facebook?url=${encodeURIComponent(url)}&apikey=mvn_5a0a786002144470162f0a25d1e42492`;

/**
 * Normalizes video entries from either API into a common shape:
 * { url: string, resolution: string }
 */
function normalizeVideos(data: any): { url: string; resolution: string }[] {
  // Primary API: res.data.data.data -> array of { url, resolution }
  if (Array.isArray(data?.data?.data)) {
    return data.data.data.map((v: any) => ({
      url: v.url,
      resolution: v.resolution ?? 'Unknown',
    }));
  }

  // Fallback API: res.data -> { hd, sd, ... }
  if (data?.hd || data?.sd) {
    const entries: { url: string; resolution: string }[] = [];
    if (data.hd) entries.push({ url: data.hd, resolution: 'HD' });
    if (data.sd) entries.push({ url: data.sd, resolution: 'SD' });
    return entries;
  }

  return [];
}

async function fetchFromPrimary(url: string): Promise<{ url: string; resolution: string }[]> {
  const res = await axios.get(PRIMARY_API(url), AXIOS_DEFAULTS);
  if (!res?.data?.status) throw new Error('Primary API returned unsuccessful status');
  const videos = normalizeVideos(res.data);
  if (!videos.length) throw new Error('No downloadable video found from primary API');
  return videos;
}

async function fetchFromFallback(url: string): Promise<{ url: string; resolution: string }[]> {
  const res = await axios.get(FALLBACK_API(url), AXIOS_DEFAULTS);
  const videos = normalizeVideos(res.data);
  if (!videos.length) throw new Error('No downloadable video found from fallback API');
  return videos;
}

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
        return await sock.sendMessage(
          chatId,
          { text: '📘 *Facebook Downloader*\n\nUsage:\n.fb <facebook video link>' },
          { quoted: message }
        );
      }

      if (!/facebook\.com|fb\.watch/i.test(url)) {
        return await sock.sendMessage(
          chatId,
          { text: '❌ Invalid Facebook link.\nPlease send a valid Facebook video URL.' },
          { quoted: message }
        );
      }

      await sock.sendMessage(chatId, {
        react: { text: '🔄', key: message.key }
      });

      // ── Try primary, fall back silently if it fails ──────────────────────
      let videos: { url: string; resolution: string }[];
      let usedFallback = false;

      try {
        videos = await fetchFromPrimary(url);
      } catch (primaryErr) {
        console.warn('Primary Facebook API failed, switching to fallback:', primaryErr);
        videos = await fetchFromFallback(url);
        usedFallback = true;
      }
      // ─────────────────────────────────────────────────────────────────────

      // Pick highest quality: HD first, then sort numeric resolutions descending
      const sorted = videos.sort((a, b) => {
        if (a.resolution === 'HD') return -1;
        if (b.resolution === 'HD') return 1;
        return (parseInt(b.resolution, 10) || 0) - (parseInt(a.resolution, 10) || 0);
      });

      const selected = sorted[0];

      // Resolve relative URLs that may come from the primary API
      const videoUrl = selected.url.startsWith('http')
        ? selected.url
        : `https://gtech-api-xtp1.onrender.com${selected.url}`;

      const caption = `📘 *Facebook Downloader*
🎞 Quality: *${selected.resolution || 'Unknown'}*

> 📥 *_Groq™_*`;

      await sock.sendMessage(
        chatId,
        { video: { url: videoUrl }, mimetype: 'video/mp4', caption },
        { quoted: message }
      );

    } catch (err: any) {
      console.error('Facebook downloader error (both APIs failed):', err);
      await sock.sendMessage(
        chatId,
        { text: '❌ Failed to download Facebook video. Please try again later.' },
        { quoted: message }
      );
    }
  }
};