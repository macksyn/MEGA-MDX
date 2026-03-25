// plugins/birthday.ts

import cron   from 'node-cron';
import moment from 'moment-timezone';

import { printLog }    from '../lib/print.js';
import isOwnerOrSudo   from '../lib/isOwner.js';
import isAdmin         from '../lib/isAdmin.js';
import { createStore } from '../lib/pluginStore.js';
import bus             from '../lib/pluginBus.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const TIMEZONE = 'Africa/Lagos';

const DEFAULT_SETTINGS = {
  enableReminders:        true,
  enableAutoWishes:       true,
  reminderDays:           [7, 3, 1],
  reminderTime:           '09:00',
  wishTime:               '00:01',
  enableGroupReminders:   true,
  enablePrivateReminders: true,
  reminderGroups:         [] as string[],
  adminNumbers:           [] as string[],
};

const MONTH_NAMES = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const MONTH_MAP: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7,
  aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface BirthdaySettings {
  enableReminders:        boolean;
  enableAutoWishes:       boolean;
  reminderDays:           number[];
  reminderTime:           string;
  wishTime:               string;
  enableGroupReminders:   boolean;
  enablePrivateReminders: boolean;
  reminderGroups:         string[];
  adminNumbers:           string[];
  loaded?:                boolean;
}

interface ParsedBirthday {
  day:         number;
  month:       number;
  year:        number | null;
  monthName:   string;
  displayDate: string;
  searchKey:   string;
  age:         number | null;
}

interface BirthdayDoc {
  userId:            string;
  name:              string;
  birthday:          ParsedBirthday;
  lastUpdated:       string;
  updateHistory:     any[];
  birthdayImageUrl?: string;
  imageSetAt?:       string;
}

// ── Storage ───────────────────────────────────────────────────────────────────

const db             = createStore('birthdays');
const dbBirthdays    = db;
const dbSettings     = db.table!('settings');
const dbWishesLog    = db.table!('wishes_log');
const dbRemindersLog = db.table!('reminders_log');
const dbAdminGroup   = db.table!('admin_group');

// ── State ─────────────────────────────────────────────────────────────────────

let birthdaySettings: BirthdaySettings = { ...DEFAULT_SETTINGS, loaded: false };
let schedulerStarted      = false;
let busListenerRegistered = false;

// Mutable socket reference — cron closures always use the live socket
// so reconnects don't leave jobs holding a dead connection.
let currentSock: any = null;

const cronJobs             = new Map<string, any>();
const lastSchedulerRun: Record<string, boolean> = {};

// ── Settings persistence ──────────────────────────────────────────────────────

async function loadSettings(): Promise<void> {
  try {
    const saved = await dbSettings.get('config');
    if (saved) {
      birthdaySettings = { ...DEFAULT_SETTINGS, ...saved, loaded: true };
    } else {
      birthdaySettings = { ...DEFAULT_SETTINGS, loaded: true };
    }
  } catch (e: any) {
    printLog('error', `[BIRTHDAY] loadSettings error: ${e.message}`);
    birthdaySettings = { ...DEFAULT_SETTINGS, loaded: true };
  }
}

async function saveSettings(): Promise<void> {
  try {
    const toSave = { ...birthdaySettings };
    delete toSave.loaded;
    await dbSettings.set('config', toSave);
  } catch (e: any) {
    printLog('error', `[BIRTHDAY] saveSettings error: ${e.message}`);
  }
}

// ── Admin group helpers ───────────────────────────────────────────────────────

async function getAdminGroupId(): Promise<string | null> {
  try {
    const record = await dbAdminGroup.get('config');
    return (record as any)?.groupId || null;
  } catch (e: any) {
    printLog('error', `[BIRTHDAY] getAdminGroupId error: ${e.message}`);
    return null;
  }
}

async function setAdminGroupId(groupId: string): Promise<void> {
  try {
    await dbAdminGroup.set('config', { groupId, setAt: new Date().toISOString() });
    printLog('success', `[BIRTHDAY] Admin hub registered: ${groupId.split('@')[0]}`);
  } catch (e: any) {
    printLog('error', `[BIRTHDAY] setAdminGroupId error: ${e.message}`);
  }
}

async function isFromAdminGroup(chatId: string): Promise<boolean> {
  const adminGroupId = await getAdminGroupId();
  if (!adminGroupId) return false;
  return chatId === adminGroupId;
}

// ── Birthday CRUD ─────────────────────────────────────────────────────────────

async function getAllBirthdays(): Promise<Record<string, BirthdayDoc>> {
  try {
    return await dbBirthdays.getAll();
  } catch (e: any) {
    printLog('error', `[BIRTHDAY] getAllBirthdays error: ${e.message}`);
    return {};
  }
}

async function getBirthdayData(userId: string): Promise<BirthdayDoc | null> {
  try {
    return await dbBirthdays.get(userId);
  } catch (e: any) {
    printLog('error', `[BIRTHDAY] getBirthdayData error: ${e.message}`);
    return null;
  }
}

async function saveBirthdayData(
  userId: string,
  name: string,
  dobStringOrParsed: string | ParsedBirthday
): Promise<boolean> {
  try {
    let parsed: ParsedBirthday | null;
    if (typeof dobStringOrParsed === 'string') {
      parsed = parseDOB(dobStringOrParsed);
    } else {
      parsed = dobStringOrParsed;
    }

    if (!parsed) {
      printLog('warning', `[BIRTHDAY] Could not parse DOB for ${name}`);
      return false;
    }

    const now      = new Date().toISOString();
    const existing = await dbBirthdays.get(userId) as BirthdayDoc | null;

    let historyEntry: any;
    if (!existing) {
      historyEntry = { type: 'initial', name, birthday: parsed, timestamp: now };
    } else {
      const prevBirthday = existing.birthday || {} as any;
      const dateChanged  = prevBirthday.searchKey !== parsed.searchKey;
      historyEntry = {
        type:             dateChanged ? 'birthday_change' : 'name_update',
        previousName:     existing.name,
        previousBirthday: prevBirthday,
        newName:          name,
        newBirthday:      parsed,
        timestamp:        now
      };
    }

    const updateHistory = existing?.updateHistory
      ? [...existing.updateHistory, historyEntry]
      : [historyEntry];

    const doc: BirthdayDoc = {
      userId,
      name,
      birthday:      parsed,
      lastUpdated:   now,
      updateHistory,
      // Preserve existing photo if set — updating name/dob must not wipe it
      ...(existing?.birthdayImageUrl ? { birthdayImageUrl: existing.birthdayImageUrl } : {}),
      ...(existing?.imageSetAt       ? { imageSetAt:       existing.imageSetAt       } : {}),
    };

    await dbBirthdays.set(userId, doc);

    const action = !existing
      ? 'Created'
      : historyEntry.type === 'birthday_change' ? 'Date changed' : 'Updated';
    printLog('success', `[BIRTHDAY] 🎂 ${action} birthday for ${name} (${parsed.displayDate})`);
    return true;
  } catch (e: any) {
    printLog('error', `[BIRTHDAY] saveBirthdayData error: ${e.message}`);
    return false;
  }
}

// ── Photo helpers ─────────────────────────────────────────────────────────────

async function findByPhone(phone: string): Promise<BirthdayDoc | null> {
  try {
    const clean = phone.replace(/\D/g, '');
    if (!clean) return null;
    const birthdays = await getAllBirthdays();
    const entry = Object.values(birthdays).find(b =>
      b.userId.replace('@s.whatsapp.net', '').replace(/\D/g, '') === clean
    );
    return entry || null;
  } catch (e: any) {
    printLog('error', `[BIRTHDAY] findByPhone error: ${e.message}`);
    return null;
  }
}

