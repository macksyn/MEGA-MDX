import type { BotContext } from '../types.js';
import store from '../lib/lightweight_store.js';
import isOwnerOrSudo from '../lib/isOwner.js';
import isAdmin from '../lib/isAdmin.js';
import { promptMenu, promptText } from '../lib/menuSession.js';

// Type definitions
type AntilinkAction = 'delete' | 'kick' | 'warn';
type AntilinkType = 'on' | 'off';

interface AntilinkConfig {
    enabled: boolean;
    action: AntilinkAction | null;
    type: AntilinkType | null;
}

interface WarningInfo {
    count: number;
    lastWarned: number;
    warnings: Array<{
        timestamp: number;
        linkType: string;
    }>;
}

interface WhitelistInfo {
    url: string;
    expiresAt: number;
    addedBy: string;
}

// Core settings functions (unchanged)
async function setAntilink(
    chatId: string,
    type: AntilinkType,
    action: AntilinkAction
): Promise<boolean> {
    try {
        await store.saveSetting(chatId, 'antilink', {
            enabled: true,
            action: action,
            type: type
        });
        return true;
    } catch (error: any) {
        console.error('Error setting antilink:', error);
        return false;
    }
}

async function getAntilink(chatId: string, _type: string): Promise<AntilinkConfig | null> {
    try {
        const settings = await store.getSetting(chatId, 'antilink');
        return settings || null;
    } catch (error: any) {
        console.error('Error getting antilink:', error);
        return null;
    }
}

async function removeAntilink(chatId: string, _type: string): Promise<boolean> {
    try {
        await store.saveSetting(chatId, 'antilink', {
            enabled: false,
            action: null,
            type: null
        });
        return true;
    } catch (error: any) {
        console.error('Error removing antilink:', error);
        return false;
    }
}

// Warning management functions
async function addWarning(chatId: string, userId: string, linkType: string): Promise<WarningInfo> {
    const key = `antilink_warnings_${userId}`;
    const warnings = await store.getSetting(chatId, key) || {
        count: 0,
        lastWarned: 0,
        warnings: []
    };

    warnings.count++;
    warnings.lastWarned = Date.now();
    warnings.warnings.push({
        timestamp: Date.now(),
        linkType: linkType
    });

    if (warnings.warnings.length > 10) {
        warnings.warnings = warnings.warnings.slice(-10);
    }

    await store.saveSetting(chatId, key, warnings);
    return warnings;
}

async function getWarnings(chatId: string, userId: string): Promise<WarningInfo> {
    const key = `antilink_warnings_${userId}`;
    const warnings = await store.getSetting(chatId, key) || {
        count: 0,
        lastWarned: 0,
        warnings: []
    };
    return warnings;
}

async function clearWarnings(chatId: string, userId: string): Promise<void> {
    const key = `antilink_warnings_${userId}`;
    await store.saveSetting(chatId, key, {
        count: 0,
        lastWarned: 0,
        warnings: []
    });
}

// Whitelist management functions
async function addToWhitelist(chatId: string, url: string, addedBy: string, durationMinutes: number = 10): Promise<boolean> {
    try {
        const whitelist = await store.getSetting(chatId, 'antilink_whitelist') || [];
        const expiresAt = Date.now() + (durationMinutes * 60 * 1000);

        const cleanedWhitelist = whitelist.filter((item: WhitelistInfo) => item.expiresAt > Date.now());
        cleanedWhitelist.push({
            url: url,
            expiresAt: expiresAt,
            addedBy: addedBy
        });

        await store.saveSetting(chatId, 'antilink_whitelist', cleanedWhitelist);

        setTimeout(async () => {
            await cleanExpiredWhitelist(chatId);
        }, durationMinutes * 60 * 1000 + 1000);

        return true;
    } catch (error: any) {
        console.error('Error adding to whitelist:', error);
        return false;
    }
}

