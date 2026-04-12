import type { BotContext } from '../types.js';

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    initAuthCreds,
    BufferJSON
} from '@whiskeysockets/baileys';

import NodeCache from 'node-cache';
import pino from 'pino';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import store from '../lib/lightweight_store.js';
import { parsePhoneNumber } from 'awesome-phonenumber';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_CLONES = 5;

const HAS_DB = !!(
    process.env.MONGO_URL    ||
    process.env.POSTGRES_URL ||
    process.env.MYSQL_URL    ||
    process.env.DB_URL
);

// ── In-memory registry  (authId → { conn, ownerJid }) ────────────────────────

interface CloneEntry {
    conn:     any;
    ownerJid: string;
}

if (!(global as any).conns) (global as any).conns = new Map<string, CloneEntry>();
const conns: Map<string, CloneEntry> = (global as any).conns;

// ── DB-backed auth state ──────────────────────────────────────────────────────

async function useDbAuthState(authId: string) {
    const SETTING_KEY = `cloneAuth_${authId}`;

    const saved  = await store.getSetting('cloneAuth', SETTING_KEY);
    const parsed = saved
        ? JSON.parse(JSON.stringify(saved), BufferJSON.reviver)
        : null;

    const creds  = parsed?.creds ?? initAuthCreds();
    const keysRaw: Record<string, any> = parsed?.keys ?? {};

    const keys = {
        get: async (type: string, ids: string[]) => {
            const result: Record<string, any> = {};
            for (const id of ids) {
                const val = keysRaw[`${type}-${id}`];
                if (val) result[id] = val;
            }
            return result;
        },
        set: async (data: Record<string, Record<string, any>>) => {
            for (const [type, entries] of Object.entries(data)) {
                for (const [id, val] of Object.entries(entries)) {
                    if (val) {
                        keysRaw[`${type}-${id}`] = val;
                    } else {
                        delete keysRaw[`${type}-${id}`];
                    }
                }
            }
        }
    };

    const saveCreds = async () => {
        const payload = JSON.parse(
            JSON.stringify({ creds, keys: keysRaw }, BufferJSON.replacer)
        );
        await store.saveSetting('cloneAuth', SETTING_KEY, payload);
    };

    return {
        state: {
            creds,
            keys: makeCacheableSignalKeyStore(keys as any, pino({ level: 'fatal' }))
        },
        saveCreds
    };
}

// ── Clone metadata helpers (exported for listrent + stoprent) ─────────────────

export interface CloneMeta {
    authId:     string;
    ownerJid:   string;
    userNumber: string;
    createdAt:  number;
    status:     'pending' | 'online' | 'offline';
}

export async function saveCloneMeta(meta: CloneMeta) {
    await store.saveSetting('cloneMeta', meta.authId, meta);
}

export async function getCloneMeta(authId: string): Promise<CloneMeta | null> {
    return (await store.getSetting('cloneMeta', authId)) ?? null;
}

export async function deleteCloneMeta(authId: string) {
    await store.saveSetting('cloneMeta', authId, null);
    await store.saveSetting('cloneAuth', `cloneAuth_${authId}`, null);
}

export async function getAllCloneMetas(): Promise<CloneMeta[]> {
    const registry: string[] = (await store.getSetting('cloneMeta', '__registry')) ?? [];
    const metas: CloneMeta[] = [];
    for (const id of registry) {
        const m = await getCloneMeta(id);
        if (m) metas.push(m);
    }
    return metas;
}

export async function registerAuthId(authId: string) {
    const registry: string[] = (await store.getSetting('cloneMeta', '__registry')) ?? [];
    if (!registry.includes(authId)) {
        registry.push(authId);
        await store.saveSetting('cloneMeta', '__registry', registry);
    }
}

export async function unregisterAuthId(authId: string) {
    const registry: string[] = (await store.getSetting('cloneMeta', '__registry')) ?? [];
    await store.saveSetting('cloneMeta', '__registry', registry.filter(id => id !== authId));
}

// ── Core clone starter (exported for onLoad restore) ──────────────────────────

