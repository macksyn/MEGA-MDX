import type { BotContext } from '../types.js';

/*****************************************************************************
 *                                                                           *
 *                     Developed By Qasim Ali                                *
 *                                                                           *
 *  🌐  GitHub   : https://github.com/GlobalTechInfo                         *
 *  ▶️  YouTube  : https://youtube.com/@GlobalTechInfo                       *
 *  💬  WhatsApp : https://whatsapp.com/channel/0029VagJIAr3bbVBCpEkAM07     *
 *                                                                           *
 *    © 2026 GlobalTechInfo. All rights reserved.                            *
 *                                                                           *
 *****************************************************************************/

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    BufferJSON,
    initAuthCreds,
} from '@whiskeysockets/baileys';
import NodeCache from 'node-cache';
import pino from 'pino';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import store from '../lib/lightweight_store.js';

if (!(global as any).conns) (global as any).conns = [];

const MONGO_URL    = process.env.MONGO_URL;
const POSTGRES_URL = process.env.POSTGRES_URL;
const MYSQL_URL    = process.env.MYSQL_URL;
const SQLITE_URL   = process.env.DB_URL;
const HAS_DB       = !!(MONGO_URL || POSTGRES_URL || MYSQL_URL || SQLITE_URL);

const CLONES_DIR      = path.join(process.cwd(), 'session', 'clones');
const REGISTRY_NS     = 'clone_registry';
const PAIRING_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// ─── Registry ──────────────────────────────────────────────────────────────

interface CloneMeta {
    authId:     string;
    userNumber: string;
    createdAt:  number;
    status:     'pairing' | 'active' | 'offline';
}

async function getRegistry(): Promise<CloneMeta[]> {
    const data = await store.getSetting(REGISTRY_NS, 'list');
    return Array.isArray(data) ? data : [];
}

async function saveRegistry(list: CloneMeta[]): Promise<void> {
    await store.saveSetting(REGISTRY_NS, 'list', list);
}

async function registerClone(meta: CloneMeta): Promise<void> {
    const list = await getRegistry();
    const idx  = list.findIndex(c => c.authId === meta.authId);
    if (idx >= 0) list[idx] = meta; else list.push(meta);
    await saveRegistry(list);
}

async function unregisterClone(authId: string): Promise<void> {
    const list = await getRegistry();
    await saveRegistry(list.filter(c => c.authId !== authId));
}

async function updateCloneStatus(authId: string, status: CloneMeta['status']): Promise<void> {
    const list = await getRegistry();
    const item = list.find(c => c.authId === authId);
    if (item) { item.status = status; await saveRegistry(list); }
}

// ─── DB-backed auth state ──────────────────────────────────────────────────

async function useDBAuthState(authId: string) {
    const ns = `clone_${authId}`;

    async function readData(key: string): Promise<any> {
        const raw = await store.getSetting(ns, key);
        if (raw == null) return null;
        try {
            const str = typeof raw === 'string' ? raw : JSON.stringify(raw);
            return JSON.parse(str, BufferJSON.reviver);
        } catch { return null; }
    }

    async function writeData(key: string, data: any): Promise<void> {
        const safe = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
        await store.saveSetting(ns, key, safe);
    }

    const creds = (await readData('creds')) ?? initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type: string, ids: string[]) => {
                    const result: Record<string, any> = {};
                    await Promise.all(ids.map(async id => {
                        const val = await readData(`key_${type}_${id}`);
                        if (val !== null) result[id] = val;
                    }));
                    return result;
                },
                set: async (data: Record<string, Record<string, any> | null>) => {
                    await Promise.all(
                        Object.entries(data).flatMap(([type, typeData]) =>
                            Object.entries(typeData ?? {}).map(([id, val]) =>
                                val != null
                                    ? writeData(`key_${type}_${id}`, val)
                                    : store.saveSetting(ns, `key_${type}_${id}`, null)
                            )
                        )
                    );
                }
            }
        },
        saveCreds: async () => writeData('creds', creds)
    };
}

// ─── Auth-state routing ────────────────────────────────────────────────────

async function getAuthState(authId: string) {
    if (HAS_DB) return useDBAuthState(authId);
    const sessionPath = path.join(CLONES_DIR, authId);
    fs.mkdirSync(sessionPath, { recursive: true });
    return useMultiFileAuthState(sessionPath);
}

async function deleteAuthState(authId: string): Promise<void> {
    if (!HAS_DB) {
        const p = path.join(CLONES_DIR, authId);
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    }
}

