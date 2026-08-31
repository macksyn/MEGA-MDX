import type { BotContext } from '../types.js';
import axios from 'axios';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Malvin tiktokio wrapper — current primary source for TikTok links */
async function fetchPrimaryApi(url: string) {
  const apiUrl = `https://api.malvin.gleeze.com/api/download/tiktokio?url=${encodeURIComponent(url)}&apikey=malvin-2jlQ1pnPfogmXHjlVBUnzgWLHtDLoLXmuVojOdvh`;
  const { data } = await axios.get(apiUrl, {
    timeout: 45000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*'
    }
  });

  if (!data?.status || !data?.data) throw new Error('Invalid API response');

  const res    = data.data;
  const medias: any[] = Array.isArray(res.medias) ? res.medias : [];
  const video  = medias.find((m: any) => m.type === 'video');
  if (!video) throw new Error('No downloadable video found');

  // download_url (tiktokio's own proxy) has come back clean in testing;
  // direct_url occasionally has corrupted trailing bytes on some CDN
  // mirrors, so it's only used as a fallback, not the first choice.
  const videoUrl = video.download_url || video.direct_url;
  if (!videoUrl) throw new Error('No downloadable video found');

  // This API only returns media links, a thumbnail, and an (often null)
  // title — no author/stats/sound metadata — so those fields default out.
  return {
    videoUrl,
    isHd:      /hd/i.test(video.quality ?? ''),
    author:    'Unknown',
    username:  'Unknown',
    region:    'N/A',
    duration:  'N/A',
    likes:     0,
    comments:  0,
    shares:    0,
    views:     0,
    sound:     'N/A',
    posted:    'N/A',
    title:     res.title || 'No caption'
  };
}

/** Fallback API (JawadTech) – used only when the primary fails */
async function fetchFallbackApi(url: string) {
  const apiUrl = `https://jawad-tech.vercel.app/download/tiktok?url=${encodeURIComponent(url)}`;
  
  // Accept all HTTP status codes so we can read the JSON error message
  const { data } = await axios.get(apiUrl, {
    timeout: 45000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    validateStatus: () => true   // Don't throw on 4xx / 5xx
  });

  // Check the API's own status field
  if (!data?.status || !data?.result) {
    const errorMsg = data?.error || 'Unknown fallback API error';
    throw new Error(errorMsg);
  }

  // Flat, minimal metadata – safe parsing
  const m = data.metadata || {};
  
  return {
    videoUrl:  data.result,
    isHd:      data.quality === 'hd',   // usually false but keep it
    author:    typeof m.author === 'string' ? m.author : (m.author?.nickname || 'Unknown'),
    username:  m.username || 'Unknown',
    region:    m.region || 'N/A',
    duration:  m.duration ? `${m.duration}s` : 'N/A',
    likes:     m.stats?.likes ?? 0,
    comments:  m.stats?.comments ?? 0,
    shares:    m.stats?.shares ?? 0,
    views:     m.stats?.views ?? 0,
    sound:     m.music ? `${m.music.title || 'Unknown'} – ${m.music.author || ''}` : 'N/A',
    posted:    m.published || 'N/A',
    title:     m.title || 'No caption'
  };
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export default {
  command: 'tiktok',
  aliases: ['tt', 'ttdl', 'tiktokdl'],
  category: 'download',
  description: 'Download TikTok video without watermark (HD if available)',
  usage: '.tiktok <TikTok URL>',

  async handler(sock: any, message: any, args: any, context: BotContext) {
    const { chatId, rawText } = context;

    // The URL is passed explicitly via `args` by every delegating caller
    // (download.ts sends `[normalized]`, group-autodownload.ts goes through
    // download.ts). Trust that first instead of re-deriving it from rawText.
    let url = Array.isArray(args) && args.length > 0
      ? args.join(' ').trim()
      : '';

    // Fallback: pull the first URL out of rawText with a real URL regex.
    // Works whether rawText is a full command (".tiktok <url>") or a bare
    // link — unlike the old "slice off prefix + first word" approach, which
    // assumed rawText always had the shape "<prefix><command> <url>" and
    // silently mangled anything that didn't (e.g. auto-downloaded bare links).
    if (!url && rawText) {
      url = rawText.match(/https?:\/\/\S+/i)?.[0] ?? '';
    }

    if (!url) {
      return await sock.sendMessage(chatId, {
        text: '🎵 *TikTok Downloader*\n\nPlease provide a TikTok URL.\nExample:\n.tiktok https://vm.tiktok.com/XXXX\n.tiktok https://vt.tiktok.com/XXXX'
      }, { quoted: message });
    }

    try {
      if (!context.silent) {
        await sock.sendMessage(chatId, {
          react: { text: '⏳', key: message.key }
        });
      }

      let result;
      try {
        // Always try the primary API first
        result = await fetchPrimaryApi(url);
      } catch (primaryError: any) {
        console.log('Primary API failed, trying fallback:', primaryError.message);
        // If primary fails, attempt the fallback API
        result = await fetchFallbackApi(url);
      }

      const {
        videoUrl, isHd, author, username, region,
        duration, likes, comments, shares, views,
        sound, posted, title
      } = result;

      const caption =
`🎵 *TikTok Downloader*
━━━━━━━━━━━━━━━━━━━
👤 *User:* ${author}
🆔 *Username:* ${username}
🌍 *Region:* ${region}
⏱️ *Duration:* ${duration}

❤️ *Likes:* ${likes}
💬 *Comments:* ${comments}
🔁 *Shares:* ${shares}
👀 *Views:* ${views}

🎧 *Sound:* ${sound}
📅 *Posted:* ${posted}

📝 *Caption:*
${title}

✨ *Quality:* ${isHd ? 'HD No Watermark' : 'No Watermark'}
━━━━━━━━━━━━━━━━━━━`;

      await sock.sendMessage(chatId, {
        video: { url: videoUrl },
        mimetype: 'video/mp4',
        caption
      }, { quoted: message });

      if (!context.silent) {
        await sock.sendMessage(chatId, {
          react: { text: '', key: message.key }
        });
      }

    } catch (error: any) {
      console.error('TikTok plugin error:', error);

      if (error.code === 'ECONNABORTED') {
        await sock.sendMessage(chatId, {
          text: '⏱️ Request timed out. Please try again later.'
        }, { quoted: message });
      } else {
        await sock.sendMessage(chatId, {
          text: `❌ Failed to download TikTok video.\nReason: ${error.message}`
        }, { quoted: message });
      }
    }
  }
};