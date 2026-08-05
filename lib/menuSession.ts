// @ts-nocheck
/***
 * lib/menuSession.ts
 *
 * Shared "type a number, reply to the menu" session system — the pattern
 * validated in plugins/buttonTest.ts, generalized so any plugin can use it
 * instead of typing full commands from memory.
 *
 * Confirmed on this setup: native WhatsApp buttons don't render reliably
 * (known Baileys/WhatsApp limitation for non-Business-API bots), but a
 * typed-number reply that quotes the menu message works cleanly. This
 * module is built on that confirmed path, not on buttons.
 *
 * Renders a clean USSD-style numbered list (keycap digits, thin dividers,
 * optional subtitle/description lines) since that's the format people
 * already instinctively know how to answer.
 *
 * ── Usage ────────────────────────────────────────────────────────────
 *   import { promptMenu } from '../lib/menuSession.js';
 *
 *   const result = await promptMenu(sock, message, chatId, userId, {
 *     title: '💹 FOREX',
 *     subtitle: 'Balance: 12,400 coins',
 *     text: 'What would you like to do?',
 *     options: [
 *       { label: 'Place a trade', value: 'trade', description: 'Open a new position' },
 *       { label: 'Check prices', value: 'prices' },
 *     ],
 *   });
 *
 *   if (result.cancelled) { ... }
 *   else if (result.timedOut) { ... }
 *   else { // result.value === 'trade' | 'prices' }
 *
 * Chain multiple calls with plain await for multi-step flows (pick pair,
 * then direction, then bet) — no extra state machinery needed, since each
 * `promptMenu` call already blocks until that step's answer comes in.
 *
 * ── Design notes / limits worth knowing ──────────────────────────────
 * - One listener is registered on the `sock` instance the first time
 *   promptMenu is called; it's shared across every plugin using this
 *   module, not one-per-plugin. Matching is by the sent menu message's own
 *   id + the requesting user's id, so concurrent prompts (different users,
 *   different plugins, even the same user in two chats) can't collide.
 * - A reply only counts if it quotes the exact menu message. Anything else
 *   (a reply to a different message, an un-quoted message, a different
 *   sender) is ignored, not consumed — so it can't accidentally eat a
 *   pending prompt somewhere else.
 * - Replying "0" or "cancel" resolves with `cancelled: true`.
 * - An invalid-but-quoted reply (wrong number, gibberish) does NOT consume
 *   the prompt — it gets a quick nudge and can still answer before the TTL.
 * - Default TTL is 3 minutes; pass `ttlMs` to override per-call.
 * - This module only handles numbered *selection*. Free-text input (a URL,
 *   a name, an amount) isn't in scope here by design — collect that with a
 *   normal command argument, then use promptMenu for whatever's left that's
 *   a pick-from-a-list decision.
 */

import { cleanJid } from './isOwner.js';

export interface MenuOption {
  label: string;
  value: string;
  /** Short USSD-style sub-line shown under the option, e.g. "Delete + warn". */
  description?: string;
}

export interface MenuPromptConfig {
  title?: string;
  /** One-line status/context shown under the title, e.g. "Status: ✅ Enabled". */
  subtitle?: string;
  text: string;
  options: MenuOption[];
  footer?: string;
  ttlMs?: number;
  /** Custom label for the cancel line. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Merged into the sendMessage payload (e.g. channelInfo). */
  extra?: Record<string, any>;
}

export interface MenuResult {
  value: string | null;
  timedOut: boolean;
  cancelled: boolean;
}

const DEFAULT_TTL_MS = 3 * 60_000; // within the validated 2-5 minute window
const DIVIDER = '┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄';

