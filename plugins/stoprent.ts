import type { BotContext } from '../types.js';

import store from '../lib/lightweight_store.js';
import fs from 'fs';
import path from 'path';

const HAS_DB = !!(
    process.env.MONGO_URL    ||
    process.env.POSTGRES_URL ||
    process.env.MYSQL_URL    ||
    process.env.DB_URL
);

async function getAllCloneMetas() {
    const registry: string[] = (await store.getSetting('cloneMeta', '__registry')) ?? [];
    const metas: any[] = [];
    for (const authId of registry) {
        const m = await store.getSetting('cloneMeta', authId);
        if (m) metas.push({ authId, ...m });
    }
    return metas;
}

async function deleteCloneMeta(authId: string) {
    await store.saveSetting('cloneMeta', authId, null);
    await store.saveSetting('cloneAuth', `cloneAuth_${authId}`, null);
}

async function unregisterAuthId(authId: string) {
    const registry: string[] = (await store.getSetting('cloneMeta', '__registry')) ?? [];
    await store.saveSetting('cloneMeta', '__registry', registry.filter(id => id !== authId));
}

function cleanupFileSession(authId: string) {
    const sessionPath = path.join(process.cwd(), 'session', 'clones', authId);
    if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
    }
}

async function disconnectClone(authId: string) {
    const conns: Map<string, { conn: any; ownerJid: string }> =
        (global as any).conns ?? new Map();

    const entry = conns.get(authId);
    if (entry) {
        try {
            entry.conn.ws?.close();
        } catch {}
        conns.delete(authId);
    }

    await deleteCloneMeta(authId);
    await unregisterAuthId(authId);

    if (!HAS_DB) cleanupFileSession(authId);
}

export default {
    command:     'stoprent',
    aliases:     ['stopclone', 'delrent'],
    category:    'owner',
    description: 'Stop a specific sub-bot or all sub-bots',
    usage:       '.stoprent <authId|all>',
    ownerOnly:   true,

    async handler(sock: any, message: any, args: any[], context: BotContext) {
        const { chatId, senderId } = context;

        const conns: Map<string, { conn: any; ownerJid: string }> =
            (global as any).conns ?? new Map();

        if (!args[0]) {
            const metas = await getAllCloneMetas();
            const mine  = metas.filter(m => m.ownerJid === senderId);

            if (mine.length === 0) {
                return sock.sendMessage(chatId, {
                    text: '❌ You have no active clones to stop.'
                }, { quoted: message });
            }

            const lines = mine.map(m =>
                `• \`${m.authId}\` — ${m.userNumber} (${m.status})`
            ).join('\n');

            return sock.sendMessage(chatId, {
                text: `*Usage:* \`.stoprent <authId>\` or \`.stoprent all\`\n\n` +
                      `*Your clones:*\n${lines}`
            }, { quoted: message });
        }

        // ── Stop all ──────────────────────────────────────────────────────────
        if (args[0].toLowerCase() === 'all') {
            const metas = await getAllCloneMetas();
            const mine  = metas.filter(m => m.ownerJid === senderId);

            if (mine.length === 0) {
                return sock.sendMessage(chatId, {
                    text: '❌ You have no clones to stop.'
                }, { quoted: message });
            }

            let stopped = 0;
            for (const m of mine) {
                try {
                    await disconnectClone(m.authId);
                    stopped++;
                } catch (e: any) {
                    console.error(`[stoprent] Error stopping ${m.authId}:`, e.message);
                }
            }

            return sock.sendMessage(chatId, {
                text: `✅ Stopped and removed *${stopped}* clone(s).`
            }, { quoted: message });
        }

        // ── Stop by authId ────────────────────────────────────────────────────
        const authId = args[0].trim();
        const meta   = await store.getSetting('cloneMeta', authId);

        if (!meta) {
            return sock.sendMessage(chatId, {
                text: `❌ Clone \`${authId}\` not found.\nUse \`.listrent\` to see valid IDs.`
            }, { quoted: message });
        }

        if (meta.ownerJid !== senderId) {
            return sock.sendMessage(chatId, {
                text: `❌ Clone \`${authId}\` does not belong to you.`
            }, { quoted: message });
        }

        try {
            await disconnectClone(authId);
            return sock.sendMessage(chatId, {
                text: `✅ Clone \`${authId}\` (${meta.userNumber}) stopped and removed.`
            }, { quoted: message });
        } catch (e: any) {
            return sock.sendMessage(chatId, {
                text: `❌ Error stopping clone: ${e.message}`
            }, { quoted: message });
        }
    }
};