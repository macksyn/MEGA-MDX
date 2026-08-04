import type { BotContext } from '../types.js';
import store from '../lib/lightweight_store.js';
import isOwnerOrSudo from '../lib/isOwner.js';
import isAdmin from '../lib/isAdmin.js';

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

// Core settings functions
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

    // Keep only last 10 warnings to prevent data bloat
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

        // Clean expired entries first
        const cleanedWhitelist = whitelist.filter((item: WhitelistInfo) => item.expiresAt > Date.now());
        
        // Add new entry
        cleanedWhitelist.push({
            url: url,
            expiresAt: expiresAt,
            addedBy: addedBy
        });

        await store.saveSetting(chatId, 'antilink_whitelist', cleanedWhitelist);
        
        // Auto-clean after expiry
        setTimeout(async () => {
            await cleanExpiredWhitelist(chatId);
        }, durationMinutes * 60 * 1000 + 1000); // +1 second buffer

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

        // Check if any whitelist entry matches the URL
        for (const item of whitelist) {
            if (item.expiresAt > now) {
                // Check for exact match or domain match
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

// Main link detection handler
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

        // Check if sender is exempt
        const isOwnerSudo = await isOwnerOrSudo(senderId, sock, chatId);
        if (isOwnerSudo) return;

        // Check if sender is admin
        try {
            const { isSenderAdmin } = await isAdmin(sock, chatId, senderId);
            if (isSenderAdmin) return;
        } catch (e: any) {}

        // Determine link type with prioritized checking
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

        // Check whitelist
        const whitelisted = await isWhitelisted(chatId, matchedUrl);
        if (whitelisted) return;

        const messageId = message.key.id;
        const participant = message.key.participant || senderId;
        const action = config.action || 'delete';

        // Delete message for delete and kick actions
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
                // Message might already be deleted or bot lacks permission
                if (error.status !== 404) {
                    console.error('Failed to delete message:', error);
                }
            }
        }

        // Handle based on action type
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

                // If warnings >= 3, automatically kick
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
                    // First warn them, but don't kick yet
                    await sock.sendMessage(chatId, {
                        text: `⚠️ *Final Warning ${kickWarnInfo.count}/3*\n\n` +
                              `@${senderId.split('@')[0]}, posting ${linkType} links is not allowed here!\n\n` +
                              `*Remaining warnings before removal:* ${kickRemainingWarns}\n` +
                              `If you post another link, you will be removed from the group.`,
                        mentions: [senderId]
                    });
                } else {
                    // Kick after 3 warnings
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

export default {
    command: 'antilink',
    aliases: ['alink', 'linkblock'],
    category: 'admin',
    description: 'Prevent users from sending links in the group with smart warnings and whitelisting',
    usage: '.antilink <on|off|set|whitelist|status>',
    groupOnly: true,
    adminOnly: true,

    async handler(sock: any, message: any, args: any, context: BotContext) {
        const chatId = context.chatId || message.key.remoteJid;
        const action = args[0]?.toLowerCase();

        if (!action) {
            const config = await getAntilink(chatId, 'on');
            const whitelist = await getWhitelist(chatId);
            
            let whitelistText = '';
            if (whitelist.length > 0) {
                whitelistText = `\n*Active Whitelisted Links:*\n`;
                whitelist.forEach((item: WhitelistInfo, index: number) => {
                    const timeLeft = Math.max(0, Math.ceil((item.expiresAt - Date.now()) / 60000));
                    whitelistText += `${index + 1}. ${item.url} (${timeLeft} min left)\n`;
                });
            }

            await sock.sendMessage(chatId, {
                text: `*🔗 ANTILINK SETUP*\n\n` +
                      `*Current Status:* ${config?.enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
                      `*Current Action:* ${config?.action || 'Not set'}\n` +
                      `*Warning System:* 3 warnings before kick\n` +
                      `*Whitelist:* ${whitelist.length} active item(s)\n\n` +
                      `*Commands:*\n` +
                      `• \`.antilink on\` - Enable antilink\n` +
                      `• \`.antilink off\` - Disable antilink\n` +
                      `• \`.antilink set delete\` - Delete & warn (auto-kick after 3)\n` +
                      `• \`.antilink set kick\` - Warn 3x then kick\n` +
                      `• \`.antilink set warn\` - Warn only (no kick)\n` +
                      `• \`.antilink whitelist <url>\` - Allow link for 10 min\n` +
                      `• \`.antilink whitelist clear\` - Clear whitelist\n` +
                      `• \`.antilink warnings @user\` - View warnings\n` +
                      `• \`.antilink clearwarn @user\` - Clear warnings\n\n` +
                      `*Protected Links:*\n` +
                      `• WhatsApp Groups\n` +
                      `• WhatsApp Channels\n` +
                      `• Telegram\n` +
                      `• All other links\n\n` +
                      `*Exempt:* Admins, Owner, and Sudo users` +
                      whitelistText
            }, { quoted: message });
            return;
        }

        switch (action) {
            case 'on':
                const existingConfig = await getAntilink(chatId, 'on');
                if (existingConfig?.enabled) {
                    await sock.sendMessage(chatId, {
                        text: '⚠️ *Antilink is already enabled*\n\nUse `.antilink` to see current settings.'
                    }, { quoted: message });
                    return;
                }
                const result = await setAntilink(chatId, 'on', 'delete');
                await sock.sendMessage(chatId, {
                    text: result 
                        ? '✅ *Antilink enabled successfully!*\n\n' +
                          '*Default Action:* Delete messages + warn\n' +
                          '*Warning System:* 3 warnings, then auto-kick\n' +
                          '*Whitelist:* Allow links temporarily with `.antilink whitelist <url>`\n\n' +
                          '*Exempt:* Admins, Owner, Sudo users'
                        : '❌ *Failed to enable antilink*'
                }, { quoted: message });
                break;

            case 'off':
                await removeAntilink(chatId, 'on');
                await sock.sendMessage(chatId, {
                    text: '❌ *Antilink disabled*\n\nUsers can now send links freely.'
                }, { quoted: message });
                break;

            case 'set':
                if (args.length < 2) {
                    await sock.sendMessage(chatId, {
                        text: '❌ *Please specify an action*\n\n' +
                              'Usage: `.antilink set <delete|kick|warn>`\n\n' +
                              '*delete* - Delete messages, warn, auto-kick after 3 warnings\n' +
                              '*kick* - Warn 3 times, then remove from group\n' +
                              '*warn* - Only send warnings, never kick'
                    }, { quoted: message });
                    return;
                }
                const setAction = args[1].toLowerCase() as AntilinkAction;
                if (!['delete', 'kick', 'warn'].includes(setAction)) {
                    await sock.sendMessage(chatId, {
                        text: '❌ *Invalid action*\n\nChoose: delete, kick, or warn'
                    }, { quoted: message });
                    return;
                }
                const setResult = await setAntilink(chatId, 'on', setAction);

                const actionDescriptions: Record<AntilinkAction, string> = {
                    delete: 'Delete link messages\n• Warn users\n• Auto-kick after 3 warnings',
                    kick: 'Delete messages\n• Warn 3 times\n• Kick after 3rd warning',
                    warn: 'Only send warning messages\n• No message deletion\n• No kicking'
                };

                await sock.sendMessage(chatId, {
                    text: setResult
                        ? `✅ *Antilink action set to: ${setAction}*\n\n` +
                          `${actionDescriptions[setAction]}\n\n` +
                          `*Exempt:* Admins, Owner, Sudo users\n` +
                          `*Whitelist:* Use \`.antilink whitelist <url>\` to temporarily allow links`
                        : '❌ *Failed to set antilink action*'
                }, { quoted: message });
                break;

            case 'whitelist':
                if (args.length < 2) {
                    await sock.sendMessage(chatId, {
                        text: '❌ *Please specify a URL or "clear"*\n\n' +
                              'Usage:\n' +
                              '• `.antilink whitelist <url>` - Allow a link for 10 minutes\n' +
                              '• `.antilink whitelist clear` - Remove all whitelisted links\n\n' +
                              'Example: `.antilink whitelist https://example.com`'
                    }, { quoted: message });
                    return;
                }

                if (args[1].toLowerCase() === 'clear') {
                    await store.saveSetting(chatId, 'antilink_whitelist', []);
                    await sock.sendMessage(chatId, {
                        text: '✅ *Whitelist cleared*\n\nAll temporarily allowed links have been removed.'
                    }, { quoted: message });
                    return;
                }

                const urlToWhitelist = args[1];
                if (!urlToWhitelist.match(/^https?:\/\/.+/i)) {
                    await sock.sendMessage(chatId, {
                        text: '❌ *Invalid URL*\n\nPlease provide a valid URL starting with http:// or https://'
                    }, { quoted: message });
                    return;
                }

                const whitelistResult = await addToWhitelist(chatId, urlToWhitelist, context.senderId);
                if (whitelistResult) {
                    await sock.sendMessage(chatId, {
                        text: `✅ *Link whitelisted for 10 minutes*\n\n` +
                              `*URL:* ${urlToWhitelist}\n` +
                              `*Expires:* In 10 minutes\n\n` +
                              `This link can now be posted without triggering antilink protection.`
                    }, { quoted: message });
                } else {
                    await sock.sendMessage(chatId, {
                        text: '❌ *Failed to whitelist link*'
                    }, { quoted: message });
                }
                break;

            case 'warnings':
                let targetUser = senderId;
                if (message.mentions && message.mentions.length > 0) {
                    targetUser = message.mentions[0];
                } else if (args.length > 1 && args[1].startsWith('@')) {
                    // Try to extract user from mention text
                    targetUser = args[1].replace('@', '') + '@s.whatsapp.net';
                }

                const userWarnings = await getWarnings(chatId, targetUser);
                const username = targetUser.split('@')[0];

                let warningHistory = '';
                if (userWarnings.warnings.length > 0) {
                    warningHistory = '\n*Warning History:*\n';
                    userWarnings.warnings.forEach((warn, index) => {
                        const date = new Date(warn.timestamp).toLocaleString();
                        warningHistory += `${index + 1}. ${warn.linkType} - ${date}\n`;
                    });
                }

                await sock.sendMessage(chatId, {
                    text: `*⚠️ WARNINGS FOR @${username}*\n\n` +
                          `*Total Warnings:* ${userWarnings.count}\n` +
                          `*Last Warned:* ${userWarnings.lastWarned ? new Date(userWarnings.lastWarned).toLocaleString() : 'Never'}\n` +
                          `${userWarnings.count >= 3 ? '\n⚠️ User has reached maximum warnings!' : ''}` +
                          warningHistory,
                    mentions: [targetUser]
                }, { quoted: message });
                break;

            case 'clearwarn':
            case 'clearwarnings':
                let clearTarget = senderId;
                if (message.mentions && message.mentions.length > 0) {
                    clearTarget = message.mentions[0];
                } else if (args.length > 1 && args[1].startsWith('@')) {
                    clearTarget = args[1].replace('@', '') + '@s.whatsapp.net';
                }

                await clearWarnings(chatId, clearTarget);
                const clearUsername = clearTarget.split('@')[0];
                await sock.sendMessage(chatId, {
                    text: `✅ *Warnings cleared for @${clearUsername}*\n\nTheir warning count has been reset to 0.`,
                    mentions: [clearTarget]
                }, { quoted: message });
                break;

            case 'status':
            case 'get':
                const status = await getAntilink(chatId, 'on');
                const whitelistStatus = await getWhitelist(chatId);

                let whitelistStatusText = '';
                if (whitelistStatus.length > 0) {
                    whitelistStatusText = '\n*Active Whitelisted Links:*\n';
                    whitelistStatus.forEach((item: WhitelistInfo, index: number) => {
                        const timeLeft = Math.max(0, Math.ceil((item.expiresAt - Date.now()) / 60000));
                        whitelistStatusText += `${index + 1}. ${item.url}\n   Expires in: ${timeLeft} minutes\n`;
                    });
                } else {
                    whitelistStatusText = '\n*No whitelisted links*';
                }

                await sock.sendMessage(chatId, {
                    text: `*🔗 ANTILINK STATUS*\n\n` +
                          `*Status:* ${status?.enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
                          `*Action:* ${status?.action || 'Not set'}\n` +
                          `*Warning Limit:* 3 warnings before kick\n\n` +
                          `*What happens when links are detected:*\n` +
                          `${status?.action === 'delete' ? '• Message is deleted\n• User gets warning\n• Auto-kick after 3 warnings' : ''}` +
                          `${status?.action === 'kick' ? '• Message is deleted\n• User warned 3 times\n• Kicked after 3rd warning' : ''}` +
                          `${status?.action === 'warn' ? '• User gets warning\n• Message stays\n• No kicking' : ''}\n\n` +
                          `*Exempt:* Admins, Owner, Sudo users\n` +
                          `*Whitelist:* Use \`.antilink whitelist <url>\` to temporarily allow links` +
                          whitelistStatusText
                }, { quoted: message });
                break;

            default:
                await sock.sendMessage(chatId, {
                    text: '❌ *Invalid command*\n\nUse `.antilink` to see available options.'
                }, { quoted: message });
        }
    },

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