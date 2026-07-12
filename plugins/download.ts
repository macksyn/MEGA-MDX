/**
 * plugins/download.ts
 * Universal downloader: auto-detects service and delegates to the
 * appropriate plugin handler.
 *
 * Shows one central animated progress message (analyze → detect → download)
 * so the individual platform plugins don't need to duplicate that UX.
 * Delegated plugins receive `silent: true` in their context and should skip
 * their own "starting" reactions/status text when it's set.
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

const DETECTORS: Array<{ regex: RegExp; plugin: string; name: string }> = [
    { regex: /(?:(?:vt|vm)\.)?tiktok\.com/i,       plugin: './tiktok.js',    name: 'TikTok'    },
    { regex: /(?:x\.com|twitter\.com)/i,            plugin: './twitter.js',   name: 'Twitter' },
    { regex: /facebook\.com|fb\.watch/i,            plugin: './facebook.js',  name: 'Facebook'  },
    { regex: /instagram\.com|instagr\.am/i,         plugin: './instagram.js', name: 'Instagram' },
    { regex: /(?:youtube\.com|youtu\.be)/i,          plugin: './video.js',     name: 'YouTube'   },
    { regex: /mega\.nz/i,                           plugin: './mega.js',      name: 'MEGA'      },
    { regex: /terabox\.com|1024terabox\.com/i,      plugin: './terabox.js',   name: 'TeraBox'   },
    { regex: /snapchat\.com|snap\.chat/i,           plugin: './snapchat.js',  name: 'Snapchat'  },
    { regex: /spotify\.com/i,                       plugin: './spotify.js',   name: 'Spotify'   },
];

// ── Animation helpers ──────────────────────────────────────────────────────────

const BAR_LENGTH = 10;
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function bar(percent: number): string {
    const filled = Math.round((percent / 100) * BAR_LENGTH);
    return '■'.repeat(filled) + '□'.repeat(BAR_LENGTH - filled);
}

async function editText(sock: any, chatId: string, key: any, text: string, channelInfo?: any): Promise<void> {
    try {
        await sock.sendMessage(chatId, { text, edit: key, ...channelInfo });
    } catch { /* animation frames are cosmetic — never crash the flow */ }
}

/**
 * Runs the "📥 Downloading..." progress animation on the given message while
 * `work` runs concurrently. Stops as soon as `work` settles, whichever frame
 * it's on — it never blocks completion waiting for the animation to finish.
 */
async function withDownloadAnimation<T>(
    sock: any, chatId: string, key: any, channelInfo: any, work: Promise<T>
): Promise<T> {
    const frames = [20, 40, 60, 80];
    let stopped = false;

    const animate = (async () => {
        for (const pct of frames) {
            if (stopped) return;
            await editText(sock, chatId, key, `📥 Downloading...\n\n${bar(pct)} ${pct}%`, channelInfo);
            await delay(900);
        }
    })();

    try {
        return await work;
    } finally {
        stopped = true;
        await Promise.race([animate, delay(50)]);
    }
}

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
        const channelInfo = context.channelInfo;

        // Pass the full context through so delegated plugins receive a valid BotContext.
        // `silent: true` tells them to skip their own starting reactions/status text —
        // this plugin already shows the central animated progress.
        const delegateCtx: BotContext = { ...context, chatId, senderId, config, silent: true } as BotContext;

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
        const match = DETECTORS.find(d => d.regex.test(normalized));

        let sent: any;
        try {
            sent = await sock.sendMessage(chatId, {
                text: `🔍 Analyzing your link...\n\n${bar(10)} 10%`,
                ...channelInfo
            }, { quoted: message });

            await delay(400);
            await editText(sock, chatId, sent.key, `🔍 Analyzing your link...\n\n${bar(30)} 30%`, channelInfo);
            await delay(400);

            if (match) {
                await editText(
                    sock, chatId, sent.key,
                    `✅ ${match.name} detected!\n📱 Fetching media from ${match.name}...`,
                    channelInfo
                );
                await delay(500);

                try {
                    const mod     = await import(match.plugin) as any;
                    const handler = mod.default?.handler ?? mod.handler;
                    await withDownloadAnimation(
                        sock, chatId, sent.key, channelInfo,
                        handler(sock, message, [normalized], delegateCtx)
                    );
                    await editText(sock, chatId, sent.key, `📥 Downloading...\n\n${bar(100)} 100%`, channelInfo);
                } catch (err: any) {
                    printLog('error', `[DOWNLOAD] Delegate error (${match.plugin}): ${err.message}`);
                    await editText(sock, chatId, sent.key, `❌ Download failed via ${match.name}: ${err.message}`, channelInfo);
                }
                return;
            }

            // No detector matched — try the generic fetch plugin as a last resort
            await editText(sock, chatId, sent.key, `✅ Link detected!\n📱 Fetching media...`, channelInfo);
            await delay(400);

            try {
                const fetchMod = await import('./fetch.js') as any;
                const handler  = fetchMod.default?.handler ?? fetchMod.handler;
                await withDownloadAnimation(
                    sock, chatId, sent.key, channelInfo,
                    handler(sock, message, [normalized], delegateCtx)
                );
                await editText(sock, chatId, sent.key, `📥 Downloading...\n\n${bar(100)} 100%`, channelInfo);
            } catch (err: any) {
                printLog('error', `[DOWNLOAD] Fetch fallback error: ${err.message}`);
                await editText(sock, chatId, sent.key, `❌ Could not download from that link: ${err.message}`, channelInfo);
            }

        } catch (error: any) {
            printLog('error', `[DOWNLOAD] Handler error: ${error.message}`);
            if (sent?.key) {
                await editText(sock, chatId, sent.key, `❌ Download failed: ${error.message}`, channelInfo);
            } else {
                await sock.sendMessage(chatId, { text: `❌ Download failed: ${error.message}` }, { quoted: message });
            }
        }
    },
};
