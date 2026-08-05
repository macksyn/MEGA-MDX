import type { BotContext } from '../types.js';
import store from '../lib/lightweight_store.js';
import isOwnerOrSudo from '../lib/isOwner.js';
import isAdmin from '../lib/isAdmin.js';
import { promptMenu } from '../lib/menuSession.js';
import { cleanJid } from '../lib/isOwner.js';

interface AntilinkSettings {
    enabled: boolean;
    action: string | null;
    allowedDomains?: string[];
}

interface WhitelistEntry {
    value: string;      // full link substring, or user JID
    expiresAt: number;  // epoch ms
    addedBy: string;    // JID of whoever added it
}

// In-memory settings cache: chatId -> settings (or null if none saved yet).
// Avoids a DB round-trip on every single message in every group.
const antilinkCache = new Map<string, AntilinkSettings | null>();

// Temporary exemptions. Not persisted to the DB on purpose — these are
// meant to be short-lived (minutes/hours), so an in-memory map with lazy
// expiry pruning is enough and keeps this fast on the hot path.
const linkWhitelist = new Map<string, WhitelistEntry[]>();
const userWhitelist = new Map<string, WhitelistEntry[]>();

const DEFAULT_WHITELIST_MINUTES = 60;
const MAX_WHITELIST_MINUTES = 60 * 24; // 24h safety cap

function pruneExpired(entries: WhitelistEntry[]): WhitelistEntry[] {
    const now = Date.now();
    return entries.filter(e => e.expiresAt > now);
}

function addToWhitelist(map: Map<string, WhitelistEntry[]>, chatId: string, value: string, addedBy: string, durationMs: number) {
    const existing = pruneExpired(map.get(chatId) || []);
    existing.push({ value, expiresAt: Date.now() + durationMs, addedBy });
    map.set(chatId, existing);
}

function getActiveEntries(map: Map<string, WhitelistEntry[]>, chatId: string): WhitelistEntry[] {
    const entries = pruneExpired(map.get(chatId) || []);
    map.set(chatId, entries);
    return entries;
}

function isMatchWhitelisted(map: Map<string, WhitelistEntry[]>, chatId: string, matcher: (value: string) => boolean): boolean {
    return getActiveEntries(map, chatId).some(e => matcher(e.value));
}

// Compares JIDs while tolerating @lid vs phone-number identifier mismatches
// (same class of bug fixed elsewhere in the contact store).
function isSameUser(a: string, b: string): boolean {
    if (a === b) return true;
    return a.split('@')[0] === b.split('@')[0];
}

function extractDomain(text: string): string | null {
    const match = text.match(/(?:https?:\/\/|www\.)([^\/\s]{1,200})/i);
    if (!match) return null;
    return match[1].toLowerCase().replace(/^www\./, '');
}

function extractTargetUser(message: any): string | null {
    const contextInfo = message.message?.extendedTextMessage?.contextInfo;
    if (contextInfo?.participant) return contextInfo.participant;
    if (contextInfo?.mentionedJid?.length) return contextInfo.mentionedJid[0];
    return null;
}