async function setPhoto(userId: string, url: string): Promise<boolean> {
  try {
    const existing = await dbBirthdays.get(userId) as BirthdayDoc | null;
    if (!existing) return false;
    await dbBirthdays.set(userId, {
      ...existing,
      birthdayImageUrl: url,
      imageSetAt:       new Date().toISOString()
    });
    printLog('success', `[BIRTHDAY] 🖼️ Photo saved for ${existing.name}`);
    return true;
  } catch (e: any) {
    printLog('error', `[BIRTHDAY] setPhoto error: ${e.message}`);
    return false;
  }
}

async function removePhoto(userId: string): Promise<boolean> {
  try {
    const existing = await dbBirthdays.get(userId) as BirthdayDoc | null;
    if (!existing) return false;
    const updated: BirthdayDoc = { ...existing };
    delete updated.birthdayImageUrl;
    delete updated.imageSetAt;
    await dbBirthdays.set(userId, updated);
    printLog('success', `[BIRTHDAY] 🗑️ Photo removed for ${existing.name}`);
    return true;
  } catch (e: any) {
    printLog('error', `[BIRTHDAY] removePhoto error: ${e.message}`);
    return false;
  }
}

// ── Query helpers ─────────────────────────────────────────────────────────────

async function getTodaysBirthdays(): Promise<BirthdayDoc[]> {
  try {
    const now       = moment.tz(TIMEZONE);
    const searchKey = `${String(now.month() + 1).padStart(2, '0')}-${String(now.date()).padStart(2, '0')}`;
    const birthdays = await getAllBirthdays();
    return Object.values(birthdays).filter(b => b.birthday?.searchKey === searchKey);
  } catch {
    return [];
  }
}

// Exact-day match — used by the reminder/wish scheduler.
async function getUpcomingBirthdays(daysAhead: number): Promise<BirthdayDoc[]> {
  try {
    const target    = moment.tz(TIMEZONE).add(daysAhead, 'days');
    const searchKey = `${String(target.month() + 1).padStart(2, '0')}-${String(target.date()).padStart(2, '0')}`;
    const birthdays = await getAllBirthdays();
    return Object.values(birthdays).filter(b => b.birthday?.searchKey === searchKey);
  } catch {
    return [];
  }
}

// Range-based count — used by status display so numbers match .birthday upcoming.
function countBirthdaysWithinDays(allBdays: Record<string, BirthdayDoc>, days: number): number {
  const now = moment.tz(TIMEZONE);
  return Object.values(allBdays).filter(entry => {
    const b        = entry.birthday;
    const nextBday = moment.tz({ year: now.year(), month: b.month - 1, date: b.day }, TIMEZONE);
    if (nextBday.isBefore(now, 'day')) nextBday.add(1, 'year');
    const daysUntil = nextBday.diff(now, 'days');
    return daysUntil >= 0 && daysUntil <= days;
  }).length;
}

function countBirthdaysExactDay(allBdays: Record<string, BirthdayDoc>, daysAhead: number): number {
  const now = moment.tz(TIMEZONE);
  return Object.values(allBdays).filter(entry => {
    const b        = entry.birthday;
    const nextBday = moment.tz({ year: now.year(), month: b.month - 1, date: b.day }, TIMEZONE);
    if (nextBday.isBefore(now, 'day')) nextBday.add(1, 'year');
    return nextBday.diff(now, 'days') === daysAhead;
  }).length;
}

// ── Wish / reminder log helpers ───────────────────────────────────────────────

async function hasWishedToday(userId: string): Promise<boolean> {
  try {
    const today = moment.tz(TIMEZONE).format('YYYY-MM-DD');
    const log   = await dbWishesLog.get('log') || {};
    return !!((log as any)[today]?.[userId]);
  } catch {
    return false;
  }
}

async function markWishedToday(userId: string, name: string, successfulSends: number): Promise<void> {
  try {
    const today  = moment.tz(TIMEZONE).format('YYYY-MM-DD');
    const log    = (await dbWishesLog.get('log') || {}) as any;
    if (!log[today]) log[today] = {};
    log[today][userId] = { name, timestamp: new Date().toISOString(), successfulSends };
    await dbWishesLog.set('log', log);
  } catch {}
}

async function hasReminderSent(reminderKey: string): Promise<boolean> {
  try {
    const log = (await dbRemindersLog.get('log') || {}) as any;
    return !!log[reminderKey];
  } catch {
    return false;
  }
}

async function markReminderSent(reminderKey: string, userId: string, daysAhead: number): Promise<void> {
  try {
    const log        = (await dbRemindersLog.get('log') || {}) as any;
    log[reminderKey] = { userId, daysAhead, timestamp: new Date().toISOString() };
    await dbRemindersLog.set('log', log);
  } catch {}
}

async function runCleanup(): Promise<void> {
  try {
    const cutoff = moment.tz(TIMEZONE).subtract(365, 'days');

    const wishLog    = (await dbWishesLog.get('log') || {}) as any;
    let wishCleaned  = 0;
    for (const date of Object.keys(wishLog)) {
      if (moment.tz(date, TIMEZONE).isBefore(cutoff)) {
        delete wishLog[date];
        wishCleaned++;
      }
    }
    if (wishCleaned > 0) await dbWishesLog.set('log', wishLog);

    const remLog    = (await dbRemindersLog.get('log') || {}) as any;
    let remCleaned  = 0;
    for (const key of Object.keys(remLog)) {
      const dateMatch = key.match(/^(\d{4}-\d{2}-\d{2})/);
      if (dateMatch && moment.tz(dateMatch[1], TIMEZONE).isBefore(cutoff)) {
        delete remLog[key];
        remCleaned++;
      }
    }
    if (remCleaned > 0) await dbRemindersLog.set('log', remLog);

    printLog('info', `[BIRTHDAY] Cleanup done — wishes: ${wishCleaned}, reminders: ${remCleaned}`);
  } catch (e: any) {
    printLog('error', `[BIRTHDAY] Cleanup error: ${e.message}`);
  }
}

// ── DOB parsing ───────────────────────────────────────────────────────────────

function parseDOB(dobString: string): ParsedBirthday | null {
  if (!dobString || typeof dobString !== 'string') return null;
  const clean = dobString.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
  let day: number | undefined, month: number | undefined, year: number | null = null;

  const verboseMatch = clean.match(/([a-zA-Z]+)\s+(\d{1,2})(?:[,\s]+(\d{4}))?/);
  if (verboseMatch) {
    const monthKey = verboseMatch[1].toLowerCase();
    month = MONTH_MAP[monthKey];
    day   = parseInt(verboseMatch[2]);
    year  = verboseMatch[3] ? parseInt(verboseMatch[3]) : null;
  }

  if (!month) {
    const numericMatch = clean.match(/(\d{1,4})[\/\-\.](\d{1,2})(?:[\/\-\.](\d{1,4}))?/);
    if (numericMatch) {
      const a = parseInt(numericMatch[1]);
      const b = parseInt(numericMatch[2]);
      const c = numericMatch[3] ? parseInt(numericMatch[3]) : null;
      if      (a > 31)      { year = a; month = b; day = c ?? undefined; }
      else if (c && c > 31) { day = a; month = b; year = c; }
      else if (!c)          { day = a; month = b; year = null; }
      else                  { day = a; month = b; year = c < 100 ? 2000 + c : c; }
    }
  }

  if (!month || !day || month < 1 || month > 12 || day < 1 || day > 31) return null;

  const searchKey   = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const displayDate = `${MONTH_NAMES[month]} ${day}${year ? ', ' + year : ''}`;

  let age: number | null = null;
  if (year) {
    const now = moment.tz(TIMEZONE);
    age = now.year() - year;
    if (now.month() + 1 < month || (now.month() + 1 === month && now.date() < day)) age--;
  }

  return { day, month, year, monthName: MONTH_NAMES[month], displayDate, searchKey, age };
}

