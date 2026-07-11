import type { BotContext } from '../types.js';
import { downloadContentFromMessage } from '@whiskeysockets/baileys';

export default {
  command: 'send',
  aliases: ['save'],
  isPrefixless: true,
  category: 'download',
  description: 'Download quoted Status updates by replying with "send" or "save"',
  usage: 'Reply to a status and type: send OR save',
  ownerOnly: true,

  async handler(sock: any, message: any, args: any, context: BotContext) {
    const chatId = context.chatId || message.key.remoteJid;

    const m = message.message;
    const type = Object.keys(m)[0];

    // Check the quoted/context message
    const contextInfo =
      m[type]?.contextInfo ||
      m?.extendedTextMessage?.contextInfo;

    if (!contextInfo || contextInfo.remoteJid !== 'status@broadcast') {
      // Not a status reply — do nothing (don't interrupt normal "send"/"save" usage)
      return;
    }

    const quotedMsg = contextInfo.quotedMessage;
    if (!quotedMsg) return;

    try {
      const quotedType = Object.keys(quotedMsg)[0];
      const mediaData = quotedMsg[quotedType];

      // Text status
      if (quotedType === 'conversation' || quotedType === 'extendedTextMessage') {
        const text = quotedMsg.conversation || quotedMsg.extendedTextMessage?.text;
        return await sock.sendMessage(
          chatId,
          { text: `📝 *Status Text:*\n\n${text}` },
          { quoted: message }
        );
      }

      // Media status
      const stream = await downloadContentFromMessage(
        mediaData,
        quotedType.replace('Message', '') as any
      );

      let buffer = Buffer.from([]);
      for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
      }

      if (quotedType === 'imageMessage') {
        await sock.sendMessage(
          chatId,
          { image: buffer, caption: mediaData.caption || '📸 Status saved!' },
          { quoted: message }
        );
      } else if (quotedType === 'videoMessage') {
        await sock.sendMessage(
          chatId,
          { video: buffer, caption: mediaData.caption || '🎬 Status saved!' },
          { quoted: message }
        );
      } else if (quotedType === 'audioMessage') {
        await sock.sendMessage(
          chatId,
          { audio: buffer, mimetype: 'audio/mp4' },
          { quoted: message }
        );
      } else {
        await sock.sendMessage(
          chatId,
          { text: '❌ Unsupported status type.' },
          { quoted: message }
        );
      }

    } catch (e: any) {
      console.error('[statusdl] Error:', e);
      await sock.sendMessage(
        chatId,
        { text: '❌ Failed to download status. It may have expired.' },
        { quoted: message }
      );
    }
  }
};