/**
 * plugins/inactive.ts
 * Tracks user activity per group and sends DMs to inactive members.
 *
 * Architecture mirrors chatbot.ts / activitytracker.ts:
 *   - createStore (lib/pluginStore)   → same DB pattern
 *   - onMessage hook                  → passive tracking on every group message
 *   - schedules[].every               → 24-hour automated DM check
 *   - lib/isAdmin + lib/isOwner       → admin / owner-only guards
 *   - Subcommand routing              → same pattern as other group plugins
 */

import type { BotContext } from '../types.js';
import { createStore }     from '../lib/pluginStore.js';
import isAdmin             from '../lib/isAdmin.js';
import isOwnerOrSudo       from '../lib/isOwner.js';
import { printLog }        from '../lib/print.js';
import config              from '../config.js';

// ── Storage ───────────────────────────────────────────────────────────────────
// Tables created automatically by pluginStore on first access.
//   plugin_inactivetracker_activity  → per-user activity records
//   plugin_inactivetracker_settings  → per-group configuration

const db         = createStore('inactivetracker');
const dbActivity = db.table!('activity');   // key: `groupId__userId`
const dbSettings = db.table!('settings');   // key: groupId

// ── Types ─────────────────────────────────────────────────────────────────────

interface GroupSettings {
    enabled:          boolean;
    inactiveDays:     number;
    dmMessage:        string;
    maxReminders:     number;
    reminderInterval: number;
    excludeAdmins:    boolean;
}

