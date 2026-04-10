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

interface VideoResult {
  buffer: Buffer;
  resolution: string;
}

/** Resolves relative URLs returned by the primary API. */
function resolveUrl(url: string): string {
  return url.startsWith('http') ? url : `https://gtech-api-xtp1.onrender.com${url}`;
}

/**
 * Downloads a video URL into a Buffer.
 * Throws if the server returns a non-video content-type (e.g. broken proxy).
 */
async function downloadBuffer(videoUrl: string): Promise<Buffer> {
  const res = await axios.get(videoUrl, {
    ...AXIOS_DEFAULTS,
    responseType: 'arraybuffer',
    timeout: 120000, // longer timeout for actual video bytes
  });

  const contentType: string = res.headers['content-type'] ?? '';
  if (!contentType.includes('video') && !contentType.includes('octet-stream')) {
    throw new Error(`Bad content-type "${contentType}" — likely a broken proxy URL`);
  }

  return Buffer.from(res.data);
}

/**
 * Primary API: fetches metadata, picks best quality, downloads buffer.
 * Any failure (bad status, empty list, broken URL) throws so the caller
 * can seamlessly fall through to the fallback.
 */
async function fetchFromPrimary(fbUrl: string): Promise<VideoResult> {
  const res = await axios.get(PRIMARY_API(fbUrl), AXIOS_DEFAULTS);

  if (!res?.data?.status) throw new Error('Primary API returned unsuccessful status');

  const videos: any[] = res?.data?.data?.data;
  if (!Array.isArray(videos) || !videos.length) {
    throw new Error('No video entries in primary API response');
  }

  const sorted = videos.sort(
    (a, b) => (parseInt(b.resolution, 10) || 0) - (parseInt(a.resolution, 10) || 0)
  );
  const selected = sorted[0];
  const videoUrl = resolveUrl(selected.url);

  // This is the key step — if the URL is a broken proxy it throws here,
  // not inside Baileys' sendMessage where we can no longer catch it.
  const buffer = await downloadBuffer(videoUrl);

  return { buffer, resolution: selected.resolution ?? 'Unknown' };
}

/**
 * Fallback API: fetches metadata and downloads buffer.
 */
async function fetchFromFallback(fbUrl: string): Promise<VideoResult> {
  const res = await axios.get(FALLBACK_API(fbUrl), AXIOS_DEFAULTS);

  if (!res?.data?.result?.video_url) {
    throw new Error('No video_url in fallback API response');
  }

  const { video_url, quality } = res.data.result;
  const buffer = await downloadBuffer(video_url);

  return { buffer, resolution: quality ?? 'HD' };
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

      await sock.sendMessage(chatId, { react: { text: '🔄', key: message.key } });

      // ── Primary → Fallback chain ─────────────────────────────────────────
      // Both fetchFromPrimary and fetchFromFallback download the actual video
      // bytes before returning, so any broken URL is caught HERE — not inside
      // Baileys' sendMessage where recovery is impossible.
      let result: VideoResult;

      try {
        result = await fetchFromPrimary(url);
      } catch (primaryErr) {
        console.warn('[Facebook] Primary failed, switching to fallback:', (primaryErr as Error).message);
        result = await fetchFromFallback(url);
      }
      // ────────────────────────────────────────────────────────────────────

      const caption = `📘 *Facebook Downloader*
🎞 Quality: *${result.resolution}*

> 📥 *_Groq™_*`;

      // Send a pre-downloaded buffer — bypasses all Baileys streaming/proxy issues
      await sock.sendMessage(
        chatId,
        { video: result.buffer, mimetype: 'video/mp4', caption },
        { quoted: message }
      );

    } catch (err: any) {
      console.error('[Facebook] Both APIs failed:', err.message);
      await sock.sendMessage(
        chatId,
        { text: '❌ Failed to download Facebook video. Please try again later.' },
        { quoted: message }
      );
    }
  }
};