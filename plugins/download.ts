/**
 * plugins/download.ts
 * Universal downloader: auto-detects service and delegates to the
 * appropriate plugin handler.
 */

import type { BotContext } from '../types.js';
import { printLog }        from '../lib/print.js';
import config              from '../config.js';

// ── URL detection ─────────────────────────────────────────────────────────────
// Use require() so TypeScript doesn't need @types/url-regex-safe installed.
// Falls back silently to a simple regex if the package is absent.

let urlRegexFn: (() => RegExp) | null = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod  = require('url-regex-safe') as any;
    urlRegexFn = typeof mod === 'function' ? mod : (mod?.default ?? null);
} catch {
    urlRegexFn = null;
}

function extractUrl(text: string): string | null {
    const pattern = urlRegexFn ? urlRegexFn() : /https?:\/\/\S+/i;
    return text.match(pattern)?.[0] ?? null;
}

// ── Service detector map ──────────────────────────────────────────────────────
// Order matters — first match wins.

const DETECTORS: Array<{ regex: RegExp; plugin: string }> = [
    { regex: /(?:(?:vm|vt)\.)?tiktok\.com/i,       plugin: './tiktok.js'    },
    { regex: /(?:x\.com|twitter\.com)/i,            plugin: './twitter.js'   },
    { regex: /facebook\.com|fb\.watch/i,            plugin: './facebook.js'  },
    { regex: /instagram\.com|instagr\.am/i,         plugin: './instagram.js' },
    { regex: /(?:youtube\.com|youtu\.be)/i,          plugin: './video.js'      },
    { regex: /mega\.nz/i,                           plugin: './mega.js'      },
    { regex: /terabox\.com|1024terabox\.com/i,      plugin: './terabox.js'   },
    { regex: /snapchat\.com|snap\.chat/i,           plugin: './snapchat.js'  },
    { regex: /spotify\.com/i,                       plugin: './spotify.js'   },
];

// ── Plugin export ─────────────────────────────────────────────────────────────

export default {
    command:     'download',
    aliases:     ['dl'],
    category:    'download',
    description: 'Universal downloader: auto-detects service and downloads media',
    usage:       '.download <url>',

    async handler(sock: any, message: any, args: string[], context: BotContext): Promise<void> {
        const chatId   = context.chatId   || message.key.remoteJid;
        const senderId = context.senderId || message.key.participant || message.key.remoteJid;

        // Pass the full context through so delegated plugins receive a valid BotContext.
        // Only override the two fields that may differ at delegation time.
        const delegateCtx: BotContext = { ...context, chatId, senderId, config };

        // Resolve URL — from args first, then scan the raw message text
        let url = args[0];
        if (!url) {
            const text =
                message?.message?.conversation ||
                message?.message?.extendedTextMessage?.text || '';
            url = extractUrl(text.trim()) ?? '';
        }

        if (!url) {
            await sock.sendMessage(chatId, {
                text: '❌ Provide a link to download.\n\nExample: `.download <url>`'
            }, { quoted: message });
            return;
        }

        const normalized = url.trim();

        try {
            await sock.sendMessage(chatId, {
                text: '⏳ Detecting service and downloading...'
            }, { quoted: message });

            // Walk the detector list and delegate to the matching plugin
            for (const { regex, plugin } of DETECTORS) {
                if (!regex.test(normalized)) continue;

                try {
                    const mod     = await import(plugin) as any;
                    const handler = mod.default?.handler ?? mod.handler;
                    await handler(sock, message, [normalized], delegateCtx);
                    return;
                } catch (err: any) {
                    printLog('error', `[DOWNLOAD] Delegate error (${plugin}): ${err.message}`);
                    await sock.sendMessage(chatId, {
                        text: `❌ Download failed via ${plugin.replace('./', '').replace('.js', '')}: ${err.message}`
                    }, { quoted: message });
                    return;
                }
            }

            // No detector matched — try the generic fetch plugin as a last resort
            try {
                const fetchMod = await import('./fetch.js') as any;
                const handler  = fetchMod.default?.handler ?? fetchMod.handler;
                await handler(sock, message, [normalized], delegateCtx);
            } catch (err: any) {
                printLog('error', `[DOWNLOAD] Fetch fallback error: ${err.message}`);
                await sock.sendMessage(chatId, {
                    text: `❌ Could not download from that link: ${err.message}`
                }, { quoted: message });
            }

        } catch (error: any) {
            printLog('error', `[DOWNLOAD] Handler error: ${error.message}`);
            await sock.sendMessage(chatId, {
                text: `❌ Download failed: ${error.message}`
            }, { quoted: message });
        }
    },
};