async function isWhitelisted(chatId: string, url: string): Promise<boolean> {
    try {
        const whitelist = await store.getSetting(chatId, 'antilink_whitelist') || [];
        const now = Date.now();
        for (const item of whitelist) {
            if (item.expiresAt > now) {
                if (url.includes(item.url) || item.url.includes(url)) {
                    return true;
                }
            }
        }
        return false;
    } catch (error: any) {
        console.error('Error checking whitelist:', error);
        return false;
    }
}

async function cleanExpiredWhitelist(chatId: string): Promise<void> {
    try {
        const whitelist = await store.getSetting(chatId, 'antilink_whitelist') || [];
        const now = Date.now();
        const cleanedWhitelist = whitelist.filter((item: WhitelistInfo) => item.expiresAt > now);
        if (cleanedWhitelist.length !== whitelist.length) {
            await store.saveSetting(chatId, 'antilink_whitelist', cleanedWhitelist);
        }
    } catch (error: any) {
        console.error('Error cleaning whitelist:', error);
    }
}

async function getWhitelist(chatId: string): Promise<WhitelistInfo[]> {
    try {
        await cleanExpiredWhitelist(chatId);
        const whitelist = await store.getSetting(chatId, 'antilink_whitelist') || [];
        return whitelist.filter((item: WhitelistInfo) => item.expiresAt > Date.now());
    } catch (error: any) {
        console.error('Error getting whitelist:', error);
        return [];
    }
}

