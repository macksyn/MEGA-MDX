import type { BotContext } from '../types.js';
import axios from 'axios';

const API_URL = 'https://api.qasimdev.dpdns.org/api/download/pinterest';
const API_KEY = process.env.QASIMDEV_API_KEY;

if (!API_KEY) {
  throw new Error('QASIMDEV_API_KEY is not configured');
}

const AXIOS_DEFAULTS = {
  timeout: 60000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    Accept: 'application/json, text/plain, */*',
  },
};

export default {
  command: 'pinterest',
  aliases: ['pindl', 'pinterestdl'],

  category: 'download',

  description: 'Download Pinterest images and videos',

  usage: '.pin <Pinterest link>',

  async handler(
    sock: any,
    message: any,
    args: any,
    context: BotContext
  ) {
    const chatId = context.chatId || message.key.remoteJid;

    const url =
      args.join(' ').trim() ||
      message.message?.conversation?.trim() ||
      message.message?.extendedTextMessage?.text?.trim();

    try {
      // ─────────────────────────────────────────────
      // Validate URL
      // ─────────────────────────────────────────────

      if (!url) {
        return await sock.sendMessage(
          chatId,
          {
            text:
              '📌 *Pinterest Downloader*\n\n' +
              'Usage:\n' +
              '.pin <Pinterest link>\n\n' +
              'Example:\n' +
              '.pin https://pin.it/xxxxx',
          },
          { quoted: message }
        );
      }

      // Remove command itself if the full message text was used
      const cleanUrl = url.replace(
        /^\.?(pinterest|pin|pindl|pinterestdl)\s+/i,
        ''
      ).trim();

      // Pinterest URL validation
      if (
        !/^https?:\/\/(?:www\.)?(?:pinterest\.[a-z.]+|pin\.it)\//i.test(
          cleanUrl
        )
      ) {
        return await sock.sendMessage(
          chatId,
          {
            text:
              '❌ *Invalid Pinterest link.*\n\n' +
              'Please send a valid Pinterest URL.\n\n' +
              'Example:\n' +
              '.pin https://pin.it/xxxxx',
          },
          { quoted: message }
        );
      }

      // ─────────────────────────────────────────────
      // React
      // ─────────────────────────────────────────────

      if (!context.silent) {
        await sock.sendMessage(chatId, {
          react: {
            text: '📌',
            key: message.key,
          },
        });
      }

      // ─────────────────────────────────────────────
      // Call Pinterest API
      // ─────────────────────────────────────────────

      const apiUrl = `${API_URL}?url=${encodeURIComponent(cleanUrl)}&apiKey=${encodeURIComponent(API_KEY)}`;

      const response = await axios.get(apiUrl, AXIOS_DEFAULTS);

      const data = response?.data;

      if (!data?.success || !data?.data?.download_url) {
        throw new Error('Pinterest API returned no download URL');
      }

      const downloadUrl = data.data.download_url;

      if (
        typeof downloadUrl !== 'string' ||
        !downloadUrl.startsWith('http')
      ) {
        throw new Error('Invalid Pinterest download URL');
      }

      // ─────────────────────────────────────────────
      // Download actual media
      // ─────────────────────────────────────────────

      const mediaResponse = await axios.get(downloadUrl, {
        ...AXIOS_DEFAULTS,
        responseType: 'arraybuffer',
        maxContentLength: 100 * 1024 * 1024,
        maxBodyLength: 100 * 1024 * 1024,
      });

      const buffer = Buffer.from(mediaResponse.data);

      if (!buffer.length) {
        throw new Error('Downloaded Pinterest file is empty');
      }

      // ─────────────────────────────────────────────
      // Detect media type
      // ─────────────────────────────────────────────

      const rawContentType = mediaResponse.headers?.['content-type'];

const contentType =
  typeof rawContentType === 'string'
    ? rawContentType.toLowerCase()
    : '';

      let mediaType: 'image' | 'video' | 'document' = 'document';

      if (contentType.startsWith('image/')) {
        mediaType = 'image';
      } else if (contentType.startsWith('video/')) {
        mediaType = 'video';
      } else {
        // Fallback to URL extension
        const extension = downloadUrl
          .split('?')[0]
          .split('.')
          .pop()
          ?.toLowerCase();

        if (
          ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(extension || '')
        ) {
          mediaType = 'image';
        } else if (
          ['mp4', 'webm', 'mov', 'm4v'].includes(extension || '')
        ) {
          mediaType = 'video';
        }
      }

      // ─────────────────────────────────────────────
      // Caption
      // ─────────────────────────────────────────────

      const caption =
        `📌 *Pinterest Downloader*\n\n` +
        `📥 Downloaded successfully\n\n` +
        `> 📥 *Groq™*`;

      // ─────────────────────────────────────────────
      // Send media
      // ─────────────────────────────────────────────

      if (mediaType === 'video') {
        await sock.sendMessage(
          chatId,
          {
            video: buffer,
            mimetype: contentType || 'video/mp4',
            caption,
          },
          { quoted: message }
        );
      } else if (mediaType === 'image') {
        await sock.sendMessage(
          chatId,
          {
            image: buffer,
            mimetype: contentType || 'image/jpeg',
            caption,
          },
          { quoted: message }
        );
      } else {
        await sock.sendMessage(
          chatId,
          {
            document: buffer,
            mimetype: contentType || 'application/octet-stream',
            fileName: 'pinterest-download',
            caption,
          },
          { quoted: message }
        );
      }

      // ─────────────────────────────────────────────
      // Success reaction
      // ─────────────────────────────────────────────

      if (!context.silent) {
        await sock.sendMessage(chatId, {
          react: {
            text: '✅',
            key: message.key,
          },
        });
      }
    } catch (err: any) {
      console.error(
        'Pinterest downloader error:',
        err?.response?.data || err?.message || err
      );

      if (!context.silent) {
        await sock.sendMessage(chatId, {
          react: {
            text: '❌',
            key: message.key,
          },
        });
      }

      await sock.sendMessage(
        chatId,
        {
          text:
            '❌ *Pinterest Download Failed*\n\n' +
            'I couldn’t download that Pinterest media.\n' +
            'Please check the link and try again later.',
        },
        { quoted: message }
      );
    }
  },
};