// ── Message templates ─────────────────────────────────────────────────────────

function getBirthdayWishMessage(person: BirthdayDoc): string {
  const tag    = `@${person.userId.split('@')[0]}`;
  const wishes = [
    `🎉🎂 HAPPY BIRTHDAY ${tag}! 🎂🎉\n\nWishing you a day filled with happiness and a year filled with joy! 🎈✨`,
    `🎊 Happy Birthday to our amazing friend ${tag}! 🎊\n\nMay your special day be surrounded with happiness, filled with laughter! 🎨🎁`,
    `🌟 It's ${tag}'s Birthday! 🌟\n\n🎂 Another year older, another year wiser, another year more awesome!\nMay all your dreams come true! ✨🎉`,
    `🎈 BIRTHDAY ALERT! 🎈\n\nIt's ${tag}'s special day! 🎂\nLet's celebrate this wonderful person who brings joy to our group! 🎊🎉`,
    `🎵 Happy Birthday to you! 🎵\n🎵 Happy Birthday dear ${tag}! 🎵\n\n🎂 Hope your day is as special as you are! 🌟`,
  ];
  let msg = wishes[Math.floor(Math.random() * wishes.length)];
  if (person.birthday?.age != null) msg += `\n\n🎈 Celebrating ${person.birthday.age + 1} wonderful years! 🎈`;
  msg += `\n\n👏 From all of us at GIST HQ! 👏`;
  return msg;
}

function getReminderMessage(person: BirthdayDoc, daysUntil: number): string {
  const tag = `@${person.userId.split('@')[0]}`;
  let msg   = daysUntil === 1
    ? `🎂 *BIRTHDAY REMINDER* 🎂\n\n📅 Tomorrow is ${tag}'s birthday!\n\n🎁 Don't forget to wish them well! 🎉`
    : `🎂 *BIRTHDAY REMINDER* 🎂\n\n📅 ${tag}'s birthday is in *${daysUntil} days!*\n\n🗓️ Date: ${person.birthday.displayDate} 🎉`;
  if (person.birthday?.age != null) msg += `\n\n🎈 They'll be turning *${person.birthday.age + 1}*! 🎈`;
  return msg;
}

// ── Network helpers ───────────────────────────────────────────────────────────

async function safeSend(sock: any, jid: string, msgObj: any): Promise<boolean> {
  try {
    await sock.sendMessage(jid, msgObj);
    return true;
  } catch (e: any) {
    printLog('error', `[BIRTHDAY] safeSend to ${jid.split('@')[0]} failed: ${e.message}`);
    return false;
  }
}

async function getGroupParticipants(sock: any, groupId: string): Promise<string[]> {
  try {
    const meta   = await sock.groupMetadata(groupId);
    if (!meta?.participants) return [];
    const botJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
    return meta.participants.map((p: any) => p.id).filter((id: string) => id !== botJid);
  } catch {
    return [];
  }
}

// ── Scheduler tasks ───────────────────────────────────────────────────────────

async function runBirthdayWishes(sock: any): Promise<void> {
  if (!birthdaySettings.enableAutoWishes) return;
  const todaysBirthdays = await getTodaysBirthdays();
  if (todaysBirthdays.length === 0) return;

  for (const person of todaysBirthdays) {
    try {
      if (await hasWishedToday(person.userId)) continue;
      let sent = 0;

      if (birthdaySettings.enablePrivateReminders) {
        const privateWishText =
          `🎉 *HAPPY BIRTHDAY ${person.name}!* 🎉\n\n` +
          `Today is your special day! 🎂\n\n` +
          `Wishing you all the happiness in the world! ✨🎈\n\n` +
          `👏 From all of us at GIST HQ!`;

        const privateMsg: any = person.birthdayImageUrl
          ? { image: { url: person.birthdayImageUrl }, caption: privateWishText }
          : { text: privateWishText };

        const ok = await safeSend(sock, person.userId, privateMsg);
        if (ok) sent++;
        await new Promise(r => setTimeout(r, 3000));
      }

      if (birthdaySettings.enableGroupReminders && birthdaySettings.reminderGroups.length > 0) {
        const wishMsg = getBirthdayWishMessage(person);
        for (const groupId of birthdaySettings.reminderGroups) {
          const participants = await getGroupParticipants(sock, groupId);
          const mentions     = [...new Set([person.userId, ...participants])];

          const groupMsg: any = person.birthdayImageUrl
            ? { image: { url: person.birthdayImageUrl }, caption: wishMsg, mentions }
            : { text: wishMsg, mentions };

          const ok = await safeSend(sock, groupId, groupMsg);
          if (ok) sent++;
          await new Promise(r => setTimeout(r, 5000));
        }
      }

      if (sent > 0) await markWishedToday(person.userId, person.name, sent);
      await new Promise(r => setTimeout(r, 8000));
    } catch (e: any) {
      printLog('error', `[BIRTHDAY] Error processing birthday for ${person.name}: ${e.message}`);
    }
  }
}

async function runBirthdayReminders(sock: any, daysAhead: number): Promise<void> {
  if (!birthdaySettings.enableReminders) return;
  if (!birthdaySettings.reminderDays.includes(daysAhead)) return;
  const upcoming = await getUpcomingBirthdays(daysAhead);
  if (upcoming.length === 0) return;
  const today = moment.tz(TIMEZONE).format('YYYY-MM-DD');

  for (const person of upcoming) {
    const reminderKey = `${today}-${person.userId}-${daysAhead}`;
    try {
      if (await hasReminderSent(reminderKey)) continue;
      const reminderMsg = getReminderMessage(person, daysAhead);
      if (birthdaySettings.enableGroupReminders && birthdaySettings.reminderGroups.length > 0) {
        for (const groupId of birthdaySettings.reminderGroups) {
          const participants = await getGroupParticipants(sock, groupId);
          const mentions     = [...new Set([person.userId, ...participants])];
          await safeSend(sock, groupId, { text: reminderMsg, mentions });
          await new Promise(r => setTimeout(r, 3000));
        }
      }
      await markReminderSent(reminderKey, person.userId, daysAhead);
    } catch (e: any) {
      printLog('error', `[BIRTHDAY] Error sending reminder for ${person.name}: ${e.message}`);
    }
  }
}

// ── node-cron scheduler ───────────────────────────────────────────────────────

function startScheduler(sock: any): void {
  currentSock = sock; // always refresh — handles reconnects

  if (schedulerStarted) return; // register cron jobs only once
  schedulerStarted = true;

  const [wishH, wishM] = birthdaySettings.wishTime.split(':').map(Number);
  const [remH,  remM]  = birthdaySettings.reminderTime.split(':').map(Number);

  cronJobs.set('wishes', cron.schedule(
    `${wishM} ${wishH} * * *`,
    () => runBirthdayWishes(currentSock),
    { timezone: TIMEZONE }
  ));

  cronJobs.set('reminders', cron.schedule(
    `${remM} ${remH} * * *`,
    async () => {
      for (const days of birthdaySettings.reminderDays) {
        await runBirthdayReminders(currentSock, days);
      }
    },
    { timezone: TIMEZONE }
  ));

  cronJobs.set('cleanup', cron.schedule('0 2 * * 0', runCleanup, { timezone: TIMEZONE }));

  printLog('info', '[BIRTHDAY] node-cron scheduler started');
}