// Main link detection handler (unchanged)
export async function handleLinkDetection(
    sock: any,
    chatId: string,
    message: any,
    userMessage: string,
    senderId: string
) {
    try {
        const config = await getAntilink(chatId, 'on');
        if (!config?.enabled) return;

        const isOwnerSudo = await isOwnerOrSudo(senderId, sock, chatId);
        if (isOwnerSudo) return;

        try {
            const { isSenderAdmin } = await isAdmin(sock, chatId, senderId);
            if (isSenderAdmin) return;
        } catch (e: any) {}

        let linkType = '';
        let matchedUrl = '';

        const linkChecks = [
            { pattern: /(chat\.whatsapp\.com\/[A-Za-z0-9]{20,})/i, type: 'WhatsApp Group' },
            { pattern: /(wa\.me\/channel\/[A-Za-z0-9]{20,})/i, type: 'WhatsApp Channel' },
            { pattern: /((?:t\.me|telegram\.me|telegram\.dog)\/[A-Za-z0-9_]{3,})/i, type: 'Telegram' },
            { pattern: /(https?:\/\/[^\s]+)/i, type: 'Scam' }
        ];

        for (const check of linkChecks) {
            const match = userMessage.match(check.pattern);
            if (match) {
                linkType = check.type;
                matchedUrl = match[1];
                break;
            }
        }

        if (!linkType) return;

        const whitelisted = await isWhitelisted(chatId, matchedUrl);
        if (whitelisted) return;

        const messageId = message.key.id;
        const participant = message.key.participant || senderId;
        const action = config.action || 'delete';

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
            } catch (error: any) {
                if (error.status !== 404) {
                    console.error('Failed to delete message:', error);
                }
            }
        }

        switch (action) {
            case 'warn':
                const warnInfo = await addWarning(chatId, senderId, linkType);
                const remainingWarns = Math.max(0, 3 - warnInfo.count);

                await sock.sendMessage(chatId, {
                    text: `⚠️ *Warning ${warnInfo.count}/3*\n\n` +
                          `@${senderId.split('@')[0]}, posting ${linkType} links is not allowed here!\n\n` +
                          `*Remaining warnings:* ${remainingWarns}\n` +
                          `${warnInfo.count >= 3 ? '\n⚠️ You have reached the maximum warnings. Further violations will result in removal.' : ''}`,
                    mentions: [senderId]
                });
                break;

            case 'delete':
                const deleteWarnInfo = await addWarning(chatId, senderId, linkType);
                const deleteRemainingWarns = Math.max(0, 3 - deleteWarnInfo.count);

                await sock.sendMessage(chatId, {
                    text: `⚠️ *Message Deleted - Warning ${deleteWarnInfo.count}/3*\n\n` +
                          `@${senderId.split('@')[0]}, posting ${linkType} links is not allowed here!\n\n` +
                          `*Remaining warnings:* ${deleteRemainingWarns}\n` +
                          `${deleteWarnInfo.count >= 3 ? '\n⚠️ You have reached the maximum warnings. Further violations will result in removal.' : ''}`,
                    mentions: [senderId]
                });

                if (deleteWarnInfo.count >= 3) {
                    try {
                        await sock.groupParticipantsUpdate(chatId, [senderId], 'remove');
                        await clearWarnings(chatId, senderId);
                        await sock.sendMessage(chatId, {
                            text: `🚫 @${senderId.split('@')[0]} has been removed for repeatedly posting links after 3 warnings.`,
                            mentions: [senderId]
                        });
                    } catch (error: any) {
                        console.error('Failed to kick user after max warnings:', error);
                        await sock.sendMessage(chatId, {
                            text: `⚠️ @${senderId.split('@')[0]} has reached ${deleteWarnInfo.count} warnings but I couldn't remove them. Please check my admin permissions.`,
                            mentions: [senderId]
                        });
                    }
                }
                break;

            case 'kick':
                const kickWarnInfo = await addWarning(chatId, senderId, linkType);
                const kickRemainingWarns = Math.max(0, 3 - kickWarnInfo.count);

                if (kickWarnInfo.count < 3) {
                    await sock.sendMessage(chatId, {
                        text: `⚠️ *Final Warning ${kickWarnInfo.count}/3*\n\n` +
                              `@${senderId.split('@')[0]}, posting ${linkType} links is not allowed here!\n\n` +
                              `*Remaining warnings before removal:* ${kickRemainingWarns}\n` +
                              `If you post another link, you will be removed from the group.`,
                        mentions: [senderId]
                    });
                } else {
                    try {
                        await sock.groupParticipantsUpdate(chatId, [senderId], 'remove');
                        await clearWarnings(chatId, senderId);
                        await sock.sendMessage(chatId, {
                            text: `🚫 @${senderId.split('@')[0]} has been removed for posting ${linkType} links after ${kickWarnInfo.count} warnings.`,
                            mentions: [senderId]
                        });
                    } catch (error: any) {
                        console.error('Failed to kick user:', error);
                        await sock.sendMessage(chatId, {
                            text: `⚠️ Failed to remove @${senderId.split('@')[0]}. Make sure the bot is an admin and has permission to remove members.`,
                            mentions: [senderId]
                        });
                    }
                }
                break;
        }

    } catch (error: any) {
        console.error('Error in link detection:', error);
    }
}

