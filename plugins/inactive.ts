/**
 * plugins/inactive.ts
 * Tracks user activity per group and sends DMs to inactive members.
 * Handles empathetic AI-powered replies, consent-based admin alerts,
 * and multi-stage conversations for conflict, boring, and exam scenarios.
 *
 * Architecture:
 *   - createStore (lib/pluginStore)   → same DB pattern as other plugins
 *   - onMessage hook                  → passive tracking + reply interception
 *   - cron                            → 24-hour automated DM check
 *   - lib/isAdmin + lib/isOwner       → admin / owner-only guards
 *   - Subcommand routing              → same pattern as other group plugins
 *   - Anthropic API                   → reply classification + feedback summarizer
 */

import type { BotContext } from '../types.js';
import { createStore }     from '../lib/pluginStore.js';
import isAdmin             from '../lib/isAdmin.js';
import isOwnerOrSudo       from '../lib/isOwner.js';
import { printLog }        from '../lib/print.js';
import config              from '../config.js';

// ── Storage ───────────────────────────────────────────────────────────────────
// Tables created automatically by pluginStore on first access.
//   inactivetracker_activity  → per-user activity records
//   inactivetracker_settings  → per-group configuration
//   inactivetracker_replies   → pending reply state (cleared after reply or 7 days)

const db         = createStore('inactivetracker');
const dbActivity = db.table!('activity');  // key: `groupId__userId`
const dbSettings = db.table!('settings'); // key: groupId
const dbReplies  = db.table!('replies');  // key: userId

// ── Types ─────────────────────────────────────────────────────────────────────

interface GroupSettings {
    enabled:          boolean;
    inactiveDays:     number;
    dmMessage:        string;
    maxReminders:     number;
    reminderInterval: number;
    excludeAdmins:    boolean;
    dmDelayMs:        number;
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

interface PendingReply {
    userId:        string;
    groupId:       string;
    groupName:     string;
    sentAt:        string;
    adminJids:     string[];
    stage:         'initial' | 'conflict_consent' | 'boring_followup' | 'boring_consent';
    originalMsg?:  string;
    boringDetail?: string;
}

type ReplyCategory  = 'serious' | 'conflict' | 'exams' | 'boring' | 'casual' | 'returning' | 'unknown';
type AlertType      = 'serious' | 'conflict' | 'boring';
type ConsentResult  = 'yes' | 'no' | 'unknown';

interface ClassifiedReply {
    category:  ReplyCategory;
    reasoning: string;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: GroupSettings = {
    enabled:          false,
    inactiveDays:     7,
    dmMessage:        'Hi {user}! 👋\n\nWe noticed you haven\'t been active in *{groupName}* for *{days}*. We miss you! 💙\n\nFeel free to jump back in whenever you\'re ready.',
    maxReminders:     3,
    reminderInterval: 7,
    excludeAdmins:    false,
    dmDelayMs:        2000,
};

// ── In-memory cache ───────────────────────────────────────────────────────────

const settingsCache = new Map<string, { data: GroupSettings; ts: number }>();
const CACHE_TTL     = 60_000; // 1 minute

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
        return true;
    } catch (error: any) {
        printLog('error', `[INACTIVE] saveGroupSettings: ${error.message}`);
        return false;
    }
}