async function runMissedTasks(sock: any): Promise<void> {
  currentSock = sock;

  const today       = moment.tz(TIMEZONE).format('YYYY-MM-DD');
  const currentTime = moment.tz(TIMEZONE).format('HH:mm');

  if (currentTime >= birthdaySettings.wishTime && !lastSchedulerRun[`wishes_${today}`]) {
    lastSchedulerRun[`wishes_${today}`] = true;
    printLog('info', '[BIRTHDAY] Running missed wishes after restart');
    await runBirthdayWishes(sock);
  }

  for (const days of birthdaySettings.reminderDays) {
    const runKey = `reminder_${days}_${today}`;
    if (currentTime >= birthdaySettings.reminderTime && !lastSchedulerRun[runKey]) {
      lastSchedulerRun[runKey] = true;
      printLog('info', `[BIRTHDAY] Running missed ${days}-day reminders after restart`);
      await runBirthdayReminders(sock, days);
    }
  }
}

// ── onLoad ────────────────────────────────────────────────────────────────────

async function onLoad(sock: any): Promise<void> {
  await loadSettings();
  await runMissedTasks(sock);

  if (!busListenerRegistered) {
    busListenerRegistered = true;

    bus.on('attendance:birthday', async (payload: any) => {
      try {
        const { userId, name, birthdayData } = payload;
        if (!birthdayData?.displayDate) {
          printLog('warning', '[BIRTHDAY] Invalid birthday data received from attendance');
          return;
        }
        const success = await saveBirthdayData(userId, name, birthdayData.displayDate);
        if (success) {
          printLog('success', `[BIRTHDAY] 🎂 Auto-saved from attendance → ${name} (${birthdayData.displayDate})`);
        } else {
          printLog('warning', `[BIRTHDAY] Failed to save birthday from attendance for ${name}`);
        }
      } catch (err: any) {
        printLog('error', `[BIRTHDAY] Event handler error: ${err.message}`);
      }
    });

    printLog('info', '[BIRTHDAY] ✅ Now listening for attendance:birthday events');
  }

  try {
    startScheduler(sock);
    await runMissedTasks(sock);
  } catch (err: any) {
    printLog('error', `[BIRTHDAY] Scheduler failed (non-fatal): ${err.message}`);
  }
}

// ── Sub-command handlers ──────────────────────────────────────────────────────

async function showBirthdayMenu(sock: any, message: any, chatId: string, _channelInfo: any): Promise<void> {
  const adminGroupId = await getAdminGroupId();
  const isAdminHub   = chatId === adminGroupId;

  let menu =
    `🎂 *BIRTHDAY SYSTEM* 🎂\n\n` +
    `📅 *View Commands:*\n` +
    `• *.birthday today* — Today's birthdays\n` +
    `• *.birthday upcoming [days]* — Upcoming (default 7 days)\n` +
    `• *.birthday thismonth* — This month's birthdays\n` +
    `• *.birthday status* — System status\n` +
    `• *.mybirthday* — View your birthday info\n\n` +
    `👑 *Admin Commands:*\n` +
    `• *.birthday all* — View all recorded birthdays\n` +
    `• *.birthday settings* — View/change settings\n` +
    `• *.birthday groups* — Manage reminder groups\n` +
    `• *.birthday force wishes* — Force today's wishes\n` +
    `• *.birthday force reminders [days]* — Force reminders\n` +
    `• *.birthday test [@user]* — Test birthday wish\n\n`;

  if (isAdminHub) {
    menu +=
      `🔐 *Admin Hub (this group only):*\n` +
      `• *.birthday setphoto [number] [url]* — Attach birthday photo\n` +
      `• *.birthday removeimage [number]* — Remove photo\n` +
      `• *.birthday preview [number]* — Preview exact wish\n` +
      `• *.birthday listimages* — Photo status for all members\n\n`;
  }

  menu +=
    `🤖 *Auto Features:*\n` +
    `• Birthdays auto-saved from attendance forms\n` +
    `• Scheduled wishes at midnight (WAT)\n` +
    `• Advance reminders 7, 3 & 1 day(s) before\n\n` +
    `🌍 Timezone: Africa/Lagos (WAT)`;

  await sock.sendMessage(chatId, { text: menu }, { quoted: message });
}

async function handleMyBirthday(sock: any, message: any, senderId: string, chatId: string): Promise<void> {
  const data = await getBirthdayData(senderId);
  if (!data) {
    return sock.sendMessage(chatId, {
      text:
        `🎂 *No Birthday Recorded*\n\n` +
        `Your birthday hasn't been saved yet.\n\n` +
        `💡 It is saved automatically when you submit an attendance form with your D.O.B.`
    }, { quoted: message });
  }

  const b        = data.birthday;
  const now      = moment.tz(TIMEZONE);
  const nextBday = moment.tz({ year: now.year(), month: b.month - 1, date: b.day }, TIMEZONE);
  if (nextBday.isBefore(now, 'day')) nextBday.add(1, 'year');
  const daysUntil = nextBday.diff(now, 'days');

  let msg  = `🎂 *Your Birthday Information* 🎂\n\n`;
  msg     += `👤 Name: ${data.name}\n`;
  msg     += `📅 Birthday: ${b.displayDate}\n`;
  if (b.year)        msg += `📊 Year: ${b.year}\n`;
  if (b.age != null) msg += `🎈 Current Age: ${b.age} years old\n`;
  msg     += `💾 Last Updated: ${new Date(data.lastUpdated).toLocaleString('en-NG', { timeZone: TIMEZONE })}\n\n`;

  if      (daysUntil === 0) msg += `🎉 *IT'S YOUR BIRTHDAY TODAY!* 🎉\n🎊 *HAPPY BIRTHDAY!* 🎊`;
  else if (daysUntil === 1) msg += `🎂 *Your birthday is TOMORROW!* 🎂`;
  else if (daysUntil <= 7)  msg += `🗓 *Your birthday is in ${daysUntil} days!*`;
  else                      msg += `📅 Days until next birthday: *${daysUntil}*`;

  await sock.sendMessage(chatId, { text: msg }, { quoted: message });
}

async function handleToday(sock: any, message: any, chatId: string): Promise<void> {
  const list = await getTodaysBirthdays();
  if (list.length === 0) {
    return sock.sendMessage(chatId, {
      text: `🎂 *No birthdays today*\n\n📅 Check upcoming: *.birthday upcoming*`
    }, { quoted: message });
  }

  let msg = `🎉 *TODAY'S BIRTHDAYS* 🎉\n\n`;
  const mentions: string[] = [];
  list.forEach(p => {
    mentions.push(p.userId);
    msg += `🎂 @${p.userId.split('@')[0]}`;
    if (p.birthday.age != null) msg += ` *(Turning ${p.birthday.age + 1}!)*`;
    msg += '\n';
  });
  msg += `\n🎊 *Let's wish them a happy birthday!* 🎊`;
  await sock.sendMessage(chatId, { text: msg, mentions }, { quoted: message });
}