// --- COMMAND HANDLER ---
export default {
    command: 'antilink',
    aliases: ['alink', 'linkblock'],
    category: 'admin',
    description: 'Prevent users from sending links in the group with smart warnings and whitelisting',
    usage: '.antilink (for interactive menu) or .antilink <subcommand>',
    groupOnly: true,
    adminOnly: true,

    async handler(sock: any, message: any, args: any, context: BotContext) {
        const chatId = context.chatId || message.key.remoteJid;
        const senderId = context.senderId;   // ✅ DEFINED HERE

        // Group & admin checks
        if (!chatId.endsWith('@g.us')) {
            await sock.sendMessage(chatId, { text: '❌ This command is only for groups.' });
            return;
        }
        const { isSenderAdmin } = await isAdmin(sock, chatId, senderId);
        if (!isSenderAdmin && !(await isOwnerOrSudo(senderId, sock, chatId))) {
            await sock.sendMessage(chatId, { text: '❌ Only admins can use this command.' });
            return;
        }

        // If arguments are provided, fall back to the old direct command flow
        if (args.length > 0) {
            await handleDirectCommand(sock, message, args, chatId, senderId, context);
            return;
        }

        // --- INTERACTIVE MENU FLOW ---
        const config = await getAntilink(chatId, 'on');
        const enabled = config?.enabled || false;
        const action = config?.action || 'delete';
        const statusText = enabled ? '✅ Enabled' : '❌ Disabled';

        const mainOptions = [
            { label: `${enabled ? 'Disable' : 'Enable'} Antilink`, value: 'toggle' },
            { label: `Change Action (current: ${action})`, value: 'setaction' },
            { label: 'Manage Whitelist', value: 'whitelist' },
            { label: 'View User Warnings', value: 'viewwarnings' },
            { label: 'Clear User Warnings', value: 'clearwarnings' },
            { label: 'Show Status', value: 'status' },
            { label: 'Cancel', value: 'cancel' }
        ];

        const result = await promptMenu(sock, message, chatId, senderId, {
            title: '🔗 Antilink Control Panel',
            text: `Current status: ${statusText}\nAction: ${action}\n\nSelect an option:`,
            options: mainOptions,
            ttlMs: 120000
        });

        if (result.cancelled || result.timedOut) {
            if (result.timedOut) {
                await sock.sendMessage(chatId, { text: '⏰ Menu timed out.' });
            }
            return;
        }

        // Handle each menu option
        switch (result.value) {
            case 'toggle':
                if (enabled) {
                    await removeAntilink(chatId, 'on');
                    await sock.sendMessage(chatId, { text: '❌ Antilink disabled.' });
                } else {
                    await setAntilink(chatId, 'on', 'delete');
                    await sock.sendMessage(chatId, { text: '✅ Antilink enabled with default action: delete.' });
                }
                break;

            case 'setaction': {
                const actionOptions = [
                    { label: 'Delete (warn & auto-kick after 3)', value: 'delete' },
                    { label: 'Kick (warn 3 times then kick)', value: 'kick' },
                    { label: 'Warn (only warnings)', value: 'warn' },
                    { label: 'Cancel', value: 'cancel' }
                ];
                const actionResult = await promptMenu(sock, message, chatId, senderId, {
                    title: '⚙️ Select Action',
                    text: `Current action: ${action}\nChoose new action:`,
                    options: actionOptions,
                    ttlMs: 60000
                });
                if (actionResult.cancelled || actionResult.timedOut) {
                    if (actionResult.timedOut) await sock.sendMessage(chatId, { text: '⏰ Timed out.' });
                    break;
                }
                if (actionResult.value === 'cancel') break;
                await setAntilink(chatId, 'on', actionResult.value as AntilinkAction);
                await sock.sendMessage(chatId, { text: `✅ Action set to: ${actionResult.value}` });
                break;
            }

            case 'whitelist': {
                const wlOptions = [
                    { label: 'View Whitelist', value: 'view' },
                    { label: 'Add URL to Whitelist', value: 'add' },
                    { label: 'Clear Whitelist', value: 'clear' },
                    { label: 'Cancel', value: 'cancel' }
                ];
                const wlResult = await promptMenu(sock, message, chatId, senderId, {
                    title: '📋 Whitelist Management',
                    text: 'Select an option:',
                    options: wlOptions,
                    ttlMs: 60000
                });
                if (wlResult.cancelled || wlResult.timedOut) {
                    if (wlResult.timedOut) await sock.sendMessage(chatId, { text: '⏰ Timed out.' });
                    break;
                }
                switch (wlResult.value) {
                    case 'view': {
                        const wl = await getWhitelist(chatId);
                        let wlText = '';
                        if (wl.length === 0) {
                            wlText = 'No whitelisted links.';
                        } else {
                            wlText = 'Active whitelisted links:\n';
                            wl.forEach((item, idx) => {
                                const timeLeft = Math.max(0, Math.ceil((item.expiresAt - Date.now()) / 60000));
                                wlText += `${idx+1}. ${item.url} (expires in ${timeLeft} min)\n`;
                            });
                        }
                        await sock.sendMessage(chatId, { text: `📋 Whitelist:\n${wlText}` });
                        break;
                    }
                    case 'add': {
                        await sock.sendMessage(chatId, { 
                            text: '📝 Please reply with the URL you want to whitelist (e.g., https://example.com).\nReply *cancel* to abort.' 
                        });
                        const urlResult = await promptText(sock, chatId, senderId, 60000);
                        if (urlResult.timedOut) {
                            await sock.sendMessage(chatId, { text: '⏰ Timed out.' });
                        } else if (urlResult.cancelled) {
                            await sock.sendMessage(chatId, { text: 'Cancelled.' });
                        } else {
                            const url = urlResult.text.trim();
                            if (!url.match(/^https?:\/\/.+/i)) {
                                await sock.sendMessage(chatId, { text: '❌ Invalid URL. Must start with http:// or https://' });
                            } else {
                                const added = await addToWhitelist(chatId, url, senderId);
                                if (added) {
                                    await sock.sendMessage(chatId, { text: `✅ Whitelisted: ${url} for 10 minutes.` });
                                } else {
                                    await sock.sendMessage(chatId, { text: '❌ Failed to whitelist.' });
                                }
                            }
                        }
                        break;
                    }
                    case 'clear': {
                        await store.saveSetting(chatId, 'antilink_whitelist', []);
                        await sock.sendMessage(chatId, { text: '✅ Whitelist cleared.' });
                        break;
                    }
                    case 'cancel':
                        break;
                }
                break;
            }

            case 'viewwarnings': {
                await sock.sendMessage(chatId, { 
                    text: '🔍 Reply with the user\'s phone number (e.g., 1234567890) or mention them (e.g., @1234567890).\nReply *cancel* to abort.' 
                });
                const mentionResult = await promptText(sock, chatId, senderId, 60000);
                if (mentionResult.timedOut || mentionResult.cancelled) {
                    await sock.sendMessage(chatId, { text: mentionResult.timedOut ? '⏰ Timed out.' : 'Cancelled.' });
                    break;
                }
                const msgText = mentionResult.text;
                let targetUser = null;
                const mentionMatch = msgText.match(/@(\d+)/);
                if (mentionMatch) {
                    targetUser = mentionMatch[1] + '@s.whatsapp.net';
                } else {
                    const phoneMatch = msgText.match(/\d{10,15}/);
                    if (phoneMatch) {
                        targetUser = phoneMatch[0] + '@s.whatsapp.net';
                    } else {
                        await sock.sendMessage(chatId, { text: '❌ Could not identify user. Please provide a valid phone number or mention.' });
                        break;
                    }
                }
                if (targetUser) {
                    const warnings = await getWarnings(chatId, targetUser);
                    let warnText = `⚠️ Warnings for @${targetUser.split('@')[0]}\n`;
                    warnText += `Total: ${warnings.count}\n`;
                    warnText += `Last warned: ${warnings.lastWarned ? new Date(warnings.lastWarned).toLocaleString() : 'Never'}\n`;
                    if (warnings.warnings.length > 0) {
                        warnText += 'History:\n';
                        warnings.warnings.forEach((w, i) => {
                            warnText += `${i+1}. ${w.linkType} at ${new Date(w.timestamp).toLocaleString()}\n`;
                        });
                    }
                    await sock.sendMessage(chatId, { text: warnText, mentions: [targetUser] });
                }
                break;
            }

            case 'clearwarnings': {
                await sock.sendMessage(chatId, { 
                    text: '🧹 Reply with the user\'s phone number or mention to clear warnings.\nReply *cancel* to abort.' 
                });
                const clearResult = await promptText(sock, chatId, senderId, 60000);
                if (clearResult.timedOut || clearResult.cancelled) {
                    await sock.sendMessage(chatId, { text: clearResult.timedOut ? '⏰ Timed out.' : 'Cancelled.' });
                    break;
                }
                const clearText = clearResult.text;
                let clearTarget = null;
                const clearMention = clearText.match(/@(\d+)/);
                if (clearMention) {
                    clearTarget = clearMention[1] + '@s.whatsapp.net';
                } else {
                    const phoneMatch = clearText.match(/\d{10,15}/);
                    if (phoneMatch) {
                        clearTarget = phoneMatch[0] + '@s.whatsapp.net';
                    } else {
                        await sock.sendMessage(chatId, { text: '❌ Could not identify user.' });
                        break;
                    }
                }
                if (clearTarget) {
                    await clearWarnings(chatId, clearTarget);
                    await sock.sendMessage(chatId, { text: `✅ Warnings cleared for @${clearTarget.split('@')[0]}`, mentions: [clearTarget] });
                }
                break;
            }

            case 'status': {
                const statusConfig = await getAntilink(chatId, 'on');
                const whitelistStatus = await getWhitelist(chatId);
                let statusTextFull = `🔗 Antilink Status\n`;
                statusTextFull += `Status: ${statusConfig?.enabled ? '✅ Enabled' : '❌ Disabled'}\n`;
                statusTextFull += `Action: ${statusConfig?.action || 'Not set'}\n`;
                statusTextFull += `Whitelist: ${whitelistStatus.length} active\n`;
                if (whitelistStatus.length > 0) {
                    statusTextFull += 'Whitelisted:\n';
                    whitelistStatus.forEach((item, idx) => {
                        const timeLeft = Math.max(0, Math.ceil((item.expiresAt - Date.now()) / 60000));
                        statusTextFull += `${idx+1}. ${item.url} (${timeLeft} min left)\n`;
                    });
                }
                await sock.sendMessage(chatId, { text: statusTextFull });
                break;
            }

            case 'cancel':
                break;
        }
    },

    // Expose internal functions for backward compatibility or external use
    handleLinkDetection,
    setAntilink,
    getAntilink,
    removeAntilink,
    addWarning,
    getWarnings,
    clearWarnings,
    addToWhitelist,
    isWhitelisted,
    getWhitelist,
    cleanExpiredWhitelist
};

