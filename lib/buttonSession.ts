// @ts-nocheck
/***
 * lib/buttonSession.ts
 *
 * Drop-in replacement for lib/menuSession.ts's promptMenu(), built on
 * gifted-btns instead of "type a number and reply". Same function name,
 * same call signature, same MenuResult shape — so any plugin currently
 * doing:
 *
 *   import { promptMenu } from '../lib/menuSession.js';
 *
 * can switch to:
 *
 *   import { promptMenu } from '../lib/buttonSession.js';
 *
 * with no other changes, and switch back just as easily if a given menu
 * doesn't render well as buttons. Keep menuSession.ts around — this is
 * not a replacement for it project-wide, it's an alternative per plugin
 * (or even per-menu) until buttons are proven reliable everywhere you'd
 * want them.
 *
 * ── What's confirmed vs experimental (as of the on-device test today) ──
 *
 * CONFIRMED (real device, real tap, real round-trip):
 *   - gifted-btns' sendButtons() with quick_reply buttons renders and
 *     taps come back as a `templateButtonReplyMessage`.
 *   - Tested with exactly 3 buttons, no cancel button added on top.
 *
 * NOT YET CONFIRMED — treat as experimental until you've tested it live:
 *   - single_select (list) rendering via sendInteractiveMessage. The
 *     gifted-btns README documents it and it's used for the >3-option
 *     path below, but nobody has tapped one yet on this bot.
 *   - The incoming shape for a single_select tap. Based on standard
 *     Baileys message types this SHOULD be
 *     `message.listResponseMessage.singleSelectReply.selectedRowId`,
 *     but that's inference from general Baileys API shape, not something
 *     pulled from your actual messageHandler.ts or a real captured tap.
 *   - Whether 3 quick_reply buttons is really the practical ceiling, or
 *     4+ also renders fine. Picked 3 to match WhatsApp's long-standing
 *     classic button limit and because that's exactly what was proven
 *     today — not because 4 is confirmed to fail.
 *
 * If a single_select menu doesn't render, or a tap on one doesn't
 * resolve the prompt, that's this module's untested path failing, not
 * evidence that buttons don't work at all — the quick_reply path stays
 * solid regardless.
 *
 * ── Design notes carried over from menuSession.ts ───────────────────
 * - One listener per sock (WeakSet-guarded), shared across all plugins
 *   using this module.
 * - Pending prompts keyed by the sent message's own id. Matched to a
 *   reply via contextInfo.stanzaId, same as menuSession — WhatsApp
 *   button/list replies carry contextInfo just like quoted text replies.
 * - A reply only resolves the prompt if it's actually a response to
 *   that exact message. Anything else is ignored, not consumed.
 * - Cancel is automatic: a "❌ Cancel" option is appended for you: as a
 *   quick_reply button in the small-menu case, as an extra row in the
 *   single_select case. Don't add your own cancel entry in `options`.
 * - Default TTL is 3 minutes, same as menuSession. Override with ttlMs.
 * - Unrecognized/malformed taps get logged in full (not just a type
 *   name) so a future mismatch can be diagnosed from one log line
 *   instead of another multi-round guessing loop.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { sendButtons, sendInteractiveMessage } = require('gifted-btns');
// gifted-btns v1.0.2 confirmed CJS-only — see plugins/testbuttons.ts for
// how this was verified (require('gifted-btns') dump, no dependencies,
// {valid,errors,warnings} validator shape, etc.)

import { cleanJid } from './isOwner.js';

export interface MenuOption {
  label: string;
  value: string;
  description?: string; // only shown in the single_select (list) path — quick_reply buttons have no room for it
}

export interface MenuPromptConfig {
  title?: string;
  subtitle?: string;
  text: string;
  options: MenuOption[];
  footer?: string;
  ttlMs?: number;
  cancelLabel?: string;
  extra?: Record<string, any>; // NOTE: unlike menuSession, this is not currently merged into the send payload — see promptMenu() below
}

export interface MenuResult {
  value: string | null;
  timedOut: boolean;
  cancelled: boolean;
}

const DEFAULT_TTL_MS = 3 * 60_000;

// Confirmed ceiling for the quick_reply path: proven at exactly 3 buttons
// today. Cancel counts toward this total, so options.length must be <= 2
// to stay on the confirmed path once cancel is added.
const QUICK_REPLY_MAX_TOTAL_BUTTONS = 3;

interface PendingPrompt {
  chatId: string;
  userId: string;
  options: MenuOption[];
  resolve: (result: MenuResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingPrompt>(); // keyed by the sent message's own id
const registeredSocks = new WeakSet<any>();

function getContextInfo(msg: any): any {
  const m = msg.message;
  if (!m) return null;
  return (
    m.templateButtonReplyMessage?.contextInfo ||   // CONFIRMED shape for quick_reply taps (tested today)
    m.buttonsResponseMessage?.contextInfo ||        // legacy buttonsMessage shape, not yet seen on this bot
    m.listResponseMessage?.contextInfo ||           // single_select shape, UNCONFIRMED on this bot
    m.interactiveResponseMessage?.contextInfo ||    // native_flow generic shape, UNCONFIRMED on this bot
    m.extendedTextMessage?.contextInfo ||           // in case someone replies to the button msg with plain text instead
    null
  );
}

/**
 * Pulls the selected option's id (the string we encoded as opt_N or
 * "cancel") out of whichever response shape actually arrived.
 * Returns null if the shape isn't recognized — caller should log the
 * raw message in that case rather than silently drop it.
 */
