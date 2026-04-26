import type { BotContext } from '../types.js';
import axios from 'axios';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Use the primary discardapi for vm.tiktok.com links */
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

/** Use the Jawad API for vt.tiktok.com links (or as a fallback) */
async function fetchFallbackApi(url: string) {
  const apiUrl = `https://jawad-tech.vercel.app/download/ttdl?url=${encodeURIComponent(url)}`;
  const { data } = await axios.get(apiUrl, {
    timeout: 45000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });

  if (!data?.status || !data?.result) throw new Error('Invalid API response from fallback');

  const m = data.metadata;
  return {
    videoUrl:  data.result,
    isHd:      data.quality === 'hd',
    author:    m.author.nickname,
    username:  m.author.username,
    region:    m.region,
    duration:  `${m.duration}s`,
    likes:     m.stats.likes,
    comments:  m.stats.comments,
    shares:    m.stats.shares,
    views:     m.stats.views,
    sound:     `${m.music.title} – ${m.music.author}`,
    posted:    m.published,
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
      await sock.sendMessage(chatId, {
        text: '⏳ Downloading TikTok video...'
      }, { quoted: message });

      // Route: prefer fallback API for vt.tiktok.com; use primary for everything else.
      // If the primary fails for any reason, fall back automatically.
      const isVtLink = url.includes('vt.tiktok.com');

      let result;
      if (isVtLink) {
        result = await fetchFallbackApi(url);
      } else {
        try {
          result = await fetchPrimaryApi(url);
        } catch {
          // Primary failed — try the fallback before giving up
          result = await fetchFallbackApi(url);
        }
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