// --- LEGACY DIRECT COMMAND HANDLER (with senderId parameter) ---
async function handleDirectCommand(
    sock: any,
    message: any,
    args: string[],
    chatId: string,
    senderId: string,   // ✅ MUST BE PRESENT
    context: BotContext
) {
    const action = args[0]?.toLowerCase();

    if (!action) {
        return;
    }

    switch (action) {
        case 'on': {
            const existingConfig = await getAntilink(chatId, 'on');
            if (existingConfig?.enabled) {
                await sock.sendMessage(chatId, {
                    text: '⚠️ Antilink is already enabled. Use `.antilink` to see settings.'
                }, { quoted: message });
                return;
            }
            const result = await setAntilink(chatId, 'on', 'delete');
            await sock.sendMessage(chatId, {
                text: result
                    ? '✅ Antilink enabled (default action: delete).'
                    : '❌ Failed to enable antilink.'
            }, { quoted: message });
            break;
        }

        case 'off': {
            await removeAntilink(chatId, 'on');
            await sock.sendMessage(chatId, {
                text: '❌ Antilink disabled.'
            }, { quoted: message });
            break;
        }

        case 'set': {
            if (args.length < 2) {
                await sock.sendMessage(chatId, {
                    text: '❌ Usage: .antilink set <delete|kick|warn>'
                }, { quoted: message });
                return;
            }
            const setAction = args[1].toLowerCase() as AntilinkAction;
            if (!['delete', 'kick', 'warn'].includes(setAction)) {
                await sock.sendMessage(chatId, {
                    text: '❌ Invalid action. Choose: delete, kick, or warn'
                }, { quoted: message });
                return;
            }
            const setResult = await setAntilink(chatId, 'on', setAction);
            await sock.sendMessage(chatId, {
                text: setResult
                    ? `✅ Action set to: ${setAction}`
                    : '❌ Failed to set action.'
            }, { quoted: message });
            break;
        }

        case 'whitelist': {
            if (args.length < 2) {
                await sock.sendMessage(chatId, {
                    text: '❌ Usage: .antilink whitelist <url> or .antilink whitelist clear'
                }, { quoted: message });
                return;
            }
            if (args[1].toLowerCase() === 'clear') {
                await store.saveSetting(chatId, 'antilink_whitelist', []);
                await sock.sendMessage(chatId, { text: '✅ Whitelist cleared.' }, { quoted: message });
                return;
            }
            const url = args[1];
            if (!url.match(/^https?:\/\/.+/i)) {
                await sock.sendMessage(chatId, {
                    text: '❌ Invalid URL. Must start with http:// or https://'
                }, { quoted: message });
                return;
            }
            const added = await addToWhitelist(chatId, url, senderId);   // ✅ senderId used here
            if (added) {
                await sock.sendMessage(chatId, {
                    text: `✅ Whitelisted: ${url} for 10 minutes.`
                }, { quoted: message });
            } else {
                await sock.sendMessage(chatId, {
                    text: '❌ Failed to whitelist.'
                }, { quoted: message });
            }
            break;
        }

        case 'warnings': {
            let targetUser = senderId;   // ✅ senderId used here
            if (message.mentions && message.mentions.length > 0) {
                targetUser = message.mentions[0];
            } else if (args.length > 1 && args[1].startsWith('@')) {
                targetUser = args[1].replace('@', '') + '@s.whatsapp.net';
            }
            const warnings = await getWarnings(chatId, targetUser);
            let warnText = `⚠️ Warnings for @${targetUser.split('@')[0]}\n`;
            warnText += `Total: ${warnings.count}\n`;
            warnText += `Last warned: ${warnings.lastWarned ? new Date(warnings.lastWarned).toLocaleString() : 'Never'}`;
            await sock.sendMessage(chatId, { text: warnText, mentions: [targetUser] }, { quoted: message });
            break;
        }

        case 'clearwarn':
        case 'clearwarnings': {
            let clearTarget = senderId;   // ✅ senderId used here
            if (message.mentions && message.mentions.length > 0) {
                clearTarget = message.mentions[0];
            } else if (args.length > 1 && args[1].startsWith('@')) {
                clearTarget = args[1].replace('@', '') + '@s.whatsapp.net';
            }
            await clearWarnings(chatId, clearTarget);
            await sock.sendMessage(chatId, {
                text: `✅ Warnings cleared for @${clearTarget.split('@')[0]}`,
                mentions: [clearTarget]
            }, { quoted: message });
            break;
        }

        case 'status':
        case 'get': {
            const statusConfig = await getAntilink(chatId, 'on');
            const whitelistStatus = await getWhitelist(chatId);
            let statusTextFull = `🔗 Antilink Status\n`;
            statusTextFull += `Status: ${statusConfig?.enabled ? '✅ Enabled' : '❌ Disabled'}\n`;
            statusTextFull += `Action: ${statusConfig?.action || 'Not set'}\n`;
            statusTextFull += `Whitelist: ${whitelistStatus.length} active\n`;
            if (whitelistStatus.length > 0) {
                statusTextFull += 'Whitelisted:\n';
                whitelistStatus.forEach((item, idx) => {
                    const timeLeft = Math.max(0, Math.ceil((item.expiresAt - Date.now()) / 60000));
                    statusTextFull += `${idx+1}. ${item.url} (${timeLeft} min left)\n`;
                });
            }
            await sock.sendMessage(chatId, { text: statusTextFull }, { quoted: message });
            break;
        }

        default: {
            await sock.sendMessage(chatId, {
                text: '❌ Unknown subcommand. Use `.antilink` for interactive menu.'
            }, { quoted: message });
        }
    }
}