function extractSelectedId(msg: any): string | null {
  const m = msg.message;
  if (!m) return null;

  // CONFIRMED today: quick_reply tap -> templateButtonReplyMessage.selectedId
  if (m.templateButtonReplyMessage?.selectedId) {
    return m.templateButtonReplyMessage.selectedId;
  }

  // Standard Baileys shape for buttonsMessage taps — not yet seen on this
  // bot, included defensively in case a future WhatsApp/Baileys update
  // changes which shape gets used for the same quick_reply buttons.
  if (m.buttonsResponseMessage?.selectedButtonId) {
    return m.buttonsResponseMessage.selectedButtonId;
  }

  // UNCONFIRMED: standard Baileys shape for a list/single_select tap.
  if (m.listResponseMessage?.singleSelectReply?.selectedRowId) {
    return m.listResponseMessage.singleSelectReply.selectedRowId;
  }

  // UNCONFIRMED: generic native_flow response — paramsJson is a JSON
  // string, typically { id: '...' } for quick_reply-shaped responses
  // coming back through this wrapper.
  const nativeFlowParams = m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (nativeFlowParams) {
    try {
      const parsed = JSON.parse(nativeFlowParams);
      if (parsed?.id) return parsed.id;
    } catch {
      // fall through to null
    }
  }

  return null;
}

function registerListener(sock: any) {
  if (registeredSocks.has(sock)) return;
  registeredSocks.add(sock);

  sock.ev.on('messages.upsert', async (upsert: any) => {
    try {
      const msg = upsert.messages?.[0];
      if (!msg || msg.key?.fromMe) return;

      const contextInfo = getContextInfo(msg);
      const quotedId = contextInfo?.stanzaId;
      if (!quotedId) return;

      const prompt = pending.get(quotedId);
      if (!prompt) return;

      const senderId = cleanJid(msg.key.participant || msg.key.remoteJid);
      if (senderId !== prompt.userId) return; // right menu, wrong person — ignore, don't consume

      const selectedId = extractSelectedId(msg);

      if (!selectedId) {
        // Quoted/replied to our menu, but in a shape we don't recognize.
        // Log the raw payload so a future fix here is a one-line lookup,
        // not another multi-message guessing session.
        console.warn(
          '[buttonSession] unrecognized response shape for a pending prompt — raw message:',
          JSON.stringify(msg.message, null, 2)
        );
        return; // don't consume — let it time out or let a valid reply come in
      }

      if (selectedId === 'cancel') {
        clearTimeout(prompt.timer);
        pending.delete(quotedId);
        prompt.resolve({ value: null, timedOut: false, cancelled: true });
        return;
      }

      const match = selectedId.match(/^opt_(\d+)$/);
      const idx = match ? parseInt(match[1], 10) : NaN;

      if (isNaN(idx) || idx < 0 || idx >= prompt.options.length) {
        console.warn(`[buttonSession] got selectedId "${selectedId}" that doesn't match any known option — ignoring.`);
        return;
      }

      clearTimeout(prompt.timer);
      pending.delete(quotedId);
      prompt.resolve({ value: prompt.options[idx].value, timedOut: false, cancelled: false });
    } catch (err) {
      console.error('[buttonSession] listener error:', err);
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
  const cancelLabel = config.cancelLabel || '❌ Cancel';
  const minutes = Math.round(ttlMs / 60_000);
  const footer = config.footer || `Expires in ${minutes} min${minutes === 1 ? '' : 's'}`;

  const bodyLines: string[] = [];
  if (config.title) bodyLines.push(`*${config.title}*`);
  if (config.subtitle) bodyLines.push(`_${config.subtitle}_`);
  bodyLines.push(config.text);
  const bodyText = bodyLines.join('\n');

  const totalWithCancel = config.options.length + 1;
  const useQuickReply = totalWithCancel <= QUICK_REPLY_MAX_TOTAL_BUTTONS;

  let sent: any;

  if (useQuickReply) {
    // CONFIRMED PATH — same shape proven in plugins/testbuttons.ts.
    const buttons = config.options.map((o, i) => ({ id: `opt_${i}`, text: o.label }));
    buttons.push({ id: 'cancel', text: cancelLabel });

    sent = await sendButtons(sock, chatId, {
      text: bodyText,
      footer,
      buttons,
    }, { quoted: message });
  } else {
    // EXPERIMENTAL PATH — sends fine per gifted-btns' docs, but the
    // incoming tap shape (listResponseMessage.singleSelectReply) is NOT
    // yet confirmed on this bot. If prompts using this path never
    // resolve (always time out despite a visible tap), check the
    // console.warn log this listener prints for the actual raw shape,
    // and fix extractSelectedId() above to match it.
    const rows = config.options.map((o, i) => ({
      id: `opt_${i}`,
      title: o.label,
      description: o.description,
    }));
    rows.push({ id: 'cancel', title: cancelLabel });

    sent = await sendInteractiveMessage(sock, chatId, {
      text: bodyText,
      footer,
      interactiveButtons: [
        {
          name: 'single_select',
          buttonParamsJson: JSON.stringify({
            title: config.title || 'Choose an option',
            sections: [{ title: 'Options', rows }],
          }),
        },
      ],
    }, { quoted: message });
  }

  const promptMessageId = sent?.key?.id;

  return new Promise<MenuResult>((resolve) => {
    if (!promptMessageId) {
      // Couldn't get a message id back — nothing to key a reply to, fail closed.
      resolve({ value: null, timedOut: true, cancelled: false });
      return;
    }
    const timer = setTimeout(() => {
      pending.delete(promptMessageId);
      resolve({ value: null, timedOut: true, cancelled: false });
    }, ttlMs);
    pending.set(promptMessageId, { chatId, userId, options: config.options, resolve, timer });
  });
}