async function isGroupEnabled(groupId: string): Promise<boolean> {
    const s = await getGroupSettings(groupId);
    return s?.enabled === true;
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
        const prefix = `${groupId}__`;
        const cutoff = Date.now() - inactiveDays * 24 * 60 * 60 * 1000;

        return Object.entries(all)
            .filter(([key, r]) =>
                key.startsWith(prefix) &&
                r.lastActivity &&
                new Date(r.lastActivity).getTime() < cutoff
            )
            .map(([, r]) => r);
    } catch (error: any) {
        printLog('error', `[INACTIVE] getInactiveUsers: ${error.message}`);
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

async function getUserName(sock: any, userId: string): Promise<string> {
    try {
        const resolved = await Promise.resolve(sock.getName(userId));
        if (resolved && String(resolved).trim()) return String(resolved).trim();
    } catch {}

    try {
        const c = sock.store?.contacts?.[userId];
        if (c?.name || c?.notify) return c.name || c.notify;
    } catch {}

    return userId.split('@')[0];
}

// ── Message formatting ────────────────────────────────────────────────────────

function friendlyDays(days: number): string {
    if (days === 1) return '1 day';
    if (days < 7)   return `${days} days`;

    const weeks = Math.floor(days / 7);
    if (days % 7 === 0 && weeks <= 4) return weeks === 1 ? 'a week' : `${weeks} weeks`;

    const months = Math.floor(days / 30);
    if (months >= 1) return months === 1 ? 'about a month' : `about ${months} months`;

    return `${days} days`;
}

function formatDMMessage(template: string, replacements: Record<string, string>): string {
    let msg = template;
    for (const [key, value] of Object.entries(replacements)) {
        msg = msg.replace(new RegExp(`\\{${key}\\}`, 'gi'), String(value));
    }
    return msg;
}

// ── Mention extraction ────────────────────────────────────────────────────────

function getMentions(message: any): string[] {
    const ctx =
        message.message?.extendedTextMessage?.contextInfo ||
        message.message?.imageMessage?.contextInfo        ||
        message.message?.videoMessage?.contextInfo        ||
        null;
    return ctx?.mentionedJid ?? [];
}

// ── AI: reply classifier ──────────────────────────────────────────────────────

async function classifyReply(userMessage: string): Promise<ClassifiedReply> {
    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model:      'claude-sonnet-4-20250514',
                max_tokens: 200,
                system:
`You classify WhatsApp replies to an inactivity reminder DM.
Respond ONLY with valid JSON. No markdown, no explanation outside the JSON.

Categories:
- "serious"   → illness, death, bereavement, grief, mental health crisis,
                 family emergency, accident, hospital, surgery, or any genuinely
                 distressing personal situation.
- "conflict"  → went quiet because of something that happened in the group: drama,
                 argument, feeling ignored, excluded, disrespected, hurt by someone's
                 words. Subtle signals: "needed space from it", "some people",
                 "the vibe", "felt left out", "no one noticed I was gone",
                 "didn't feel welcome", "needed a break from the group".
- "exams"     → inactive because of exams, studying, tests, school, university,
                 college, revision, coursework, assignments, academic pressure,
                 thesis, finals, or any educational commitment.
- "boring"    → person finds the group uninteresting, boring, dead, inactive,
                 repetitive, not engaging, not relevant. Also catch: "same people",
                 "nothing new", "group died", "no vibes", "doesn't interest me
                 anymore", "feels pointless", "nobody talks".
- "casual"    → busy at work, travelling, on break, general life busyness,
                 no distress signals, no group-related reason.
- "returning" → person says they are back, thanks the bot, says they will be
                 active again, or responds positively with no complaint or distress.
- "unknown"   → unrelated, gibberish, or too ambiguous to classify.

Respond with exactly: {"category":"<one of the seven>","reasoning":"<one short sentence>"}`,
                messages: [{
                    role:    'user',
                    content: `Classify this reply to an inactivity DM: "${userMessage.slice(0, 500)}"`,
                }],
            }),
        });

        if (!response.ok) throw new Error(`API ${response.status}`);

        const data   = await response.json() as { content?: { text?: string }[] };
        const raw    = data.content?.[0]?.text?.trim() ?? '';
        const parsed = JSON.parse(raw) as ClassifiedReply;

        const validCategories: ReplyCategory[] = ['serious', 'conflict', 'exams', 'boring', 'casual', 'returning', 'unknown'];
        if (!validCategories.includes(parsed.category)) throw new Error('Invalid category returned');

        return parsed;
    } catch (error: any) {
        printLog('error', `[INACTIVE] classifyReply failed: ${error.message}`);
        return { category: 'unknown', reasoning: 'Classification failed — defaulting to unknown.' };
    }
}

// ── AI: consent classifier ────────────────────────────────────────────────────