// ─── Cleanup ───────────────────────────────────────────────────────────────

async function cleanup(authId: string): Promise<void> {
    await unregisterClone(authId);
    await deleteAuthState(authId);
    (global as any).conns = (global as any).conns.filter(
        (c: any) => c._cloneAuthId !== authId
    );
}

// ─── evOnce helper ─────────────────────────────────────────────────────────
//
// BUG FIX: baileys v7 rc uses a mitt-based emitter that has .on and .off
// but NO .once — calling conn.ev.once() throws "not a function".
// This helper simulates it with a fired-flag so the callback runs at most
// once regardless of whether .off succeeds.

function evOnce(ev: any, event: string, cb: () => void): void {
    let fired = false;
    const wrapper = () => {
        if (fired) return;
        fired = true;
        try { ev.off(event, wrapper); } catch {}
        cb();
    };
    ev.on(event, wrapper);
}

// ─── Core clone lifecycle ──────────────────────────────────────────────────

async function startClone(opts: {
    authId:        string;
    userNumber:    string;
    parentSock:    any;
    notifyChatId?: string;
    isReconnect?:  boolean;
}): Promise<void> {
    const { authId, userNumber, parentSock, notifyChatId, isReconnect = false } = opts;

    const { state, saveCreds } = await getAuthState(authId);
    const { version }          = await fetchLatestBaileysVersion();
    const msgRetryCounterCache = new NodeCache();

    const conn = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.macOS('Chrome'),
        auth: {
            creds: state.creds,
            keys:  makeCacheableSignalKeyStore(
                state.keys,
                pino({ level: 'fatal' }).child({ level: 'fatal' })
            ),
        },
        markOnlineOnConnect: true,
        msgRetryCounterCache,
        connectTimeoutMs:      120_000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs:   30_000,
    }) as any;

    // Register saveCreds FIRST — before pairing — so every key exchange
    // during the handshake is persisted to the correct backend immediately.
    conn.ev.on('creds.update', saveCreds);

    // ── Pairing flow ──────────────────────────────────────────────────────
    if (!conn.authState.creds.registered) {
        if (isReconnect) {
            // Never completed pairing — remove this orphan
            console.warn(`[rentbot] Clone ${authId} was never paired — removing orphan`);
            await cleanup(authId);
            return;
        }

        await new Promise(r => setTimeout(r, 6_000));

        // Auto-cleanup if user never scans within PAIRING_TIMEOUT
        let pairingDone = false;
        const pairingTimer = setTimeout(async () => {
            if (pairingDone) return;
            console.warn(`[rentbot] Pairing timeout for ${authId} — cleaning up`);
            try { (conn as any).end(undefined); } catch {}
            await cleanup(authId);
            if (notifyChatId) {
                parentSock.sendMessage(notifyChatId, {
                    text: `⏰ Pairing timed out for *${userNumber}*. Session cleaned up. Try again.`
                }).catch(() => {});
            }
        }, PAIRING_TIMEOUT);

        // BUG FIX: requestPairingCode is in its own try/catch.
        // Previously it shared a try block with conn.ev.once(), so when
        // .once threw "not a function" the catch called cleanup() even
        // though the pairing code was already sent — destroying a valid session.
        let code: string;
        try {
            code = await conn.requestPairingCode(userNumber);
            code = code?.match(/.{1,4}/g)?.join('-') || code;
        } catch (err: any) {
            clearTimeout(pairingTimer);
            console.error('[rentbot] requestPairingCode error:', err.message);
            await cleanup(authId);
            if (notifyChatId) {
                parentSock.sendMessage(notifyChatId, {
                    text: `❌ Failed to generate pairing code for *${userNumber}*.\n${err.message}`
                }).catch(() => {});
            }
            return;
        }

        // Send code — isolated so a send failure doesn't abort the clone
        if (notifyChatId) {
            parentSock.sendMessage(notifyChatId, {
                text: `*🤖 MEGA-MD CLONE PAIRING*\n\n` +
                      `📱 Number: *${userNumber}*\n` +
                      `🔑 Code:   *${code}*\n\n` +
                      `1. Open WhatsApp → Settings → Linked Devices\n` +
                      `2. Tap *Link a Device* → *Link with phone number*\n` +
                      `3. Enter the code above.\n\n` +
                      `⏳ Code expires in 5 minutes.`
            }).catch(() => {});
        }

        // BUG FIX: use evOnce() — mitt has no .once
        evOnce(conn.ev, 'creds.update', () => {
            pairingDone = true;
            clearTimeout(pairingTimer);
        });
    }

    // ── Connection state ──────────────────────────────────────────────────
    conn.ev.on('connection.update', async (update: any) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            (global as any).conns = (global as any).conns.filter(
                (c: any) => c._cloneAuthId !== authId
            );
            conn._cloneAuthId = authId;
            (global as any).conns.push(conn);
            await updateCloneStatus(authId, 'active');

            console.log(`[rentbot] ✅ Clone ${authId} (${userNumber}) connected`);
            if (notifyChatId && !isReconnect) {
                parentSock.sendMessage(notifyChatId, {
                    text: `✅ Clone *${userNumber}* is online!\n` +
                          `ID: \`${authId}\`\n` +
                          `Backend: ${HAS_DB ? 'Database 🗄️' : 'File System 📁'}`
                }).catch(() => {});
            }
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
            (global as any).conns = (global as any).conns.filter(
                (c: any) => c._cloneAuthId !== authId
            );

            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                console.log(`[rentbot] Clone ${authId} logged out — removing`);
                await cleanup(authId);
                if (notifyChatId) {
                    parentSock.sendMessage(notifyChatId, {
                        text: `📴 Clone *${userNumber}* was logged out and removed.`
                    }).catch(() => {});
                }
            } else {
                console.log(`[rentbot] Clone ${authId} disconnected (${statusCode}) — reconnecting in 5s…`);
                await updateCloneStatus(authId, 'offline');
                setTimeout(() => {
                    startClone({ authId, userNumber, parentSock, isReconnect: true }).catch(e =>
                        console.error(`[rentbot] Reconnect failed for ${authId}:`, e.message)
                    );
                }, 5_000);
            }
        }
    });

    // ── Forward messages through main handler ──────────────────────────────
    try {
        const { handleMessages } = await import('../lib/messageHandler.js');
        conn.ev.on('messages.upsert', async (chatUpdate: any) => {
            await handleMessages(conn, chatUpdate);
        });
    } catch (e: any) {
        console.error('[rentbot] Failed to attach message handler:', e.message);
    }
}

