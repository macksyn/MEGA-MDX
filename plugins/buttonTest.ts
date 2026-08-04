// @ts-nocheck
/***
 * plugins/buttonTest.ts
 *
 * PROOF OF CONCEPT — not a real feature. Testing whether tappable
 * interactive messages (buttons) actually render and round-trip correctly
 * on your WhatsApp/Baileys setup before we commit to building the Phase 2
 * menu system on top of them.
 *
 * Usage: .buttontest
 *
 * ── Read before testing ─────────────────────────────────────────────────
 * WhatsApp has steadily tightened what interactive formats render for
 * non-Business-API / personal-linked-device bots. Baileys' classic
 * `buttonsMessage` format (used below, since it's the simplest to inspect)
 * is widely reported to show up blank or silently fail depending on
 * WhatsApp client version and Baileys version — that's a known ecosystem
 * pain point, not necessarily a bug in this file. This plugin is built to
 * be informative either way:
 *   - If buttons render and you tap one, it confirms the whole loop works.
 *   - If they don't render, just reply with the number instead (1/2/3) —
 *     that path is also being listened for, so we still learn whether the
 *     "catch this specific person's next reply" mechanism itself works,
 *     independent of whether the visual buttons do.
 *   - Either way it dumps the raw incoming message shape back to you, so
 *     we can see exactly what your Baileys version actually hands back
 *     instead of guessing from docs that may be stale.
 *
 * ── Architecture note / assumption I'm flagging ──────────────────────────
 * I don't have visibility into your plugin loader or message router, so I
 * don't know whether it already supports a "wait for this user's next
 * reply" pattern (your exitfeedback plugin suggests it might). Rather than
 * guess at hooking into infrastructure I can't see, this file registers
 * its own lightweight `messages.upsert` listener directly on the first
 * time `.buttontest` runs, using the `sock` instance the loader already
 * gives command handlers. That makes it fully self-contained for testing
 * purposes — but if your router turns out to already have a reply-capture
 * pattern, the real Phase 2 menu system should probably use that instead
 * of this ad-hoc listener, for consistency with the rest of the codebase.
 * ── Update after first live test ─────────────────────────────────────
 * Buttons did NOT render on this setup — confirms the known Baileys/
 * WhatsApp pain point mentioned above. The typed-number fallback DID work.
 * Based on that, this version:
 *   1. Only accepts a typed number if it's sent as a quoted reply to the
 *      specific menu message (not just any message in the chat) — this
 *      also fixes a latent bug where a second concurrent test in the same
 *      chat would've silently overwritten the first (previously keyed by
 *      chatId only; now keyed by the sent message's own id).
 *   2. Expires the pending test after a few minutes of no reply.
 */

import { cleanJid } from '../lib/isOwner.js';

export const command = 'buttontest';
export const aliases = ['btntest'];
export const category = 'debug';
export const cooldown = 3000;

// ── Pending-response tracking ──────────────────────────────────────────
// Keyed by the sent menu message's own id, so concurrent tests (different
// users, or the same user running it twice) never collide with each other.
// A reply only counts if it quotes that exact message AND comes from the
// same user who triggered it.
const PENDING_TTL_MS = 3 * 60_000; // within the requested 2-5 minute window
interface PendingTest {
  chatId: string;
  userId: string;
  triggeredAt: number;
}
const pending = new Map<string, PendingTest>();

let listenerRegistered = false;
let cleanupTimerStarted = false;

function startCleanupSweep() {
  if (cleanupTimerStarted) return;
  cleanupTimerStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const [id, test] of pending.entries()) {
      if (now - test.triggeredAt > PENDING_TTL_MS) pending.delete(id);
    }
  }, 60_000);
}

/** Finds the stanzaId of whatever message this reply is quoting, checking
 *  every content-type shape Baileys might use to carry contextInfo. */
function getQuotedStanzaId(msg: any): string | null {
  const m = msg.message;
  if (!m) return null;
  const candidates = [
    m.extendedTextMessage?.contextInfo,
    m.buttonsResponseMessage?.contextInfo,
    m.listResponseMessage?.contextInfo,
    m.templateButtonReplyMessage?.contextInfo,
    m.conversation ? m.contextInfo : null, // some frameworks hoist contextInfo up a level
  ];
  for (const ctx of candidates) {
    if (ctx?.stanzaId) return ctx.stanzaId;
  }
  return null;
}