export async function startClone(
    authId:     string,
    userNumber: string,
    ownerJid:   string,
    parentSock: any,
    chatId:     string,
    isNew:      boolean
): Promise<void> {

    if (conns.has(authId)) {
        try { conns.get(authId)!.conn.ev.removeAllListeners(); } catch {}
    }

    const sessionPath = path.join(process.cwd(), 'session', 'clones', authId);

    let state: any, saveCreds: () => Promise<void>;
    if (HAS_DB) {
        ({ state, saveCreds } = await useDbAuthState(authId));
    } else {
        if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
        }
        ({ state, saveCreds } = await useMultiFileAuthState(sessionPath));
    }

    const { version }          = await fetchLatestBaileysVersion();
    const msgRetryCounterCache = new NodeCache();

    const conn = makeWASocket({
        version,
        logger:                pino({ level: 'silent' }),
        printQRInTerminal:     false,
        browser:               Browsers.macOS('Chrome'),
        auth: { creds: state.creds, keys: state.keys },
        markOnlineOnConnect:   true,
        msgRetryCounterCache,
        connectTimeoutMs:      120_000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs:   30_000,
    });

    conns.set(authId, { conn, ownerJid });

    if (isNew && !conn.authState.creds.registered) {
        await new Promise(r => setTimeout(r, 6000));
        try {
            let code = await conn.requestPairingCode(userNumber);
            code = code?.match(/.{1,4}/g)?.join('-') ?? code;

            await parentSock.sendMessage(chatId, {
                text: `*MEGA-MD Clone — pairing code*\n\n` +
                      `Code: *${code}*\n` +
                      `Clone ID: \`${authId}\`\n\n` +
                      `1. Open WhatsApp Settings\n` +
                      `2. Linked Devices → Link with phone number\n` +
                      `3. Enter the code above\n\n` +
                      `To stop: \`.stoprent ${authId}\`\n` +
                      `To list all: \`.listrent\``
            });
        } catch (err: any) {
            await parentSock.sendMessage(chatId, {
                text: `❌ Pairing code request failed: ${err.message}\n` +
                      `Run \`.stoprent ${authId}\` and try again.`
            });
            await deleteCloneMeta(authId);
            await unregisterAuthId(authId);
            conns.delete(authId);
            return;
        }
    }

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('connection.update', async (update: any) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            await saveCloneMeta({
                authId, ownerJid, userNumber,
                createdAt: Date.now(),
                status:    'online'
            });
            if (isNew) {
                await parentSock.sendMessage(chatId, {
                    text: `✅ Clone *online*\n` +
                          `ID: \`${authId}\`\n` +
                          `Number: ${userNumber}\n` +
                          `Storage: ${HAS_DB ? 'Database' : 'File system'}`
                });
            }
        }

        if (connection === 'close') {
            const code = (lastDisconnect?.error as any)?.output?.statusCode;

            if (code === DisconnectReason.loggedOut || code === 401) {
                await deleteCloneMeta(authId);
                await unregisterAuthId(authId);
                conns.delete(authId);
                if (!HAS_DB && fs.existsSync(sessionPath)) {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                }
                try {
                    await parentSock.sendMessage(ownerJid, {
                        text: `⚠️ Clone \`${authId}\` (${userNumber}) was logged out and removed.`
                    });
                } catch {}
                return;
            }

            await saveCloneMeta({
                authId, ownerJid, userNumber,
                createdAt: Date.now(),
                status:    'offline'
            });

            setTimeout(() => {
                startClone(authId, userNumber, ownerJid, parentSock, chatId, false)
                    .catch(console.error);
            }, 5_000);
        }
    });

    try {
        const { handleMessages } = await import('../lib/messageHandler.js');
        conn.ev.on('messages.upsert', async (chatUpdate: any) => {
            await handleMessages(conn, chatUpdate);
        });
    } catch (e: any) {
        console.error('[rentbot] Handler linkage failed:', e.message);
    }
}

// ── onLoad — restore clones after bot restart ─────────────────────────────────

export async function onLoad(sock: any): Promise<void> {
    const metas = await getAllCloneMetas();
    if (metas.length === 0) return;

    console.log(`[rentbot] Restoring ${metas.length} clone(s)…`);
    for (const meta of metas) {
        try {
            await startClone(
                meta.authId, meta.userNumber, meta.ownerJid,
                sock, meta.ownerJid, false
            );
            console.log(`[rentbot] Restored clone ${meta.authId}`);
        } catch (e: any) {
            console.error(`[rentbot] Failed to restore ${meta.authId}:`, e.message);
        }
    }
}

// ── Plugin export — ONLY starts clones ───────────────────────────────────────

export default {
    command:     'rentbot',
    aliases:     ['botclone', 'clonebot'],
    category:    'owner',
    description: 'Start a sub-bot clone via pairing code',
    usage:       '.rentbot <number>',
    ownerOnly:   true,
    onLoad,

    async handler(sock: any, message: any, args: any[], context: BotContext) {
        const { chatId, senderId } = context;

        if (!args[0]) {
            return sock.sendMessage(chatId, {
                text: `*Usage:* \`.rentbot <number>\`\n` +
                      `Example: \`.rentbot 2348012345678\`\n\n` +
                      `*Manage clones:*\n` +
                      `• \`.listrent\` — view your clones\n` +
                      `• \`.stoprent <authId>\` — stop a clone\n` +
                      `• \`.stoprent all\` — stop all your clones`
            }, { quoted: message });
        }

        const rawNumber = args[0].replace(/[^0-9]/g, '');

        const pn = parsePhoneNumber('+' + rawNumber);
        if (!pn.valid) {
            return sock.sendMessage(chatId, {
                text: `❌ Invalid phone number: \`${rawNumber}\`\n` +
                      `Format: country code + number, e.g. \`2348012345678\``
            }, { quoted: message });
        }

        const allMetas   = await getAllCloneMetas();
        const ownerCount = allMetas.filter(
            m => m.ownerJid === senderId && m.status !== 'offline'
        ).length;

        if (ownerCount >= MAX_CLONES) {
            return sock.sendMessage(chatId, {
                text: `❌ You have reached the maximum of *${MAX_CLONES}* clones.\n` +
                      `Stop one first with \`.stoprent <authId>\`.`
            }, { quoted: message });
        }

        const authId = crypto.randomBytes(4).toString('hex');

        await saveCloneMeta({
            authId,
            ownerJid:   senderId,
            userNumber: rawNumber,
            createdAt:  Date.now(),
            status:     'pending'
        });
        await registerAuthId(authId);

        await sock.sendMessage(chatId, {
            text: `⏳ Starting clone \`${authId}\` for *${rawNumber}*…`
        }, { quoted: message });

        try {
            await startClone(authId, rawNumber, senderId, sock, chatId, true);
        } catch (err: any) {
            await deleteCloneMeta(authId);
            await unregisterAuthId(authId);
            await sock.sendMessage(chatId, {
                text: `❌ Failed to start clone: ${err.message}`
            }, { quoted: message });
        }
    }
};