/**
 * plugins/schedule.ts
 *
 * Group Event Scheduler with RSVP & Auto-Reminders
 * ─────────────────────────────────────────────────
 * Commands:
 *   .event                          — help / menu
 *   .event create <title> | <datetime> | [description]
 *   .event list                     — upcoming events in this group
 *   .event info <id>                — full event details
 *   .event rsvp <id>                — confirm your attendance
 *   .event unrsvp <id>              — withdraw your RSVP
 *   .event attendees <id>           — show who's coming
 *   .event cancel <id>              — mark event cancelled  [admin]
 *   .event delete <id>              — permanently remove event [admin]
 *   .event reminder <id> <mins>     — add a reminder offset  [admin]
 *   .event settings [reminders X,Y] — view / change group defaults [admin]
 *
 * Date-time formats accepted:
 *   "25/12/2025 18:00"  |  "2025-12-25 18:00"
 *   "tomorrow 9am"      |  "next friday 3pm"
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const moment  = require('moment-timezone');

import { createStore }   from '../lib/pluginStore.js';
import { printLog }      from '../lib/print.js';
import config            from '../config.js';

// ── Storage ───────────────────────────────────────────────────────────────────
const db        = createStore('scheduler');
const dbEvents  = db.table!('events');    // eventId  → EventRecord
const dbRsvps   = db.table!('rsvps');     // eventId  → { userId: timestamp, … }
const dbGrpCfg  = db.table!('groupcfg'); // groupId  → GroupConfig

// ── Defaults ──────────────────────────────────────────────────────────────────
const DEFAULT_REMINDERS     = [60, 10];
const MAX_EVENTS_PER_GROUP  = 20;
const ID_LENGTH             = 6;

// ── In-memory caches ──────────────────────────────────────────────────────────
const _eventCache   = new Map<string, any>();
const _notifiedMap  = new Map<string, Set<number>>();
let   _cacheLoadedAt = 0;
const CACHE_TTL_MS  = 5 * 60_000;

// Track whether the schedule engine has been started
let _engineStarted = false;

// ── Timezone helper ───────────────────────────────────────────────────────────
function tz(): string {
    return config.timeZone || 'Africa/Lagos';
}

function nowMoment(): any {
    return moment.tz(tz());
}

// ── ID generator ──────────────────────────────────────────────────────────────
function makeId(): string {
    return Math.random().toString(16).slice(2, 2 + ID_LENGTH).toUpperCase();
}

// ── Date parser ───────────────────────────────────────────────────────────────
const DATE_FORMATS = [
    'DD/MM/YYYY HH:mm',
    'DD/MM/YYYY h:mma',
    'YYYY-MM-DD HH:mm',
    'YYYY-MM-DD h:mma',
    'D MMMM YYYY HH:mm',
    'D MMMM YYYY h:mma',
    'MMMM D YYYY HH:mm',
    'MMMM D YYYY h:mma',
    'DD/MM/YYYY',
    'YYYY-MM-DD',
];

function parseDateTime(raw: string): any | null {
    const str  = raw.trim();
    const zone = tz();
    const lc   = str.toLowerCase();
    let base   = nowMoment();

    const relMatch = lc.match(
        /^(today|tomorrow|next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday))\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{2}:\d{2})/i
    );

    if (relMatch) {
        const dayPart  = relMatch[1];
        const timePart = relMatch[3];

        if (dayPart === 'tomorrow') {
            base = base.add(1, 'day');
        } else if (dayPart !== 'today') {
            const target    = relMatch[2];
            const days      = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
            const targetIdx = days.indexOf(target.trim().toLowerCase());
            const nowIdx    = base.day();
            let diff        = (targetIdx - nowIdx + 7) % 7;
            if (diff === 0) diff = 7;
            base = base.add(diff, 'days');
        }

        const parsed = moment.tz(
            `${base.format('YYYY-MM-DD')} ${timePart.trim()}`,
            ['YYYY-MM-DD HH:mm', 'YYYY-MM-DD h:mma', 'YYYY-MM-DD ha'],
            zone
        );

        return parsed.isValid() ? parsed : null;
    }

    for (const fmt of DATE_FORMATS) {
        const m = moment.tz(str, fmt, true, zone);
        if (m.isValid()) return m;
    }

    const fallback = moment.tz(str, zone);
    return fallback.isValid() ? fallback : null;
}

// ── Group config helpers ──────────────────────────────────────────────────────
async function getGroupConfig(groupId: string): Promise<any> {
    const cfg = await dbGrpCfg.getOrDefault(groupId, {});
    return {
        reminders: cfg.reminders ?? [...DEFAULT_REMINDERS],
        ...cfg
    };
}

// ── Event CRUD ────────────────────────────────────────────────────────────────
async function createEvent({ groupId, creatorId, title, startAt, description }: any) {
    const allEvents  = await dbEvents.getAll();
    const groupEvents = Object.values(allEvents).filter(
        (e: any) => e.groupId === groupId && e.status === 'upcoming'
    );

    if (groupEvents.length >= MAX_EVENTS_PER_GROUP) {
        return { ok: false, reason: `Maximum ${MAX_EVENTS_PER_GROUP} upcoming events per group reached.` };
    }

    const cfg  = await getGroupConfig(groupId);
    const id   = makeId();

    const event = {
        id,
        groupId,
        creatorId,
        title:       title.trim(),
        description: description?.trim() || '',
        startAt:     startAt.toISOString(),
        status:      'upcoming',
        createdAt:   new Date().toISOString(),
        reminders:   [...cfg.reminders],
    };

    await dbEvents.set(id, event);
    await dbRsvps.set(id, {});
    _eventCache.set(id, event);

    return { ok: true, event };
}

async function getEvent(id: string): Promise<any> {
    if (_eventCache.has(id)) return _eventCache.get(id);
    const ev = await dbEvents.get(id);
    if (ev) _eventCache.set(id, ev);
    return ev;
}

async function listGroupEvents(groupId: string, status = 'upcoming'): Promise<any[]> {
    const all = await dbEvents.getAll();
    return Object.values(all)
        .filter((e: any) => e.groupId === groupId && e.status === status)
        .sort((a: any, b: any) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
}

async function updateEventStatus(id: string, status: string): Promise<boolean> {
    const ev = await getEvent(id);
    if (!ev) return false;
    const updated = { ...ev, status, updatedAt: new Date().toISOString() };
    await dbEvents.set(id, updated);
    _eventCache.set(id, updated);
    return true;
}

// ── RSVP helpers ──────────────────────────────────────────────────────────────
async function getRsvps(eventId: string): Promise<Record<string, string>> {
    return await dbRsvps.getOrDefault(eventId, {});
}

async function addRsvp(eventId: string, userId: string): Promise<number> {
    const rsvps: any   = await getRsvps(eventId);
    rsvps[userId] = new Date().toISOString();
    await dbRsvps.set(eventId, rsvps);
    return Object.keys(rsvps).length;
}

async function removeRsvp(eventId: string, userId: string): Promise<boolean> {
    const rsvps: any = await getRsvps(eventId);
    if (!rsvps[userId]) return false;
    delete rsvps[userId];
    await dbRsvps.set(eventId, rsvps);
    return true;
}

// ── Formatting helpers ────────────────────────────────────────────────────────
function formatEventShort(ev: any): string {
    const start = moment.tz(ev.startAt, tz());
    const diff  = start.diff(moment.tz(tz()));
    const rel   = diff > 0 ? `in ${moment.duration(diff).humanize()}` : '(past)';

    return (
        `📌 *[${ev.id}]* ${ev.title}\n` +
        `   🗓 ${start.format('ddd, D MMM YYYY [at] HH:mm')} — ${rel}`
    );
}

function formatEventFull(ev: any, rsvps: Record<string, string>): string {
    const start     = moment.tz(ev.startAt, tz());
    const diffMs    = start.diff(moment.tz(tz()));
    const countDown = diffMs > 0 ? `in ${moment.duration(diffMs).humanize()}` : '(past)';
    const attendeeCount = Object.keys(rsvps).length;
    const statusIco = ev.status === 'upcoming' ? '🟢' : ev.status === 'cancelled' ? '🔴' : '✅';

    let text =
        `${statusIco} *EVENT DETAILS*\n\n` +
        `🆔 ID: \`${ev.id}\`\n` +
        `📣 Title: *${ev.title}*\n`;

    if (ev.description) text += `📝 Description: ${ev.description}\n`;

    text +=
        `🗓 When: ${start.format('dddd, D MMMM YYYY [at] HH:mm z')}\n` +
        `⏰ Countdown: ${countDown}\n` +
        `📊 Status: ${ev.status.toUpperCase()}\n` +
        `👥 RSVPs: ${attendeeCount}\n` +
        `🔔 Reminders: ${ev.reminders.map((r: number) => `${r} min`).join(', ')}\n` +
        `👤 Created by: @${ev.creatorId.split('@')[0]}\n`;

    return text;
}

// ── Notification sender ───────────────────────────────────────────────────────
async function sendReminder(sock: any, ev: any, minutesBefore: number): Promise<void> {
    const start    = moment.tz(ev.startAt, tz());
    const rsvps    = await getRsvps(ev.id);
    const mentions = Object.keys(rsvps);

    let header: string, body: string;

    if (minutesBefore === 0) {
        header = `🎉 *EVENT STARTING NOW!*`;
        body   = `Get ready everyone! *${ev.title}* is starting right now!`;
    } else {
        header = `⏰ *EVENT REMINDER — ${minutesBefore} MIN*`;
        body   = `*${ev.title}* starts in ${minutesBefore} minutes!\n🗓 ${start.format('HH:mm')}`;
    }

    let text = `${header}\n\n${body}`;
    if (ev.description)   text += `\n\n📝 ${ev.description}`;
    if (mentions.length)  text += `\n\n👥 RSVPs: ${mentions.map((id: string) => `@${id.split('@')[0]}`).join(' ')}`;
    else                  text += `\n\n📌 No RSVPs yet — use *.event rsvp ${ev.id}* to join!`;

    try {
        await sock.sendMessage(ev.groupId, { text, mentions });
        printLog('info', `[Scheduler] Reminder sent for "${ev.title}" (${minutesBefore}min)`);
    } catch (err: any) {
        printLog('error', `[Scheduler] Failed to send reminder: ${err.message}`);
    }
}

// ── Schedule tick ─────────────────────────────────────────────────────────────
async function scheduleTick(sock: any): Promise<void> {
    try {
        if (Date.now() - _cacheLoadedAt > CACHE_TTL_MS) {
            const all = await dbEvents.getAll();
            for (const [id, ev] of Object.entries(all)) {
                _eventCache.set(id, ev);
            }
            _cacheLoadedAt = Date.now();
        }

        const nowMs = Date.now();

        for (const [id, ev] of _eventCache) {
            if (ev.status !== 'upcoming') continue;

            const startMs  = new Date(ev.startAt).getTime();
            const diffMins = (startMs - nowMs) / 60_000;

            if (!_notifiedMap.has(id)) _notifiedMap.set(id, new Set());
            const fired = _notifiedMap.get(id)!;

            for (const offset of ev.reminders as number[]) {
                if (!fired.has(offset) && diffMins <= offset && diffMins > offset - 1.5) {
                    fired.add(offset);
                    await sendReminder(sock, ev, offset);
                }
            }

            if (!fired.has(0) && diffMins <= 0 && diffMins > -1.5) {
                fired.add(0);
                await sendReminder(sock, ev, 0);
                await updateEventStatus(id, 'done');
                _eventCache.delete(id);
                _notifiedMap.delete(id);
            }

            if (diffMins < -24 * 60) {
                await updateEventStatus(id, 'done');
                _eventCache.delete(id);
                _notifiedMap.delete(id);
            }
        }
    } catch (err: any) {
        printLog('error', `[Scheduler] Tick error: ${err.message}`);
    }
}

// ── Called from messageHandler to lazily start the engine ────────────────────
export function startSchedulerEngine(sock: any): void {
    if (_engineStarted) return;
    _engineStarted = true;
    setInterval(() => scheduleTick(sock), 60_000);
    printLog('info', '[Scheduler] Engine started');
}

// ── Menu text ─────────────────────────────────────────────────────────────────
function menuText(): string {
    const p = config.prefix;
    return (
        `📅 *GROUP EVENT SCHEDULER*\n\n` +
        `*Create & Manage Events:*\n` +
        `• *${p}event create <title> | <date time> | [description]*\n` +
        `• *${p}event list* — upcoming events\n` +
        `• *${p}event info <id>* — event details\n` +
        `• *${p}event cancel <id>* — cancel event _(admin)_\n` +
        `• *${p}event delete <id>* — delete event _(admin)_\n\n` +
        `*RSVP:*\n` +
        `• *${p}event rsvp <id>* — confirm attendance\n` +
        `• *${p}event unrsvp <id>* — withdraw attendance\n` +
        `• *${p}event attendees <id>* — see who's coming\n\n` +
        `*Settings _(admin)_:*\n` +
        `• *${p}event reminder <id> <mins>* — add a reminder offset\n` +
        `• *${p}event settings* — view/change group defaults\n\n` +
        `*Date formats:*\n` +
        `  25/12/2025 18:00\n` +
        `  tomorrow 9am\n` +
        `  next friday 3pm\n`
    );
}

// ── Sub-command handlers ──────────────────────────────────────────────────────

async function cmdCreate(sock: any, message: any, args: string[], context: any): Promise<void> {
    const { chatId, senderId, isSenderAdmin, senderIsOwnerOrSudo, channelInfo } = context;

    if (!isSenderAdmin && !senderIsOwnerOrSudo) {
        return sock.sendMessage(chatId, {
            text: '🚫 Only group admins can create events.',
            ...channelInfo
        }, { quoted: message });
    }

    const raw   = args.join(' ');
    const parts = raw.split('|').map((p: string) => p.trim());

    if (parts.length < 2) {
        return sock.sendMessage(chatId, {
            text: `⚠️ Usage:\n*${config.prefix}event create <title> | <date & time> | [description]*\n\nExample:\n*${config.prefix}event create Town Hall | 25/12/2025 18:00 | Monthly meeting*`,
            ...channelInfo
        }, { quoted: message });
    }

    const [title, dateRaw, description] = parts;
    const startAt = parseDateTime(dateRaw);

    if (!startAt) {
        return sock.sendMessage(chatId, {
            text: `❌ Could not parse date/time: *${dateRaw}*\n\nTry formats like:\n• 25/12/2025 18:00\n• tomorrow 9am\n• next friday 3pm`,
            ...channelInfo
        }, { quoted: message });
    }

    if (startAt.isBefore(nowMoment())) {
        return sock.sendMessage(chatId, {
            text: '❌ The event date/time is in the past. Please pick a future date.',
            ...channelInfo
        }, { quoted: message });
    }

    const result = await createEvent({ groupId: chatId, creatorId: senderId, title, startAt, description });

    if (!result.ok) {
        return sock.sendMessage(chatId, { text: `❌ ${result.reason}`, ...channelInfo }, { quoted: message });
    }

    const ev = result.event!;

    return sock.sendMessage(chatId, {
        text:
            `✅ *Event Created!*\n\n` +
            `📌 *${ev.title}*\n` +
            `🆔 ID: \`${ev.id}\`\n` +
            `🗓 ${startAt.format('dddd, D MMMM YYYY [at] HH:mm z')}\n` +
            `🔔 Reminders: ${ev.reminders.map((r: number) => `${r} min before`).join(', ')}\n` +
            (ev.description ? `📝 ${ev.description}\n` : '') +
            `\n💡 Members can RSVP with *${config.prefix}event rsvp ${ev.id}*`,
        mentions: [senderId],
        ...channelInfo
    }, { quoted: message });
}

async function cmdList(sock: any, message: any, _args: string[], context: any): Promise<void> {
    const { chatId, channelInfo } = context;
    const events = await listGroupEvents(chatId, 'upcoming');

    if (!events.length) {
        return sock.sendMessage(chatId, {
            text: `📭 No upcoming events in this group.\n\n💡 Admins can create one with *${config.prefix}event create*`,
            ...channelInfo
        }, { quoted: message });
    }

    const lines = events.map((ev: any) => formatEventShort(ev)).join('\n\n');

    return sock.sendMessage(chatId, {
        text: `📅 *UPCOMING EVENTS* (${events.length})\n\n${lines}\n\n💡 Use *${config.prefix}event info <id>* for full details`,
        ...channelInfo
    }, { quoted: message });
}

async function cmdInfo(sock: any, message: any, args: string[], context: any): Promise<void> {
    const { chatId, channelInfo } = context;
    const id = (args[0] || '').toUpperCase().trim();

    if (!id) {
        return sock.sendMessage(chatId, { text: `⚠️ Usage: *${config.prefix}event info <id>*`, ...channelInfo }, { quoted: message });
    }

    const ev = await getEvent(id);
    if (!ev || ev.groupId !== chatId) {
        return sock.sendMessage(chatId, { text: `❌ Event *${id}* not found in this group.`, ...channelInfo }, { quoted: message });
    }

    const rsvps = await getRsvps(id);

    return sock.sendMessage(chatId, {
        text: formatEventFull(ev, rsvps),
        mentions: [ev.creatorId],
        ...channelInfo
    }, { quoted: message });
}

async function cmdRsvp(sock: any, message: any, args: string[], context: any): Promise<void> {
    const { chatId, senderId, channelInfo } = context;
    const id = (args[0] || '').toUpperCase().trim();

    if (!id) {
        return sock.sendMessage(chatId, { text: `⚠️ Usage: *${config.prefix}event rsvp <id>*`, ...channelInfo }, { quoted: message });
    }

    const ev = await getEvent(id);
    if (!ev || ev.groupId !== chatId) {
        return sock.sendMessage(chatId, { text: `❌ Event *${id}* not found in this group.`, ...channelInfo }, { quoted: message });
    }

    if (ev.status !== 'upcoming') {
        return sock.sendMessage(chatId, { text: `❌ Cannot RSVP to a *${ev.status}* event.`, ...channelInfo }, { quoted: message });
    }

    const rsvps: any = await getRsvps(id);
    if (rsvps[senderId]) {
        return sock.sendMessage(chatId, {
            text: `ℹ️ You're already on the RSVP list for *${ev.title}*.`,
            ...channelInfo
        }, { quoted: message });
    }

    const total = await addRsvp(id, senderId);
    const start = moment.tz(ev.startAt, tz());

    return sock.sendMessage(chatId, {
        text:
            `✅ *RSVP Confirmed!*\n\n` +
            `📌 ${ev.title}\n` +
            `🗓 ${start.format('D MMM YYYY [at] HH:mm')}\n` +
            `👥 Total attendees: ${total}`,
        mentions: [senderId],
        ...channelInfo
    }, { quoted: message });
}

async function cmdUnrsvp(sock: any, message: any, args: string[], context: any): Promise<void> {
    const { chatId, senderId, channelInfo } = context;
    const id = (args[0] || '').toUpperCase().trim();

    if (!id) {
        return sock.sendMessage(chatId, { text: `⚠️ Usage: *${config.prefix}event unrsvp <id>*`, ...channelInfo }, { quoted: message });
    }

    const ev = await getEvent(id);
    if (!ev || ev.groupId !== chatId) {
        return sock.sendMessage(chatId, { text: `❌ Event *${id}* not found in this group.`, ...channelInfo }, { quoted: message });
    }

    const removed = await removeRsvp(id, senderId);
    if (!removed) {
        return sock.sendMessage(chatId, {
            text: `ℹ️ You were not on the RSVP list for *${ev.title}*.`,
            ...channelInfo
        }, { quoted: message });
    }

    return sock.sendMessage(chatId, {
        text: `❎ RSVP removed — you've been taken off *${ev.title}*.`,
        mentions: [senderId],
        ...channelInfo
    }, { quoted: message });
}

async function cmdAttendees(sock: any, message: any, args: string[], context: any): Promise<void> {
    const { chatId, channelInfo } = context;
    const id = (args[0] || '').toUpperCase().trim();

    if (!id) {
        return sock.sendMessage(chatId, { text: `⚠️ Usage: *${config.prefix}event attendees <id>*`, ...channelInfo }, { quoted: message });
    }

    const ev = await getEvent(id);
    if (!ev || ev.groupId !== chatId) {
        return sock.sendMessage(chatId, { text: `❌ Event *${id}* not found in this group.`, ...channelInfo }, { quoted: message });
    }

    const rsvps    = await getRsvps(id);
    const mentions = Object.keys(rsvps);

    if (!mentions.length) {
        return sock.sendMessage(chatId, {
            text: `👥 No RSVPs yet for *${ev.title}*.\n\nBe the first! Use *${config.prefix}event rsvp ${id}*`,
            ...channelInfo
        }, { quoted: message });
    }

    const lines = mentions.map((uid: string, i: number) => {
        const ts = moment.tz(rsvps[uid], tz()).format('D MMM, HH:mm');
        return `${i + 1}. @${uid.split('@')[0]} _(${ts})_`;
    }).join('\n');

    return sock.sendMessage(chatId, {
        text:
            `👥 *ATTENDEES — ${ev.title}*\n` +
            `🆔 ${id} | Total: ${mentions.length}\n\n` +
            `${lines}`,
        mentions,
        ...channelInfo
    }, { quoted: message });
}

async function cmdCancel(sock: any, message: any, args: string[], context: any): Promise<void> {
    const { chatId, isSenderAdmin, senderIsOwnerOrSudo, channelInfo } = context;

    if (!isSenderAdmin && !senderIsOwnerOrSudo) {
        return sock.sendMessage(chatId, { text: '🚫 Only admins can cancel events.', ...channelInfo }, { quoted: message });
    }

    const id = (args[0] || '').toUpperCase().trim();

    if (!id) {
        return sock.sendMessage(chatId, { text: `⚠️ Usage: *${config.prefix}event cancel <id>*`, ...channelInfo }, { quoted: message });
    }

    const ev = await getEvent(id);
    if (!ev || ev.groupId !== chatId) {
        return sock.sendMessage(chatId, { text: `❌ Event *${id}* not found in this group.`, ...channelInfo }, { quoted: message });
    }

    if (ev.status === 'cancelled') {
        return sock.sendMessage(chatId, { text: `ℹ️ Event *${ev.title}* is already cancelled.`, ...channelInfo }, { quoted: message });
    }

    await updateEventStatus(id, 'cancelled');

    const rsvps    = await getRsvps(id);
    const mentions = Object.keys(rsvps);

    const text =
        `🔴 *EVENT CANCELLED*\n\n` +
        `📌 *${ev.title}* has been cancelled.\n` +
        `🆔 ID: ${id}` +
        (mentions.length ? `\n\n👥 ${mentions.map((u: string) => `@${u.split('@')[0]}`).join(' ')} — heads up!` : '');

    return sock.sendMessage(chatId, { text, mentions, ...channelInfo }, { quoted: message });
}

async function cmdDelete(sock: any, message: any, args: string[], context: any): Promise<void> {
    const { chatId, isSenderAdmin, senderIsOwnerOrSudo, channelInfo } = context;

    if (!isSenderAdmin && !senderIsOwnerOrSudo) {
        return sock.sendMessage(chatId, { text: '🚫 Only admins can delete events.', ...channelInfo }, { quoted: message });
    }

    const id = (args[0] || '').toUpperCase().trim();

    if (!id) {
        return sock.sendMessage(chatId, { text: `⚠️ Usage: *${config.prefix}event delete <id>*`, ...channelInfo }, { quoted: message });
    }

    const ev = await getEvent(id);
    if (!ev || ev.groupId !== chatId) {
        return sock.sendMessage(chatId, { text: `❌ Event *${id}* not found.`, ...channelInfo }, { quoted: message });
    }

    await dbEvents.del(id);
    await dbRsvps.del(id);
    _eventCache.delete(id);
    _notifiedMap.delete(id);

    return sock.sendMessage(chatId, {
        text: `🗑 Event *${ev.title}* (ID: ${id}) has been permanently deleted.`,
        ...channelInfo
    }, { quoted: message });
}

async function cmdReminder(sock: any, message: any, args: string[], context: any): Promise<void> {
    const { chatId, isSenderAdmin, senderIsOwnerOrSudo, channelInfo } = context;

    if (!isSenderAdmin && !senderIsOwnerOrSudo) {
        return sock.sendMessage(chatId, { text: '🚫 Only admins can change reminder times.', ...channelInfo }, { quoted: message });
    }

    const id   = (args[0] || '').toUpperCase().trim();
    const mins = parseInt(args[1]);

    if (!id || isNaN(mins) || mins < 1) {
        return sock.sendMessage(chatId, {
            text: `⚠️ Usage: *${config.prefix}event reminder <id> <minutes>*\nExample: *${config.prefix}event reminder ABC123 30*`,
            ...channelInfo
        }, { quoted: message });
    }

    const ev = await getEvent(id);
    if (!ev || ev.groupId !== chatId) {
        return sock.sendMessage(chatId, { text: `❌ Event *${id}* not found.`, ...channelInfo }, { quoted: message });
    }

    const existing: number[] = ev.reminders || [];
    if (!existing.includes(mins)) {
        existing.push(mins);
        existing.sort((a: number, b: number) => b - a);
        if (existing.length > 5) existing.length = 5;
    }

    const updated = { ...ev, reminders: existing };
    await dbEvents.set(id, updated);
    _eventCache.set(id, updated);

    return sock.sendMessage(chatId, {
        text:
            `✅ Reminder updated for *${ev.title}*\n` +
            `🔔 Active reminders: ${existing.map((r: number) => `${r} min`).join(', ')}`,
        ...channelInfo
    }, { quoted: message });
}

async function cmdSettings(sock: any, message: any, args: string[], context: any): Promise<void> {
    const { chatId, isSenderAdmin, senderIsOwnerOrSudo, channelInfo } = context;
    const cfg = await getGroupConfig(chatId);

    if (!args.length) {
        return sock.sendMessage(chatId, {
            text:
                `⚙️ *SCHEDULER SETTINGS*\n\n` +
                `🔔 Default reminders: ${cfg.reminders.map((r: number) => `${r} min`).join(', ')}\n\n` +
                `_Admins can change defaults:_\n` +
                `*${config.prefix}event settings reminders 30,10*`,
            ...channelInfo
        }, { quoted: message });
    }

    if (!isSenderAdmin && !senderIsOwnerOrSudo) {
        return sock.sendMessage(chatId, { text: '🚫 Only admins can change settings.', ...channelInfo }, { quoted: message });
    }

    const sub   = (args[0] || '').toLowerCase();
    const value = args.slice(1).join(' ');

    if (sub === 'reminders') {
        const parsed = value.split(',').map((v: string) => parseInt(v.trim())).filter((v: number) => !isNaN(v) && v > 0);
        if (!parsed.length) {
            return sock.sendMessage(chatId, {
                text: `⚠️ Usage: *${config.prefix}event settings reminders 60,30,10*`,
                ...channelInfo
            }, { quoted: message });
        }

        parsed.sort((a: number, b: number) => b - a);
        const newCfg = { ...cfg, reminders: parsed.slice(0, 5) };
        await dbGrpCfg.set(chatId, newCfg);

        return sock.sendMessage(chatId, {
            text: `✅ Default reminders updated: ${newCfg.reminders.map((r: number) => `${r} min`).join(', ')}`,
            ...channelInfo
        }, { quoted: message });
    }

    return sock.sendMessage(chatId, {
        text: `❓ Unknown setting: *${sub}*\n\nAvailable: *reminders*`,
        ...channelInfo
    }, { quoted: message });
}

// ── Plugin export ─────────────────────────────────────────────────────────────
export default {
    command:     'program',
    aliases:     ['event', 'programs'],
    category:    'utility',
    description: 'Group event scheduler with RSVP and auto-reminders',
    usage:       '.program create <title> | <date> | [description]',
    groupOnly:   true,

    // Warm the event cache on startup
    async onLoad(_sock: any): Promise<void> {
        try {
            const all = await dbEvents.getAll();
            let count = 0;
            for (const [id, ev] of Object.entries(all) as [string, any][]) {
                if (ev.status === 'upcoming') {
                    _eventCache.set(id, ev);
                    count++;
                }
            }
            _cacheLoadedAt = Date.now();
            printLog('success', `[Scheduler] Loaded ${count} upcoming event(s) into cache`);
        } catch (err: any) {
            printLog('error', `[Scheduler] onLoad error: ${err.message}`);
        }
    },

    // 1-minute cron — pluginLoader.ts picks this up automatically
    schedules: [
        {
            every:   60_000,
            handler: async (sock: any) => {
                await scheduleTick(sock);
            }
        }
    ],

    async handler(sock: any, message: any, args: string[], context: any = {}): Promise<void> {
        const { chatId, channelInfo } = context;

        if (!args.length) {
            return sock.sendMessage(chatId, { text: menuText(), ...channelInfo }, { quoted: message });
        }

        const sub     = args[0].toLowerCase();
        const subArgs = args.slice(1);

        switch (sub) {
            case 'create':
            case 'add':
            case 'new':
                return cmdCreate(sock, message, subArgs, context);

            case 'list':
            case 'ls':
            case 'upcoming':
                return cmdList(sock, message, subArgs, context);

            case 'info':
            case 'view':
            case 'show':
                return cmdInfo(sock, message, subArgs, context);

            case 'rsvp':
            case 'join':
            case 'attend':
                return cmdRsvp(sock, message, subArgs, context);

            case 'unrsvp':
            case 'leave':
            case 'decline':
                return cmdUnrsvp(sock, message, subArgs, context);

            case 'attendees':
            case 'who':
            case 'going':
                return cmdAttendees(sock, message, subArgs, context);

            case 'cancel':
                return cmdCancel(sock, message, subArgs, context);

            case 'delete':
            case 'remove':
            case 'del':
                return cmdDelete(sock, message, subArgs, context);

            case 'reminder':
            case 'remind':
                return cmdReminder(sock, message, subArgs, context);

            case 'settings':
            case 'config':
            case 'set':
                return cmdSettings(sock, message, subArgs, context);

            case 'help':
            case 'menu':
                return sock.sendMessage(chatId, { text: menuText(), ...channelInfo }, { quoted: message });

            default:
                return sock.sendMessage(chatId, {
                    text: `❓ Unknown sub-command: *${sub}*\nUse *${config.prefix}event* to see all options.`,
                    ...channelInfo
                }, { quoted: message });
        }
    }
};
