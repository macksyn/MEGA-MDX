// @ts-nocheck
/***
 * lib/bankUi.ts
 *
 * Screen router for the bank app, built on lib/buttonSession.ts's promptMenu.
 * buttonSession is one-shot ("send a menu, await one tap"); a banking app is
 * a NAVIGATION: home -> deposit -> amount -> back home with a receipt. This
 * module is that loop, so each feature just declares screens:
 *
 *   view(ctx, params)            -> what to show (text + button options)
 *   select(value, ctx, params)   -> where to go next
 *
 * Navigation results (return one from select()):
 *   { go: 'deposit', params?, reset?, notice? }  push a screen (reset:true = clear the stack first)
 *   { back: true, notice? }                      pop one screen
 *   { stay: true, notice? }                      re-render this screen
 *   { exit: true }                               end the session
 * `notice` is a one-line receipt/error prepended to the NEXT screen, so one
 * step = one message instead of a result message plus a menu message.
 *
 * Back is appended automatically below the root screen; Cancel is appended by
 * promptMenu. Don't add either yourself.
 *
 * Swapping menu backend: the import below can point at lib/menuSession.js
 * (numbered replies) — same promptMenu signature — if list menus misbehave.
 */
import { promptMenu, type MenuOption } from './buttonSession.js';
import { cleanJid } from './isOwner.js';
import config from '../config.js';

export interface BankCtx {
  sock: any;
  message: any;
  chatId: string;
  userId: string;       // cleanJid(senderId) — the wallet/account key
  channelInfo: any;
  notice?: string;
  fallbackHint?: string; // plain-text hint if the very first menu cannot be sent (defaults to the bank commands)
}

export interface ScreenView {
  title: string;       // also the label on the list-menu button, so keep it SHORT (~20 chars)
  subtitle?: string;
  text: string;
  footer?: string;     // overrides the default "Expires in N mins" footer
  options: MenuOption[];
}

export type Nav =
  | { go: string; params?: any; reset?: boolean; notice?: string }
  | { back: true; notice?: string }
  | { stay: true; notice?: string }
  | { exit: true };

export interface Screen {
  view(ctx: BankCtx, params?: any): Promise<ScreenView>;
  select(value: string, ctx: BankCtx, params?: any): Promise<Nav>;
}

const BACK = '__back__';
const MAX_STEPS = 40;          // runaway-loop guard
const SCREEN_TTL_MS = 3 * 60_000;

export async function runApp(ctx: BankCtx, screens: Record<string, Screen>, start: string): Promise<void> {
  const stack: Array<{ id: string; params?: any }> = [{ id: start }];
  let lastView: ScreenView | null = null;
  let anyMenuSent = false;

  try {
    for (let step = 0; step < MAX_STEPS && stack.length > 0; step++) {
      const top = stack[stack.length - 1];
      const screen = screens[top.id];
      if (!screen) throw new Error(`unknown bank screen "${top.id}"`);

      const view = await screen.view(ctx, top.params);
      lastView = view;
      const options = [...view.options];
      if (stack.length > 1) options.push({ label: '⬅️ Back', value: BACK });

      const text = ctx.notice ? `${ctx.notice}\n\n${view.text}` : view.text;
      ctx.notice = undefined;

      const res = await promptMenu(ctx.sock, ctx.message, ctx.chatId, ctx.userId, {
        title: view.title,
        subtitle: view.subtitle,
        text,
        options,
        footer: view.footer,
        ttlMs: SCREEN_TTL_MS,
      });
      anyMenuSent = true;

      if (res.cancelled || res.timedOut || res.value == null) return;
      if (res.value === BACK) { stack.pop(); continue; }

      const nav = await screen.select(res.value, ctx, top.params);

      if ('exit' in nav) return;
      if ('notice' in nav && nav.notice) ctx.notice = nav.notice;
      if ('back' in nav) { stack.pop(); continue; }
      if ('go' in nav) {
        if (nav.reset) stack.length = 0;
        stack.push({ id: nav.go, params: nav.params });
      }
      // { stay } falls through and re-renders the same screen
    }
  } catch (err: any) {
    console.error('[bank/ui] session error:', err);
    const prefix = config.prefix || '.';

    // The very first menu failed to send (button transport problem). Players are used to typing
    // "bank" to read the reserve, so still show them the board as plain text instead of an error.
    if (!anyMenuSent && lastView) {
      const plain =
        `*${lastView.title}*\n` + (lastView.subtitle ? `_${lastView.subtitle}_\n` : '') + `\n${lastView.text}\n\n` +
        `_${ctx.fallbackHint || `Menu buttons are unavailable right now — use *${prefix}bank deposit <amount>*, *${prefix}bank withdraw <amount>* or *${prefix}bank statement*.`}_`;
      const sent = await ctx.sock.sendMessage(ctx.chatId, { text: plain, ...ctx.channelInfo }, { quoted: ctx.message }).then(() => true, () => false);
      if (sent) return;
    }
    await ctx.sock.sendMessage(ctx.chatId, {
      text: `⚠️ Something went wrong. Your coins are safe — run *${prefix}bank* to try again.`,
      ...ctx.channelInfo,
    }, { quoted: ctx.message }).catch(() => {});
  }
}

