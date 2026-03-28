/**
 * plugins/group-autodownload.ts
 *
 * Watches a single designated WhatsApp group for bare links.
 * When anyone shares a URL — no command needed — the bot auto-triggers
 * the existing download gateway (plugins/download.ts) which handles
 * service detection and delegation to the individual platform plugins.
 *
 * ── Setup (3 steps) ──────────────────────────────────────────────────────────
 *  1. Add  DOWNLOAD_GROUP_JID=1234567890-1234567890@g.us  to your .env
 *  2. Drop this file into  plugins/group-autodownload.ts
 *  3. Apply the two-line patch to lib/messageHandler.ts  (see bottom of file)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

import config        from '../config.js';
import { printLog }  from '../lib/print.js';
import { channelInfo } from '../lib/messageConfig.js';

// ── Env ───────────────────────────────────────────────────────────────────────

const DOWNLOAD_GROUP_JID = (process.env.DOWNLOAD_GROUP_JID ?? '').trim();

// ── URL extractor ─────────────────────────────────────────────────────────────
// Tries url-regex-safe (same optional dep as download.ts), falls back to a
// simple regex so the plugin works even if the package isn't installed.

let urlRegexFn: (() => RegExp) | null = null;
try {
    const mod  = require('url-regex-safe') as any;
    urlRegexFn = typeof mod === 'function' ? mod : (mod?.default ?? null);
} catch {
    urlRegexFn = null;
}

function extractUrl(text: string): string | null {
    const pattern = urlRegexFn ? urlRegexFn() : /https?:\/\/[^\s]+/i;
    // Strip trailing punctuation that may have been attached to the URL
    return text.match(pattern)?.[0]?.replace(/[.,;:!?'")\]]+$/, '') ?? null;
}

// ── Reaction helper ───────────────────────────────────────────────────────────

async function react(sock: any, message: any, emoji: string): Promise<void> {
    try {
        await sock.sendMessage(message.key.remoteJid, {
            react: { text: emoji, key: message.key },
        });
    } catch { /* reactions are cosmetic — never crash the flow */ }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Called inside handleMessages() in lib/messageHandler.ts.
 *
 * Returns  true  → link was detected and handling was kicked off.
 *                   The caller (messageHandler) should  return  immediately.
 * Returns  false → not our concern; messageHandler continues as normal.
 */
export async function handleGroupAutoDownload(
    sock:    any,
    message: any,
    context: Record<string, any>,
): Promise<boolean> {

    // ── Guard: feature must be configured ────────────────────────────────────
    if (!DOWNLOAD_GROUP_JID) return false;

    const chatId   = context.chatId   as string;
    const senderId = context.senderId as string;

    // ── Guard: only the designated download group ─────────────────────────────
    if (chatId !== DOWNLOAD_GROUP_JID) return false;

    // ── Guard: ignore the bot's own messages ──────────────────────────────────
    if (message.key.fromMe) return false;

    // ── Extract text from every relevant message type ─────────────────────────
    const rawText: string =
        message?.message?.conversation                   ||
        message?.message?.extendedTextMessage?.text      ||
        message?.message?.imageMessage?.caption          ||
        message?.message?.videoMessage?.caption          || '';

    const trimmed = rawText.trim();
    if (!trimmed) return false;

    // ── Guard: let bot commands pass through normally ─────────────────────────
    // e.g. .download, .menu, .help typed in the group still work as commands
    if (config.prefixes.some((p: string) => trimmed.startsWith(p))) return false;

    // ── Extract URL ───────────────────────────────────────────────────────────
    const url = extractUrl(trimmed);
    if (!url) return false;   // message contains no URL — not our job

    // ─────────────────────────────────────────────────────────────────────────
    // All guards passed. Own the message and delegate to the download gateway.
    // ─────────────────────────────────────────────────────────────────────────

    printLog('info', `[AUTO-DL] Link from ${senderId.split('@')[0]}: ${url}`);

    // Instant ⏳ reaction — user sees the bot noticed the link immediately
    await react(sock, message, '⏳');

    const delegateCtx = {
        ...context,
        chatId,
        senderId,
        config,
        channelInfo,
    };

    try {
        // Hand off to plugins/download.ts — it sends its own status messages,
        // runs the DETECTORS list, and delegates to the platform-specific plugin.
        const downloadMod = await import('./download.js') as any;
        const handler     = downloadMod.default?.handler ?? downloadMod.handler;
        await handler(sock, message, [url], delegateCtx);

        // ✅ reaction signals completion to the group
        await react(sock, message, '✅');

    } catch (err: any) {
        // download.ts failed before it could send its own error message.
        // This path is rare but handled cleanly.
        printLog('error', `[AUTO-DL] Gateway threw: ${err.message}`);
        await react(sock, message, '❌');
        await sock.sendMessage(chatId, {
            text: `❌ Auto-download failed: ${err.message}`,
            ...channelInfo,
        }, { quoted: message });
    }

    return true;
}

/* ═══════════════════════════════════════════════════════════════════════════════
 *
 *  PATCH 1 — lib/messageHandler.ts  (imports section, near the other plugins)
 *  ─────────────────────────────────────────────────────────────────────────────
 *  import { handleGroupAutoDownload } from '../plugins/group-autodownload.js';
 *
 *
 *  PATCH 2 — lib/messageHandler.ts  (inside handleMessages, after the userBanned
 *             check and before the TicTacToe check — search "handleTicTacToeMove")
 *  ─────────────────────────────────────────────────────────────────────────────
 *
 *      // ── Download-group auto-downloader ────────────────────────────────────
 *      if (isGroup && !message.key.fromMe) {
 *          const autoHandled = await handleGroupAutoDownload(sock, message, {
 *              chatId, senderId, isGroup, config, channelInfo,
 *              rawText, userMessage, messageText,
 *              isSenderAdmin: false, isBotAdmin: false,
 *              senderIsOwnerOrSudo: false, isOwnerOrSudoCheck: false,
 *          });
 *          if (autoHandled) return;
 *      }
 *      // ── End auto-downloader ────────────────────────────────────────────────
 *
 *
 *  PATCH 3 — .env  (one new line)
 *  ─────────────────────────────────────────────────────────────────────────────
 *  DOWNLOAD_GROUP_JID=1234567890-1234567890@g.us
 *
 *  Tip: to find a group's JID, send any message in the group and check the
 *  bot console — the printMessage logger prints every remoteJid.
 *
 * ═══════════════════════════════════════════════════════════════════════════════ */
