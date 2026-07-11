// plugins/program_scheduler.ts
// Group activity scheduler with RSVP, analytics, and automated reminders.
// Ported to MEGA-MDX plugin architecture.

import { createStore } from '../lib/pluginStore.js';
import moment from 'moment-timezone';
import isAdmin from '../lib/isAdmin.js';

// ── Storage ───────────────────────────────────────────────────────────────────
const db = createStore('group_scheduler');

// ── Config ────────────────────────────────────────────────────────────────────
const TIMEZONE             = 'Africa/Lagos';
const DEFAULT_REMINDER_HRS = 2;
const DEFAULT_DURATION     = 60; // minutes
const DEFAULT_REMINDERS    = {
  morningReminder:   true,
  tomorrowPreview:   true,
  twoHourReminder:   true,
  startNotification: false,
  endNotification:   false,
};

moment.tz.setDefault(TIMEZONE);

// In-memory dedup guard for sent notifications
const sentNotifications = new Map<string, number>();

// ── Emoji map ─────────────────────────────────────────────────────────────────
const PROGRAM_EMOJIS: Record<string, string> = {
  relationship: '💕', food: '🍽️', health: '🏥', fitness: '💪',
  study: '📚',       gaming: '🎮', movie: '🎬',  music: '🎵',
  owambe: '👗',      calls: '📞', biz: '💼',     mcm: '💘',
  wcw: '💘',         market: '🛒', throwback: '📸', bible: '📖',
  worship: '🙏',     freaky: '🔞', default: '📅',
};

function getProgramEmoji(name: string): string {
  const n = name.toLowerCase();
  for (const [key, emoji] of Object.entries(PROGRAM_EMOJIS)) {
    if (n.includes(key)) return emoji;
  }
  return PROGRAM_EMOJIS.default;
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface RSVP { attending: string[]; notAttending: string[] }
interface ProgramStats { timesRun: number; totalAttendees: number; avgAttendance: number }
interface Program {
  id: string; name: string; day: number; dayName: string;
  hour: number; minute: number; timeDisplay: string;
  duration: number; durationDisplay: string;
  enabled: boolean; rsvps: RSVP; stats: ProgramStats;
  createdAt: string;
}
interface ReminderSettings {
  morningReminder: boolean; tomorrowPreview: boolean;
  twoHourReminder: boolean; startNotification: boolean; endNotification: boolean;
}
interface Analytics { totalProgramsCreated: number; totalProgramsCompleted: number; totalAttendances: number }
interface Scheduler {
  groupId: string; enabled: boolean; programs: Program[];
  reminderSettings: ReminderSettings; analytics: Analytics;
  lastDailyReminder: string | null; lastTomorrowReminder: string | null;
  createdAt: string; updatedAt: string;
}

// ── Time / day helpers ────────────────────────────────────────────────────────
const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function getDayName(n: number) { return DAY_NAMES[n]; }

function parseDay(input: string): number | null {
  const map: Record<string, number> = {
    sunday:0,sun:0, monday:1,mon:1, tuesday:2,tue:2,tues:2,
    wednesday:3,wed:3, thursday:4,thu:4,thur:4,thurs:4,
    friday:5,fri:5, saturday:6,sat:6,
  };
  return map[input.toLowerCase()] ?? null;
}

function parseTime(input: string): { hour: number; minute: number } | null {
  const m = input.toLowerCase().trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let hour = parseInt(m[1]);
  const minute = parseInt(m[2] || '0');
  const mer = m[3];
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
  if (mer === 'pm' && hour !== 12) hour += 12;
  if (mer === 'am' && hour === 12) hour = 0;
  return { hour, minute };
}

function parseDuration(input?: string): number {
  if (!input) return DEFAULT_DURATION;
  const s = input.toLowerCase().trim();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*h(?:our)?s?$/i))) return Math.round(parseFloat(m[1]) * 60);
  if ((m = s.match(/^(\d+)\s*m(?:in)?(?:ute)?s?$/i)))    return parseInt(m[1]);
  if ((m = s.match(/^(\d+)\s*h\s*(\d+)\s*m$/i)))          return parseInt(m[1]) * 60 + parseInt(m[2]);
  return DEFAULT_DURATION;
}

