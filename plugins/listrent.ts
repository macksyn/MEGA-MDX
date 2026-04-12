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

export default {
    command:     'listrent',
    aliases:     ['listclone', 'botclones'],
    category:    'owner',
    description: 'List all active and stored sub-bot clones',
    usage:       '.listrent',
    ownerOnly:   true,

    async handler(sock: any, message: any, _args: any, context: BotContext) {
        const { chatId, senderId } = context;

        const conns: Map<string, { conn: any; ownerJid: string }> =
            (global as any).conns ?? new Map();

        const metas = await getAllCloneMetas();

        if (conns.size === 0 && metas.length === 0) {
            return sock.sendMessage(chatId, {
                text: '❌ No sub-bots are currently active or stored.'
            }, { quoted: message });
        }

        let msg = `*─── [ CLONE BOTS ] ───*\n\n`;
        msg += `*Storage:* ${HAS_DB ? 'Database' : 'File system'}\n\n`;

        const mentions: string[] = [];

        if (conns.size > 0) {
            msg += `*Online clones:*\n\n`;
            let i = 1;
            for (const [authId, { conn, ownerJid }] of conns) {
                const user = conn.user;
                const numJid = user?.id ?? '';
                const number = numJid.split(':')[0];
                const isYours = ownerJid === senderId;

                msg += `*${i}.* \`${authId}\`\n`;
                msg += `   └ Number: @${number}\n`;
                msg += `   └ Name: ${user?.name ?? 'Sub-bot'}\n`;
                msg += `   └ Owner: ${isYours ? 'You' : ownerJid.split('@')[0]}\n`;
                msg += `   └ Status: Online\n\n`;

                if (numJid) mentions.push(numJid);
                i++;
            }
        }

        const offlineMetas = metas.filter(m => !conns.has(m.authId));
        if (offlineMetas.length > 0) {
            msg += `*Stored / offline clones:*\n\n`;
            offlineMetas.forEach((m, i) => {
                const isYours = m.ownerJid === senderId;
                const created = m.createdAt
                    ? new Date(m.createdAt).toLocaleString()
                    : 'unknown';

                msg += `*${i + 1}.* \`${m.authId}\`\n`;
                msg += `   └ Number: ${m.userNumber ?? 'N/A'}\n`;
                msg += `   └ Owner: ${isYours ? 'You' : (m.ownerJid?.split('@')[0] ?? 'N/A')}\n`;
                msg += `   └ Status: ${m.status ?? 'offline'}\n`;
                msg += `   └ Created: ${created}\n\n`;
            });
        }

        msg += `*Total online:* ${conns.size}\n`;
        msg += `*Total stored:* ${metas.length}`;

        return sock.sendMessage(chatId, { text: msg, mentions }, { quoted: message });
    }
};