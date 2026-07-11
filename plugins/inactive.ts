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
    dmMessages:       string[];
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
    awaitingReaction?: boolean;
}

type ReplyCategory  = 'serious' | 'conflict' | 'exams' | 'boring' | 'casual' | 'returning' | 'unknown';
type AlertType      = 'serious' | 'conflict' | 'boring';
type ConsentResult  = 'yes' | 'no' | 'unknown';

interface ClassifiedReply {
    category:  ReplyCategory;
    reasoning: string;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_DM_MESSAGES = [
    `Hey {user}! 👋 We noticed you've been quiet in {groupName} for {days}. Thought I'd check in — the crew misses your energy!`,
    `Hi {user}, it's been {days} since your last post in {groupName}. No pressure, just a friendly nudge. Hope all is well!`,
    `Hello {user}! {groupName} has been a little quieter without you for {days}. If you feel like dropping in, we'd love it. 😊`,
    `Hey {user}, you've been away from {groupName} for {days}. When you're ready, the group is still here and would love to see you again.`,
    `Hi {user}! Just a gentle reminder that we noticed your absence from {groupName} for {days}. If you want to come back later, we're ready.`,
    `Hey {user}, hope everything's okay. It's been {days} since we saw you in {groupName} — the chat could use your spark again!`,
];

const DEFAULT_SETTINGS: GroupSettings = {
    enabled:          false,
    inactiveDays:     7,
    dmMessage:        DEFAULT_DM_MESSAGES[0],
    dmMessages:       DEFAULT_DM_MESSAGES,
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

function buildDMText(settings: GroupSettings, replacements: Record<string, string>): string {
    const isUsingDefaultMessage = settings.dmMessage === DEFAULT_SETTINGS.dmMessage;
    const template = isUsingDefaultMessage
        ? (settings.dmMessages?.length
            ? settings.dmMessages[Math.floor(Math.random() * settings.dmMessages.length)]
            : DEFAULT_DM_MESSAGES[Math.floor(Math.random() * DEFAULT_DM_MESSAGES.length)])
        : settings.dmMessage;
    return formatDMMessage(template, replacements);
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

function classifyReply(userMessage: string): ClassifiedReply {
    const t = userMessage.toLowerCase();

    if (/\b(sick|ill|hospital|death|died|dead|bereave|grief|mental|accident|surgery)\b|not (feeling|doing|fine|well|okay|ok|good)|feeling (bad|terrible|awful|down|low|sad|depressed)|not (fine|well|okay)|things are (not|bad)|just managing|struggling|can't cope|rough (time|patch)|hard time/i.test(t))
        return { category: 'serious', reasoning: 'Health or personal distress detected' };

    if (/\b(exam|study|test|school|university|college|revision|coursework|assignment|finals|thesis|academic|lectures|semester)\b|studies?/i.test(t))
        return { category: 'exams', reasoning: 'Academic commitment detected' };

    if (/\b(boring|dead|quiet|nothing new|no vibe|group died|pointless|repetitive)\b|same people|doesn.t interest|feels? pointless|nobody talks?|not relevant/i.test(t))
        return { category: 'boring', reasoning: 'Group disengagement detected' };

    if (/drama|argument|argued|fight|ignored|excluded|left out|disrespect|hurt|needed space|some people|the vibe|didn.t feel|felt unwelcome|needed a break from/i.test(t))
        return { category: 'conflict', reasoning: 'Group conflict signal detected' };

    if (/\b(back|returning|active again|thank|thanks|missed|coming back)\b|i.?m back|i am back/i.test(t))
        return { category: 'returning', reasoning: 'Returning member detected' };

    if (/\b(busy|work|travel|vacation|trip|offline|family|personal|life|things)\b/i.test(t))
        return { category: 'casual', reasoning: 'General busyness detected' };

    return { category: 'unknown', reasoning: 'Could not classify' };
}

function classifyConsent(userMessage: string): ConsentResult {
    const t = userMessage.toLowerCase().trim();
    const yes = ['yes','yeah','yep','yh','sure','ok','okay','please','go ahead','do it','alright','fine','why not','no problem'];
    const no  = ['no','nah','nope',"don't",'dont','no thanks','its fine',"it's fine",'leave it','forget it','never mind','nevermind','keep it','private'];
    if (yes.some(s => t === s || t.startsWith(s + ' '))) return 'yes';
    if (no.some(s  => t === s || t.startsWith(s + ' '))) return 'no';
    return 'unknown';
}

function summarizeFeedback(userMessage: string, groupName: string): string {
    return `A member shared feedback that the *${groupName}* group feels less engaging than it used to. They suggested the content or interactions may need refreshing to keep members interested and involved.`;
}

// ── Reply message pools ───────────────────────────────────────────────────────

const REPLIES: Record<ReplyCategory, string[]> = {

    serious: [
        `I'm really sorry you're going through that. Take all the time you need — the group cares about you and will be here when you're ready. 💙`,
        `Thanks for being honest with me. That sounds rough, and your wellbeing matters more than anything here. Come back when things feel calmer. 🙏`,
        `Take it easy for now — the group cares and we want you to feel okay first. When you're ready to check in again, we'll be glad to see you. 💛`,
        `That was brave to share. Rest, recover, and know the group is still here for you whenever you're ready to return. 🫶`,
    ],

    conflict: [
        `I get it — sometimes spaces don't feel right, and that's okay. The group cares about you, and you don't need to explain more than you're comfortable with. 💙\n\nIf you'd like, I can quietly let an admin know so someone can check in privately. Reply *yes* or *no* whenever you're ready.`,
        `Thanks for telling me how you feel. Your comfort matters here, and it's okay to take a break until things feel better. 🙏\n\nIf you want, I can pass this along to an admin privately. Just say *yes* or *no*.`,
        `That sounds like a rough experience, and I'm sorry the group didn’t feel safe. 💙\n\nIf you want, I can quietly notify an admin to reach out privately. Reply *yes* or *no* — no pressure.`,
        `I hear you. It's important that the group feels good for you, and taking space is okay. 🫶\n\nWould you like me to let an admin know privately so they can support you? Reply *yes* or *no*.`,
    ],

    exams: [
        `Absolutely — your studies come first. The group cares about you, and we’ll be here when the exam stress eases up. Good luck! 📚💪`,
        `No worries at all, just focus on your work. The group is still here and would love to see you back when things are calmer. 🌟`,
        `School stuff matters, so go handle it. When you're done, the group will be happy to welcome you back. 💙`,
        `Totally understandable! Take care of yourself, keep going, and drop in again once things settle down. You’ve got this. ✊`,
    ],

    boring: [
        `Thanks for being honest — that really helps. The group wants to improve, so could you tell me what makes it feel boring or stale for you?`,
        `I appreciate you sharing that. The group cares, and your opinion can help make things better. What specifically has felt off or dull lately?`,
        `That kind of feedback is useful. If you want, tell me what feels uninteresting — topics, energy, people, or anything else. We want the chat to feel worth coming back to.`,
        `Really good to know. The group wants to be better for everyone, so if you can, share a little about what’s making it feel boring. No judgment here.`,
    ],

    casual: [
        `Totally okay — life happens. The group cares, so jump back in whenever things are easier for you. 😊`,
        `No rush at all. Take your time, and when you're ready, the group will be glad to have you back. 👍`,
        `Thanks for the heads-up! We'll keep things open for you, and the group is here when you want to return. 🙌`,
        `Sounds good — go do your thing, and come back when it feels right. The group missed you. 😄`,
    ],

    returning: [
        `Welcome back! So good to see you again — the group missed you. 🎉`,
        `Awesome, you're back! Jump in when you're ready, the group cares and is happy to have you. 😊`,
        `Nice to see you again! Take it easy and come back when you feel like it — everyone’s happy you’re here. 🙌`,
        `Yay, welcome back! The group missed having you around. Feel free to join in whenever you're ready. 🎊`,
    ],

    unknown: [
        `Thanks for replying — just know the group cares and is here whenever you're ready to return. 😊`,
        `Got it! No pressure, and feel free to check back in once things feel more normal. 👍`,
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
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `⚠️ *MEMBER SUPPORT ALERT*\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `Hi, I wanted to bring to your attention that @${phone} from *${pending.groupName}* may be dealing with something difficult right now. ` +
            `They recently shared with me: "${userMessage}"\n\n` +
            `Based on what they mentioned, it sounds like they might be experiencing some personal stress or health concerns. ` +
            `I'd recommend reaching out to them privately when you have a moment—just a genuine check-in to see how they're doing can make a real difference.\n\n` +
            `─────────────────────────`;
    } else if (type === 'conflict') {
        alertText =
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `⚠️ *GROUP DYNAMICS ALERT*\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `Hi, I wanted to flag something for you. @${phone} from *${pending.groupName}* recently mentioned: "${userMessage}"\n\n` +
            `It appears their inactivity might be connected to something that happened in the group. They've consented to having you notified about this. ` +
            `When you get a chance, it would be good to reach out privately and listen to what's on their mind. Please keep this conversation between you and them—no need to bring it up in the group.\n\n` +
            `─────────────────────────`;
    } else {
        // boring — fully anonymous, no name, no mention
        const summary = summarizeFeedback(userMessage, pending.groupName);
        alertText =
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📋 *GROUP FEEDBACK — ANONYMOUS*\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `Hi, I've received some feedback from a member of *${pending.groupName}* that I think you should be aware of:\n\n` +
            `${summary}\n\n` +
            `This comes to you anonymously, but it's genuine feedback worth considering as you think about the group's direction. ` +
            `It might be worth reflecting on how you could keep things fresh and engaging for everyone.\n\n` +
            `─────────────────────────`;
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

                    const dmText = buildDMText(settings, {
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

        if (pending.awaitingReaction) {
            try {
                await sock.sendMessage(chatId, {
                    react: { text: '👍', key: message.key }
                });
            } catch {
                // ignore reaction errors
            }

            if (pending.stage === 'initial') {
                await dbReplies.del(userId);
                return true;
            }

            await dbReplies.set(userId, {
                ...pending,
                awaitingReaction: false,
            } satisfies PendingReply);
        }

        // ── Stage: conflict consent ───────────────────────────────────────────
        if (pending.stage === 'conflict_consent') {
            const consent = classifyConsent(userMessage);

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
        const { category, reasoning } = classifyReply(userMessage);
        printLog('info', `[INACTIVE] Classified as "${category}": ${reasoning}`);

        const botReply = pickReply(category);
        await sock.sendMessage(chatId, { text: botReply });

        if (category === 'serious') {
            const userName = await getUserName(sock, chatId);
            await alertAdmins(sock, pending, userMessage, userName, reasoning, 'serious');
            await resetUserActivity(pending.groupId, chatId);
            await dbReplies.set(userId, {
                ...pending,
                awaitingReaction: true,
            } satisfies PendingReply);

        } else if (category === 'conflict') {
            // Move to consent stage — keep pending state
            await dbReplies.set(userId, {
                ...pending,
                stage:            'conflict_consent',
                originalMsg:      userMessage,
                awaitingReaction: true,
            } satisfies PendingReply);

        } else if (category === 'exams') {
            // Reset so they get a fresh cycle after exams — no admin alert needed
            await resetUserActivity(pending.groupId, chatId);
            await dbReplies.set(userId, {
                ...pending,
                awaitingReaction: true,
            } satisfies PendingReply);

        } else if (category === 'boring') {
            // Move to follow-up stage to get specific feedback
            await dbReplies.set(userId, {
                ...pending,
                stage:            'boring_followup',
                originalMsg:      userMessage,
                awaitingReaction: true,
            } satisfies PendingReply);
            // botReply already sent above — it contains the follow-up question

        } else if (category === 'returning') {
            await resetUserActivity(pending.groupId, chatId);
            await dbReplies.set(userId, {
                ...pending,
                awaitingReaction: true,
            } satisfies PendingReply);

        } else {
            // casual / unknown — warm reply already sent, wait for the next response
            await dbReplies.set(userId, {
                ...pending,
                awaitingReaction: true,
            } satisfies PendingReply);
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
            `• *${prefix}inactive resetmsg* — Reset the saved DM msg to Default\n` +
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

            case 'resetmsg':
                if (!await requireAdmin(sock, chatId, message, senderId)) return;
                const settings = await getGroupSettings(chatId);
                settings.dmMessage  = DEFAULT_SETTINGS.dmMessage;
                settings.dmMessages = DEFAULT_DM_MESSAGES;
                await saveGroupSettings(chatId, settings);
                await sock.sendMessage(chatId, { text: '✅ DM messages reset to defaults.' }, { quoted: message });
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
