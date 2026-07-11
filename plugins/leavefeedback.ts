import type { BotContext } from '../types.js';
import { createStore } from '../lib/pluginStore.js';
import isAdmin from '../lib/isAdmin.js';
import isOwnerOrSudo from '../lib/isOwner.js';
import { printLog } from '../lib/print.js';
import config from '../config.js';

const db = createStore('leavefeedback');
const dbSettings = db.table!('settings');

interface GroupSettings {
    enabled:   boolean;
    dmMessage: string;
    dmDelayMs: number;
}

const DEFAULT_SETTINGS: GroupSettings = {
    enabled:   false,
    dmMessage: 'Hi {user}, I noticed you left {group}. Would you mind sharing a quick reason for leaving? Your feedback helps us improve.',
    dmDelayMs: 2000,
};

async function getGroupSettings(groupId: string): Promise<GroupSettings> {
    try {
        const saved = (await dbSettings.get(groupId)) ?? {};
        return { ...DEFAULT_SETTINGS, ...saved } as GroupSettings;
    } catch (error: any) {
        printLog('error', `[FEEDBACK] getGroupSettings: ${error.message}`);
        return { ...DEFAULT_SETTINGS };
    }
}

async function saveGroupSettings(groupId: string, settings: GroupSettings): Promise<boolean> {
    try {
        await dbSettings.set(groupId, settings);
        return true;
    } catch (error: any) {
        printLog('error', `[FEEDBACK] saveGroupSettings: ${error.message}`);
        return false;
    }
}

async function isGroupEnabled(groupId: string): Promise<boolean> {
    const settings = await getGroupSettings(groupId);
    return settings.enabled === true;
}

function formatMessage(template: string, replacements: Record<string, string>): string {
    let text = template;
    for (const [key, value] of Object.entries(replacements)) {
        text = text.replace(new RegExp(`\\{${key}\\}`, 'gi'), String(value));
    }
    return text;
}

function resolveParticipant(raw: any, sock: any): { jid: string; name: string } {
    const jidStr: string = typeof raw === 'string' ? raw : (raw?.id ?? String(raw));
    let realJid = jidStr;

    if (jidStr.includes('@lid') && sock?.store?.contacts) {
        const contacts: Record<string, any> = sock.store.contacts;
        const lidNumeric = jidStr.split('@')[0].split(':')[0];
        const resolved = Object.keys(contacts).find(k => {
            if (!k.includes('@s.whatsapp.net')) return false;
            const c = contacts[k];
            const cLid: string = c?.lid ?? '';
            return (
                cLid === jidStr ||
                cLid.split('@')[0].split(':')[0] === lidNumeric
            );
        });
        if (resolved) realJid = resolved;
    }

    const contacts: Record<string, any> = sock?.store?.contacts ?? {};
    const entry = contacts[realJid] ?? contacts[jidStr] ?? {};
    const name: string =
        entry.notify ||
        entry.name ||
        entry.verifiedName ||
        realJid.split('@')[0].split(':')[0];

    return { jid: realJid, name };
}

async function handleLeaveEvent(sock: any, id: any, participants: any, author?: string) {
    if (!await isGroupEnabled(id)) return;

    const settings = await getGroupSettings(id);
    if (!settings.enabled) return;

    let groupName = id;
    try {
        const meta = await sock.groupMetadata(id);
        groupName = meta.subject || groupName;
    } catch (error: any) {
        printLog('warning', `[FEEDBACK] Could not fetch metadata for ${id}: ${error.message}`);
    }

    for (const participant of participants) {
        try {
            const { jid: participantJid, name: resolvedName } = resolveParticipant(participant, sock);
            const displayName = resolvedName;
            const messageText = formatMessage(settings.dmMessage, {
                user:  displayName,
                group: groupName,
            });

            await sock.sendMessage(participantJid, { text: messageText });
            printLog('success', `[FEEDBACK] Sent feedback DM to ${participantJid} from ${id}`);
            await new Promise(r => setTimeout(r, settings.dmDelayMs || 2000));
        } catch (error: any) {
            printLog('error', `[FEEDBACK] Failed to DM leaving user: ${error.message}`);
        }
    }
}

async function userIsAdminOrSudo(sock: any, chatId: string, senderId: string): Promise<boolean> {
    const { isSenderAdmin } = await isAdmin(sock, chatId, senderId);
    const ownerOrSudo = await isOwnerOrSudo(senderId, sock, chatId);
    return isSenderAdmin || ownerOrSudo;
}

async function requireGroup(sock: any, chatId: string, message: any): Promise<boolean> {
    if (chatId.endsWith('@g.us')) return true;
    await sock.sendMessage(chatId, { text: '❌ This command only works in groups.' }, { quoted: message });
    return false;
}