interface ActivityRecord {
    groupId:          string;
    userId:           string;
    firstSeen:        string;
    lastActivity:     string;
    updatedAt:        string;
    remindersSent:    number;
    lastReminderSent: string | null;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: GroupSettings = {
    enabled:          false,
    inactiveDays:     7,
    dmMessage:        'Hi {user}! 👋\n\nWe noticed you haven\'t been active in *{groupName}* for *{days}*. We miss you! 💙\n\nFeel free to jump back in anytime!',
    maxReminders:     3,
    reminderInterval: 7,
    excludeAdmins:    false,
};

// ── In-memory caches ──────────────────────────────────────────────────────────

const enabledGroupsCache = new Set<string>();
const settingsCache      = new Map<string, { data: GroupSettings; ts: number }>();
const CACHE_TTL          = 60_000; // 1 minute

// ── Settings helpers ──────────────────────────────────────────────────────────

async function getGroupSettings(groupId: string): Promise<GroupSettings> {
    const now    = Date.now();
    const cached = settingsCache.get(groupId);
    if (cached && now - cached.ts < CACHE_TTL) return cached.data;

    try {
        const saved  = (await dbSettings.get(groupId)) ?? {};
        const merged = { ...DEFAULT_SETTINGS, ...saved } as GroupSettings;
        settingsCache.set(groupId, { data: merged, ts: now });
        return merged;
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

async function saveGroupSettings(groupId: string, settings: GroupSettings): Promise<boolean> {
    try {
        await dbSettings.set(groupId, settings);
        settingsCache.delete(groupId);

        if (settings.enabled) {
            enabledGroupsCache.add(groupId);
        } else {
            enabledGroupsCache.delete(groupId);
        }
        return true;
    } catch (error: any) {
        printLog('error', `[INACTIVE] saveGroupSettings: ${error.message}`);
        return false;
    }
}

async function isGroupEnabled(groupId: string): Promise<boolean> {
    if (enabledGroupsCache.has(groupId)) return true;
    try {
        const s = await getGroupSettings(groupId);
        if (s?.enabled) {
            enabledGroupsCache.add(groupId);
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

// ── Activity record helpers ───────────────────────────────────────────────────

function activityKey(groupId: string, userId: string): string {
    return `${groupId}__${userId}`;
}

async function updateUserActivity(groupId: string, userId: string): Promise<void> {
    try {
        const key      = activityKey(groupId, userId);
        const existing = (await dbActivity.get(key)) ?? {
            groupId,
            userId,
            firstSeen:        new Date().toISOString(),
            remindersSent:    0,
            lastReminderSent: null,
        };

        await dbActivity.set(key, {
            ...existing,
            lastActivity: new Date().toISOString(),
            updatedAt:    new Date().toISOString(),
        });
    } catch (error: any) {
        printLog('error', `[INACTIVE] updateUserActivity: ${error.message}`);
    }
}

async function getInactiveUsers(groupId: string, inactiveDays: number): Promise<ActivityRecord[]> {
    try {
        const all    = await dbActivity.getAll() as Record<string, ActivityRecord>;
        const cutoff = Date.now() - inactiveDays * 24 * 60 * 60 * 1000;

        return Object.values(all).filter(r =>
            r.groupId === groupId &&
            r.lastActivity &&
            new Date(r.lastActivity).getTime() < cutoff
        );
    } catch {
        return [];
    }
}

async function updateReminderSent(groupId: string, userId: string): Promise<void> {
    try {
        const key      = activityKey(groupId, userId);
        const existing = (await dbActivity.get(key)) ?? {} as ActivityRecord;

        await dbActivity.set(key, {
            ...existing,
            remindersSent:    (existing.remindersSent || 0) + 1,
            lastReminderSent: new Date().toISOString(),
            updatedAt:        new Date().toISOString(),
        });
    } catch (error: any) {
        printLog('error', `[INACTIVE] updateReminderSent: ${error.message}`);
    }
}

async function resetUserActivity(groupId: string, userId: string): Promise<void> {
    try {
        const key      = activityKey(groupId, userId);
        const existing = (await dbActivity.get(key)) ?? {} as ActivityRecord;

        await dbActivity.set(key, {
            ...existing,
            groupId,
            userId,
            lastActivity:     new Date().toISOString(),
            remindersSent:    0,
            lastReminderSent: null,
            updatedAt:        new Date().toISOString(),
        });
    } catch (error: any) {
        printLog('error', `[INACTIVE] resetUserActivity: ${error.message}`);
    }
}

// ── Name resolution ───────────────────────────────────────────────────────────
// Mirrors the pattern in index.ts: sock.getName → store.contacts → bare number.

async function getUserName(sock: any, userId: string): Promise<string> {
    try {
        const name     = sock.getName(userId);
        const resolved = (name instanceof Promise) ? await name : name;
        if (resolved && String(resolved).trim()) return String(resolved).trim();
    } catch {}

    try {
        const contact = sock.store?.contacts?.[userId];
        if (contact?.name)   return contact.name;
        if (contact?.notify) return contact.notify;
    } catch {}

    return userId.split('@')[0];
}

// ── Message formatting ────────────────────────────────────────────────────────

function friendlyDays(days: number): string {
    if (days === 1)              return '1 day';
    if (days < 7)                return `${days} days`;
    if (days === 7)              return 'a week';
    if (days < 14)               return `${days} days`;
    if (days === 14)             return '2 weeks';
    if (days < 21)               return `${days} days`;
    if (days === 21)             return '3 weeks';
    if (days < 30)               return `${days} days`;
    if (days >= 30 && days < 60) return 'about a month';
    if (days >= 60 && days < 90) return 'about 2 months';
    return `${Math.floor(days / 30)} months`;
}

function formatDMMessage(template: string, replacements: Record<string, string>): string {
    let msg = template;
    for (const [key, value] of Object.entries(replacements)) {
        msg = msg.replace(new RegExp(`\\{${key}\\}`, 'gi'), String(value));
    }
    return msg;
}

// ── Core inactivity check ─────────────────────────────────────────────────────
// Called by the scheduler and by `.inactive check`.

async function checkInactiveUsers(sock: any): Promise<void> {
    printLog('info', '[INACTIVE] 🔍 Starting inactivity check...');
    try {
        const allSettings   = await dbSettings.getAll() as Record<string, GroupSettings>;
        const enabledGroups = Object.entries(allSettings).filter(([, s]) => s.enabled);

        if (!enabledGroups.length) {
            printLog('info', '[INACTIVE] No groups with inactivity tracking enabled.');
            return;
        }

        let totalDMsSent = 0;

        for (const [groupId, settings] of enabledGroups) {
            try {
                let groupMetadata: any;
                try {
                    groupMetadata = await sock.groupMetadata(groupId);
                } catch {
                    printLog('warning', `[INACTIVE] Could not fetch metadata for ${groupId}, skipping.`);
                    continue;
                }

                const groupName     = groupMetadata.subject as string;
                const inactiveUsers = await getInactiveUsers(groupId, settings.inactiveDays);
                printLog('info', `[INACTIVE] ${inactiveUsers.length} inactive user(s) in "${groupName}"`);

                for (const activity of inactiveUsers) {
                    const { userId, remindersSent = 0, lastReminderSent, lastActivity } = activity;

                    // Max reminders guard
                    if (remindersSent >= settings.maxReminders) continue;

                    // Cooldown guard
                    if (lastReminderSent) {
                        const daysSince = Math.floor(
                            (Date.now() - new Date(lastReminderSent).getTime()) / (1000 * 60 * 60 * 24)
                        );
                        if (daysSince < settings.reminderInterval) continue;
                    }

                    // Admin exclusion guard
                    if (settings.excludeAdmins) {
                        const participant = groupMetadata.participants.find((p: any) => p.id === userId);
                        if (participant?.admin === 'admin' || participant?.admin === 'superadmin') continue;
                    }

                    const daysInactive = Math.floor(
                        (Date.now() - new Date(lastActivity).getTime()) / (1000 * 60 * 60 * 24)
                    );
                    const userName = await getUserName(sock, userId);

                    const dmText = formatDMMessage(settings.dmMessage, {
                        user:      userName,
                        groupName,
                        days:      friendlyDays(daysInactive),
                    });

                    try {
                        await sock.sendMessage(userId, { text: dmText });
                        await updateReminderSent(groupId, userId);
                        totalDMsSent++;
                        printLog('success', `[INACTIVE] DM sent → ${userName} (${daysInactive}d inactive in "${groupName}")`);
                        // Rate-limit: 2 s between DMs so we don't get flagged as spam
                        await new Promise(r => setTimeout(r, 2000));
                    } catch (dmErr: any) {
                        printLog('error', `[INACTIVE] Failed DM to ${userName}: ${dmErr.message}`);
                    }
                }
            } catch (groupErr: any) {
                printLog('error', `[INACTIVE] Error processing group ${groupId}: ${groupErr.message}`);
            }
        }

        printLog('success', `[INACTIVE] Check complete — ${totalDMsSent} DM(s) sent.`);
    } catch (error: any) {
        printLog('error', `[INACTIVE] checkInactiveUsers: ${error.message}`);
    }
}

// ── Auth helper ───────────────────────────────────────────────────────────────

async function userIsAdminOrSudo(sock: any, chatId: string, senderId: string): Promise<boolean> {
    const { isSenderAdmin } = await isAdmin(sock, chatId, senderId);
    const ownerOrSudo       = await isOwnerOrSudo(senderId, sock, chatId);
    return isSenderAdmin || ownerOrSudo;
}

// ── Guard helpers (reduce boilerplate in every subcommand) ────────────────────

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

// ── Subcommand handlers ───────────────────────────────────────────────────────

async function showMenu(sock: any, chatId: string, message: any): Promise<void> {
    const prefix = config.prefixes[0];
    await sock.sendMessage(chatId, {
        text:
            `💤 *INACTIVITY TRACKER*\n\n` +
            `📊 *Admin Commands:*\n` +
            `• *${prefix}inactive on/off* — Toggle tracking\n` +
            `• *${prefix}inactive days [n]* — Set inactive threshold (days)\n` +
            `• *${prefix}inactive msg [text]* — Set the DM message\n` +
            `• *${prefix}inactive maxreminders [n]* — Max DMs per user\n` +
            `• *${prefix}inactive interval [days]* — Days between DMs\n` +
            `• *${prefix}inactive excludeadmins on/off* — Skip admins\n` +
            `• *${prefix}inactive stats* — List inactive users\n` +
            `• *${prefix}inactive status* — View current settings\n` +
            `• *${prefix}inactive reset @user* — Reset a user's activity\n` +
            `• *${prefix}inactive check* — Trigger a manual check now\n\n` +
            `💡 *DM Message Variables:*\n` +
            `• {user} — User's display name\n` +
            `• {groupName} — Group name\n` +
            `• {days} — Time since last activity\n\n` +
            `📝 *Example:*\n` +
            `${prefix}inactive msg Hi {user}! We miss you in {groupName}! 💙`
    }, { quoted: message });
}

async function cmdToggle(sock: any, chatId: string, message: any, senderId: string, state: string): Promise<void> {
    if (!await requireGroup(sock, chatId, message)) return;
    if (!await requireAdmin(sock, chatId, message, senderId)) return;

    const settings    = await getGroupSettings(chatId);
    const wantEnabled = state === 'on';

    if (settings.enabled === wantEnabled) {
        await sock.sendMessage(chatId, {
            text: wantEnabled
                ? '⚠️ Inactivity tracking is *already enabled* in this group.'
                : '⚠️ Inactivity tracking is *already disabled* in this group.'
        }, { quoted: message });
        return;
    }

    settings.enabled = wantEnabled;
    await saveGroupSettings(chatId, settings);

    await sock.sendMessage(chatId, {
        text: wantEnabled
            ? '✅ Inactivity tracking *enabled*.\n\n💡 Members who go quiet will receive a DM reminder after the configured threshold.'
            : '❌ Inactivity tracking *disabled*.\n\n💡 No more DMs will be sent. Existing data is preserved.'
    }, { quoted: message });
}

async function cmdDays(sock: any, chatId: string, message: any, senderId: string, args: string[]): Promise<void> {
    if (!await requireGroup(sock, chatId, message)) return;
    if (!await requireAdmin(sock, chatId, message, senderId)) return;

    const days = parseInt(args[0]);
    if (isNaN(days) || days < 1) {
        await sock.sendMessage(chatId, { text: '⚠️ Provide a valid number of days (minimum 1).' }, { quoted: message });
        return;
    }

    const settings        = await getGroupSettings(chatId);
    settings.inactiveDays = days;
    await saveGroupSettings(chatId, settings);
    await sock.sendMessage(chatId, { text: `✅ Inactive threshold set to *${days} day(s)*` }, { quoted: message });
}

async function cmdMsg(sock: any, chatId: string, message: any, senderId: string, args: string[]): Promise<void> {
    if (!await requireGroup(sock, chatId, message)) return;
    if (!await requireAdmin(sock, chatId, message, senderId)) return;

    const newMsg = args.join(' ').trim();
    if (!newMsg) {
        await sock.sendMessage(chatId, {
            text: '⚠️ Provide a message text.\n\nExample: Hi {user}! We miss you in {groupName}!'
        }, { quoted: message });
        return;
    }

    const settings     = await getGroupSettings(chatId);
    settings.dmMessage = newMsg;
    await saveGroupSettings(chatId, settings);
    await sock.sendMessage(chatId, {
        text: `✅ DM message updated!\n\n_Preview:_\n${newMsg}`
    }, { quoted: message });
}

async function cmdMaxReminders(sock: any, chatId: string, message: any, senderId: string, args: string[]): Promise<void> {
    if (!await requireGroup(sock, chatId, message)) return;
    if (!await requireAdmin(sock, chatId, message, senderId)) return;

    const max = parseInt(args[0]);
    if (isNaN(max) || max < 1) {
        await sock.sendMessage(chatId, { text: '⚠️ Provide a valid number (minimum 1).' }, { quoted: message });
        return;
    }

    const settings        = await getGroupSettings(chatId);
    settings.maxReminders = max;
    await saveGroupSettings(chatId, settings);
    await sock.sendMessage(chatId, { text: `✅ Max reminders set to *${max}* per user` }, { quoted: message });
}

async function cmdInterval(sock: any, chatId: string, message: any, senderId: string, args: string[]): Promise<void> {
    if (!await requireGroup(sock, chatId, message)) return;
    if (!await requireAdmin(sock, chatId, message, senderId)) return;

    const days = parseInt(args[0]);
    if (isNaN(days) || days < 1) {
        await sock.sendMessage(chatId, { text: '⚠️ Provide a valid number of days (minimum 1).' }, { quoted: message });
        return;
    }

    const settings            = await getGroupSettings(chatId);
    settings.reminderInterval = days;
    await saveGroupSettings(chatId, settings);
    await sock.sendMessage(chatId, { text: `✅ Reminder interval set to *${days} day(s)*` }, { quoted: message });
}

async function cmdExcludeAdmins(sock: any, chatId: string, message: any, senderId: string, state: string): Promise<void> {
    if (!await requireGroup(sock, chatId, message)) return;
    if (!await requireAdmin(sock, chatId, message, senderId)) return;

    const settings          = await getGroupSettings(chatId);
    settings.excludeAdmins  = state === 'on';
    await saveGroupSettings(chatId, settings);
    await sock.sendMessage(chatId, {
        text: `✅ Exclude admins from tracking: ${settings.excludeAdmins ? '✅ Yes' : '❌ No'}`
    }, { quoted: message });
}

async function cmdStats(sock: any, chatId: string, message: any, senderId: string): Promise<void> {
    if (!await requireGroup(sock, chatId, message)) return;
    if (!await requireAdmin(sock, chatId, message, senderId)) return;

    const settings = await getGroupSettings(chatId);

    if (!settings.enabled) {
        await sock.sendMessage(chatId, {
            text: `❌ Inactivity tracking is not enabled.\n\nEnable it with: ${config.prefixes[0]}inactive on`
        }, { quoted: message });
        return;
    }

    const inactiveUsers = await getInactiveUsers(chatId, settings.inactiveDays);

    if (!inactiveUsers.length) {
        await sock.sendMessage(chatId, {
            text: `✅ No inactive users found!\n\nAll tracked members have been active within the last *${settings.inactiveDays} day(s)*.`
        }, { quoted: message });
        return;
    }

    const display  = inactiveUsers.slice(0, 20);
    const mentions = display.map(a => a.userId);

    let text = `💤 *INACTIVE USERS REPORT*\n`;
    text    += `📊 Found *${inactiveUsers.length}* inactive user(s):\n\n`;

    display.forEach((activity, i) => {
        const phone        = activity.userId.split('@')[0];
        const daysInactive = Math.floor(
            (Date.now() - new Date(activity.lastActivity).getTime()) / (1000 * 60 * 60 * 24)
        );
        text += `${i + 1}. @${phone}\n`;
        text += `   📅 Last active: *${friendlyDays(daysInactive)} ago*\n`;
        text += `   📧 Reminders sent: ${activity.remindersSent || 0}/${settings.maxReminders}\n\n`;
    });

    if (inactiveUsers.length > 20) text += `_...and ${inactiveUsers.length - 20} more_`;

    await sock.sendMessage(chatId, { text, mentions }, { quoted: message });
}

async function cmdStatus(sock: any, chatId: string, message: any, senderId: string): Promise<void> {
    if (!await requireGroup(sock, chatId, message)) return;
    if (!await requireAdmin(sock, chatId, message, senderId)) return;

    const settings = await getGroupSettings(chatId);

    let groupName = chatId;
    try {
        const meta = await sock.groupMetadata(chatId);
        groupName  = meta.subject;
    } catch {}

    await sock.sendMessage(chatId, {
        text:
            `📊 *INACTIVITY TRACKER STATUS*\n\n` +
            `🏷️ Group: *${groupName}*\n\n` +
            `💤 Tracking: ${settings.enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
            `📅 Inactive threshold: *${settings.inactiveDays} day(s)*\n` +
            `📧 Max reminders: *${settings.maxReminders}* per user\n` +
            `⏰ Reminder interval: *${settings.reminderInterval} day(s)*\n` +
            `👑 Exclude admins: ${settings.excludeAdmins ? '✅ Yes' : '❌ No'}\n\n` +
            `💬 *DM Message:*\n${settings.dmMessage}`
    }, { quoted: message });
}

async function cmdReset(sock: any, chatId: string, message: any, senderId: string): Promise<void> {
    if (!await requireGroup(sock, chatId, message)) return;
    if (!await requireAdmin(sock, chatId, message, senderId)) return;

    const mentionedJid = message.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    if (!mentionedJid) {
        await sock.sendMessage(chatId, {
            text: `⚠️ Please mention a user to reset.\n\nExample: ${config.prefixes[0]}inactive reset @user`
        }, { quoted: message });
        return;
    }

    await resetUserActivity(chatId, mentionedJid);
    const phone = mentionedJid.split('@')[0];

    await sock.sendMessage(chatId, {
        text:     `✅ Activity reset for @${phone}`,
        mentions: [mentionedJid]
    }, { quoted: message });
}

async function cmdCheck(sock: any, chatId: string, message: any, senderId: string): Promise<void> {
    if (!await requireGroup(sock, chatId, message)) return;
    if (!await requireAdmin(sock, chatId, message, senderId)) return;

    await sock.sendMessage(chatId, { text: '🔍 Running manual inactivity check...' }, { quoted: message });
    await checkInactiveUsers(sock);
    await sock.sendMessage(chatId, { text: '✅ Manual check complete!' }, { quoted: message });
}

// ── Passive tracking export ───────────────────────────────────────────────────
// Called by messageHandler.ts on every group message (same pattern as
// activitytracker.ts which is already wired in there).

export async function trackInactivity(message: any): Promise<void> {
    try {
        const chatId   = message.key?.remoteJid;
        const senderId = message.key?.participant || message.key?.remoteJid;

        if (!chatId?.endsWith('@g.us')) return;
        if (message.key?.fromMe)        return;
        if (!senderId)                  return;

        if (!await isGroupEnabled(chatId)) return;

        await updateUserActivity(chatId, senderId);
    } catch (error: any) {
        printLog('error', `[INACTIVE] trackInactivity: ${error.message}`);
    }
}

// ── Scheduler export ──────────────────────────────────────────────────────────
// Wire this into your scheduler / startSchedulerEngine the same way other
// timed jobs are registered — or call it directly from index.ts on connect.

export async function runInactivityScheduler(sock: any): Promise<void> {
    printLog('info', '[INACTIVE] ⏰ Running scheduled inactivity check...');
    await checkInactiveUsers(sock);
}

// ── Plugin export ─────────────────────────────────────────────────────────────

export default {
    command:     'inactive',
    aliases:     ['inact', 'inactivity'],
    category:    'group',
    description: 'Tracks user activity and sends DMs to inactive group members',
    groupOnly:   false,   // group guard handled per-subcommand for proper error messages
    adminOnly:   false,   // same — checked inside each subcommand

    async handler(sock: any, message: any, args: string[], context: BotContext): Promise<void> {
        const { chatId, senderId } = context;

        if (!args.length) {
            return showMenu(sock, chatId, message);
        }

        const sub     = args[0].toLowerCase();
        const subArgs = args.slice(1);

        switch (sub) {

            case 'on':
            case 'off':
                await cmdToggle(sock, chatId, message, senderId, sub);
                break;

            case 'days':
                await cmdDays(sock, chatId, message, senderId, subArgs);
                break;

            case 'msg':
            case 'message':
                await cmdMsg(sock, chatId, message, senderId, subArgs);
                break;

            case 'maxreminders':
            case 'max':
                await cmdMaxReminders(sock, chatId, message, senderId, subArgs);
                break;

            case 'interval':
                await cmdInterval(sock, chatId, message, senderId, subArgs);
                break;

            case 'excludeadmins': {
                const state = subArgs[0]?.toLowerCase();
                if (!['on', 'off'].includes(state)) {
                    await sock.sendMessage(chatId, {
                        text: `⚠️ Usage: ${config.prefixes[0]}inactive excludeadmins on/off`
                    }, { quoted: message });
                    break;
                }
                await cmdExcludeAdmins(sock, chatId, message, senderId, state);
                break;
            }

            case 'stats':
                await cmdStats(sock, chatId, message, senderId);
                break;

            case 'status':
                await cmdStatus(sock, chatId, message, senderId);
                break;

            case 'reset':
                await cmdReset(sock, chatId, message, senderId);
                break;

            case 'check':
                await cmdCheck(sock, chatId, message, senderId);
                break;

            case 'help':
                await showMenu(sock, chatId, message);
                break;

            default:
                await sock.sendMessage(chatId, {
                    text: `❓ Unknown subcommand: *${sub}*\n\nUse *${config.prefixes[0]}inactive* to see all available commands.`
                }, { quoted: message });
        }
    },

    // Expose for external wiring
    trackInactivity,
    runInactivityScheduler,
    checkInactiveUsers,
};
