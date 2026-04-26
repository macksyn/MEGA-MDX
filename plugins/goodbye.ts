import type { BotContext } from '../types.js';
import { handleGoodbye } from '../lib/welcome.js';
import { isGoodByeOn, getGoodbye } from '../lib/index.js';

// ── Shared helper: resolve LID → real JID, then pull name from store ──────────
// (Same logic as welcome.ts — keep in sync or extract to a shared lib/contactUtil.ts)

function resolveParticipant(raw: any, sock: any): { jid: string; name: string } {
  const jidStr: string =
    typeof raw === 'string' ? raw : (raw?.id ?? String(raw));

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

  const contacts: Record<string, any> = sock?.store?.contacts ?? {};
  const entry = contacts[realJid] ?? contacts[jidStr] ?? {};
  const name: string =
    entry.notify ||
    entry.name   ||
    entry.verifiedName ||
    realJid.split('@')[0].split(':')[0];

  return { jid: realJid, name };
}

// ── Goodbye leave event ───────────────────────────────────────────────────────

async function handleLeaveEvent(sock: any, id: any, participants: any) {
  const isGoodbyeEnabled = await isGoodByeOn(id);
  if (!isGoodbyeEnabled) return;

  const customMessage  = await getGoodbye(id);
  const groupMetadata  = await sock.groupMetadata(id);
  const groupName      = groupMetadata.subject;

  for (const participant of participants) {
    try {
      const { jid: participantJid, name: resolvedName } =
        resolveParticipant(participant, sock);

      const displayName = resolvedName;
      const usePP = customMessage?.includes('{pp}');

      let finalMessage: string;
      if (customMessage) {
        finalMessage = customMessage
          .replace(/{pp}/g, '')
          .replace(/{user}/g, `@${displayName}`)
          .replace(/{group}/g, groupName)
          .trim();
      } else {
        finalMessage = `*@${displayName}* just left ${groupName}!`;
      }

      let profilePicUrl = 'https://img.pyrocdn.com/dbKUgahg.png';
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
            image: buf,
            caption: finalMessage,
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
      console.error('Error sending goodbye message:', error);
      const jidStr: string =
        typeof participant === 'string'
          ? participant
          : (participant?.id ?? String(participant));
      await sock.sendMessage(id, {
        text: `Goodbye @${jidStr.split('@')[0]} 👋`,
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
    const chatId   = context.chatId || message.key.remoteJid;
    const matchText = args.join(' ');
    await handleGoodbye(sock, chatId, message, matchText);
  },

  handleLeaveEvent
};