function formatDuration(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatTime(hour: number, minute: number): string {
  const h = hour % 12 || 12, m = String(minute).padStart(2, '0');
  return `${h}:${m} ${hour >= 12 ? 'PM' : 'AM'}`;
}

// ── DB helpers ────────────────────────────────────────────────────────────────
async function getScheduler(groupId: string): Promise<Scheduler> {
  const existing = await db.get(groupId) as Scheduler | null;
  if (existing) {
    if (!existing.reminderSettings) existing.reminderSettings = { ...DEFAULT_REMINDERS };
    if (!existing.analytics)        existing.analytics = { totalProgramsCreated: 0, totalProgramsCompleted: 0, totalAttendances: 0 };
    return existing;
  }
  const fresh: Scheduler = {
    groupId, enabled: true, programs: [],
    reminderSettings: { ...DEFAULT_REMINDERS },
    analytics: { totalProgramsCreated: 0, totalProgramsCompleted: 0, totalAttendances: 0 },
    lastDailyReminder: null, lastTomorrowReminder: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await db.set(groupId, fresh);
  return fresh;
}

async function saveScheduler(s: Scheduler): Promise<void> {
  s.updatedAt = new Date().toISOString();
  await db.set(s.groupId, s);
}

// ── Program CRUD ──────────────────────────────────────────────────────────────
async function addProgram(groupId: string, name: string, day: number, time: { hour: number; minute: number }, duration: number) {
  const s = await getScheduler(groupId);
  const dup = s.programs.find(p => p.name.toLowerCase() === name.toLowerCase());
  if (dup) return { error: 'duplicate', existing: dup };

  const program: Program = {
    id: Date.now().toString(), name, day, dayName: getDayName(day),
    hour: time.hour, minute: time.minute,
    timeDisplay: formatTime(time.hour, time.minute),
    duration, durationDisplay: formatDuration(duration),
    enabled: true,
    rsvps: { attending: [], notAttending: [] },
    stats: { timesRun: 0, totalAttendees: 0, avgAttendance: 0 },
    createdAt: new Date().toISOString(),
  };

  s.programs.push(program);
  s.analytics.totalProgramsCreated++;
  await saveScheduler(s);
  return { success: true, program };
}

async function removeProgram(groupId: string, identifier: string) {
  const s = await getScheduler(groupId);
  const idx = s.programs.findIndex(p => p.id === identifier || p.name.toLowerCase() === identifier.toLowerCase());
  if (idx === -1) return null;
  const [removed] = s.programs.splice(idx, 1);
  await saveScheduler(s);
  return removed;
}

async function toggleProgram(groupId: string, identifier: string) {
  const s = await getScheduler(groupId);
  const p = s.programs.find(p => p.id === identifier || p.name.toLowerCase() === identifier.toLowerCase());
  if (!p) return null;
  p.enabled = !p.enabled;
  await saveScheduler(s);
  return p;
}

async function rsvpToProgram(groupId: string, userId: string, identifier: string, attending: boolean) {
  const s = await getScheduler(groupId);
  const p = s.programs.find(p => p.id === identifier || p.name.toLowerCase() === identifier.toLowerCase());
  if (!p) return null;
  p.rsvps.attending    = p.rsvps.attending.filter(id => id !== userId);
  p.rsvps.notAttending = p.rsvps.notAttending.filter(id => id !== userId);
  if (attending) p.rsvps.attending.push(userId);
  else           p.rsvps.notAttending.push(userId);
  await saveScheduler(s);
  return p;
}

async function clearProgramRSVPs(groupId: string, programId: string) {
  const s = await getScheduler(groupId);
  const p = s.programs.find(p => p.id === programId);
  if (!p) return;
  const count = p.rsvps.attending.length;
  p.stats.timesRun++;
  p.stats.totalAttendees += count;
  p.stats.avgAttendance   = p.stats.totalAttendees / p.stats.timesRun;
  s.analytics.totalProgramsCompleted++;
  s.analytics.totalAttendances += count;
  p.rsvps = { attending: [], notAttending: [] };
  await saveScheduler(s);
}

// ── Schedule helpers ──────────────────────────────────────────────────────────
function programsForDay(programs: Program[], day: number): Program[] {
  return programs
    .filter(p => p.enabled && p.day === day)
    .sort((a, b) => a.hour !== b.hour ? a.hour - b.hour : a.minute - b.minute);
}

function todaysPrograms(programs: Program[])   { return programsForDay(programs, moment().tz(TIMEZONE).day()); }
function tomorrowsPrograms(programs: Program[]) { return programsForDay(programs, moment().tz(TIMEZONE).add(1,'day').day()); }

function shouldSendTwoHourReminder(p: Program): boolean {
  const now     = moment().tz(TIMEZONE);
  if (p.day !== now.day()) return false;
  const pTime   = moment().tz(TIMEZONE).hour(p.hour).minute(p.minute).second(0);
  const remind  = pTime.clone().subtract(DEFAULT_REMINDER_HRS, 'hours');
  const diff    = now.diff(remind, 'minutes');
  return diff >= 0 && diff < 10;
}

function shouldStartNow(p: Program): boolean {
  const now = moment().tz(TIMEZONE);
  return p.day === now.day() && p.hour === now.hour() && p.minute === now.minute();
}

function shouldEndNow(p: Program): boolean {
  const now  = moment().tz(TIMEZONE);
  if (p.day !== now.day()) return false;
  const end  = moment().tz(TIMEZONE).hour(p.hour).minute(p.minute).add(p.duration, 'minutes');
  return end.hour() === now.hour() && end.minute() === now.minute();
}

// ── Formatted messages ────────────────────────────────────────────────────────
function buildProgramList(programs: Program[], title = 'Scheduled Programs'): string {
  if (!programs.length) return `📅 *${title}*\n\nNo programs scheduled yet.`;

  const byDay: Record<number, Program[]> = {};
  programs.forEach(p => { (byDay[p.day] = byDay[p.day] || []).push(p); });

  let msg = `📅 *${title}*\n\n`;
  Object.keys(byDay).sort((a,b) => +a - +b).forEach(day => {
    msg += `*${getDayName(+day)}*\n${'─'.repeat(20)}\n`;
    byDay[+day]
      .sort((a, b) => a.hour !== b.hour ? a.hour - b.hour : a.minute - b.minute)
      .forEach(p => {
        const emoji   = getProgramEmoji(p.name);
        const status  = p.enabled ? '' : ' (Disabled)';
        const rsvps   = p.rsvps.attending.length;
        msg += `${emoji} *${p.name}*${status}\n`;
        msg += `   ⏰ ${p.timeDisplay} (${p.durationDisplay})\n`;
        if (rsvps > 0) msg += `   👥 ${rsvps} attending\n`;
        msg += `   🆔 ${p.id}\n\n`;
      });
  });
  return msg;
}

function buildAnalytics(s: Scheduler): string {
  const a = s.analytics;
  let msg = `📊 *GROUP SCHEDULE ANALYTICS*\n\n`;
  msg += `📈 *Overall Statistics:*\n`;
  msg += `• Total Programs Created: ${a.totalProgramsCreated}\n`;
  msg += `• Programs Completed: ${a.totalProgramsCompleted}\n`;
  msg += `• Total Attendances: ${a.totalAttendances}\n`;
  if (a.totalProgramsCompleted > 0) {
    msg += `• Avg Attendance: ${Math.round(a.totalAttendances / a.totalProgramsCompleted)} per program\n`;
  }
  msg += `\n🏆 *Top Programs:*\n`;
  const top = s.programs.filter(p => p.stats.timesRun > 0)
    .sort((a, b) => b.stats.avgAttendance - a.stats.avgAttendance).slice(0, 5);
  if (top.length) {
    top.forEach((p, i) => {
      msg += `${i+1}. ${getProgramEmoji(p.name)} ${p.name}\n`;
      msg += `   • Avg: ${Math.round(p.stats.avgAttendance)} | Runs: ${p.stats.timesRun}\n\n`;
    });
  } else {
    msg += `No completed programs yet.\n`;
  }
  return msg;
}

function buildProgramReport(p: Program): string {
  const emoji = getProgramEmoji(p.name);
  let msg = `📊 *PROGRAM REPORT*\n\n${emoji} *${p.name}*\n${'━'.repeat(20)}\n\n`;
  msg += `📅 *Schedule:*\n• Day: ${p.dayName}\n• Time: ${p.timeDisplay}\n• Duration: ${p.durationDisplay}\n`;
  msg += `• Status: ${p.enabled ? 'Active ✅' : 'Disabled 🚫'}\n\n`;
  msg += `👥 *Current RSVPs:*\n• Attending: ${p.rsvps.attending.length}\n• Not Attending: ${p.rsvps.notAttending.length}\n\n`;
  if (p.stats.timesRun > 0) {
    msg += `📈 *Performance:*\n• Times Run: ${p.stats.timesRun}\n• Total Attendees: ${p.stats.totalAttendees}\n`;
    msg += `• Avg Attendance: ${Math.round(p.stats.avgAttendance)}\n\n`;
  }
  msg += `🆔 ID: ${p.id}\n📅 Created: ${moment(p.createdAt).format('MMM DD, YYYY')}`;
  return msg;
}

// ── Scheduled task implementations ────────────────────────────────────────────
async function sendDailyReminders(sock: any): Promise<void> {
  const all = await db.getAll() as Record<string, Scheduler>;
  const today    = moment().tz(TIMEZONE);
  const todayStr = today.format('YYYY-MM-DD');

  for (const s of Object.values(all)) {
    if (!s.enabled)                                continue;
    if (!s.reminderSettings?.morningReminder)      continue;
    if (s.lastDailyReminder === todayStr)          continue;

    const programs = todaysPrograms(s.programs);
    if (!programs.length) continue;

    let msg = `🌅 *Good Morning!*\n\n📅 *Today's Programs (${today.format('dddd, MMM Do')})*\n\n`;
    programs.forEach((p, i) => {
      const emoji = getProgramEmoji(p.name);
      const rsvps = p.rsvps.attending.length;
      msg += `${i+1}. ${emoji} *${p.name}*\n   ⏰ ${p.timeDisplay} (${p.durationDisplay})\n`;
      if (rsvps > 0) msg += `   👥 ${rsvps} attending\n`;
      msg += '\n';
    });
    msg += `💡 RSVP with: .attend [program name]\n📢 Reminders will fire before each program!\n${'━'.repeat(20)}`;

    try {
      await sock.sendMessage(s.groupId, { text: msg });
      s.lastDailyReminder = todayStr;
      await saveScheduler(s);
    } catch (e: any) {
      console.error(`[SCHEDULER] Daily reminder failed for ${s.groupId}:`, e.message);
    }
  }
}

async function sendTomorrowReminders(sock: any): Promise<void> {
  const all      = await db.getAll() as Record<string, Scheduler>;
  const today    = moment().tz(TIMEZONE);
  const tomorrow = today.clone().add(1, 'day');
  const todayStr = today.format('YYYY-MM-DD');

  for (const s of Object.values(all)) {
    if (!s.enabled)                           continue;
    if (!s.reminderSettings?.tomorrowPreview) continue;
    if (s.lastTomorrowReminder === todayStr)  continue;

    const programs = tomorrowsPrograms(s.programs);
    if (!programs.length) continue;

    let msg = `🌙 *Tomorrow's Preview*\n\n📅 *${tomorrow.format('dddd, MMM Do')}*\n\n`;
    programs.forEach((p, i) => {
      msg += `${i+1}. ${getProgramEmoji(p.name)} *${p.name}*\n   ⏰ ${p.timeDisplay} (${p.durationDisplay})\n\n`;
    });
    msg += `✨ Get ready for an exciting day ahead!\n💡 RSVP early: .attend [program name]\n${'━'.repeat(20)}`;

    try {
      await sock.sendMessage(s.groupId, { text: msg });
      s.lastTomorrowReminder = todayStr;
      await saveScheduler(s);
    } catch (e: any) {
      console.error(`[SCHEDULER] Tomorrow reminder failed for ${s.groupId}:`, e.message);
    }
  }
}

async function checkTwoHourReminders(sock: any): Promise<void> {
  const all = await db.getAll() as Record<string, Scheduler>;
  const now = moment().tz(TIMEZONE);

  for (const s of Object.values(all)) {
    if (!s.enabled)                            continue;
    if (!s.reminderSettings?.twoHourReminder) continue;

    for (const p of todaysPrograms(s.programs)) {
      if (!shouldSendTwoHourReminder(p)) continue;

      const key = `2hr_${s.groupId}_${p.id}_${now.format('YYYY-MM-DD')}`;
      if (sentNotifications.has(key)) continue;

      const rsvps = p.rsvps.attending.length;
      let msg = `⏰ *REMINDER ALERT* ⏰\n\n${getProgramEmoji(p.name)} *${p.name}* starts in ${DEFAULT_REMINDER_HRS} hours!\n\n`;
      msg += `🕐 Time: *${p.timeDisplay}*\n⏱️ Duration: ${p.durationDisplay}\n`;
      if (rsvps > 0) msg += `👥 ${rsvps} people attending\n`;
      msg += `\n📍 Don't miss it! 🔥\n💡 RSVP: .attend ${p.name}\n${'━'.repeat(20)}`;

      try {
        await sock.sendMessage(s.groupId, { text: msg });
        sentNotifications.set(key, Date.now());
      } catch (e: any) {
        console.error(`[SCHEDULER] 2hr reminder failed:`, e.message);
      }
    }
  }

  // Prune stale entries
  const oneDayAgo = Date.now() - 86_400_000;
  for (const [k, ts] of sentNotifications) {
    if (ts < oneDayAgo) sentNotifications.delete(k);
  }
}

async function checkLiveNotifications(sock: any): Promise<void> {
  const all = await db.getAll() as Record<string, Scheduler>;
  const now = moment().tz(TIMEZONE);

  for (const s of Object.values(all)) {
    if (!s.enabled) continue;

    for (const p of todaysPrograms(s.programs)) {
      // Start notification
      if (s.reminderSettings?.startNotification && shouldStartNow(p)) {
        const key = `start_${s.groupId}_${p.id}_${now.format('YYYY-MM-DD')}`;
        if (!sentNotifications.has(key)) {
          const emoji     = getProgramEmoji(p.name);
          const attendees = p.rsvps.attending;
          let msg = `🔴 *LIVE NOW* 🔴\n\n${emoji} *${p.name}* is starting!\n\n`;
          msg += `⏰ Time: ${p.timeDisplay}\n⏱️ Duration: ${p.durationDisplay}\n`;
          if (attendees.length) {
            msg += `\n👥 *Confirmed Attendees (${attendees.length}):*\n`;
            msg += attendees.slice(0, 5).map(id => `@${id.split('@')[0]}`).join(', ');
            if (attendees.length > 5) msg += ` and ${attendees.length - 5} others`;
          }
          msg += `\n\n📍 Join the discussion now! 🔥\n${'━'.repeat(20)}`;
          try {
            await sock.sendMessage(s.groupId, { text: msg, mentions: attendees });
            sentNotifications.set(key, Date.now());
          } catch (e: any) { console.error(`[SCHEDULER] Start notification failed:`, e.message); }
        }
      }

      // End notification
      if (s.reminderSettings?.endNotification && shouldEndNow(p)) {
        const key = `end_${s.groupId}_${p.id}_${now.format('YYYY-MM-DD')}`;
        if (!sentNotifications.has(key)) {
          const count = p.rsvps.attending.length;
          let msg = `🟢 *PROGRAM ENDED* 🟢\n\nThat's all for today's ${getProgramEmoji(p.name)} *${p.name}*!\n\n`;
          if (count > 0) msg += `👏 Thanks to our ${count} participant${count > 1 ? 's' : ''}!\n`;
          msg += `\n✨ See you next ${p.dayName}!\n${'━'.repeat(20)}`;
          try {
            await sock.sendMessage(s.groupId, { text: msg });
            sentNotifications.set(key, Date.now());
            await clearProgramRSVPs(s.groupId, p.id);
          } catch (e: any) { console.error(`[SCHEDULER] End notification failed:`, e.message); }
        }
      }
    }
  }
}

// ── Permission helper ─────────────────────────────────────────────────────────
async function canManageSchedule(sock: any, chatId: string, senderId: string, senderIsOwnerOrSudo: boolean): Promise<boolean> {
  if (senderIsOwnerOrSudo) return true;
  const { isSenderAdmin } = await isAdmin(sock, chatId, senderId);
  return isSenderAdmin;
}

// ── Schedules — managed by pluginLoader.start() ───────────────────────────────
export const schedules = [
  {
    at: '08:00',
    handler: async (sock: any) => {
      await sendDailyReminders(sock).catch((e: any) =>
        console.error('[SCHEDULER] sendDailyReminders error:', e.message)
      );
    },
  },
  {
    at: '22:00',
    handler: async (sock: any) => {
      await sendTomorrowReminders(sock).catch((e: any) =>
        console.error('[SCHEDULER] sendTomorrowReminders error:', e.message)
      );
    },
  },
  {
    every: 5 * 60_000,
    handler: async (sock: any) => {
      await checkTwoHourReminders(sock).catch((e: any) =>
        console.error('[SCHEDULER] checkTwoHourReminders error:', e.message)
      );
    },
  },
  {
    every: 60_000,
    handler: async (sock: any) => {
      await checkLiveNotifications(sock).catch((e: any) =>
        console.error('[SCHEDULER] checkLiveNotifications error:', e.message)
      );
    },
  },
];

// ── Plugin export ─────────────────────────────────────────────────────────────
export default {
  command: 'program',
  aliases: [
    'event', 'programs', 'program-list',
    'today', 'todayprogram',
    'attend', 'rsvp', 'join',
    'cantmake', 'skip', 'absent',
    'attendees', 'rsvps', 'going',
  ],
  category: 'group',
  description: 'Group activity scheduler with RSVP, analytics, and automated reminders',
  usage: '.program add [name] | [day] | [time] | [duration]',
  groupOnly: true,
  cooldown: 2,
  schedules,

  // ── Main handler ──────────────────────────────────────────────────────────
  async handler(sock: any, message: any, args: any[], context: any = {}) {
    const {
      chatId,
      senderId,
      senderIsOwnerOrSudo,
      channelInfo,
    } = context;

    const reply = (text: string) =>
      sock.sendMessage(chatId, { text, ...channelInfo }, { quoted: message });

    // Determine which command alias was used
    const prefixes   = ['.','/','!','#'];
    const rawWord    = (message.message?.conversation || message.message?.extendedTextMessage?.text || '').trim();
    const usedPrefix = prefixes.find(p => rawWord.startsWith(p)) || '.';
    const usedCmd    = rawWord.slice(usedPrefix.length).trim().split(/\s+/)[0].toLowerCase();

    // ── .programs / .schedule-list ─────────────────────────────────────────
    if (['programs','program-list'].includes(usedCmd)) {
      const s = await getScheduler(chatId);
      return reply(buildProgramList(s.programs));
    }

    // ── .today ─────────────────────────────────────────────────────────────
    if (['today','todayprogram'].includes(usedCmd)) {
      const s        = await getScheduler(chatId);
      const today    = moment().tz(TIMEZONE);
      const programs = todaysPrograms(s.programs);
      if (!programs.length) {
        return reply(`📅 *Today's Schedule*\n\n${today.format('dddd, MMMM Do')}\n\nNo programs today. Enjoy your free day! 🌟`);
      }
      let msg = `📅 *Today's Schedule*\n\n${today.format('dddd, MMMM Do')}\n\n`;
      programs.forEach((p, i) => {
        const rsvps = p.rsvps.attending.length;
        msg += `${i+1}. ${getProgramEmoji(p.name)} *${p.name}*\n   ⏰ ${p.timeDisplay} (${p.durationDisplay})\n`;
        if (rsvps > 0) msg += `   👥 ${rsvps} attending\n`;
        msg += '\n';
      });
      msg += `💡 RSVP: .attend [program name]`;
      return reply(msg);
    }

    // ── .attend / .rsvp / .join ────────────────────────────────────────────
    if (['attend','rsvp','join'].includes(usedCmd)) {
      const programName = args.join(' ');
      if (!programName) return reply('⚠️ Specify a program name.\n\nExample: .attend Food\'s Corner');
      const p = await rsvpToProgram(chatId, senderId, programName, true);
      if (!p) return reply('❌ Program not found! Use `.programs` to see all programs.');
      return reply(`✅ *RSVP Confirmed!*\n\n${getProgramEmoji(p.name)} ${p.name}\n⏰ ${p.timeDisplay}\n👥 ${p.rsvps.attending.length} attending`);
    }

    // ── .cantmake / .skip / .absent ────────────────────────────────────────
    if (['cantmake','skip','absent'].includes(usedCmd)) {
      const programName = args.join(' ');
      if (!programName) return reply('⚠️ Specify a program name.');
      const p = await rsvpToProgram(chatId, senderId, programName, false);
      if (!p) return reply('❌ Program not found!');
      return reply(`📝 *Noted*\n\n${getProgramEmoji(p.name)} ${p.name}\nYou've been marked as unable to attend.`);
    }

    // ── .attendees / .rsvps / .going ───────────────────────────────────────
    if (['attendees','rsvps','going'].includes(usedCmd)) {
      const programName = args.join(' ');
      if (!programName) return reply('⚠️ Specify a program name.\n\nExample: .attendees Food\'s Corner');
      const s = await getScheduler(chatId);
      const p = s.programs.find(p => p.id === programName || p.name.toLowerCase() === programName.toLowerCase());
      if (!p) return reply('❌ Program not found!');

      const { attending, notAttending } = p.rsvps;
      let msg = `👥 *RSVP LIST*\n\n${getProgramEmoji(p.name)} *${p.name}*\n⏰ ${p.dayName} at ${p.timeDisplay}\n\n`;
      if (attending.length) {
        msg += `✅ *Attending (${attending.length}):*\n`;
        attending.forEach((id, i) => { msg += `${i+1}. @${id.split('@')[0]}\n`; });
      } else {
        msg += `✅ *Attending:* None yet\n`;
      }
      if (notAttending.length) {
        msg += `\n❌ *Can't Make It (${notAttending.length}):*\n`;
        notAttending.forEach((id, i) => { msg += `${i+1}. @${id.split('@')[0]}\n`; });
      }
      msg += `\n💡 RSVP: .attend ${p.name}`;
      return sock.sendMessage(chatId, { text: msg, mentions: [...attending, ...notAttending], ...channelInfo }, { quoted: message });
    }

    // ── .schedule (admin management) ──────────────────────────────────────
    const isManager = await canManageSchedule(sock, chatId, senderId, senderIsOwnerOrSudo);

    if (!args.length) {
      // Show help or basic program list depending on who's asking
      if (!isManager) {
        const s = await getScheduler(chatId);
        return reply(buildProgramList(s.programs));
      }
      return reply(
        `📅 *Schedule Management*\n\n` +
        `*Add:*\n.schedule add [name] | [day] | [time] | [duration]\n` +
        `_e.g. .schedule add Food's Corner | Friday | 5 PM | 2h_\n\n` +
        `*Remove:*\n.schedule remove [id or name]\n\n` +
        `*Toggle:*\n.schedule toggle [id or name]\n\n` +
        `*Analytics:*\n.schedule stats\n.schedule report [program]\n\n` +
        `*Reminder settings:*\n.schedule settings\n.schedule settings [type] on/off\n` +
        `_Types: morning, tomorrow, 2hour, start, end_\n\n` +
        `*Enable/Disable scheduler:*\n.schedule on | .schedule off`
      );
    }

    if (!isManager) return reply('🚫 *Admin Only*\n\nOnly admins can manage the schedule.');

    const action = args[0].toLowerCase();

    // add
    if (action === 'add') {
      const parts = args.slice(1).join(' ').split('|').map(p => p.trim());
      if (parts.length < 3) {
        return reply('⚠️ Format: .schedule add [name] | [day] | [time] | [duration]\n\nExample: .schedule add Food\'s Corner | Friday | 5 PM | 2h');
      }
      const [name, dayInput, timeInput, durationInput] = parts;
      if (!name)                      return reply('❌ Program name is required!');
      const day = parseDay(dayInput);
      if (day === null)                return reply('❌ Invalid day! Use: Monday, Tuesday... Sunday');
      const time = parseTime(timeInput);
      if (!time)                       return reply('❌ Invalid time! Examples: 5 PM, 17:00, 5pm');
      const duration = parseDuration(durationInput);

      const result = await addProgram(chatId, name, day, time, duration) as any;
      if (result.error === 'duplicate') return reply(`❌ *Duplicate*\n\n"${result.existing.name}" is already scheduled.`);
      if (!result.success)             return reply('❌ Failed to add program. Please try again.');

      const { program: p } = result;
      return reply(
        `✅ *Program Added!*\n\n${getProgramEmoji(p.name)} *${p.name}*\n` +
        `📅 Day: ${p.dayName}\n⏰ Time: ${p.timeDisplay}\n⏱️ Duration: ${p.durationDisplay}\n` +
        `🆔 ID: ${p.id}\n\n🔔 Automated reminders are now active!`
      );
    }

    // remove / delete
    if (['remove','delete'].includes(action)) {
      const identifier = args.slice(1).join(' ');
      if (!identifier) return reply('⚠️ Specify a program ID or name.\n\nExample: .schedule remove Food\'s Corner');
      const removed = await removeProgram(chatId, identifier);
      if (!removed) return reply('❌ Program not found! Use `.programs` to see all.');
      return reply(`✅ *Program Removed*\n\n${getProgramEmoji(removed.name)} ${removed.name} has been removed.`);
    }

    // toggle
    if (action === 'toggle') {
      const identifier = args.slice(1).join(' ');
      if (!identifier) return reply('⚠️ Specify a program ID or name.');
      const p = await toggleProgram(chatId, identifier);
      if (!p) return reply('❌ Program not found!');
      return reply(`${p.enabled ? '✅' : '🚫'} *Program ${p.enabled ? 'Enabled' : 'Disabled'}*\n\n${getProgramEmoji(p.name)} ${p.name}`);
    }

    // stats / analytics
    if (['stats','analytics'].includes(action)) {
      const s = await getScheduler(chatId);
      return reply(buildAnalytics(s));
    }

    // report
    if (action === 'report') {
      const identifier = args.slice(1).join(' ');
      if (!identifier) return reply('⚠️ Specify a program name or ID.\n\nExample: .schedule report Food\'s Corner');
      const s = await getScheduler(chatId);
      const p = s.programs.find(p => p.id === identifier || p.name.toLowerCase() === identifier.toLowerCase());
      if (!p) return reply('❌ Program not found!');
      return reply(buildProgramReport(p));
    }

    // settings
    if (action === 'settings') {
      const s = await getScheduler(chatId);
      const rs = s.reminderSettings;

      if (args.length === 1) {
        return reply(
          `⚙️ *REMINDER SETTINGS*\n\n` +
          `🌅 Morning Reminder (8 AM): ${rs.morningReminder ? '✅' : '❌'}\n` +
          `🌙 Tomorrow Preview (10 PM): ${rs.tomorrowPreview ? '✅' : '❌'}\n` +
          `⏰ 2-Hour Reminder: ${rs.twoHourReminder ? '✅' : '❌'}\n` +
          `🟢 Start Notification: ${rs.startNotification ? '✅' : '❌'}\n` +
          `🔴 End Notification: ${rs.endNotification ? '✅' : '❌'}\n\n` +
          `💡 Toggle: .schedule settings [type] on/off\n` +
          `Types: morning, tomorrow, 2hour, start, end`
        );
      }

      const typeMap: Record<string, keyof ReminderSettings> = {
        morning: 'morningReminder', tomorrow: 'tomorrowPreview',
        '2hour': 'twoHourReminder', twohour: 'twoHourReminder',
        start:   'startNotification', end: 'endNotification',
      };
      const settingType = args[1]?.toLowerCase();
      const toggle      = args[2]?.toLowerCase();
      const settingKey  = typeMap[settingType];

      if (!settingKey)                      return reply('❌ Invalid type. Use: morning, tomorrow, 2hour, start, end');
      if (!toggle || !['on','off'].includes(toggle)) return reply('⚠️ Usage: .schedule settings [type] on/off');

      s.reminderSettings[settingKey] = toggle === 'on';
      await saveScheduler(s);
      return reply(`✅ *${settingType}* ${toggle === 'on' ? 'enabled' : 'disabled'}`);
    }

    // on / off
    if (['on','enable'].includes(action)) {
      const s = await getScheduler(chatId);
      s.enabled = true;
      await saveScheduler(s);
      return reply('✅ *Scheduler Enabled*\n\nAutomated reminders are now active!');
    }

    if (['off','disable'].includes(action)) {
      const s = await getScheduler(chatId);
      s.enabled = false;
      await saveScheduler(s);
      return reply('🚫 *Scheduler Disabled*\n\nAutomated reminders are now paused.');
    }

    return reply('❓ Unknown action. Use `.schedule` for help.');
  },
};