async function classifyConsent(userMessage: string): Promise<ConsentResult> {
    const text = userMessage.toLowerCase().trim();

    // Fast local check first — avoids an API call for clear yes/no
    const yesSignals = ['yes', 'yeah', 'yep', 'yh', 'sure', 'ok', 'okay', 'please', 'go ahead', 'do it', 'alright', 'fine'];
    const noSignals  = ['no', 'nah', 'nope', "don't", 'dont', 'no thanks', 'its fine', "it's fine", 'leave it', 'forget it', 'never mind', 'nevermind'];

    if (yesSignals.some(s => text === s || text.startsWith(s + ' '))) return 'yes';
    if (noSignals.some(s => text === s || text.startsWith(s + ' ')))  return 'no';

    // Ambiguous — use Claude
    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model:      'claude-sonnet-4-20250514',
                max_tokens: 50,
                system:
`Reply ONLY with one word: "yes", "no", or "unknown".
The user was asked if they want something shared with group admins.
Classify their reply as consent (yes), refusal (no), or unclear (unknown).`,
                messages: [{ role: 'user', content: userMessage.slice(0, 200) }],
            }),
        });

        if (!response.ok) throw new Error(`API ${response.status}`);

        const data   = await response.json() as { content?: { text?: string }[] };
        const result = data.content?.[0]?.text?.trim().toLowerCase();

        if (result === 'yes' || result === 'no') return result;
        return 'unknown';
    } catch (error: any) {
        printLog('error', `[INACTIVE] classifyConsent failed: ${error.message}`);
        return 'unknown';
    }
}

// ── AI: feedback summarizer ───────────────────────────────────────────────────

async function summarizeFeedback(userMessage: string, groupName: string): Promise<string> {
    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model:      'claude-sonnet-4-20250514',
                max_tokens: 200,
                system:
`You turn raw member feedback about a WhatsApp group into a constructive,
actionable 2-3 sentence summary for group admins.

Rules:
- Never quote the member directly
- Frame as an opportunity, not a complaint
- Be specific about the concern without being accusatory
- Do not mention or hint at who gave the feedback
- Keep it professional and kind
- Start with "A member shared feedback that..."`,
                messages: [{
                    role:    'user',
                    content: `Group name: "${groupName}"\nRaw feedback: "${userMessage.slice(0, 400)}"`,
                }],
            }),
        });

        if (!response.ok) throw new Error(`API ${response.status}`);

        const data = await response.json() as { content?: { text?: string }[] };
        return data.content?.[0]?.text?.trim() ?? 'A member shared feedback about group engagement.';
    } catch (error: any) {
        printLog('error', `[INACTIVE] summarizeFeedback failed: ${error.message}`);
        return 'A member shared feedback about group engagement but the summary could not be generated.';
    }
}

// ── Reply message pools ───────────────────────────────────────────────────────

