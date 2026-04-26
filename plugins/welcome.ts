import type { BotContext } from '../types.js';
import { handleWelcome } from '../lib/welcome.js';
import { isWelcomeOn, getWelcome } from '../lib/index.js';

export default {
  command: 'welcome',
  aliases: ['setwelcome'],
  category: 'admin',
  description: 'Configure welcome message for the group',
  usage: '.welcome [on/off/message]',
  groupOnly: true,
  adminOnly: true,

  async handler(sock: any, message: any, args: any, context: BotContext) {
    const { chatId } = context;
    const matchText = args.join(' ');
    await handleWelcome(sock, chatId, message, matchText);
  }
};

// ── Shared helper: resolve LID → real JID, then pull name from store ──────────

function resolveParticipant(raw: any, sock: any): { jid: string; name: string } {
  const jidStr: string =
    typeof raw === 'string' ? raw : (raw?.id ?? String(raw));

  // Step 1: if it's a @lid, try to find the real @s.whatsapp.net JID in contacts
  let realJid = jidStr;
  if (jidStr.includes('@lid') && sock?.store?.contacts) {
    const contacts: Record<string, any> = sock.store.contacts;
    const lidNumeric = jidStr.split('@')[0].split(':')[0];

    const resolved = Object.keys(contacts).find(k => {
      if (!k.includes('@s.whatsapp.net')) return false;
      const c = contacts[k];
      const cLid: string = c?.lid ?? '';
      return (
        cLid === jidStr ||
        cLid.split('@')[0].split(':')[0] === lidNumeric
      );
    });

    if (resolved) realJid = resolved;
  }

  // Step 2: look up a human name from the contacts store
  const contacts: Record<string, any> = sock?.store?.contacts ?? {};
  const entry = contacts[realJid] ?? contacts[jidStr] ?? {};
  const name: string =
    entry.notify ||
    entry.name   ||
    entry.verifiedName ||
    realJid.split('@')[0].split(':')[0]; // phone number fallback

  return { jid: realJid, name };
}

// ── Welcome join event ────────────────────────────────────────────────────────

async function handleJoinEvent(sock: any, id: any, participants: any) {
  const isWelcomeEnabled = await isWelcomeOn(id);
  if (!isWelcomeEnabled) return;

  const customMessage = await getWelcome(id);
  const groupMetadata  = await sock.groupMetadata(id);
  const groupName      = groupMetadata.subject;
  const groupDesc      = groupMetadata.desc || 'No description available';

  for (const participant of participants) {
    try {
      const { jid: participantJid, name: resolvedName } =
        resolveParticipant(participant, sock);

      // Final display name: prefer resolved contact name, fall back to phone number
      const displayName = resolvedName;
      const phoneNumber = participantJid.split('@')[0].split(':')[0];

      const usePP = customMessage?.includes('{pp}');

      let finalMessage: string;
      if (customMessage) {
        finalMessage = customMessage
          .replace(/{pp}/g, '')
          .replace(/{user}/g, `@${displayName}`)
          .replace(/{group}/g, groupName)
          .replace(/{description}/g, groupDesc)
          .trim();
      } else {
        const now = new Date();
        const timeString = now.toLocaleString('en-US', {
          month: '2-digit', day: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
        });
        finalMessage =
          `╭╼━≪•𝙽𝙴𝚆 𝙼𝙴𝙼𝙱𝙴𝚁•≫━╾╮\n` +
          `┃𝚆𝙴𝙻𝙲𝙾𝙼𝙴: @${displayName} 👋\n` +
          `┃Member count: #${groupMetadata.participants.length}\n` +
          `┃𝚃𝙸𝙼𝙴: ${timeString}⏰\n` +
          `╰━━━━━━━━━━━━━━━╯\n\n` +
          `*@${displayName}* Welcome to *${groupName}*! 🎉\n` +
          `*Group 𝙳𝙴𝚂𝙲𝚁𝙸𝙿𝚃𝙸𝙾𝙽*\n${groupDesc}\n\n` +
          `> *ᴘᴏᴡᴇʀᴇᴅ ʙʏ *GROQ-AI*`;
      }

      let profilePicUrl = 'https://img.pyrocdn.com/dbKUgahg.png';
      try {
        const pp = await sock.profilePictureUrl(participantJid, 'image');
        if (pp) profilePicUrl = pp;
      } catch { /* use default */ }

      if (usePP) {
        // User explicitly wants the raw profile picture
        try {
          const buf = Buffer.from(
            await (await fetch(profilePicUrl)).arrayBuffer()
          );
          await sock.sendMessage(id, {
            image: buf,
            caption: finalMessage,
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
          `&memberCount=${groupMetadata.participants.length}` +
          `&avatar=${encodeURIComponent(profilePicUrl)}`;

        const res = await fetch(apiUrl);
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          await sock.sendMessage(id, {
            image: buf,
            caption: finalMessage,
            mentions: [participantJid]
          });
          continue;
        }
      } catch { /* fall through to plain text */ }

      // Plain-text fallback
      await sock.sendMessage(id, {
        text: finalMessage,
        mentions: [participantJid]
      });

    } catch (error: any) {
      console.error('Error sending welcome message:', error);
      // Bare-minimum fallback
      const jidStr: string =
        typeof participant === 'string'
          ? participant
          : (participant?.id ?? String(participant));
      await sock.sendMessage(id, {
        text: `Welcome @${jidStr.split('@')[0]}  to ${groupName}! 🎉`,
        mentions: [jidStr]
      });
    }
  }
}

export { handleJoinEvent };