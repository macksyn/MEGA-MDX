import type { BotContext } from '../types.js';
import { handleWelcome } from '../lib/welcome.js';
import { isWelcomeOn, getWelcome } from '../lib/index.js';
import { resolveParticipant, getCachedGroupMeta } from '../lib/contactUtil.js';

export default {
  command: 'welcome',
  aliases: ['setwelcome'],
  category: 'admin',
  description: 'Configure welcome message for the group',
  usage: '.welcome [on/off/set/off]',
  groupOnly: true,
  adminOnly: true,

  async handler(sock: any, message: any, args: any, context: BotContext) {
    const { chatId } = context;
    const matchText = args.join(' ');
    await handleWelcome(sock, chatId, message, matchText);
  }
};

// ── Welcome join event ────────────────────────────────────────────────────────

async function handleJoinEvent(sock: any, id: any, participants: any) {
  const isWelcomeEnabled = await isWelcomeOn(id);
  if (!isWelcomeEnabled) return;

  const customMessage  = await getWelcome(id);
  const groupMetadata  = await getCachedGroupMeta(sock, id);
  if (!groupMetadata) return;

  const groupName  = groupMetadata.subject;
  const groupDesc  = groupMetadata.desc || 'No description available';
  const memberCount = groupMetadata.participants.length;

  for (const participant of participants) {
    try {
      const { jid: participantJid, name: displayName, phoneNumber } =
        resolveParticipant(participant, sock);

      const usePP = customMessage?.includes('{pp}');

      let finalMessage: string;
      if (customMessage) {
        // {user} → @phoneNumber so WhatsApp renders a tappable mention link
        finalMessage = customMessage
          .replace(/{pp}/g,          '')
          .replace(/{user}/g,        `@${phoneNumber}`)
          .replace(/{group}/g,       groupName)
          .replace(/{description}/g, groupDesc)
          .replace(/{count}/g,       String(memberCount))
          .trim();
      } else {
        const now = new Date();
        const timeString = now.toLocaleString('en-US', {
          month: '2-digit', day: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
        });
        // Use @phoneNumber for the mention text — WhatsApp shows it as displayName
        finalMessage =
          `╭╼━≪•𝙽𝙴𝚆 𝙼𝙴𝙼𝙱𝙴𝚁•≫━╾╮\n` +
          `┃𝚆𝙴𝙻𝙲𝙾𝙼𝙴: @${phoneNumber} 👋\n` +
          `┃Member count: #${memberCount}\n` +
          `┃𝚃𝙸𝙼𝙴: ${timeString}⏰\n` +
          `╰━━━━━━━━━━━━━━━╯\n\n` +
          `*@${phoneNumber}* Welcome to *${groupName}*! 🎉\n` +
          `*Group 𝙳𝙴𝚂𝙲𝚁𝙸𝙿𝚃𝙸𝙾𝙽*\n${groupDesc}\n\n` +
          `> *ᴘᴏᴡᴇʀᴇᴅ ʙʏ *GROQ-AI*`;
      }

      let profilePicUrl = 'https://iili.io/BspSjGp.jpg';
      try {
        const pp = await sock.profilePictureUrl(participantJid, 'image');
        if (pp) profilePicUrl = pp;
      } catch { /* use default */ }

      if (usePP) {
        try {
          const buf = Buffer.from(
            await (await fetch(profilePicUrl)).arrayBuffer()
          );
          await sock.sendMessage(id, {
            image:    buf,
            caption:  finalMessage,
            mentions: [participantJid]
          });
          continue;
        } catch { /* fall through to generated image */ }
      }

      // Try the welcome banner API
      try {
        const apiUrl =
          `https://api.some-random-api.com/welcome/img/2/gaming3` +
          `?type=join&textcolor=green` +
          `&username=${encodeURIComponent(displayName)}` +
          `&guildName=${encodeURIComponent(groupName)}` +
          `&memberCount=${memberCount}` +
          `&avatar=${encodeURIComponent(profilePicUrl)}`;

        const res = await fetch(apiUrl);
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          await sock.sendMessage(id, {
            image:    buf,
            caption:  finalMessage,
            mentions: [participantJid]
          });
          continue;
        }
      } catch { /* fall through to plain text */ }

      // Plain-text fallback
      await sock.sendMessage(id, {
        text:     finalMessage,
        mentions: [participantJid]
      });

    } catch (error: any) {
      console.error('Error sending welcome message:', error);
      const jidStr: string =
        typeof participant === 'string'
          ? participant
          : (participant?.id ?? String(participant));
      const num = jidStr.split('@')[0];
      await sock.sendMessage(id, {
        text:     `Welcome @${num} to ${groupName}! 🎉`,
        mentions: [jidStr]
      });
    }
  }
}

export { handleJoinEvent };
