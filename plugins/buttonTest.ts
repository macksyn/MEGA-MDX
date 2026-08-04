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
 */

import { cleanJid } from '../lib/isOwner.js';

export const command = 'buttontest';
export const aliases = ['btntest'];
export const category = 'debug';
export const cooldown = 3000;

// ── Pending-response tracking ──────────────────────────────────────────
// Keyed by chatId so we only react to a reply from the same chat where the
// test was triggered. Expires after 2 minutes so a stale listener can't
// misfire on an unrelated message much later.
const PENDING_TTL_MS = 2 * 60_000;
interface PendingTest {
  chatId: string;
  userId: string;
  triggeredAt: number;
}
const pending = new Map<string, PendingTest>();

let listenerRegistered = false;

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

  sock.ev.on('messages.upsert', async (upsert: any) => {
    try {
      const msg = upsert.messages?.[0];
      if (!msg || msg.key?.fromMe) return;

      const chatId = msg.key.remoteJid;
      const test = pending.get(chatId);
      if (!test) return;

      if (Date.now() - test.triggeredAt > PENDING_TTL_MS) {
        pending.delete(chatId);
        return;
      }

      const buttonId = extractButtonReply(msg);
      const plainText = extractPlainText(msg);

      if (!buttonId && !plainText) return;

      // Only react once per pending test.
      pending.delete(chatId);

      let resultLine: string;
      if (buttonId) {
        resultLine = `✅ *Button tap detected!*\nselectedButtonId: \`${buttonId}\``;
      } else {
        const trimmed = (plainText || '').trim();
        if (['1', '2', '3'].includes(trimmed)) {
          resultLine = `⌨️ *Typed number detected* (buttons likely didn't render): \`${trimmed}\``;
        } else {
          resultLine = `❓ Got a reply, but it wasn't a button tap or 1/2/3:\n\`${trimmed}\``;
        }
      }

      // Dump the raw message shape too — this is the actually useful part
      // for figuring out what your Baileys version does, regardless of
      // what the button visually looked like.
      const rawShape = JSON.stringify(msg.message, null, 2).slice(0, 1500);

      await sock.sendMessage(chatId, {
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
  pending.set(chatId, { chatId, userId, triggeredAt: Date.now() });

  const buttons = [
    { buttonId: 'test_opt_1', buttonText: { displayText: '1️⃣ Option One' }, type: 1 },
    { buttonId: 'test_opt_2', buttonText: { displayText: '2️⃣ Option Two' }, type: 1 },
    { buttonId: 'test_opt_3', buttonText: { displayText: '3️⃣ Option Three' }, type: 1 },
  ];

  await sock.sendMessage(chatId, {
    text:
      `🧪 *Button Test*\n\n` +
      `Tap one of the buttons below.\n\n` +
      `_Can't see any buttons? That's useful data too — just reply with_\n` +
      `_the number instead (1, 2, or 3)._`,
    footer: 'Phase 2 menu proof-of-concept — not a real feature',
    buttons,
    headerType: 1,
    ...channelInfo,
  }, { quoted: message });
}

export const handler = _handler;