interface PendingPrompt {
  chatId: string;
  userId: string;
  options: MenuOption[];
  resolve: (result: MenuResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingPrompt>(); // keyed by the sent menu message's own id
let listenerRegistered = false;

const KEYCAP_DIGITS: Record<string, string> = {
  '0': '0️⃣', '1': '1️⃣', '2': '2️⃣', '3': '3️⃣', '4': '4️⃣',
  '5': '5️⃣', '6': '6️⃣', '7': '7️⃣', '8': '8️⃣', '9': '9️⃣',
};

/** Renders any non-negative integer as concatenated keycap digits (works past 9, unlike a single "N️⃣"). */
function keycapNumber(n: number): string {
  return String(n).split('').map(d => KEYCAP_DIGITS[d] ?? d).join('');
}

function buildMenuText(config: MenuPromptConfig, ttlMs: number): string {
  const minutes = Math.round(ttlMs / 60_000);
  const cancelLabel = config.cancelLabel || 'Cancel';

  const lines: string[] = [];

  if (config.title) lines.push(`*${config.title}*`);
  if (config.subtitle) lines.push(`_${config.subtitle}_`);
  if (config.title || config.subtitle) lines.push(DIVIDER);

  lines.push(config.text, '');

  config.options.forEach((o, i) => {
    lines.push(`${keycapNumber(i + 1)}  *${o.label}*`);
    if (o.description) lines.push(`     ${o.description}`);
  });

  lines.push('', DIVIDER);
  lines.push(`↩️ _Reply to this message with a number_`);
  lines.push(`${keycapNumber(0)} ${cancelLabel}   ⏳ Expires in ${minutes} min${minutes === 1 ? '' : 's'}`);

  return lines.join('\n');
}

function getQuotedStanzaId(msg: any): string | null {
  const m = msg.message;
  if (!m) return null;
  const candidates = [
    m.extendedTextMessage?.contextInfo,
    m.buttonsResponseMessage?.contextInfo,
    m.listResponseMessage?.contextInfo,
    m.templateButtonReplyMessage?.contextInfo,
  ];
  for (const ctx of candidates) {
    if (ctx?.stanzaId) return ctx.stanzaId;
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

      const quotedId = getQuotedStanzaId(msg);
      if (!quotedId) return;

      const prompt = pending.get(quotedId);
      if (!prompt) return;

      const senderId = cleanJid(msg.key.participant || msg.key.remoteJid);
      if (senderId !== prompt.userId) return; // right menu, wrong person — ignore, don't consume

      const text = (extractPlainText(msg) || '').trim().toLowerCase();
      if (!text) return;

      if (text === '0' || text === 'cancel') {
        clearTimeout(prompt.timer);
        pending.delete(quotedId);
        prompt.resolve({ value: null, timedOut: false, cancelled: true });
        return;
      }

      const n = parseInt(text, 10);
      if (isNaN(n) || n < 1 || n > prompt.options.length) {
        // Quoted our menu, but not a valid choice — nudge, don't consume.
        await sock.sendMessage(prompt.chatId, {
          text: `❓ Reply with a number from *1* to *${prompt.options.length}* (or *0* to cancel).`,
        });
        return;
      }

      clearTimeout(prompt.timer);
      pending.delete(quotedId);
      prompt.resolve({ value: prompt.options[n - 1].value, timedOut: false, cancelled: false });
    } catch (err) {
      console.error('[menuSession] listener error:', err);
    }
  });
}

export async function promptMenu(
  sock: any,
  message: any,
  chatId: string,
  userId: string,
  config: MenuPromptConfig
): Promise<MenuResult> {
  registerListener(sock);

  const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;

  const sent = await sock.sendMessage(chatId, {
    text: buildMenuText(config, ttlMs),
    footer: config.footer,
    ...(config.extra || {}),
  }, { quoted: message });

  const menuMessageId = sent?.key?.id;

  return new Promise<MenuResult>((resolve) => {
    if (!menuMessageId) {
      // Couldn't get a message id back — nothing to key a reply to, fail closed.
      resolve({ value: null, timedOut: true, cancelled: false });
      return;
    }
    const timer = setTimeout(() => {
      pending.delete(menuMessageId);
      resolve({ value: null, timedOut: true, cancelled: false });
    }, ttlMs);
    pending.set(menuMessageId, { chatId, userId, options: config.options, resolve, timer });
  });
}