const REPLIES: Record<ReplyCategory, string[]> = {

    serious: [
        `Please don't worry about the group at all right now. Take all the time you need — your wellbeing comes first. 💙`,
        `Thank you for letting me know. That sounds really tough and I'm sorry you're going through this. The group will be here whenever you're ready. 🙏`,
        `Take care of yourself first. Nothing in the group is more important than you. Sending strength your way. 💙`,
        `That means a lot that you shared that. Please rest and heal — we're not going anywhere. 🫶`,
    ],

    conflict: [
        `That makes sense, and I'm glad you told me. Sometimes the group can feel like a lot. You don't owe anyone an explanation for needing space. 💙\n\nWould you like me to quietly let an admin know so they can check in with you privately? Just reply *yes* or *no* — no pressure either way.`,
        `Thank you for sharing that. Your comfort in the group matters and it's okay to step back when things don't feel right. 🙏\n\nIf you'd like, I can privately let an admin know so they can reach out — completely up to you. Reply *yes* or *no*.`,
        `I hear you. Group dynamics can get complicated and it's valid to need a break. 💙\n\nWould it help if I discreetly flagged this to an admin so they can follow up with you one-on-one? Just say *yes* or *no*.`,
        `That's completely understandable. No one should feel uncomfortable in a space they're part of. 🫶\n\nWould you like me to let an admin know privately so they can check in? Reply *yes* or *no* — your message stays between us either way.`,
    ],

    exams: [
        `That makes total sense — focus on what matters right now! 📚 The group will still be here when you come up for air. Good luck with your exams, you've got this! 💪`,
        `Exams first, always. 📖 Don't stress about the group — we'll be here when you're done. Best of luck, study hard and rest well! 🌟`,
        `Say no more! Exams take priority. 🎓 Go handle your business and come back when the pressure's off. Rooting for you! 💙`,
        `Completely understandable! Academic season is no joke. 📚 Take care of yourself, stay focused, and come back when you're through. You've got this! ✊`,
    ],

    boring: [
        `Thanks for being honest — that kind of feedback genuinely helps. 🙏\n\nCould you tell me a bit more about what makes it feel that way? For example:\n\n• The topics discussed don't interest you\n• The group feels too quiet or inactive\n• It's always the same few people talking\n• The content isn't relevant to you anymore\n• Something else entirely\n\nJust describe it however feels right — there's no wrong answer.`,
        `Appreciate you being real about it. 💙 Honest feedback is how groups get better.\n\nWhat would help me understand: what specifically makes it feel that way to you? Is it the conversations, the people, the content, the energy — or something else? Just share what comes to mind.`,
        `That's valuable to know. 🤔 Rather than guess, I'd love to understand what you mean.\n\nWhat's been making it feel boring or uninteresting to you? The more specific you can be, the more useful it is. No judgment at all.`,
        `Fair enough — and honestly, that kind of feedback matters. 😊\n\nWhat's been making it feel that way for you? Could be anything — the topics, the pace, how people interact, what gets shared. Whatever comes to mind.`,
    ],

    casual: [
        `No worries at all! Life gets busy. Jump back in whenever you're ready — we'll be here. 😊`,
        `Totally understood! Take your time and come back when things settle down. 👍`,
        `Thanks for letting me know! No pressure at all. See you when you're back. 🙌`,
        `Makes complete sense! We'll keep the seat warm for you. 😄`,
    ],

    returning: [
        `Welcome back! Great to hear from you again. 🎉`,
        `That's great news! Glad to have you back. 😊`,
        `Wonderful! Jump back in whenever you're ready. The group missed you. 🙌`,
        `So glad you're back! Looking forward to seeing you active again. 🎊`,
    ],

    unknown: [
        `Thanks for the reply! Just know the group is here whenever you're ready to come back. 😊`,
        `Got it! Feel free to reach out if you need anything. 👍`,
    ],
};

function pickReply(category: ReplyCategory): string {
    const pool = REPLIES[category];
    return pool[Math.floor(Math.random() * pool.length)];
}

// ── Admin alerts ──────────────────────────────────────────────────────────────

async function alertAdmins(
    sock:        any,
    pending:     PendingReply,
    userMessage: string,
    userName:    string,
    reasoning:   string,
    type:        AlertType = 'serious',
): Promise<void> {
    const phone = pending.userId.split('@')[0];
    let alertText: string;

    if (type === 'serious') {
        alertText =
            `🚨 *Inactivity Tracker — Member May Need Support*\n\n` +
            `👤 Member: @${phone}\n` +
            `🏷️ Group: *${pending.groupName}*\n\n` +
            `💬 Their reply:\n_"${userMessage}"_\n\n` +
            `🤖 Assessment: ${reasoning}\n\n` +
            `_They may appreciate a personal check-in. Sent to admins only._`;
    } else if (type === 'conflict') {
        alertText =
            `💬 *Inactivity Tracker — Group Dynamics Flag*\n\n` +
            `👤 Member: @${phone}\n` +
            `🏷️ Group: *${pending.groupName}*\n\n` +
            `_This member indicated their inactivity may relate to something that ` +
            `happened in the group. They consented to this notification._\n\n` +
            `🤖 Assessment: ${reasoning}\n\n` +
            `_Consider reaching out to them privately. Avoid referencing this in the group._`;
    } else {
        // boring — fully anonymous, no name, no mention
        const summary = await summarizeFeedback(userMessage, pending.groupName);
        alertText =
            `💡 *Inactivity Tracker — Engagement Feedback*\n\n` +
            `🏷️ Group: *${pending.groupName}*\n\n` +
            `${summary}\n\n` +
            `_The member consented to sharing this. No names — treat this as ` +
            `anonymous feedback for improving the group._`;
    }

    for (const adminJid of pending.adminJids) {
        try {
            // For boring alerts, omit mentions entirely to preserve anonymity
            const payload = type === 'boring'
                ? { text: alertText }
                : { text: alertText, mentions: [pending.userId] };

            await sock.sendMessage(adminJid, payload);
            await new Promise(r => setTimeout(r, 800));
            printLog('success', `[INACTIVE] ${type} alert → ${adminJid.split('@')[0]}`);
        } catch (err: any) {
            printLog('error', `[INACTIVE] Failed to alert admin ${adminJid.split('@')[0]}: ${err.message}`);
        }
    }
}