// ── Typed-amount capture ─────────────────────────────────────────────────────
// Buttons can't carry a number the player types, so "Custom amount" asks for
// one and waits for that person's next message in this chat — the flow stays
// inside the app instead of dumping them out to a typed command.

export function parseAmount(raw: string, allowAll = false): number | 'all' | null {
  const t = (raw || '').trim().toLowerCase().replace(/[,\s_]/g, '');
  if (allowAll && (t === 'all' || t === 'max')) return 'all';
  const m = t.match(/^(\d+(?:\.\d+)?)(k)?$/);
  if (!m) return null;
  const n = Math.floor(parseFloat(m[1]) * (m[2] ? 1000 : 1));
  return n > 0 ? n : null;
}

function messageText(msg: any): string {
  const m = msg?.message;
  return m?.conversation || m?.extendedTextMessage?.text || '';
}

/** Resolves a number, 'all' (if allowed), or null on cancel / timeout / giving up. */
export function askAmount(
  ctx: BankCtx,
  opts: { prompt: string; allowAll?: boolean; timeoutMs?: number; maxTries?: number }
): Promise<number | 'all' | null> {
  const { prompt, allowAll = false, timeoutMs = 60_000, maxTries = 3 } = opts;
  const prefix = config.prefix || '.';

  return new Promise(async (resolve) => {
    let tries = 0;
    let settled = false;

    const finish = (value: number | 'all' | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.sock.ev.off('messages.upsert', onMessage);
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    const onMessage = async (upsert: any) => {
      try {
        for (const msg of upsert.messages || []) {
          if (settled || !msg || msg.key?.fromMe) continue;
          if (msg.key?.remoteJid !== ctx.chatId) continue;
          if (cleanJid(msg.key.participant || msg.key.remoteJid) !== ctx.userId) continue;

          const text = messageText(msg).trim();
          if (!text) continue;
          if (text.toLowerCase() === 'cancel' || text.startsWith(prefix)) return finish(null); // they moved on

          const amount = parseAmount(text, allowAll);
          if (amount !== null) return finish(amount);

          tries++;
          if (tries >= maxTries) return finish(null);
          await ctx.sock.sendMessage(ctx.chatId, {
            text: `❌ Didn't catch that — send just a number${allowAll ? ' (or "all")' : ''}, or "cancel".`,
            ...ctx.channelInfo,
          }, { quoted: msg }).catch(() => {});
        }
      } catch (err) {
        console.error('[bank/ui] askAmount listener error:', err);
      }
    };

    ctx.sock.ev.on('messages.upsert', onMessage);

    try {
      await ctx.sock.sendMessage(ctx.chatId, {
        text: `${prompt}\n\n_Reply with a number${allowAll ? ' (or "all")' : ''}, or "cancel" · ${Math.round(timeoutMs / 1000)}s_`,
        ...ctx.channelInfo,
      }, { quoted: ctx.message });
    } catch (err) {
      finish(null);
    }
  });
}