function parseMinutes(raw: string | undefined): number {
    const n = parseInt(raw ?? '', 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_WHITELIST_MINUTES;
    return Math.min(n, MAX_WHITELIST_MINUTES);
}

function fmtTimeLeft(e: WhitelistEntry): string {
    return `${Math.max(1, Math.round((e.expiresAt - Date.now()) / 60000))}m left`;
}

async function setAntilink(chatId: string, action: string, allowedDomains?: string[]) {
    try {
        const existing = await getAntilink(chatId);
        const settings: AntilinkSettings = {
            enabled: true,
            action,
            allowedDomains: allowedDomains !== undefined ? allowedDomains : (existing?.allowedDomains || [])
        };
        await store.saveSetting(chatId, 'antilink', settings);
        antilinkCache.set(chatId, settings);
        return true;
    } catch(error: any) {
        console.error('Error setting antilink:', error);
        return false;
    }
}

async function getAntilink(chatId: string): Promise<AntilinkSettings | null> {
    if (antilinkCache.has(chatId)) return antilinkCache.get(chatId)!;
    try {
        const settings = await store.getSetting(chatId, 'antilink');
        antilinkCache.set(chatId, settings || null);
        return settings || null;
    } catch(error: any) {
        console.error('Error getting antilink:', error);
        return null;
    }
}

async function removeAntilink(chatId: string) {
    try {
        const settings: AntilinkSettings = { enabled: false, action: null, allowedDomains: [] };
        await store.saveSetting(chatId, 'antilink', settings);
        antilinkCache.set(chatId, settings);
        return true;
    } catch(error: any) {
        console.error('Error removing antilink:', error);
        return false;
    }
}

export async function handleLinkDetection(sock: any, chatId: string, message: any, userMessage: string, senderId: string) {
    try {
        // Never act on the bot's own messages (e.g. announcements containing links).
        if (message.key.fromMe) return;

        const config = await getAntilink(chatId);
        if (!config?.enabled) return;

        // Check if sender is owner or sudo
        const isOwnerSudo = await isOwnerOrSudo(senderId, sock, chatId);
        if (isOwnerSudo) return;

        // Check if sender is admin
        try {
            const { isSenderAdmin } = await isAdmin(sock, chatId, senderId);
            if (isSenderAdmin) return;
        } catch(e: any) {
            console.error('Error checking admin status in antilink (failing closed):', e);
        }

        const action = config.action || 'delete';
        let shouldAct = false;
        let linkType = '';

        const linkPatterns = {
            whatsappGroup:   /chat\.whatsapp\.com\/[A-Za-z0-9]{20,}/i,
            whatsappChannel: /wa\.me\/channel\/[A-Za-z0-9]{20,}/i,
            telegram:        /(?:t\.me|telegram\.me|telegram\.dog)\/[A-Za-z0-9_]{5,}/i,
            allLinks:        /https?:\/\/[^\s]{1,200}|www\.[a-z0-9-]{2,}\.[a-z]{2,}[^\s]{0,200}/i,
        };

        if (linkPatterns.whatsappGroup.test(userMessage)) {
            shouldAct = true;
            linkType = 'WhatsApp Group';
        } else if (linkPatterns.whatsappChannel.test(userMessage)) {
            shouldAct = true;
            linkType = 'WhatsApp Channel';
        } else if (linkPatterns.telegram.test(userMessage)) {
            shouldAct = true;
            linkType = 'Telegram';
        } else if (linkPatterns.allLinks.test(userMessage)) {
            const domain = extractDomain(userMessage);
            const domainAllowed = !!domain && (config.allowedDomains || []).some(d => domain.endsWith(d));
            if (!domainAllowed) {
                shouldAct = true;
                linkType = 'External Link';
            }
        }

        if (!shouldAct) return;

        // Temporary exemptions: a whitelisted user or a whitelisted link/domain
        // bypasses action entirely until their exemption expires.
        if (isMatchWhitelisted(userWhitelist, chatId, v => isSameUser(v, senderId))) return;
        if (isMatchWhitelisted(linkWhitelist, chatId, v => userMessage.toLowerCase().includes(v.toLowerCase()))) return;

        const messageId = message.key.id;
        const participant = message.key.participant || senderId;

        if (action === 'delete' || action === 'kick') {
            try {
                await sock.sendMessage(chatId, {
                    delete: {
                        remoteJid: chatId,
                        fromMe: false,
                        id: messageId,
                        participant: participant
                    }
                });
            } catch(error: any) {
                console.error('Failed to delete message:', error);
            }
        }

        if (action === 'warn' || action === 'delete') {
            await sock.sendMessage(chatId, {
                text: `⚠️ *Warning!!!*\n\n@${senderId.split('@')[0]}, posting ${linkType} links is not allowed here!`,
                mentions: [senderId]
            });
        }

        if (action === 'kick') {
            try {
                await sock.groupParticipantsUpdate(chatId, [senderId], 'remove');
                await sock.sendMessage(chatId, {
                    text: `🚫 @${senderId.split('@')[0]} has been removed for posting ${linkType} links.`,
                    mentions: [senderId]
                });
            } catch(error: any) {
                console.error('Failed to kick user:', error);
                await sock.sendMessage(chatId, {
                    text: `⚠️ Failed to remove user. Make sure the bot is an admin.`
                });
            }
        }

    } catch(error: any) {
        console.error('Error in link detection:', error);
    }
}

// ── Interactive USSD-style menu ─────────────────────────────────────────
// One promptMenu() call per decision. Freeform values (a URL, a raw domain
// string) can't be collected through numbered selection, so those steps
// point the person at the equivalent one-line command instead of faking a
// text-input step the menu system isn't built for.

const ACTION_DESCRIPTIONS: Record<string, string> = {
    delete: 'Delete the message + warn the sender',
    kick:   'Delete the message + remove the sender',
    warn:   'Warn the sender, message stays',
};

async function runMainMenu(sock: any, message: any, chatId: string, userId: string) {
    const config = await getAntilink(chatId);
    const enabled = !!config?.enabled;
    const action = config?.action || 'delete';

    const result = await promptMenu(sock, message, chatId, userId, {
        title: '🔗 ANTILINK',
        subtitle: `Status: ${enabled ? '✅ Enabled' : '❌ Disabled'}  ·  Action: ${action}`,
        text: 'What would you like to do?',
        options: [
            { label: enabled ? 'Turn OFF' : 'Turn ON', value: 'toggle' },
            { label: 'Change action', value: 'action', description: 'delete · kick · warn' },
            { label: 'Allowed domains', value: 'domains', description: 'Links that are never blocked' },
            { label: 'Temporary whitelist', value: 'whitelist', description: 'Time-limited exemptions' },
            { label: 'Full status', value: 'status' },
        ],
    });

    if (result.cancelled || result.timedOut) return;

    switch (result.value) {
        case 'toggle': {
            if (enabled) {
                await removeAntilink(chatId);
                await sock.sendMessage(chatId, { text: '❌ *Antilink disabled*\n\nUsers can now send links freely.' });
            } else {
                await setAntilink(chatId, 'delete');
                await sock.sendMessage(chatId, { text: '✅ *Antilink enabled*\n\nDefault action: Delete messages\n\n*Exempt:* Admins, Owner, Sudo users' });
            }
            return;
        }
        case 'action': return runActionMenu(sock, message, chatId, userId);
        case 'domains': return runDomainsMenu(sock, message, chatId, userId);
        case 'whitelist': return runWhitelistMenu(sock, message, chatId, userId);
        case 'status': return sendStatus(sock, message, chatId);
    }
}

async function runActionMenu(sock: any, message: any, chatId: string, userId: string) {
    const result = await promptMenu(sock, message, chatId, userId, {
        title: '🔗 ANTILINK · Action',
        text: 'Choose what happens when a link is caught:',
        options: (['delete', 'kick', 'warn'] as const).map(a => ({
            label: a[0].toUpperCase() + a.slice(1),
            value: a,
            description: ACTION_DESCRIPTIONS[a],
        })),
    });

    if (result.cancelled || result.timedOut || !result.value) return;

    const ok = await setAntilink(chatId, result.value);
    await sock.sendMessage(chatId, {
        text: ok
            ? `✅ *Antilink action set to: ${result.value}*\n\n${ACTION_DESCRIPTIONS[result.value]}\n\n*Exempt:* Admins, Owner, Sudo users`
            : '❌ *Failed to set antilink action*'
    });
}

async function runDomainsMenu(sock: any, message: any, chatId: string, userId: string) {
    const config = await getAntilink(chatId);
    const domains = config?.allowedDomains || [];

    const result = await promptMenu(sock, message, chatId, userId, {
        title: '🔗 ANTILINK · Domains',
        subtitle: domains.length ? `${domains.length} domain(s) currently allowed` : 'No domains allowed yet',
        text: 'Links from allowed domains are never blocked.',
        options: [
            { label: 'Add a domain', value: 'add', description: 'Needs a typed command — instructions next' },
            { label: 'Remove a domain', value: 'remove' },
            { label: 'List domains', value: 'list' },
        ],
    });

    if (result.cancelled || result.timedOut) return;

    if (result.value === 'add') {
        await sock.sendMessage(chatId, {
            text: `✍️ *Adding a domain needs the exact text*, so type it directly:\n\n\`.antilink domain add <domain>\`\n\n_Example: .antilink domain add youtube.com_`
        });
        return;
    }

    if (result.value === 'list') {
        await sock.sendMessage(chatId, {
            text: `*🔗 ALLOWED DOMAINS*\n\n${domains.length ? domains.map((d, i) => `${i + 1}. ${d}`).join('\n') : '_None_'}`
        });
        return;
    }

    if (result.value === 'remove') {
        if (!domains.length) {
            await sock.sendMessage(chatId, { text: '_No domains to remove._' });
            return;
        }
        const pick = await promptMenu(sock, message, chatId, userId, {
            title: '🔗 Remove which domain?',
            text: 'Pick one to remove:',
            options: domains.map(d => ({ label: d, value: d })),
        });
        if (pick.cancelled || pick.timedOut || !pick.value) return;

        const updated = domains.filter(d => d !== pick.value);
        await setAntilink(chatId, config?.action || 'delete', updated);
        await sock.sendMessage(chatId, { text: `✅ *${pick.value}* removed from allowed domains.` });
    }
}

async function runWhitelistMenu(sock: any, message: any, chatId: string, userId: string) {
    const targetUser = extractTargetUser(message);

    const options = [
        {
            label: 'Whitelist this user',
            value: 'user',
            description: targetUser ? `@${targetUser.split('@')[0]} (tagged/replied)` : 'Tag or reply to someone first',
        },
        { label: 'Whitelist a link', value: 'link', description: 'Needs a typed command — instructions next' },
        { label: 'View active exemptions', value: 'view' },
        { label: 'Remove an exemption', value: 'removeexemption' },
    ];

    const result = await promptMenu(sock, message, chatId, userId, {
        title: '🔗 ANTILINK · Whitelist',
        text: 'Temporary, time-limited exemptions:',
        options,
    });

    if (result.cancelled || result.timedOut) return;

    if (result.value === 'user') {
        if (!targetUser) {
            await sock.sendMessage(chatId, {
                text: '❌ Tag the user or reply to their message, then run `.antilink` again and pick this option.'
            });
            return;
        }
        const duration = await promptMenu(sock, message, chatId, userId, {
            title: `🔗 Whitelist @${targetUser.split('@')[0]}`,
            text: 'For how long?',
            options: [
                { label: '15 minutes', value: '15' },
                { label: '1 hour', value: '60' },
                { label: '4 hours', value: '240' },
                { label: '24 hours', value: '1440' },
            ],
        });
        if (duration.cancelled || duration.timedOut || !duration.value) return;

        const minutes = parseMinutes(duration.value);
        addToWhitelist(userWhitelist, chatId, targetUser, userId, minutes * 60 * 1000);
        await sock.sendMessage(chatId, {
            text: `✅ *User whitelisted for ${minutes} minute(s)*\n\n@${targetUser.split('@')[0]} can post links without action until it expires.`,
            mentions: [targetUser]
        });
        return;
    }

    if (result.value === 'link') {
        await sock.sendMessage(chatId, {
            text: `✍️ *Whitelisting a link needs the exact text*, so type it directly:\n\n\`.antilink whitelist link <url> [minutes]\`\n\n_Example: .antilink whitelist link chat.whatsapp.com/ABC123 30_`
        });
        return;
    }

    if (result.value === 'view') {
        const links = getActiveEntries(linkWhitelist, chatId);
        const users = getActiveEntries(userWhitelist, chatId);
        const linkLines = links.length ? links.map((e, i) => `${i + 1}. ${e.value} (${fmtTimeLeft(e)})`).join('\n') : '_None_';
        const userLines = users.length ? users.map((e, i) => `${i + 1}. @${e.value.split('@')[0]} (${fmtTimeLeft(e)})`).join('\n') : '_None_';
        await sock.sendMessage(chatId, {
            text: `*🔗 ACTIVE WHITELISTS*\n\n*Links:*\n${linkLines}\n\n*Users:*\n${userLines}`,
            mentions: users.map(e => e.value)
        });
        return;
    }

    if (result.value === 'removeexemption') {
        const links = getActiveEntries(linkWhitelist, chatId);
        const users = getActiveEntries(userWhitelist, chatId);
        if (!links.length && !users.length) {
            await sock.sendMessage(chatId, { text: '_No active exemptions to remove._' });
            return;
        }

        const combined = [
            ...links.map((e, i) => ({ kind: 'link' as const, idx: i, label: `${e.value} (${fmtTimeLeft(e)})` })),
            ...users.map((e, i) => ({ kind: 'user' as const, idx: i, label: `@${e.value.split('@')[0]} (${fmtTimeLeft(e)})` })),
        ];

        const pick = await promptMenu(sock, message, chatId, userId, {
            title: '🔗 Remove which exemption?',
            text: 'Pick one to remove early:',
            options: combined.map((c, i) => ({ label: c.label, value: String(i), description: c.kind === 'link' ? 'Link exemption' : 'User exemption' })),
        });
        if (pick.cancelled || pick.timedOut || !pick.value) return;

        const chosen = combined[parseInt(pick.value, 10)];
        const map = chosen.kind === 'link' ? linkWhitelist : userWhitelist;
        const entries = getActiveEntries(map, chatId);
        const [removed] = entries.splice(chosen.idx, 1);
        map.set(chatId, entries);
        await sock.sendMessage(chatId, {
            text: `✅ Removed exemption: ${chosen.kind === 'user' ? '@' + removed.value.split('@')[0] : removed.value}`,
            mentions: chosen.kind === 'user' ? [removed.value] : undefined
        });
    }
}

async function sendStatus(sock: any, message: any, chatId: string) {
    const status = await getAntilink(chatId);
    await sock.sendMessage(chatId, {
        text: `*🔗 ANTILINK STATUS*\n\n` +
              `*Status:* ${status?.enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
              `*Action:* ${status?.action || 'Not set'}\n\n` +
              `*What happens when links are detected:*\n` +
              `${status?.action === 'delete' ? '• Message is deleted\n• User gets warning' : ''}` +
              `${status?.action === 'kick' ? '• Message is deleted\n• User is removed from group' : ''}` +
              `${status?.action === 'warn' ? '• User gets warning\n• Message stays' : ''}\n\n` +
              `*Exempt:* Admins, Owner, Sudo users`
    }, { quoted: message });
}

export default {
    command: 'antilink',
    aliases: ['alink', 'linkblock'],
    category: 'admin',
    description: 'Prevent users from sending links in the group',
    usage: '.antilink — opens the menu. Or: .antilink <on|off|set|whitelist|domain>',
    groupOnly: true,
    adminOnly: true,

    async handler(sock: any, message: any, args: any, context: BotContext) {
        const chatId = context.chatId || message.key.remoteJid;
        // Must match cleanJid(...) the same way menuSession's listener cleans
        // the replying sender's JID before comparing — otherwise a raw @lid
        // JID here never matches the cleaned JID on reply, and the menu
        // silently never responds (forex.ts does this too; see cleanJid(senderId)).
        const senderJid = cleanJid(message.key.participant || message.key.remoteJid);
        const action = args[0]?.toLowerCase();

        // No arguments → USSD-style interactive menu.
        if (!action) {
            await runMainMenu(sock, message, chatId, senderJid);
            return;
        }

        switch (action) {
            case 'on': {
                const existingConfig = await getAntilink(chatId);
                if (existingConfig?.enabled) {
                    await sock.sendMessage(chatId, {
                        text: '⚠️ *Antilink is already enabled*'
                    }, { quoted: message });
                    return;
                }
                const result = await setAntilink(chatId, 'delete');
                await sock.sendMessage(chatId, {
                    text: result ? '✅ *Antilink enabled successfully!*\n\nDefault action: Delete messages\n\n*Exempt:* Admins, Owner, Sudo users' : '❌ *Failed to enable antilink*'
                }, { quoted: message });
                break;
            }

            case 'off': {
                await removeAntilink(chatId);
                await sock.sendMessage(chatId, {
                    text: '❌ *Antilink disabled*\n\nUsers can now send links freely.'
                }, { quoted: message });
                break;
            }

            case 'set': {
                if (args.length < 2) {
                    await sock.sendMessage(chatId, {
                        text: '❌ *Please specify an action*\n\nUsage: `.antilink set delete | kick | warn`'
                    }, { quoted: message });
                    return;
                }
                const setAction = args[1].toLowerCase();
                if (!['delete', 'kick', 'warn'].includes(setAction)) {
                    await sock.sendMessage(chatId, {
                        text: '❌ *Invalid action*\n\nChoose: delete, kick, or warn'
                    }, { quoted: message });
                    return;
                }
                const setResult = await setAntilink(chatId, setAction);

                await sock.sendMessage(chatId, {
                    text: setResult
                        ? `✅ *Antilink action set to: ${setAction}*\n\n${ACTION_DESCRIPTIONS[setAction]}\n\n*Exempt:* Admins, Owner, Sudo users`
                        : '❌ *Failed to set antilink action*'
                }, { quoted: message });
                break;
            }

            case 'status':
            case 'get': {
                await sendStatus(sock, message, chatId);
                break;
            }

            case 'whitelist': {
                const sub = args[1]?.toLowerCase();

                if (!sub) {
                    await runWhitelistMenu(sock, message, chatId, senderJid);
                    return;
                }

                if (sub === 'list') {
                    const links = getActiveEntries(linkWhitelist, chatId);
                    const users = getActiveEntries(userWhitelist, chatId);
                    const linkLines = links.length ? links.map((e, i) => `${i + 1}. ${e.value} (${fmtTimeLeft(e)})`).join('\n') : '_None_';
                    const userLines = users.length ? users.map((e, i) => `${i + 1}. @${e.value.split('@')[0]} (${fmtTimeLeft(e)})`).join('\n') : '_None_';

                    await sock.sendMessage(chatId, {
                        text: `*🔗 ACTIVE WHITELISTS*\n\n*Links:*\n${linkLines}\n\n*Users:*\n${userLines}`,
                        mentions: users.map(e => e.value)
                    }, { quoted: message });
                    return;
                }

                if (sub === 'remove') {
                    const kind = args[2]?.toLowerCase();
                    const idx = parseInt(args[3], 10) - 1;
                    if (!['link', 'user'].includes(kind) || Number.isNaN(idx)) {
                        await sock.sendMessage(chatId, {
                            text: '❌ Usage: `.antilink whitelist remove link|user <#>` (see `.antilink whitelist list` for numbers)'
                        }, { quoted: message });
                        return;
                    }
                    const map = kind === 'link' ? linkWhitelist : userWhitelist;
                    const entries = getActiveEntries(map, chatId);
                    if (idx < 0 || idx >= entries.length) {
                        await sock.sendMessage(chatId, { text: '❌ Invalid entry number.' }, { quoted: message });
                        return;
                    }
                    const [removed] = entries.splice(idx, 1);
                    map.set(chatId, entries);
                    await sock.sendMessage(chatId, {
                        text: `✅ Removed ${kind} exemption: ${kind === 'user' ? '@' + removed.value.split('@')[0] : removed.value}`,
                        mentions: kind === 'user' ? [removed.value] : undefined
                    }, { quoted: message });
                    return;
                }

                if (sub === 'link') {
                    const url = args[2];
                    if (!url) {
                        await sock.sendMessage(chatId, {
                            text: '❌ Usage: `.antilink whitelist link <url> [minutes]`'
                        }, { quoted: message });
                        return;
                    }
                    const minutes = parseMinutes(args[3]);
                    addToWhitelist(linkWhitelist, chatId, url, senderJid, minutes * 60 * 1000);
                    await sock.sendMessage(chatId, {
                        text: `✅ *Link whitelisted for ${minutes} minute(s)*\n\n${url}\n\nMessages containing this link won't be actioned until it expires.`
                    }, { quoted: message });
                    return;
                }

                if (sub === 'user') {
                    const target = extractTargetUser(message);
                    if (!target) {
                        await sock.sendMessage(chatId, {
                            text: '❌ Tag the user or reply to their message.\n\nUsage: `.antilink whitelist user [minutes]` (with mention or as a reply)'
                        }, { quoted: message });
                        return;
                    }
                    const minutes = parseMinutes(args[2]);
                    addToWhitelist(userWhitelist, chatId, target, senderJid, minutes * 60 * 1000);
                    await sock.sendMessage(chatId, {
                        text: `✅ *User whitelisted for ${minutes} minute(s)*\n\n@${target.split('@')[0]} can post links without action until it expires.`,
                        mentions: [target]
                    }, { quoted: message });
                    return;
                }

                await sock.sendMessage(chatId, {
                    text: '❌ Unknown whitelist option. Use `.antilink whitelist` for help.'
                }, { quoted: message });
                break;
            }

            case 'domain': {
                const sub = args[1]?.toLowerCase();

                if (!sub) {
                    await runDomainsMenu(sock, message, chatId, senderJid);
                    return;
                }

                const config = await getAntilink(chatId);
                const domains: string[] = [...(config?.allowedDomains || [])];

                if (sub === 'add') {
                    const domain = args[2]?.toLowerCase().replace(/^www\./, '');
                    if (!domain) {
                        await sock.sendMessage(chatId, { text: '❌ Usage: `.antilink domain add <domain>`' }, { quoted: message });
                        return;
                    }
                    if (!domains.includes(domain)) domains.push(domain);
                    await setAntilink(chatId, config?.action || 'delete', domains);
                    await sock.sendMessage(chatId, { text: `✅ *${domain}* added to permanently allowed domains.` }, { quoted: message });
                    return;
                }

                if (sub === 'remove') {
                    const domain = args[2]?.toLowerCase().replace(/^www\./, '');
                    if (!domain) {
                        await sock.sendMessage(chatId, { text: '❌ Usage: `.antilink domain remove <domain>`' }, { quoted: message });
                        return;
                    }
                    const updated = domains.filter(d => d !== domain);
                    await setAntilink(chatId, config?.action || 'delete', updated);
                    await sock.sendMessage(chatId, { text: `✅ *${domain}* removed from allowed domains.` }, { quoted: message });
                    return;
                }

                // default: list
                await sock.sendMessage(chatId, {
                    text: `*🔗 PERMANENTLY ALLOWED DOMAINS*\n\n${domains.length ? domains.map((d, i) => `${i + 1}. ${d}`).join('\n') : '_None_'}\n\n` +
                          `• \`.antilink domain add <domain>\`\n` +
                          `• \`.antilink domain remove <domain>\``
                }, { quoted: message });
                break;
            }

            case 'menu': {
                await runMainMenu(sock, message, chatId, senderJid);
                break;
            }

            default:
                await sock.sendMessage(chatId, {
                    text: '❌ *Invalid command*\n\nUse `.antilink` to open the menu.'
                }, { quoted: message });
        }
    },

    handleLinkDetection,
    setAntilink,
    getAntilink,
    removeAntilink
};