// ── Pending reply cleanup ─────────────────────────────────────────────────────

async function cleanupExpiredReplies(): Promise<void> {
    try {
        const all    = await dbReplies.getAll() as Record<string, PendingReply>;
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        let cleaned  = 0;

        for (const [key, record] of Object.entries(all)) {
            if (new Date(record.sentAt).getTime() < cutoff) {
                await dbReplies.del(key);
                cleaned++;
            }
        }

        if (cleaned > 0) printLog('info', `[INACTIVE] Cleared ${cleaned} expired reply state(s)`);
    } catch (error: any) {
        printLog('error', `[INACTIVE] cleanupExpiredReplies: ${error.message}`);
    }
}

// ── Core inactivity check ─────────────────────────────────────────────────────

async function checkInactiveUsers(sock: any): Promise<void> {
    if (!sock) {
        printLog('warning', '[INACTIVE] sock not ready, skipping check');
        return;
    }

    printLog('info', '[INACTIVE] Starting inactivity check...');

    try {
        const allSettings   = await dbSettings.getAll() as Record<string, GroupSettings>;
        const enabledGroups = Object.entries(allSettings).filter(([, s]) => s.enabled);

        if (!enabledGroups.length) {
            printLog('info', '[INACTIVE] No groups with tracking enabled.');
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
                printLog('info', `[INACTIVE] ${inactiveUsers.length} inactive in "${groupName}"`);

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

                        // Collect admin JIDs for possible alerts later
                        const adminJids: string[] = groupMetadata.participants
                            .filter((p: any) => p.admin === 'admin' || p.admin === 'superadmin')
                            .map((p: any) => p.id);

                        // Store pending reply state — window open for 7 days
                        await dbReplies.set(userId, {
                            userId,
                            groupId,
                            groupName,
                            sentAt:    new Date().toISOString(),
                            adminJids,
                            stage:     'initial',
                        } satisfies PendingReply);

                        printLog('success', `[INACTIVE] DM sent → ${userName} (${daysInactive}d inactive in "${groupName}")`);
                        await new Promise(r => setTimeout(r, settings.dmDelayMs ?? 2000));
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

// ── Reply handler ─────────────────────────────────────────────────────────────
// Intercepts private messages from users who have a pending inactive DM.
// Returns true if the message was handled (stops further processing).

export async function handleInactiveReply(sock: any, message: any): Promise<boolean> {
    try {
        const chatId = message.key?.remoteJid;
        if (!chatId || chatId.endsWith('@g.us')) return false;
        if (message.key?.fromMe) return false;

        // In a private DM, remoteJid equals the member's user JID —
        // the same value used as the key when writing to dbReplies in checkInactiveUsers.
        const userId  = chatId;
        const pending = await dbReplies.get(userId) as PendingReply | null;
        if (!pending) return false;

        const userMessage = (
            message.message?.conversation ||
            message.message?.extendedTextMessage?.text ||
            ''
        ).trim();
        if (!userMessage) return false;

        // ── Stage: conflict consent ───────────────────────────────────────────
        if (pending.stage === 'conflict_consent') {
            const consent = await classifyConsent(userMessage);

            if (consent === 'yes') {
                await sock.sendMessage(chatId, {
                    text: `Got it. I've quietly let the admins know. Hopefully someone will reach out to you soon. 💙`,
                });
                const userName = await getUserName(sock, chatId);
                await alertAdmins(
                    sock, pending,
                    pending.originalMsg ?? '',
                    userName,
                    'Member consented to admin notification after indicating group discomfort.',
                    'conflict',
                );
                await dbReplies.del(userId);
            } else if (consent === 'no') {
                await sock.sendMessage(chatId, {
                    text: `Understood, no worries. Your reply stays between us. Take care of yourself. 🙏`,
                });
                await dbReplies.del(userId);
            } else {
                // Ambiguous — ask once more
                await sock.sendMessage(chatId, {
                    text: `Just to confirm — would you like me to let an admin know privately? Reply *yes* or *no*. 😊`,
                });
                // Leave state intact for one more attempt
            }

            return true;
        }

        // ── Stage: boring follow-up — collecting specific feedback ────────────
        if (pending.stage === 'boring_followup') {
            await dbReplies.set(userId, {
                ...pending,
                stage:        'boring_consent',
                boringDetail: userMessage,
            } satisfies PendingReply);

            await sock.sendMessage(chatId, {
                text:
                    `That's really helpful, thank you for explaining. 🙏\n\n` +
                    `Would you be okay with me sharing this feedback (completely anonymously) ` +
                    `with the group admins? They won't know it came from you — it goes as ` +
                    `general feedback that could help improve things.\n\n` +
                    `Reply *yes* or *no* — either is perfectly fine.`,
            });

            return true;
        }

        // ── Stage: boring consent ─────────────────────────────────────────────
        if (pending.stage === 'boring_consent') {
            const consent = await classifyConsent(userMessage);

            if (consent === 'yes') {
                await sock.sendMessage(chatId, {
                    text:
                        `Perfect. I've passed it on anonymously — no names, no way to trace it back to you. 🙏\n\n` +
                        `Hopefully the admins can use it to make things better. ` +
                        `Come back whenever you feel like it — the group will be here. 😊`,
                });
                const userName = await getUserName(sock, chatId);
                await alertAdmins(
                    sock, pending,
                    pending.boringDetail ?? pending.originalMsg ?? '',
                    userName,
                    'Member shared specific feedback about group engagement.',
                    'boring',
                );
                await dbReplies.del(userId);
            } else if (consent === 'no') {
                await sock.sendMessage(chatId, {
                    text: `No worries at all — it stays between us. Thanks for being honest either way. 💙`,
                });
                await dbReplies.del(userId);
            } else {
                // Ambiguous — ask once more
                await sock.sendMessage(chatId, {
                    text: `Just to confirm — is it okay to share your feedback anonymously with the admins? Reply *yes* or *no*. 😊`,
                });
                // Leave state intact
            }

            return true;
        }

        // ── Stage: initial — first reply to the inactivity DM ────────────────
        printLog('info', `[INACTIVE] Reply from ${chatId.split('@')[0]} — classifying...`);
        const { category, reasoning } = await classifyReply(userMessage);
        printLog('info', `[INACTIVE] Classified as "${category}": ${reasoning}`);

        const botReply = pickReply(category);
        await sock.sendMessage(chatId, { text: botReply });

        if (category === 'serious') {
            const userName = await getUserName(sock, chatId);
            await alertAdmins(sock, pending, userMessage, userName, reasoning, 'serious');
            await resetUserActivity(pending.groupId, chatId);
            await dbReplies.del(userId);

        } else if (category === 'conflict') {
            // Move to consent stage — keep pending state
            await dbReplies.set(userId, {
                ...pending,
                stage:       'conflict_consent',
                originalMsg: userMessage,
            } satisfies PendingReply);

        } else if (category === 'exams') {
            // Reset so they get a fresh cycle after exams — no admin alert needed
            await resetUserActivity(pending.groupId, chatId);
            await dbReplies.del(userId);

        } else if (category === 'boring') {
            // Move to follow-up stage to get specific feedback
            await dbReplies.set(userId, {
                ...pending,
                stage:       'boring_followup',
                originalMsg: userMessage,
            } satisfies PendingReply);
            // botReply already sent above — it contains the follow-up question

        } else if (category === 'returning') {
            await resetUserActivity(pending.groupId, chatId);
            await dbReplies.del(userId);

        } else {
            // casual / unknown — warm reply already sent, clear state
            await dbReplies.del(userId);
        }

        return true;
    } catch (error: any) {
        printLog('error', `[INACTIVE] handleInactiveReply: ${error.message}`);
        return false;
    }
}

// ── Auth & guard helpers ──────────────────────────────────────────────────────

async function userIsAdminOrSudo(sock: any, chatId: string, senderId: string): Promise<boolean> {
    const { isSenderAdmin } = await isAdmin(sock, chatId, senderId);
    const ownerOrSudo       = await isOwnerOrSudo(senderId, sock, chatId);
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

    if (!newMsg.includes('{user}') && !newMsg.includes('{groupName}')) {
        await sock.sendMessage(chatId, {
            text:
                `✅ DM message saved!\n\n` +
                `⚠️ Tip: no variables detected. Add *{user}* or *{groupName}* to personalise each message.`,
        }, { quoted: message });
        return;
    }

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

    const settings         = await getGroupSettings(chatId);
    settings.excludeAdmins = state === 'on';
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

    let text  = `💤 *INACTIVE USERS REPORT*\n`;
    text     += `📊 Found *${inactiveUsers.length}* inactive user(s):\n\n`;

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

    const mentionedJid = getMentions(message)[0];
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
        mentions: [mentionedJid],
    }, { quoted: message });
}

async function cmdCheck(sock: any, chatId: string, message: any, senderId: string): Promise<void> {
    if (!await requireGroup(sock, chatId, message)) return;
    if (!await requireAdmin(sock, chatId, message, senderId)) return;

    await sock.sendMessage(chatId, { text: '🔍 Running manual inactivity check...' }, { quoted: message });
    await checkInactiveUsers(sock);
    await sock.sendMessage(chatId, { text: '✅ Manual check complete!' }, { quoted: message });
}

// ── Passive tracking ──────────────────────────────────────────────────────────
// Called on every group message to keep lastActivity fresh.

export async function trackInactivity(message: any): Promise<void> {
    try {
        const chatId   = message.key?.remoteJid;
        const senderId = message.key?.participant || message.key?.remoteJid;

        if (!chatId?.endsWith('@g.us')) return;
        if (message.key?.fromMe) return;
        if (!senderId) return;

        if (!await isGroupEnabled(chatId)) return;

        await updateUserActivity(chatId, senderId);
    } catch (error: any) {
        printLog('error', `[INACTIVE] trackInactivity: ${error.message}`);
    }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

export async function runInactivityScheduler(sock: any): Promise<void> {
    printLog('info', '[INACTIVE] Running scheduled inactivity check...');
    await checkInactiveUsers(sock);
}

// ── Schedules — managed by pluginLoader.start() ───────────────────────────────

export const schedules = [
    {
        at: '10:00',
        handler: async (sock: any) => {
            await runInactivityScheduler(sock).catch((e: any) =>
                printLog('error', `[INACTIVE] Scheduler error: ${e.message}`)
            );
        },
    },
    {
        at: '02:00',
        handler: async (_sock: any) => {
            cleanupExpiredReplies();
        },
    },
];

// ── Plugin export ─────────────────────────────────────────────────────────────

export default {
    command:     'inactive',
    aliases:     ['inact', 'inactivity'],
    category:    'group',
    description: 'Tracks user activity and sends empathetic DMs to inactive group members',
    groupOnly:   false,
    adminOnly:   false,

    // Intercepts private replies before any other plugin sees them
    async onMessage(sock: any, message: any): Promise<boolean | void> {
        return handleInactiveReply(sock, message);
    },

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
                if (!state || !['on', 'off'].includes(state)) {
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

    // Exposed for external wiring and testing
    schedules,
    trackInactivity,
    runInactivityScheduler,
    checkInactiveUsers,
    handleInactiveReply,
};
