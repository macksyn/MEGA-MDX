import type { BotContext } from '../types.js';
import axios from 'axios';

const API_KEY = process.env.QASIM_API_KEY || 'xbps-install-Syu';
const API_BASE_URL = 'https://api.qasimdev.dpdns.org/api/twitter/download';

interface Media { type: 'video' | 'image'; url: string }
interface Tweet {
  authorUsername: string;
  authorName: string;
  date: string;
  likes: number;
  retweets: number;
  replies: number;
  text: string;
  media: Media[];
}

// Pulls user + id out of any x.com / twitter.com status link and drops
// tracking junk like /video/1?a=...&s=08
function parseTweetUrl(raw: string): { user: string; id: string; clean: string } | null {
  const m = raw.match(/(?:twitter|x)\.com\/(?:#!\/)?([^/?#]+)\/status(?:es)?\/(\d+)/i);
  if (!m) return null;
  const [, user, id] = m;
  return { user, id, clean: `https://x.com/${user}/status/${id}` };
}

// Provider 1: your existing API (fail fast so the fallback gets a turn)
async function fromQasim(t: { clean: string }): Promise<Tweet> {
  const { data } = await axios.get(API_BASE_URL, {
    params: { url: t.clean, apiKey: API_KEY },
    timeout: 8000,
  });
  if (!data?.success || !data.data?.media?.length) throw new Error('no media');
  return data.data;
}

// Provider 2: fxtwitter public API
async function fromFx(t: { user: string; id: string }): Promise<Tweet> {
  const { data } = await axios.get(`https://api.fxtwitter.com/${t.user}/status/${t.id}`, {
    timeout: 10000,
  });
  const tw = data?.tweet;
  const all = tw?.media?.all ?? [];
  if (!all.length) throw new Error('no media');
  return {
    authorUsername: tw.author?.screen_name,
    authorName: tw.author?.name,
    date: tw.created_at,
    likes: tw.likes,
    retweets: tw.retweets,
    replies: tw.replies,
    text: tw.text,
    media: all.map((m: any) => ({
      type: m.type === 'photo' ? 'image' : 'video', // 'gif' comes back as an mp4
      url: m.url,
    })),
  };
}

async function getTweet(t: { user: string; id: string; clean: string }): Promise<Tweet> {
  const providers = [fromQasim, fromFx];
  for (const p of providers) {
    try {
      return await p(t);
    } catch (e: any) {
      // log code/message only, never the whole error (it contains the apiKey)
      console.warn(`[twitter] ${p.name} failed: ${e.code || e.message}`);
    }
  }
  throw new Error('ALL_PROVIDERS_FAILED');
}

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

    const parsed = parseTweetUrl(url);
    if (!parsed) {
      return await sock.sendMessage(chatId, { text: '❌ That doesn\'t look like a valid Tweet/X link.' }, { quoted: message });
    }

    try {
      const tweet = await getTweet(parsed);

      const caption = `
📝 @${tweet.authorUsername} (${tweet.authorName})
📅 ${tweet.date}
❤️ Likes: ${tweet.likes} | 🔁 Retweets: ${tweet.retweets} | 💬 Replies: ${tweet.replies}

💬 ${tweet.text}
      `.trim();

      // caption on the first item only, so multi-media posts don't repeat it
      for (const [i, item] of tweet.media.entries()) {
        const cap = i === 0 ? caption : undefined;
        if (item.type === 'video') {
          await sock.sendMessage(chatId, { video: { url: item.url }, caption: cap }, { quoted: message });
        } else {
          await sock.sendMessage(chatId, { image: { url: item.url }, caption: cap }, { quoted: message });
        }
      }
    } catch (error: any) {
      console.error('Twitter plugin error:', error.code || error.message);
      await sock.sendMessage(chatId, {
        text: '❌ Couldn\'t fetch media. The post may have no video/image, or the download services are down. Try again in a bit.',
      }, { quoted: message });
    }
  },
};