async function handleUpcoming(sock: any, message: any, chatId: string, args: string[]): Promise<void> {
  const days = args[0] ? parseInt(args[0]) : 7;
  if (isNaN(days) || days < 1 || days > 365) {
    return sock.sendMessage(chatId, { text: '⚠️ Please provide a valid number of days (1-365)' }, { quoted: message });
  }

  const birthdays = await getAllBirthdays();
  const now       = moment.tz(TIMEZONE);
  const upcoming: (BirthdayDoc & { daysUntil: number })[] = [];

  Object.values(birthdays).forEach(entry => {
    const b        = entry.birthday;
    const nextBday = moment.tz({ year: now.year(), month: b.month - 1, date: b.day }, TIMEZONE);
    if (nextBday.isBefore(now, 'day')) nextBday.add(1, 'year');
    const daysUntil = nextBday.diff(now, 'days');
    if (daysUntil >= 0 && daysUntil <= days) upcoming.push({ ...entry, daysUntil });
  });

  if (upcoming.length === 0) {
    return sock.sendMessage(chatId, { text: `📅 *No birthdays in the next ${days} days*` }, { quoted: message });
  }

  upcoming.sort((a, b) => a.daysUntil - b.daysUntil);

  let msg = `📅 *UPCOMING BIRTHDAYS (Next ${days} days)* 📅\n\n`;
  const mentions: string[] = [];

  upcoming.forEach(u => {
    mentions.push(u.userId);
    if      (u.daysUntil === 0) msg += `🎊 @${u.userId.split('@')[0]} — *TODAY!* 🎊\n`;
    else if (u.daysUntil === 1) msg += `🎂 @${u.userId.split('@')[0]} — Tomorrow\n`;
    else msg += `📌 @${u.userId.split('@')[0]} — in ${u.daysUntil} days (${u.birthday.monthName} ${u.birthday.day})\n`;
    if (u.birthday.age != null) {
      const age = u.daysUntil === 0 ? u.birthday.age : u.birthday.age + 1;
      msg += `   🎈 ${u.daysUntil === 0 ? 'Turned' : 'Turning'} ${age}\n`;
    }
  });

  await sock.sendMessage(chatId, { text: msg, mentions }, { quoted: message });
}

async function handleThisMonth(sock: any, message: any, chatId: string): Promise<void> {
  const now          = moment.tz(TIMEZONE);
  const currentMonth = now.month() + 1;
  const birthdays    = await getAllBirthdays();
  const list         = Object.values(birthdays)
    .filter(b => b.birthday.month === currentMonth)
    .sort((a, b) => a.birthday.day - b.birthday.day);
  const monthName = now.format('MMMM YYYY');

  if (list.length === 0) {
    return sock.sendMessage(chatId, { text: `📅 *No birthdays in ${monthName}*` }, { quoted: message });
  }

  let msg = `📅 *${monthName.toUpperCase()} BIRTHDAYS* 📅\n\n`;
  const mentions: string[] = [];
  list.forEach(p => {
    mentions.push(p.userId);
    msg += `🎂 @${p.userId.split('@')[0]} — ${p.birthday.monthName} ${p.birthday.day}`;
    if (p.birthday.age != null) msg += ` (${p.birthday.age} yrs)`;
    if      (p.birthday.day === now.date()) msg += ` 🎊 TODAY!`;
    else if (p.birthday.day <  now.date()) msg += ` ✅ Celebrated`;
    else msg += ` (${p.birthday.day - now.date()} days away)`;
    msg += '\n';
  });
  await sock.sendMessage(chatId, { text: msg, mentions }, { quoted: message });
}

async function handleAll(sock: any, message: any, chatId: string, senderId: string): Promise<void> {
  const isOwner = await isOwnerOrSudo(senderId, sock, chatId);
  let isSenderAdmin = false;
  if (chatId.endsWith('@g.us')) {
    try { const r = await isAdmin(sock, chatId, senderId); isSenderAdmin = r.isSenderAdmin; } catch {}
  }
  if (!isOwner && !isSenderAdmin) {
    return sock.sendMessage(chatId, { text: '🚫 Only admins can view all birthdays.' }, { quoted: message });
  }

  const birthdays = await getAllBirthdays();
  const list      = Object.values(birthdays).sort((a, b) => {
    if (a.birthday.month !== b.birthday.month) return a.birthday.month - b.birthday.month;
    return a.birthday.day - b.birthday.day;
  });

  if (list.length === 0) {
    return sock.sendMessage(chatId, { text: `🎂 *No birthdays recorded yet*` }, { quoted: message });
  }

  let msg = `🎂 *ALL BIRTHDAYS* 🎂\n\n📊 Total: *${list.length} members*\n`;
  const mentions: string[] = [];
  let currentMonth: number | null = null;

  list.forEach(p => {
    mentions.push(p.userId);
    if (currentMonth !== p.birthday.month) {
      currentMonth = p.birthday.month;
      msg += `\n📅 *${p.birthday.monthName.toUpperCase()}*\n`;
    }
    msg += `🎂 @${p.userId.split('@')[0]} — ${p.birthday.day}`;
    if (p.birthday.age != null) msg += ` (${p.birthday.age} yrs)`;
    msg += '\n';
  });

  await sock.sendMessage(chatId, { text: msg, mentions }, { quoted: message });
}

async function handleBirthdayStatus(sock: any, message: any, chatId: string): Promise<void> {
  await loadSettings();
  const allBdays = await getAllBirthdays();
  const now      = moment.tz(TIMEZONE);

  const todayKey      = `${String(now.month() + 1).padStart(2, '0')}-${String(now.date()).padStart(2, '0')}`;
  const todayCount    = Object.values(allBdays).filter(b => b.birthday?.searchKey === todayKey).length;
  const tomorrowCount = countBirthdaysExactDay(allBdays, 1);
  const next3Count    = countBirthdaysWithinDays(allBdays, 3);
  const next7Count    = countBirthdaysWithinDays(allBdays, 7);
  const withPhoto     = Object.values(allBdays).filter(b => b.birthdayImageUrl).length;
  const adminGroupId  = await getAdminGroupId();

  let msg  = `📊 *BIRTHDAY SYSTEM STATUS* 📊\n\n`;
  msg     += `⏰ Time (WAT): ${now.format('YYYY-MM-DD HH:mm:ss')}\n`;
  msg     += `🤖 Scheduler: ${schedulerStarted ? '✅ Running' : '⚠️ Not started'}\n\n`;
  msg     += `📊 *Registered:* ${Object.keys(allBdays).length}\n`;
  msg     += `• Today: ${todayCount}\n`;
  msg     += `• Tomorrow: ${tomorrowCount}\n`;
  msg     += `• Next 3 days: ${next3Count}\n`;
  msg     += `• Next 7 days: ${next7Count}\n`;
  msg     += `• With photo: ${withPhoto} 🖼️\n\n`;
  msg     += `⚙️ *Settings:*\n`;
  msg     += `• Auto Wishes: ${birthdaySettings.enableAutoWishes ? '✅' : '❌'} at ${birthdaySettings.wishTime}\n`;
  msg     += `• Reminders: ${birthdaySettings.enableReminders ? '✅' : '❌'} at ${birthdaySettings.reminderTime}\n`;
  msg     += `• Group Reminders: ${birthdaySettings.enableGroupReminders ? '✅' : '❌'}\n`;
  msg     += `• Private Wishes: ${birthdaySettings.enablePrivateReminders ? '✅' : '❌'}\n`;
  msg     += `• Reminder Days: ${birthdaySettings.reminderDays.join(', ')}\n`;
  msg     += `• Groups: ${birthdaySettings.reminderGroups.length}\n`;
  msg     += `• Admin Hub: ${adminGroupId ? `✅ ${adminGroupId.split('@')[0]}` : '❌ Not set'}`;

  await sock.sendMessage(chatId, { text: msg }, { quoted: message });
}