async function requireAdmin(sock: any, chatId: string, message: any, senderId: string): Promise<boolean> {
    if (await userIsAdminOrSudo(sock, chatId, senderId)) return true;
    await sock.sendMessage(chatId, { text: '🔒 Only group admins can use this command.' }, { quoted: message });
    return false;
}

async function showMenu(sock: any, chatId: string, message: any): Promise<void> {
    const prefix = config.prefixes[0];
    await sock.sendMessage(chatId, {
        text:
            `📣 *FEEDBACK DM*

` +
            `📌 *Admin Commands:*
` +
            `• *${prefix}feedback on/off* — Enable or disable feedback DMs
` +
            `• *${prefix}feedback msg [text]* — Set the DM message
` +
            `• *${prefix}feedback status* — Show current settings

` +
            `💡 *Variables:*
` +
            `• {user} — Leaving member's display name
` +
            `• {group} — Group name

` +
            `📝 Example:
` +
            `${prefix}feedback msg Hi {user}, sorry to see you leave {group}. Can you tell me why?`
    }, { quoted: message });
}

async function cmdToggle(sock: any, chatId: string, message: any, senderId: string, state: string): Promise<void> {
    if (!await requireGroup(sock, chatId, message)) return;
    if (!await requireAdmin(sock, chatId, message, senderId)) return;

    const settings = await getGroupSettings(chatId);
    const wantEnabled = state === 'on';

    if (settings.enabled === wantEnabled) {
        await sock.sendMessage(chatId, {
            text: wantEnabled
                ? '⚠️ Leave feedback DMs are already enabled.'
                : '⚠️ Leave feedback DMs are already disabled.'
        }, { quoted: message });
        return;
    }

    settings.enabled = wantEnabled;
    await saveGroupSettings(chatId, settings);
    await sock.sendMessage(chatId, {
        text: wantEnabled
            ? '✅ Leave feedback DMs are now enabled. Users who leave will receive a private message asking for feedback.'
            : '❌ Leave feedback DMs are now disabled.'
    }, { quoted: message });
}

async function cmdMsg(sock: any, chatId: string, message: any, senderId: string, args: string[]): Promise<void> {
    if (!await requireGroup(sock, chatId, message)) return;
    if (!await requireAdmin(sock, chatId, message, senderId)) return;

    const newMsg = args.join(' ').trim();
    if (!newMsg) {
        await sock.sendMessage(chatId, {
            text: `⚠️ Please provide a DM message.\n\nExample: .leavefeedback msg Hi {user}, sorry you left {group}. Can you share why?`
        }, { quoted: message });
        return;
    }

    const settings = await getGroupSettings(chatId);
    settings.dmMessage = newMsg;
    await saveGroupSettings(chatId, settings);

    let reply = '✅ Leave feedback message updated!';
    if (!newMsg.includes('{user}') && !newMsg.includes('{group}')) {
        reply += '\n\n⚠️ Tip: Use {user} or {group} to personalize the message.';
    }

    await sock.sendMessage(chatId, { text: reply }, { quoted: message });
}

async function cmdStatus(sock: any, chatId: string, message: any, senderId: string): Promise<void> {
    if (!await requireGroup(sock, chatId, message)) return;
    if (!await requireAdmin(sock, chatId, message, senderId)) return;

    const settings = await getGroupSettings(chatId);
    await sock.sendMessage(chatId, {
        text:
            `📊 *LEAVE FEEDBACK DM STATUS*

` +
            `🏷️ Group: ${chatId}
` +
            `✅ Enabled: ${settings.enabled ? 'Yes' : 'No'}
` +
            `
` +
            `💬 Message:
${settings.dmMessage}`
    }, { quoted: message });
}

export default {
    command: 'feedback',
    aliases: ['leavefb', 'feedbackleave', 'leavefbmsg'],
    category: 'admin',
    description: 'DM leaving members and ask why they left the group',
    usage: '${config.prefixes[0]}feedback on/off | ${config.prefixes[0]}feedback msg [text] | ${config.prefixes[0]}feedback status',
    groupOnly: true,
    adminOnly: true,

    async handler(sock: any, message: any, args: string[], context: BotContext): Promise<void> {
        const { chatId, senderId } = context;
        if (!args.length) return showMenu(sock, chatId, message);

        const sub = args[0].toLowerCase();
        const subArgs = args.slice(1);

        switch (sub) {
            case 'on':
            case 'off':
                await cmdToggle(sock, chatId, message, senderId, sub);
                break;
            case 'msg':
            case 'message':
                await cmdMsg(sock, chatId, message, senderId, subArgs);
                break;
            case 'status':
                await cmdStatus(sock, chatId, message, senderId);
                break;
            case 'help':
                await showMenu(sock, chatId, message);
                break;
            default:
                await sock.sendMessage(chatId, {
                    text: `❓ Unknown subcommand: *${sub}*
Use *${config.prefixes[0]}feedback* to see available commands.`
                }, { quoted: message });
        }
    },

    handleLeaveEvent,
};