// ─── onLoad — reconnect clones after bot restart ───────────────────────────

export async function onLoad(sock: any): Promise<void> {
    const registry = await getRegistry();
    if (registry.length === 0) return;

    console.log(`[rentbot] Restoring ${registry.length} clone(s) from registry…`);
    for (const { authId, userNumber } of registry) {
        await new Promise(r => setTimeout(r, 2_000)); // stagger restores
        startClone({ authId, userNumber, parentSock: sock, isReconnect: true }).catch(e =>
            console.error(`[rentbot] Failed to restore clone ${authId}:`, e.message)
        );
    }
}

// ─── Plugin export ─────────────────────────────────────────────────────────

export default {
    command:     'rentbot',
    aliases:     ['botclone', 'clonebot'],
    category:    'owner',
    description: 'Start a sub-bot clone via WhatsApp pairing code',
    usage:       '.rentbot 923051391xxx',
    ownerOnly:   true,

    async handler(sock: any, message: any, args: string[], context: BotContext) {
        const { chatId } = context;

        if (!args[0]) {
            return sock.sendMessage(chatId, {
                text: `*Usage:* \`.rentbot 923051391xxx\`\nProvide the full international number (digits only).`
            }, { quoted: message });
        }

        const userNumber = args[0].replace(/\D/g, '');
        if (userNumber.length < 7) {
            return sock.sendMessage(chatId, {
                text: `❌ Invalid number format. Example: \`.rentbot 923051234567\``
            }, { quoted: message });
        }

        const authId = crypto.randomBytes(4).toString('hex');

        await registerClone({
            authId,
            userNumber,
            createdAt: Date.now(),
            status:    'pairing',
        });

        await sock.sendMessage(chatId, {
            text: `⏳ Requesting pairing code for *${userNumber}*…`
        }, { quoted: message });

        startClone({
            authId,
            userNumber,
            parentSock:   sock,
            notifyChatId: chatId,
        }).catch(async e => {
            console.error('[rentbot] startClone error:', e.message);
            await cleanup(authId);
            sock.sendMessage(chatId, {
                text: `❌ Failed to start clone: ${e.message}`
            }, { quoted: message }).catch(() => {});
        });
    }
};