async function handleTest(sock: any, message: any, chatId: string, senderId: string, isGroup: boolean): Promise<void> {
  const isOwner = await isOwnerOrSudo(senderId, sock, chatId);
  let isSenderAdmin = false;
  if (chatId.endsWith('@g.us')) {
    try { const r = await isAdmin(sock, chatId, senderId); isSenderAdmin = r.isSenderAdmin; } catch {}
  }
  if (!isOwner && !isSenderAdmin) {
    return sock.sendMessage(chatId, { text: '🚫 Only admins can test birthday wishes.' }, { quoted: message });
  }
  if (!isGroup) {
    return sock.sendMessage(chatId, { text: '⚠️ This command must be used in a group.' }, { quoted: message });
  }

  const mentionedJid = message.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  let targetUserId   = message.key.participant || message.key.remoteJid;
  let targetName     = targetUserId.split('@')[0];

  if (mentionedJid?.length > 0) {
    targetUserId = mentionedJid[0];
    const data   = await getBirthdayData(targetUserId);
    targetName   = data ? data.name : targetUserId.split('@')[0];
  } else {
    const data = await getBirthdayData(targetUserId);
    if (data) targetName = data.name;
  }

  await sock.sendMessage(chatId, {
    text: `🧪 Testing birthday wish for *${targetName}*...\n\nSending in 3 seconds...`
  }, { quoted: message });
  await new Promise(r => setTimeout(r, 3000));

  const testPerson = {
    userId:   targetUserId,
    name:     targetName,
    birthday: { age: null, displayDate: moment.tz(TIMEZONE).format('MMMM DD') }
  } as any;

  const participants = await getGroupParticipants(sock, chatId);
  const mentions     = [...new Set([targetUserId, ...participants])];
  await safeSend(sock, chatId, {
    text: `🧪 *TEST MODE* 🧪\n\n${getBirthdayWishMessage(testPerson)}\n\n_This is a test. No actual birthday today._`,
    mentions
  });
}

async function handleForce(sock: any, message: any, chatId: string, senderId: string, args: string[]): Promise<void> {
  const isOwner = await isOwnerOrSudo(senderId, sock, chatId);
  let isSenderAdmin = false;
  if (chatId.endsWith('@g.us')) {
    try { const r = await isAdmin(sock, chatId, senderId); isSenderAdmin = r.isSenderAdmin; } catch {}
  }
  if (!isOwner && !isSenderAdmin) {
    return sock.sendMessage(chatId, { text: '🚫 Only admins (or owner/sudo) can force birthday tasks.' }, { quoted: message });
  }

  if (!args[0]) {
    return sock.sendMessage(chatId, {
      text:
        `🔧 *FORCE COMMANDS*\n\n` +
        `• *wishes* — Force today's birthday wishes\n` +
        `• *reminders [days]* — Force reminders\n` +
        `• *cleanup* — Force cleanup\n\n` +
        `Usage: *.birthday force [command]*`
    }, { quoted: message });
  }

  const type  = args[0].toLowerCase();
  const today = moment.tz(TIMEZONE).format('YYYY-MM-DD');

  if (type === 'wishes') {
    await sock.sendMessage(chatId, { text: '🔧 Forcing birthday wishes...' }, { quoted: message });
    delete lastSchedulerRun[`wishes_${today}`];
    await runBirthdayWishes(sock);
    return sock.sendMessage(chatId, { text: '✅ Forced birthday wishes completed!' }, { quoted: message });
  }
  if (type === 'reminders') {
    const days = args[1] ? parseInt(args[1]) : 7;
    if (isNaN(days)) return sock.sendMessage(chatId, { text: '❌ Invalid days parameter' }, { quoted: message });
    await sock.sendMessage(chatId, { text: `🔧 Forcing ${days}-day reminders...` }, { quoted: message });
    delete lastSchedulerRun[`reminder_${days}_${today}`];
    await runBirthdayReminders(sock, days);
    return sock.sendMessage(chatId, { text: `✅ Forced ${days}-day reminders completed!` }, { quoted: message });
  }
  if (type === 'cleanup') {
    await sock.sendMessage(chatId, { text: '🔧 Running cleanup...' }, { quoted: message });
    await runCleanup();
    return sock.sendMessage(chatId, { text: '✅ Cleanup completed!' }, { quoted: message });
  }
  return sock.sendMessage(chatId, { text: `❓ Unknown force command: *${type}*` }, { quoted: message });
}

async function showSettingsMenu(sock: any, message: any, chatId: string): Promise<void> {
  const s   = birthdaySettings;
  let msg   = `⚙️ *BIRTHDAY SETTINGS* ⚙️\n\n`;
  msg      += `🔔 Reminders: ${s.enableReminders ? '✅ ON' : '❌ OFF'}\n`;
  msg      += `🎉 Auto Wishes: ${s.enableAutoWishes ? '✅ ON' : '❌ OFF'}\n`;
  msg      += `👥 Group Reminders: ${s.enableGroupReminders ? '✅ ON' : '❌ OFF'}\n`;
  msg      += `💬 Private Reminders: ${s.enablePrivateReminders ? '✅ ON' : '❌ OFF'}\n`;
  msg      += `⏰ Wish Time (WAT): ${s.wishTime}\n`;
  msg      += `🔔 Reminder Time (WAT): ${s.reminderTime}\n`;
  msg      += `📅 Reminder Days: ${s.reminderDays.join(', ')} days before\n`;
  msg      += `👥 Groups: ${s.reminderGroups.length}\n\n`;
  msg      += `🔧 *Change Settings:*\n`;
  msg      += `• *.birthday settings reminders on/off*\n`;
  msg      += `• *.birthday settings wishes on/off*\n`;
  msg      += `• *.birthday settings groupreminders on/off*\n`;
  msg      += `• *.birthday settings privatereminders on/off*\n`;
  msg      += `• *.birthday settings wishtime HH:MM*\n`;
  msg      += `• *.birthday settings remindertime HH:MM*\n`;
  msg      += `• *.birthday settings reminderdays 7,3,1*\n`;
  msg      += `• *.birthday settings reload*`;
  await sock.sendMessage(chatId, { text: msg }, { quoted: message });
}

async function handleSettingsCmd(sock: any, message: any, chatId: string, senderId: string, args: string[]): Promise<void> {
  const isOwner = await isOwnerOrSudo(senderId, sock, chatId);
  let isSenderAdmin = false;
  if (chatId.endsWith('@g.us')) {
    try { const r = await isAdmin(sock, chatId, senderId); isSenderAdmin = r.isSenderAdmin; } catch {}
  }
  if (!isOwner && !isSenderAdmin) {
    return sock.sendMessage(chatId, { text: '🚫 Only admins (or owner/sudo) can modify birthday settings.' }, { quoted: message });
  }
  if (args.length === 0) return showSettingsMenu(sock, message, chatId);

  const setting = args[0].toLowerCase();
  const value   = args.slice(1).join(' ').trim();

  switch (setting) {
    case 'reminders':
      birthdaySettings.enableReminders = value === 'on';
      await saveSettings();
      return sock.sendMessage(chatId, { text: `✅ Reminders *${birthdaySettings.enableReminders ? 'enabled' : 'disabled'}*!` }, { quoted: message });
    case 'wishes':
      birthdaySettings.enableAutoWishes = value === 'on';
      await saveSettings();
      return sock.sendMessage(chatId, { text: `✅ Auto wishes *${birthdaySettings.enableAutoWishes ? 'enabled' : 'disabled'}*!` }, { quoted: message });
    case 'groupreminders':
      birthdaySettings.enableGroupReminders = value === 'on';
      await saveSettings();
      return sock.sendMessage(chatId, { text: `✅ Group reminders *${birthdaySettings.enableGroupReminders ? 'enabled' : 'disabled'}*!` }, { quoted: message });
    case 'privatereminders':
      birthdaySettings.enablePrivateReminders = value === 'on';
      await saveSettings();
      return sock.sendMessage(chatId, { text: `✅ Private reminders *${birthdaySettings.enablePrivateReminders ? 'enabled' : 'disabled'}*!` }, { quoted: message });
    case 'wishtime':
      if (!/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(value)) {
        return sock.sendMessage(chatId, { text: '⚠️ Invalid time format. Use HH:MM' }, { quoted: message });
      }
      birthdaySettings.wishTime = value;
      await saveSettings();
      return sock.sendMessage(chatId, { text: `✅ Wish time set to *${value}*!` }, { quoted: message });
    case 'remindertime':
      if (!/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(value)) {
        return sock.sendMessage(chatId, { text: '⚠️ Invalid time format. Use HH:MM' }, { quoted: message });
      }
      birthdaySettings.reminderTime = value;
      await saveSettings();
      return sock.sendMessage(chatId, { text: `✅ Reminder time set to *${value}*!` }, { quoted: message });
    case 'reminderdays': {
      const days = value.split(',').map(d => parseInt(d.trim())).filter(d => !isNaN(d) && d >= 1 && d <= 365);
      if (days.length === 0) {
        return sock.sendMessage(chatId, { text: '⚠️ Invalid days. Use comma-separated numbers, e.g. *7,3,1*' }, { quoted: message });
      }
      birthdaySettings.reminderDays = days.sort((a, b) => b - a);
      await saveSettings();
      return sock.sendMessage(chatId, { text: `✅ Reminder days set to *${days.join(', ')}*!` }, { quoted: message });
    }
    case 'reload':
      await loadSettings();
      return sock.sendMessage(chatId, { text: '✅ Birthday settings reloaded!' }, { quoted: message });
    default:
      return sock.sendMessage(chatId, { text: `❓ Unknown setting: *${setting}*` }, { quoted: message });
  }
}

