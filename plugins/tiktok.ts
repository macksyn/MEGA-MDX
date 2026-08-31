import type { BotContext } from '../types.js';
import axios from 'axios';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Use the primary discardapi for any TikTok link */
async function fetchPrimaryApi(url: string) {
  const apiUrl = `https://discardapi.onrender.com/api/dl/tiktok?apikey=guru&url=${encodeURIComponent(url)}`;
  const { data } = await axios.get(apiUrl, {
    timeout: 45000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });

  if (!data?.status || !data?.result) throw new Error('Invalid API response');

  const res = data.result;
  const hd   = res.data.find((v: any) => v.type === 'nowatermark_hd');
  const noWm = res.data.find((v: any) => v.type === 'nowatermark');
  const videoUrl = hd?.url || noWm?.url;
  if (!videoUrl) throw new Error('No downloadable video found');

  return {
    videoUrl,
    isHd:      !!hd,
    author:    res.author.nickname,
    username:  res.author.fullname,
    region:    res.region,
    duration:  res.duration,
    likes:     res.stats.likes,
    comments:  res.stats.comment,
    shares:    res.stats.share,
    views:     res.stats.views,
    sound:     res.music_info.title,
    posted:    res.taken_at,
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

    const prefix      = rawText.match(/^[.!#]/)?.[0] || '.';
    const commandPart = rawText.slice(prefix.length).trim();
    const parts       = commandPart.split(/\s+/);
    const url         = parts.slice(1).join(' ').trim();

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