function extractButtonReply(msg: any): string | null {
  const m = msg.message;
  if (!m) return null;
  // Classic buttons
  if (m.buttonsResponseMessage?.selectedButtonId) {
    return m.buttonsResponseMessage.selectedButtonId;
  }
  // List messages (in case a future test swaps to list format)
  if (m.listResponseMessage?.singleSelectReply?.selectedRowId) {
    return m.listResponseMessage.singleSelectReply.selectedRowId;
  }
  // Older template button replies
  if (m.templateButtonReplyMessage?.selectedId) {
    return m.templateButtonReplyMessage.selectedId;
  }
  return null;
}

function extractPlainText(msg: any): string | null {
  const m = msg.message;
  if (!m) return null;
  return m.conversation || m.extendedTextMessage?.text || null;
}

function registerListener(sock: any) {
  if (listenerRegistered) return;
  listenerRegistered = true;
  startCleanupSweep();

  sock.ev.on('messages.upsert', async (upsert: any) => {
    try {
      const msg = upsert.messages?.[0];
      if (!msg || msg.key?.fromMe) return;

      const quotedId = getQuotedStanzaId(msg);
      if (!quotedId) return; // not a reply to anything — ignore, per the new requirement

      const test = pending.get(quotedId);
      if (!test) return; // reply to something, but not to a pending menu of ours

      if (Date.now() - test.triggeredAt > PENDING_TTL_MS) {
        pending.delete(quotedId);
        return; // expired — silently ignore rather than resurrect it
      }

      const senderId = cleanJid(msg.key.participant || msg.key.remoteJid);
      if (senderId !== test.userId) return; // quoted the right message, wrong person

      const buttonId = extractButtonReply(msg);
      const plainText = extractPlainText(msg);
      if (!buttonId && !plainText) return;

      // Only react once per pending test.
      pending.delete(quotedId);

      let resultLine: string;
      if (buttonId) {
        resultLine = `✅ *Button tap detected!*\nselectedButtonId: \`${buttonId}\``;
      } else {
        const trimmed = (plainText || '').trim();
        if (['1', '2', '3'].includes(trimmed)) {
          resultLine = `⌨️ *Quoted-reply number detected* (buttons likely didn't render): \`${trimmed}\``;
        } else {
          resultLine = `❓ Got a quoted reply, but it wasn't a button tap or 1/2/3:\n\`${trimmed}\``;
        }
      }

      // Dump the raw message shape too — this is the actually useful part
      // for figuring out what your Baileys version does, regardless of
      // what the button visually looked like.
      const rawShape = JSON.stringify(msg.message, null, 2).slice(0, 1500);

      await sock.sendMessage(test.chatId, {
        text:
          `🧪 *Button Test Result*\n\n` +
          `${resultLine}\n\n` +
          `Raw \`message\` object (truncated):\n\`\`\`${rawShape}\`\`\``,
      });
    } catch (err) {
      console.error('[buttonTest] listener error:', err);
    }
  });
}

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, senderId, channelInfo } = context;
  const userId = cleanJid(senderId);

  registerListener(sock);

  const buttons = [
    { buttonId: 'test_opt_1', buttonText: { displayText: '1️⃣ Option One' }, type: 1 },
    { buttonId: 'test_opt_2', buttonText: { displayText: '2️⃣ Option Two' }, type: 1 },
    { buttonId: 'test_opt_3', buttonText: { displayText: '3️⃣ Option Three' }, type: 1 },
  ];

  const sent = await sock.sendMessage(chatId, {
    text:
      `🧪 *Button Test*\n\n` +
      `Tap one of the buttons below.\n\n` +
      `_Can't see any buttons? Reply directly to *this message*_\n` +
      `_(swipe or long-press → Reply) with the number instead —_\n` +
      `_1, 2, or 3. Only counts if it quotes this exact message._\n\n` +
      `_Expires in a few minutes if no reply comes._`,
    footer: 'Phase 2 menu proof-of-concept — not a real feature',
    buttons,
    headerType: 1,
    ...channelInfo,
  }, { quoted: message });

  const menuMessageId = sent?.key?.id;
  if (menuMessageId) {
    pending.set(menuMessageId, { chatId, userId, triggeredAt: Date.now() });
  }
}

export const handler = _handler;