async function showGroups(sock: any, message: any, chatId: string): Promise<void> {
  const groups = birthdaySettings.reminderGroups;
  let msg      = `👥 *BIRTHDAY REMINDER GROUPS* 👥\n\n`;
  if (groups.length === 0) msg += `📝 No groups configured.\n\n`;
  else {
    msg += `📊 Total: ${groups.length}\n\n`;
    groups.forEach((g, i) => { msg += `${i + 1}. ${g.split('@')[0]}\n`; });
    msg += '\n';
  }
  msg += `🔧 *Commands:*\n• *.birthday groups add* — Add current group\n• *.birthday groups remove [groupId]* — Remove\n• *.birthday groups clear* — Remove all`;
  await sock.sendMessage(chatId, { text: msg }, { quoted: message });
}

async function handleGroups(sock: any, message: any, chatId: string, senderId: string, isGroup: boolean, args: string[]): Promise<void> {
  const isOwner = await isOwnerOrSudo(senderId, sock, chatId);
  let isSenderAdmin = false;
  if (chatId.endsWith('@g.us')) {
    try { const r = await isAdmin(sock, chatId, senderId); isSenderAdmin = r.isSenderAdmin; } catch {}
  }
  if (!isOwner && !isSenderAdmin) {
    return sock.sendMessage(chatId, { text: '🚫 Only admins (or owner/sudo) can manage birthday groups.' }, { quoted: message });
  }
  if (args.length === 0) return showGroups(sock, message, chatId);

  const action = args[0].toLowerCase();

  if (action === 'add') {
    if (!isGroup) return sock.sendMessage(chatId, { text: '⚠️ Run this command *inside the group* you want to add.' }, { quoted: message });
    if (birthdaySettings.reminderGroups.includes(chatId)) return sock.sendMessage(chatId, { text: '⚠️ This group is already added.' }, { quoted: message });
    birthdaySettings.reminderGroups.push(chatId);
    await saveSettings();
    return sock.sendMessage(chatId, { text: '✅ Group added for birthday reminders!' }, { quoted: message });
  }
  if (action === 'remove') {
    const groupArg = args[1];
    if (!groupArg) return sock.sendMessage(chatId, { text: '⚠️ Specify a group ID to remove.' }, { quoted: message });
    const idx = birthdaySettings.reminderGroups.findIndex(g => g.includes(groupArg));
    if (idx === -1) return sock.sendMessage(chatId, { text: `⚠️ Group not found: *${groupArg}*` }, { quoted: message });
    birthdaySettings.reminderGroups.splice(idx, 1);
    await saveSettings();
    return sock.sendMessage(chatId, { text: '✅ Group removed from birthday reminders!' }, { quoted: message });
  }
  if (action === 'clear') {
    const count = birthdaySettings.reminderGroups.length;
    if (count === 0) return sock.sendMessage(chatId, { text: '📝 No groups are currently configured.' }, { quoted: message });
    birthdaySettings.reminderGroups = [];
    await saveSettings();
    return sock.sendMessage(chatId, { text: `✅ Cleared all *${count}* group(s)!` }, { quoted: message });
  }
  return showGroups(sock, message, chatId);
}

// ── Admin Hub handlers (admin group only) ─────────────────────────────────────

async function handleSetAdminGroup(sock: any, message: any, chatId: string, senderId: string): Promise<void> {
  const isOwner = await isOwnerOrSudo(senderId, sock, chatId);
  if (!isOwner) {
    return sock.sendMessage(chatId, { text: '🚫 Only the bot owner can register the admin hub.' }, { quoted: message });
  }
  if (!chatId.endsWith('@g.us')) {
    return sock.sendMessage(chatId, { text: '⚠️ This command must be run inside a group.' }, { quoted: message });
  }
  await setAdminGroupId(chatId);
  return sock.sendMessage(chatId, {
    text:
      `✅ *Birthday Admin Hub registered!*\n\n` +
      `This group is now the private control centre for birthday photo management.\n\n` +
      `🔐 *Available here:*\n` +
      `• *.birthday setphoto [number] [url]*\n` +
      `• *.birthday removeimage [number]*\n` +
      `• *.birthday preview [number]*\n` +
      `• *.birthday listimages*`
  }, { quoted: message });
}

async function handleSetPhoto(sock: any, message: any, chatId: string, args: string[]): Promise<void> {
  // Silent rejection outside admin hub — no hint to other groups that this exists
  if (!await isFromAdminGroup(chatId)) return;

  if (args.length < 1) {
    return sock.sendMessage(chatId, {
      text:
        `⚠️ *Usage:*\n` +
        `*.birthday setphoto [number] [url]*\n\n` +
        `Or reply to a *.tourl* result:\n` +
        `*.birthday setphoto [number]*`
    }, { quoted: message });
  }

  const phone = args[0].replace(/\D/g, '');
  if (!phone || phone.length < 7) {
    return sock.sendMessage(chatId, {
      text: '⚠️ Please provide a valid phone number.\n\nExample: *.birthday setphoto 2348012345678 https://...*'
    }, { quoted: message });
  }

  // URL from inline arg, or extracted from a quoted .tourl reply
  let url: string | null = args[1] || null;

  if (!url) {
    const quotedText: string =
      message.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ||
      message.message?.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text ||
      '';
    const match = quotedText.match(/https:\/\/\S+/);
    if (match) url = match[0];
  }

  if (!url || !url.startsWith('https://')) {
    return sock.sendMessage(chatId, {
      text:
        '⚠️ No valid URL found.\n\n' +
        'Provide it directly: *.birthday setphoto [number] [url]*\n' +
        'Or reply to a *.tourl* result.'
    }, { quoted: message });
  }

  const person = await findByPhone(phone);
  if (!person) {
    return sock.sendMessage(chatId, {
      text: `❌ No birthday record found for *${phone}*.\n\nMake sure they have submitted an attendance form first.`
    }, { quoted: message });
  }

  const success = await setPhoto(person.userId, url);
  if (success) {
    return sock.sendMessage(chatId, {
      text:
        `✅ Birthday photo saved for *${person.name}*!\n\n` +
        `🔗 ${url}\n\n` +
        `🎂 Their wish on *${person.birthday.displayDate}* will include this photo.\n\n` +
        `💡 Use *.birthday preview ${phone}* to see exactly how it will look.`
    }, { quoted: message });
  }
  return sock.sendMessage(chatId, { text: `❌ Failed to save photo for *${person.name}*.` }, { quoted: message });
}

