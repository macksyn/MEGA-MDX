import type { BotContext } from '../types.js';
import { handleGoodbye } from '../lib/welcome.js';
import { isGoodByeOn, getGoodbye } from '../lib/index.js';
import { resolveParticipant, getCachedGroupMeta } from '../lib/contactUtil.js';

// ── Goodbye leave event ───────────────────────────────────────────────────────

async function handleLeaveEvent(sock: any, id: any, participants: any) {
  const isGoodbyeEnabled = await isGoodByeOn(id);
  if (!isGoodbyeEnabled) return;

  const customMessage = await getGoodbye(id);
  const groupMetadata  = await getCachedGroupMeta(sock, id);
  if (!groupMetadata) return;

  const groupName   = groupMetadata.subject;
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
          .replace(/{pp}/g,    '')
          .replace(/{user}/g,  `@${phoneNumber}`)
          .replace(/{group}/g, groupName)
          .replace(/{count}/g, String(memberCount))
          .trim();
      } else {
        finalMessage = `*@${phoneNumber}* just left *${groupName}*! 👋`;
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
        } catch { /* fall through */ }
      }

      // Try the goodbye banner API
      try {
        const apiUrl =
          `https://api.some-random-api.com/welcome/img/2/gaming1` +
          `?type=leave&textcolor=red` +
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
      console.error('Error sending goodbye message:', error);
      const jidStr: string =
        typeof participant === 'string'
          ? participant
          : (participant?.id ?? String(participant));
      await sock.sendMessage(id, {
        text:     `Goodbye @${jidStr.split('@')[0]} 👋`,
        mentions: [jidStr]
      });
    }
  }
}

export default {
  command: 'goodbye',
  aliases: ['bye', 'leave'],
  category: 'admin',
  description: 'Configure goodbye messages for leaving members',
  usage: '.goodbye <on|off|set message>',
  groupOnly: true,
  adminOnly: true,

  async handler(sock: any, message: any, args: any, context: BotContext) {
    const chatId    = context.chatId || message.key.remoteJid;
    const matchText = args.join(' ');
    await handleGoodbye(sock, chatId, message, matchText);
  },

  handleLeaveEvent
};
