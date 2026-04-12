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

const CLONES_DIR        = path.join(process.cwd(), 'session', 'clones');
const REGISTRY_NS       = 'clone_registry';  // chatId namespace for registry
const PAIRING_TIMEOUT   = 5 * 60 * 1000;    // 5 minutes

// ─── Registry ──────────────────────────────────────────────────────────────
// Tracks which clones exist so we can reconnect them after a bot restart.

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
//
// BUG FIXED: useMultiFileAuthState always writes to disk, ignoring the DB
// backend.  useDBAuthState stores the real creds *and* signal keys in the
// store via BufferJSON so Buffers survive JSON round-trips.

async function useDBAuthState(authId: string) {
    const ns = `clone_${authId}`;

    async function readData(key: string): Promise<any> {
        const raw = await store.getSetting(ns, key);
        if (raw == null) return null;
        try {
            // store may return already-parsed object (Mongo) or string (SQL)
            const str = typeof raw === 'string' ? raw : JSON.stringify(raw);
            return JSON.parse(str, BufferJSON.reviver);
        } catch {
            return null;
        }
    }

    async function writeData(key: string, data: any): Promise<void> {
        // Convert Buffers → {type:"Buffer", data:[...]} before handing to store
        const safe = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
        await store.saveSetting(ns, key, safe);
    }

    // Load existing creds or create fresh ones
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
        // BUG FIXED: saveCreds now actually persists creds to the correct backend
        saveCreds: async () => writeData('creds', creds)
    };
}

// ─── Auth-state routing ────────────────────────────────────────────────────

async function getAuthState(authId: string) {
    if (HAS_DB) {
        return useDBAuthState(authId);
    }
    const sessionPath = path.join(CLONES_DIR, authId);
    fs.mkdirSync(sessionPath, { recursive: true });
    return useMultiFileAuthState(sessionPath);
}

async function deleteAuthState(authId: string): Promise<void> {
    if (!HAS_DB) {
        const p = path.join(CLONES_DIR, authId);
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    }
    // For DB: keys are namespaced to this authId and will be overwritten on
    // reuse, so no explicit deletion is needed.
}

// ─── Full cleanup ──────────────────────────────────────────────────────────

async function cleanup(authId: string): Promise<void> {
    await unregisterClone(authId);
    await deleteAuthState(authId);
    (global as any).conns = (global as any).conns.filter(
        (c: any) => c._cloneAuthId !== authId
    );
}

// ─── Core clone lifecycle ──────────────────────────────────────────────────

async function startClone(opts: {
    authId:       string;
    userNumber:   string;
    parentSock:   any;
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
        connectTimeoutMs:    120_000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 30_000,
    }) as any;

    // ── Pairing flow ──────────────────────────────────────────────────────
    if (!conn.authState.creds.registered) {
        if (isReconnect) {
            // BUG FIXED: orphaned un-paired sessions are removed on restart
            console.warn(`[rentbot] Clone ${authId} was never paired — removing orphan`);
            await cleanup(authId);
            return;
        }

        await new Promise(r => setTimeout(r, 6_000));

        // BUG FIXED: pairing timeout cleans up the partial session automatically
        let pairingDone = false;
        const pairingTimer = setTimeout(async () => {
            if (pairingDone) return;
            console.warn(`[rentbot] Pairing timeout for ${authId} — cleaning up`);
            try { (conn as any).end(undefined); } catch {}
            await cleanup(authId);
            if (notifyChatId) {
                await parentSock.sendMessage(notifyChatId, {
                    text: `⏰ Pairing timed out for *${userNumber}*. Session cleaned up. Try again.`
                });
            }
        }, PAIRING_TIMEOUT);

        try {
            let code = await conn.requestPairingCode(userNumber);
            code     = code?.match(/.{1,4}/g)?.join('-') || code;

            if (notifyChatId) {
                await parentSock.sendMessage(notifyChatId, {
                    text: `*🤖 MEGA-MD CLONE PAIRING*\n\n` +
                          `📱 Number: *${userNumber}*\n` +
                          `🔑 Code:   *${code}*\n\n` +
                          `1. Open WhatsApp → Settings → Linked Devices\n` +
                          `2. Tap *Link a Device* → *Link with phone number*\n` +
                          `3. Enter the code above.\n\n` +
                          `⏳ Code expires in 5 minutes.`
                });
            }

            // Clear timeout as soon as the first creds.update fires
            conn.ev.once('creds.update', () => { pairingDone = true; clearTimeout(pairingTimer); });

        } catch (err: any) {
            clearTimeout(pairingTimer);
            console.error('[rentbot] requestPairingCode error:', err.message);
            await cleanup(authId);
            if (notifyChatId) {
                await parentSock.sendMessage(notifyChatId, {
                    text: `❌ Failed to generate pairing code for *${userNumber}*.\n${err.message}`
                });
            }
            return;
        }
    }

    // ── Persist creds on every update ─────────────────────────────────────
    conn.ev.on('creds.update', saveCreds);

    // ── Connection state ──────────────────────────────────────────────────
    conn.ev.on('connection.update', async (update: any) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            // Remove any stale entry then add current conn
            (global as any).conns = (global as any).conns.filter(
                (c: any) => c._cloneAuthId !== authId
            );
            conn._cloneAuthId = authId;
            (global as any).conns.push(conn);
            await updateCloneStatus(authId, 'active');

            console.log(`[rentbot] ✅ Clone ${authId} (${userNumber}) connected`);
            if (notifyChatId && !isReconnect) {
                await parentSock.sendMessage(notifyChatId, {
                    text: `✅ Clone *${userNumber}* is online!\n` +
                          `ID: \`${authId}\`\n` +
                          `Backend: ${HAS_DB ? 'Database 🗄️' : 'File System 📁'}`
                });
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
                    await parentSock.sendMessage(notifyChatId, {
                        text: `📴 Clone *${userNumber}* was logged out and removed.`
                    });
                }
            } else {
                console.log(`[rentbot] Clone ${authId} lost connection (${statusCode}) — reconnecting in 5s…`);
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

// ─── onLoad — reconnect all clones after bot restart ──────────────────────
//
// BUG FIXED: export onLoad so commandHandler.runOnLoad() picks it up and
// restores every registered clone automatically on startup.

export async function onLoad(sock: any): Promise<void> {
    const registry = await getRegistry();
    if (registry.length === 0) return;

    console.log(`[rentbot] Restoring ${registry.length} clone(s) from registry…`);

    for (const { authId, userNumber } of registry) {
        // Stagger restores so we don't hammer the WA servers simultaneously
        await new Promise(r => setTimeout(r, 2_000));
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
                text: `*Usage:* \`.rentbot 923051391xxx\`\n` +
                      `Provide the full international number (digits only).`
            }, { quoted: message });
        }

        const userNumber = args[0].replace(/\D/g, '');
        if (userNumber.length < 7) {
            return sock.sendMessage(chatId, {
                text: `❌ Invalid number format. Example: \`.rentbot 923051234567\``
            }, { quoted: message });
        }

        const authId = crypto.randomBytes(4).toString('hex');

        // Register *before* starting so the clone is tracked even if pairing
        // fails mid-way — the pairing timeout will call cleanup() to remove it.
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
            parentSock:    sock,
            notifyChatId:  chatId,
        }).catch(async e => {
            console.error('[rentbot] startClone error:', e.message);
            await cleanup(authId);
            await sock.sendMessage(chatId, {
                text: `❌ Failed to start clone: ${e.message}`
            }, { quoted: message });
        });
    }
};