async function handleRemoveImage(sock: any, message: any, chatId: string, args: string[]): Promise<void> {
  if (!await isFromAdminGroup(chatId)) return;

  if (!args[0]) {
    return sock.sendMessage(chatId, { text: '⚠️ Usage: *.birthday removeimage [number]*' }, { quoted: message });
  }

  const phone  = args[0].replace(/\D/g, '');
  const person = await findByPhone(phone);
  if (!person) {
    return sock.sendMessage(chatId, { text: `❌ No birthday record found for *${phone}*.` }, { quoted: message });
  }
  if (!person.birthdayImageUrl) {
    return sock.sendMessage(chatId, { text: `⚠️ *${person.name}* doesn't have a photo set.` }, { quoted: message });
  }

  const success = await removePhoto(person.userId);
  if (success) {
    return sock.sendMessage(chatId, {
      text: `✅ Photo removed for *${person.name}*. Their wish will be text-only.`
    }, { quoted: message });
  }
  return sock.sendMessage(chatId, { text: `❌ Failed to remove photo for *${person.name}*.` }, { quoted: message });
}

async function handlePreview(sock: any, message: any, chatId: string, args: string[]): Promise<void> {
  if (!await isFromAdminGroup(chatId)) return;

  if (!args[0]) {
    return sock.sendMessage(chatId, { text: '⚠️ Usage: *.birthday preview [number]*' }, { quoted: message });
  }

  const phone  = args[0].replace(/\D/g, '');
  const person = await findByPhone(phone);
  if (!person) {
    return sock.sendMessage(chatId, { text: `❌ No birthday record found for *${phone}*.` }, { quoted: message });
  }

  const wishText = getBirthdayWishMessage(person);

  // Metadata header
  await sock.sendMessage(chatId, {
    text:
      `🔍 *PREVIEW — ${person.name}*\n\n` +
      `📅 Birthday: ${person.birthday.displayDate}\n` +
      `🖼️ Photo: ${person.birthdayImageUrl ? '✅ Set' : '❌ Not set (will send as text)'}\n` +
      `${person.birthdayImageUrl ? `🔗 ${person.birthdayImageUrl}\n` : ''}` +
      `─────────────────`
  }, { quoted: message });

  await new Promise(r => setTimeout(r, 1000));

  // Actual wish preview
  if (person.birthdayImageUrl) {
    await sock.sendMessage(chatId, {
      image:   { url: person.birthdayImageUrl },
      caption: wishText
    });
  } else {
    await sock.sendMessage(chatId, { text: wishText });
  }
}

async function handleListImages(sock: any, message: any, chatId: string): Promise<void> {
  if (!await isFromAdminGroup(chatId)) return;

  const birthdays = await getAllBirthdays();
  const list      = Object.values(birthdays).sort((a, b) => {
    if (a.birthday.month !== b.birthday.month) return a.birthday.month - b.birthday.month;
    return a.birthday.day - b.birthday.day;
  });

  if (list.length === 0) {
    return sock.sendMessage(chatId, { text: '📋 No birthday records found.' }, { quoted: message });
  }

  const withPhoto    = list.filter(b => b.birthdayImageUrl);
  const withoutPhoto = list.filter(b => !b.birthdayImageUrl);

  let msg  = `🖼️ *BIRTHDAY PHOTO STATUS*\n\n`;
  msg     += `✅ Ready: ${withPhoto.length}\n`;
  msg     += `❌ Needs photo: ${withoutPhoto.length}\n`;
  msg     += `📊 Total: ${list.length}\n\n`;

  if (withPhoto.length > 0) {
    msg += `*✅ READY:*\n`;
    withPhoto.forEach(p => {
      msg += `• ${p.name} — ${p.birthday.displayDate}\n`;
    });
    msg += '\n';
  }

  if (withoutPhoto.length > 0) {
    msg += `*❌ NEEDS PHOTO:*\n`;
    withoutPhoto.forEach(p => {
      msg += `• ${p.name} — ${p.birthday.displayDate} _(${p.userId.split('@')[0]})_\n`;
    });
  }

  await sock.sendMessage(chatId, { text: msg }, { quoted: message });
}

// ── Main command handler ──────────────────────────────────────────────────────

async function handleBirthdayCommand(sock: any, message: any, args: string[], context: any): Promise<void> {
  const chatId   = context.chatId || message.key.remoteJid;
  const senderId = message.key.participant || message.key.remoteJid;
  const isGroup  = chatId.endsWith('@g.us');

  if (!birthdaySettings.loaded) await loadSettings();
  startScheduler(sock);

  const invokedCmd = (context.userMessage || '').trim().split(/\s+/)[0].replace(/^[.!#\/]/, '');
  if (['mybirthday', 'mybday'].includes(invokedCmd)) {
    return handleMyBirthday(sock, message, senderId, chatId);
  }

  if (args.length === 0) return showBirthdayMenu(sock, message, chatId, context.channelInfo || {});

  const sub     = args[0].toLowerCase();
  const subArgs = args.slice(1);

  switch (sub) {
    case 'today':          return handleToday(sock, message, chatId);
    case 'upcoming':       return handleUpcoming(sock, message, chatId, subArgs);
    case 'thismonth':      return handleThisMonth(sock, message, chatId);
    case 'status':         return handleBirthdayStatus(sock, message, chatId);
    case 'all':            return handleAll(sock, message, chatId, senderId);
    case 'test':           return handleTest(sock, message, chatId, senderId, isGroup);
    case 'settings':       return handleSettingsCmd(sock, message, chatId, senderId, subArgs);
    case 'groups':         return handleGroups(sock, message, chatId, senderId, isGroup, subArgs);
    case 'force':          return handleForce(sock, message, chatId, senderId, subArgs);
    case 'setadmingroup':  return handleSetAdminGroup(sock, message, chatId, senderId);
    case 'setphoto':       return handleSetPhoto(sock, message, chatId, subArgs);
    case 'removeimage':    return handleRemoveImage(sock, message, chatId, subArgs);
    case 'preview':        return handlePreview(sock, message, chatId, subArgs);
    case 'listimages':     return handleListImages(sock, message, chatId);
    case 'help':           return showBirthdayMenu(sock, message, chatId, context.channelInfo || {});
    default:
      return sock.sendMessage(chatId, {
        text: `❓ Unknown birthday command: *${sub}*\n\nUse *.birthday help* to see available commands.`
      }, { quoted: message });
  }
}

// ── Plugin export ─────────────────────────────────────────────────────────────

const birthdayPlugin = {
  command:     'birthday',
  aliases:     ['bday', 'birthdays', 'mybirthday', 'mybday'],
  description: 'Birthday system — auto wishes, reminders, photo management, and tracking',
  category:    'social',
  handler:     handleBirthdayCommand,
  onLoad,
  saveBirthdayData,
  getBirthdayData,
  getAllBirthdays,
  getTodaysBirthdays,
  getUpcomingBirthdays,
  parseDOB,
  startScheduler
};

export default birthdayPlugin;

export {
  saveBirthdayData,
  getBirthdayData,
  getAllBirthdays,
  getTodaysBirthdays,
  getUpcomingBirthdays,
  parseDOB,
  startScheduler,
  onLoad
};
