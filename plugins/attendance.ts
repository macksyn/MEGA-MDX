// @ts-nocheck
// plugins/attendance.ts - MEGA-MD Attendance System

import moment from 'moment-timezone';
import isAdmin       from '../lib/isAdmin.js';
import isOwnerOrSudo from '../lib/isOwner.js';
import { createStore } from '../lib/pluginStore.js';
import bus           from '../lib/pluginBus.js';

// Activity tracker is optional — fails gracefully if not present
let activityTracker: any = null;
try {
  activityTracker = require('./activitytracker');
} catch (e) {
  console.log('[ATTENDANCE] Activity tracker not available (optional)');
}

moment.tz.setDefault('Africa/Lagos');

// ── Storage ───────────────────────────────────────────────────────────────────

const db         = createStore('attendance');
const dbUsers    = db.table!('users');
const dbRecords  = db.table!('records');
const dbSettings = db.table!('settings');

// ── Types ─────────────────────────────────────────────────────────────────────

interface AttendanceSettings {
  rewardAmount:           number;
  requireImage:           boolean;
  imageRewardBonus:       number;
  minFieldLength:         number;
  enableStreakBonus:      boolean;
  streakBonusMultiplier:  number;
  adminNumbers:           string[];
  autoDetection:          boolean;
  preferredDateFormat:    string;
  enabledChats:           Record<string, boolean>;
}

interface UserData {
  userId:           string;
  lastAttendance:   string | null;
  totalAttendances: number;
  streak:           number;
  longestStreak:    number;
  displayName:      string;
  createdAt:        Date;
  updatedAt:        Date;
}

interface ParsedBirthday {
  day:         number;
  month:       number;
  year:        number | null;
  monthName:   string;
  displayDate: string;
  searchKey:   string;
  originalText: string;
  parsedAt:    string;
}

interface ValidationResult {
  isValidForm:       boolean;
  missingFields:     string[];
  hasWakeUpMembers:  boolean;
  hasImage:          boolean;
  imageRequired:     boolean;
  errors:            string[];
  extractedData:     Record<string, any>;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const defaultSettings: AttendanceSettings = {
  rewardAmount:          500,
  requireImage:          false,
  imageRewardBonus:      200,
  minFieldLength:        2,
  enableStreakBonus:     true,
  streakBonusMultiplier: 1.5,
  adminNumbers:          [],
  autoDetection:         true,
  preferredDateFormat:   'DD/MM',
  enabledChats:          {}
};

// ── User cache ────────────────────────────────────────────────────────────────

const userCache    = new Map<string, { user: UserData; timestamp: number }>();
const cacheTimeout = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [userId, data] of userCache.entries()) {
    if (now - data.timestamp > cacheTimeout) userCache.delete(userId);
  }
}, 60_000);

let attendanceSettings: AttendanceSettings = { ...defaultSettings };

// ── Settings persistence ──────────────────────────────────────────────────────

async function loadSettings(): Promise<void> {
  try {
    const saved = await dbSettings.get('config');
    if (saved) {
      attendanceSettings = { ...defaultSettings, ...saved };
      if (!attendanceSettings.enabledChats) attendanceSettings.enabledChats = {};
    }
  } catch (error) {
    console.error('[ATTENDANCE] Error loading settings:', error);
  }
}

async function saveSettings(): Promise<void> {
  try {
    await dbSettings.set('config', attendanceSettings);
  } catch (error) {
    console.error('[ATTENDANCE] Error saving settings:', error);
  }
}

// ── User helpers ──────────────────────────────────────────────────────────────

async function initUser(userId: string): Promise<UserData> {
  const cached = userCache.get(userId);
  if (cached && Date.now() - cached.timestamp < cacheTimeout) return cached.user;

  let userData = await dbUsers.get(userId) as UserData | null;
  if (!userData) {
    userData = {
      userId,
      lastAttendance:   null,
      totalAttendances: 0,
      streak:           0,
      longestStreak:    0,
      displayName:      '',
      createdAt:        new Date(),
      updatedAt:        new Date()
    };
    await dbUsers.set(userId, userData);
  }
  userCache.set(userId, { user: userData, timestamp: Date.now() });
  return userData;
}

async function updateUserData(userId: string, patch: Partial<UserData>): Promise<void> {
  await dbUsers.patch(userId, { ...patch, updatedAt: new Date() });
  userCache.delete(userId);
}

// ── Date / birthday helpers ───────────────────────────────────────────────────

const MONTH_NAMES: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7,
  aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
};

function isLeapYear(year: number | null): boolean {
  return year ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) : false;
}

function parseBirthday(dobText: string): ParsedBirthday | null {
  if (!dobText || typeof dobText !== 'string') return null;

  const cleaned = dobText.toLowerCase().trim()
    .replace(/^(dob|d\.o\.b|date of birth|birthday|born)[:=\s]*/i, '')
    .replace(/[,\s]+$/, '')
    .trim();
  if (!cleaned) return null;

  let day: number | undefined, month: number | undefined, year: number | null = null;

  const norm = cleaned
    .replace(/(\d+)(st|nd|rd|th)\b/g, '$1')
    .replace(/\bof\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let match = norm.match(/([a-z]+)\s+(\d{1,2}),?\s*(\d{4})?/i);
  if (match) {
    month = MONTH_NAMES[match[1]] || MONTH_NAMES[match[1].substring(0, 3)];
    day   = parseInt(match[2]);
    year  = match[3] ? parseInt(match[3]) : null;
    if (month && day >= 1 && day <= 31) return formatBirthday(day, month, year, cleaned);
  }

  match = norm.match(/(\d{1,2})\s+([a-z]+)\s*(\d{4})?/i);
  if (match) {
    day   = parseInt(match[1]);
    month = MONTH_NAMES[match[2]] || MONTH_NAMES[match[2].substring(0, 3)];
    year  = match[3] ? parseInt(match[3]) : null;
    if (month && day >= 1 && day <= 31) return formatBirthday(day, month, year, cleaned);
  }

  match = norm.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if (match) {
    const num1 = parseInt(match[1]);
    const num2 = parseInt(match[2]);
    year = match[3] ? (match[3].length === 2 ? 2000 + parseInt(match[3]) : parseInt(match[3])) : null;

    if (attendanceSettings.preferredDateFormat === 'DD/MM') {
      day = num1; month = num2;
    } else if (attendanceSettings.preferredDateFormat === 'MM/DD') {
      month = num1; day = num2;
    } else {
      if      (num1 > 12 && num2 <= 12) { day = num1; month = num2; }
      else if (num2 > 12 && num1 <= 12) { month = num1; day = num2; }
      else                               { day = num1; month = num2; }
    }
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31)
      return formatBirthday(day, month, year, cleaned);
  }

  match = norm.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (match) {
    year = parseInt(match[1]); month = parseInt(match[2]); day = parseInt(match[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31)
      return formatBirthday(day, month, year, cleaned);
  }

  match = norm.match(/([a-z]+)\s+(\d{1,2})/i);
  if (match) {
    month = MONTH_NAMES[match[1]] || MONTH_NAMES[match[1].substring(0, 3)];
    day   = parseInt(match[2]);
    if (month && day >= 1 && day <= 31) return formatBirthday(day, month, null, cleaned);
  }

  return null;
}

function formatBirthday(
  day: number,
  month: number,
  year: number | null,
  originalText: string
): ParsedBirthday | null {
  const monthNames = [
    'January','February','March','April','May','June',
    'July','August','September','October','November','December'
  ];
  const daysInMonth = [31, year && isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > daysInMonth[month - 1]) return null;

  return {
    day, month, year,
    monthName:   monthNames[month - 1],
    displayDate: year
      ? `${monthNames[month - 1]} ${day}, ${year}`
      : `${monthNames[month - 1]} ${day}`,
    searchKey:   `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    originalText,
    parsedAt:    new Date().toISOString()
  };
}

// ── Record helpers ────────────────────────────────────────────────────────────

async function saveAttendanceRecord(userId: string, attendanceData: any): Promise<boolean> {
  try {
    const record = {
      userId,
      date:          attendanceData.date,
      extractedData: attendanceData.extractedData,
      hasImage:      attendanceData.hasImage,
      reward:        attendanceData.reward,
      streak:        attendanceData.streak,
      timestamp:     new Date()
    };
    const existing = await dbRecords.getOrDefault(userId, []);
    existing.unshift(record);
    await dbRecords.set(userId, existing);
    return true;
  } catch (error) {
    console.error('[ATTENDANCE] Error saving record:', error);
    return false;
  }
}

async function getAttendanceRecords(userId: string, limit = 10): Promise<any[]> {
  const records = await dbRecords.getOrDefault(userId, []);
  return records.slice(0, limit);
}

async function cleanupRecords(): Promise<number> {
  try {
    const cutoffTime = moment.tz('Africa/Lagos').subtract(90, 'days').valueOf();
    const allRecords = await dbRecords.getAll();
    let deletedCount = 0;
    for (const [userId, records] of Object.entries(allRecords)) {
      const arr      = (records as any[]) || [];
      const filtered = arr.filter(r => new Date(r.timestamp).getTime() >= cutoffTime);
      deletedCount  += arr.length - filtered.length;
      await dbRecords.set(userId, filtered);
    }
    console.log(`✅ Attendance records cleanup completed (${deletedCount} records deleted)`);
    return deletedCount;
  } catch (error) {
    console.error('[ATTENDANCE] Error cleaning up records:', error);
    return 0;
  }
}

// ── Form helpers ──────────────────────────────────────────────────────────────

function hasImage(message: any): boolean {
  try {
    return !!(
      message.message?.imageMessage ||
      message.message?.stickerMessage ||
      message.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage ||
      message.message?.extendedTextMessage?.contextInfo?.quotedMessage?.stickerMessage
    );
  } catch {
    return false;
  }
}

function getImageStatus(hasImg: boolean, isRequired: boolean): string {
  return isRequired && !hasImg
    ? '❌ Image required but not found'
    : hasImg ? '📸 Image detected ✅' : '📸 No image (optional)';
}

const attendanceFormRegex = /GIST\s+HQ.*?\*?Name\*?[:].*?\*?Relationship\*?[:]/is;

function validateAttendanceForm(body: string, hasImg = false): ValidationResult {
  const validation: ValidationResult = {
    isValidForm:      false,
    missingFields:    [],
    hasWakeUpMembers: false,
    hasImage:         hasImg,
    imageRequired:    attendanceSettings.requireImage,
    errors:           [],
    extractedData:    {}
  };

  if (
    !/GIST\s+HQ/i.test(body) ||
    !/\*?Name\*?[:]/i.test(body) ||
    !/\*?Relationship\*?[:]/i.test(body)
  ) {
    validation.errors.push('❌ Invalid attendance form format');
    return validation;
  }

  if (attendanceSettings.requireImage && !hasImg) {
    validation.missingFields.push('📸 Image (required)');
  }

  const requiredFields = [
    { name: 'Name',         pattern: /\*?Name\*?[:]\s*([^\n]+)/i,          fieldName: '👤 Name',              isBirthday: false },
    { name: 'Location',     pattern: /\*?Location\*?[:]\s*([^\n]+)/i,      fieldName: '🌍 Location',           isBirthday: false },
    { name: 'Time',         pattern: /\*?Time\*?[:]\s*([^\n]+)/i,          fieldName: '⌚ Time',               isBirthday: false },
    { name: 'Weather',      pattern: /\*?Weather\*?[:]\s*([^\n]+)/i,       fieldName: '🌥 Weather',            isBirthday: false },
    { name: 'Mood',         pattern: /\*?Mood\*?[:]\s*([^\n]+)/i,          fieldName: '❤️‍🔥 Mood',            isBirthday: false },
    { name: 'DOB',          pattern: /\*?D\.?O\.?B\.?\*?[:]\s*([^\n]+)/i, fieldName: '🗓 D.O.B',             isBirthday: true  },
    { name: 'Relationship', pattern: /\*?Relationship\*?[:]\s*([^\n]+)/i,  fieldName: '👩‍❤️‍👨 Relationship', isBirthday: false }
  ];

  requiredFields.forEach(field => {
    const match = body.match(field.pattern);
    if (!match || !match[1] || match[1].trim().length < attendanceSettings.minFieldLength) {
      validation.missingFields.push(field.fieldName);
    } else {
      validation.extractedData[field.name.toLowerCase()] = match[1].trim();
      if (field.isBirthday) {
        validation.extractedData.parsedBirthday = parseBirthday(match[1].trim());
        if (!validation.extractedData.parsedBirthday) {
          validation.missingFields.push(field.fieldName + ' (invalid format)');
        }
      }
    }
  });

  const wakeUp1 = body.match(/1[:]\s*([^\n]+)/i);
  const wakeUp2 = body.match(/2[:]\s*([^\n]+)/i);
  const wakeUp3 = body.match(/3[:]\s*([^\n]+)/i);
  const missingWakeUps: string[] = [];
  if (!wakeUp1?.[1] || wakeUp1[1].trim().length < attendanceSettings.minFieldLength) missingWakeUps.push('1:');
  if (!wakeUp2?.[1] || wakeUp2[1].trim().length < attendanceSettings.minFieldLength) missingWakeUps.push('2:');
  if (!wakeUp3?.[1] || wakeUp3[1].trim().length < attendanceSettings.minFieldLength) missingWakeUps.push('3:');

  if (missingWakeUps.length > 0) {
    validation.missingFields.push(`🔔 Wake up members (${missingWakeUps.join(', ')})`);
  } else {
    validation.hasWakeUpMembers = true;
    validation.extractedData.wakeUpMembers = [wakeUp1![1].trim(), wakeUp2![1].trim(), wakeUp3![1].trim()];
  }

  validation.isValidForm = validation.missingFields.length === 0;
  return validation;
}

function updateStreak(userId: string, userData: UserData, today: string): number {
  const yesterday = moment.tz('Africa/Lagos').subtract(1, 'day').format('DD-MM-YYYY');
  if (userData.lastAttendance === yesterday) {
    userData.streak = (userData.streak || 0) + 1;
  } else if (userData.lastAttendance !== today) {
    userData.streak = 1;
  }
  if (userData.streak > (userData.longestStreak || 0)) userData.longestStreak = userData.streak;
  return userData.streak;
}

function getNigeriaTime(): any  { return moment.tz('Africa/Lagos'); }
function getCurrentDate(): string { return getNigeriaTime().format('DD-MM-YYYY'); }

// ── Auto-detection (called by messageHandler directly) ────────────────────────

async function handleAutoAttendance(message: any, sock: any): Promise<boolean> {
  try {
    const messageText: string =
      message.message?.conversation ||
      message.message?.extendedTextMessage?.text ||
      message.message?.imageMessage?.caption ||
      message.message?.videoMessage?.caption ||
      message.body || '';

    const senderId: string = message.key.participant || message.key.remoteJid;
    const chatId: string   = message.key.remoteJid;

    if (!attendanceFormRegex.test(messageText)) return false;

    const today    = getCurrentDate();
    const userData = await initUser(senderId);

    if (userData.lastAttendance === today) {
      await sock.sendMessage(chatId, {
        text: `📝 You've already marked your attendance today! Come back tomorrow.`
      }, { quoted: message });
      return true;
    }

    const messageHasImage = hasImage(message);
    const validation      = validateAttendanceForm(messageText, messageHasImage);

    if (!validation.isValidForm) {
      await sock.sendMessage(chatId, {
        text: `❌ *INCOMPLETE ATTENDANCE FORM* \n\n📄 Please complete the following fields:\n\n` +
              `${validation.missingFields.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\n` +
              `💡 *Please fill out all required fields and try again.*`
      }, { quoted: message });
      return true;
    }

    const currentStreak = updateStreak(senderId, userData, today);
    await updateUserData(senderId, {
      lastAttendance:   today,
      totalAttendances: (userData.totalAttendances || 0) + 1,
      streak:           currentStreak,
      longestStreak:    userData.longestStreak,
      displayName:      validation.extractedData.name || userData.displayName
    });

    let birthdayMessage = '';
    if (validation.extractedData.parsedBirthday && validation.extractedData.name) {
      bus.emit('attendance:birthday', {
        userId:       senderId,
        name:         validation.extractedData.name,
        birthdayData: validation.extractedData.parsedBirthday
      });
      birthdayMessage = `\n🎂 Birthday saved/updated: ${validation.extractedData.parsedBirthday.displayDate}.`;
    }

    await saveAttendanceRecord(senderId, {
      date:          today,
      extractedData: validation.extractedData,
      hasImage:      messageHasImage,
      reward:        0,
      streak:        currentStreak
    });

    if (activityTracker?.trackActivity) {
      try { await activityTracker.trackActivity({ ...message, _attendanceEvent: true }); } catch {}
    }

    await sock.sendMessage(chatId, {
      text: `✅ *ATTENDANCE APPROVED!* ✅\n\n🔥 Current streak: ${currentStreak} days` +
            (birthdayMessage ? `\n${birthdayMessage}` : '') +
            `\n\n🎉 *Thank you for your participation!*`
    }, { quoted: message });

    return true;
  } catch (error) {
    console.error('[ATTENDANCE] Error in auto attendance handler:', error);
    return false;
  }
}

// ── Command sub-handlers ──────────────────────────────────────────────────────

async function showAttendanceMenu(sock: any, chatId: string, message: any): Promise<void> {
  await sock.sendMessage(chatId, {
    text: `📋 *ATTENDANCE SYSTEM* 📋\n\n` +
          `📊 *User Commands:*\n` +
          `• *stats* - View your attendance stats\n` +
          `• *test [form]* - Test attendance form\n` +
          `• *testbirthday [date]* - Test birthday parsing\n` +
          `• *records* - View your attendance history\n\n` +
          `👑 *Admin Commands:*\n` +
          `• *settings* - View/modify settings\n` +
          `• *cleanup* - Clean old records (90+ days)\n\n` +
          `🤖 *Auto-Detection:*\n` +
          `Just send your GIST HQ attendance form!\n\n` +
          `💡 *Usage:* .attendance [command]`
  }, { quoted: message });
}

async function handleStats(sock: any, chatId: string, senderId: string, message: any): Promise<void> {
  try {
    const userData = await initUser(senderId);
    const today    = getCurrentDate();

    let statsMessage =
      `📊 *YOUR ATTENDANCE STATS* 📊\n\n` +
      `📅 Last attendance: ${userData.lastAttendance || 'Never'}\n` +
      `📋 Total attendances: ${userData.totalAttendances || 0}\n` +
      `🔥 Current streak: ${userData.streak || 0} days\n` +
      `🏆 Longest streak: ${userData.longestStreak || 0} days\n` +
      `✅ Today's status: ${userData.lastAttendance === today ? 'Marked ✅' : 'Not marked ❌'}\n` +
      `📸 Image required: ${attendanceSettings.requireImage ? 'Yes' : 'No'}\n` +
      `📅 Date format: ${attendanceSettings.preferredDateFormat}`;

    const streak = userData.streak || 0;
    statsMessage +=
      streak >= 7 ? `\n🌟 *Amazing! You're on fire with a ${streak}-day streak!*` :
      streak >= 3 ? `\n🔥 *Great job! Keep the streak going!*` :
                    `\n💪 *Mark your attendance daily to build a streak!*`;

    await sock.sendMessage(chatId, { text: statsMessage }, { quoted: message });
  } catch (error) {
    await sock.sendMessage(chatId, { text: '❌ *Error loading stats. Please try again.*' }, { quoted: message });
    console.error('[ATTENDANCE] Stats error:', error);
  }
}

async function handleSettingsCmd(
  sock: any, chatId: string, senderId: string, message: any, args: string[]
): Promise<void> {
  const isOwner = await isOwnerOrSudo(senderId, sock, chatId);
  let isSenderAdmin = false;
  if (chatId.endsWith('@g.us')) {
    try {
      const result = await isAdmin(sock, chatId, senderId);
      isSenderAdmin = result.isSenderAdmin;
    } catch {}
  }

  if (!isOwner && !isSenderAdmin) {
    await sock.sendMessage(chatId, { text: '🚫 Only admins can use this command.' }, { quoted: message });
    return;
  }

  if (args.length === 0) {
    const settingsMessage =
      `⚙️ *ATTENDANCE SETTINGS* ⚙️\n\n` +
      `💰 Reward Amount: ₦${attendanceSettings.rewardAmount.toLocaleString()}\n` +
      `📸 Require Image: ${attendanceSettings.requireImage ? 'Yes ✅' : 'No ❌'}\n` +
      `💎 Image Bonus: ₦${attendanceSettings.imageRewardBonus.toLocaleString()}\n` +
      `📅 Date Format: ${attendanceSettings.preferredDateFormat}\n` +
      `🔧 *Change Settings:*\n` +
      `• *reward [amount]*\n• *requireimage on/off*\n• *imagebonus [amount]*\n• *dateformat MM/DD|DD/MM*`;
    await sock.sendMessage(chatId, { text: settingsMessage }, { quoted: message });
    return;
  }

  const setting = args[0].toLowerCase();
  const value   = args.slice(1).join(' ');

  switch (setting) {
    case 'reward': {
      const amount = parseInt(value);
      if (isNaN(amount) || amount < 0) {
        await sock.sendMessage(chatId, { text: '⚠️ Please specify a valid reward amount.' }, { quoted: message });
        return;
      }
      attendanceSettings.rewardAmount = amount;
      await saveSettings();
      await sock.sendMessage(chatId, { text: `✅ Reward amount set to ₦${amount.toLocaleString()}` }, { quoted: message });
      break;
    }
    case 'requireimage': {
      if (!['on', 'off'].includes(value.toLowerCase())) {
        await sock.sendMessage(chatId, { text: '⚠️ Please specify: *on* or *off*' }, { quoted: message });
        return;
      }
      attendanceSettings.requireImage = value.toLowerCase() === 'on';
      await saveSettings();
      await sock.sendMessage(chatId, {
        text: `✅ Image requirement ${attendanceSettings.requireImage ? 'enabled' : 'disabled'}`
      }, { quoted: message });
      break;
    }
    case 'imagebonus': {
      const bonus = parseInt(value);
      if (isNaN(bonus) || bonus < 0) {
        await sock.sendMessage(chatId, { text: '⚠️ Please specify a valid bonus amount.' }, { quoted: message });
        return;
      }
      attendanceSettings.imageRewardBonus = bonus;
      await saveSettings();
      await sock.sendMessage(chatId, { text: `✅ Image bonus set to ₦${bonus.toLocaleString()}` }, { quoted: message });
      break;
    }
    case 'dateformat': {
      if (!['MM/DD', 'DD/MM'].includes(value)) {
        await sock.sendMessage(chatId, { text: '⚠️ Please specify: *MM/DD* or *DD/MM*' }, { quoted: message });
        return;
      }
      attendanceSettings.preferredDateFormat = value;
      await saveSettings();
      await sock.sendMessage(chatId, { text: `✅ Date format set to ${value}` }, { quoted: message });
      break;
    }
    default:
      await sock.sendMessage(chatId, { text: `❓ Unknown setting: *${setting}*` }, { quoted: message });
  }
}

async function handleTest(sock: any, chatId: string, message: any, args: string[]): Promise<void> {
  const fullText: string =
    message.message?.conversation ||
    message.message?.extendedTextMessage?.text ||
    message.message?.imageMessage?.caption ||
    message.message?.videoMessage?.caption || '';
  const testText = fullText.replace(/^[.!#]attendance\s+test\s*/i, '').trim();

  if (!testText) {
    await sock.sendMessage(chatId, {
      text: `🔍 *Attendance Form Test*\n\nUsage: .attendance test [paste your attendance form]`
    }, { quoted: message });
    return;
  }

  const validation = validateAttendanceForm(testText, hasImage(message));
  let result =
    `🔍 *Form Detection Results:*\n\n` +
    `📋 Valid Form: ${validation.isValidForm ? '✅ Yes' : '❌ No'}\n` +
    `📸 Image: ${getImageStatus(validation.hasImage, validation.imageRequired)}\n` +
    `🔔 Wake-up Members: ${validation.hasWakeUpMembers ? '✅ Present' : '❌ Missing'}\n` +
    `🚫 Missing/Invalid Fields: ${validation.missingFields.length > 0 ? validation.missingFields.join(', ') : 'None'}\n`;

  if (Object.keys(validation.extractedData).length > 0) {
    result += `\n📝 Extracted Data:\n`;
    for (const [k, v] of Object.entries(validation.extractedData)) {
      if (k === 'parsedBirthday') {
        result += v ? `🎂 DOB: ${(v as any).displayDate}\n` : `🎂 DOB: Invalid format\n`;
      } else if (k !== 'wakeUpMembers' && v) {
        result += `${k}: ${v}\n`;
      }
    }
  }

  await sock.sendMessage(chatId, { text: result }, { quoted: message });
}

async function handleTestBirthday(sock: any, chatId: string, message: any, args: string[]): Promise<void> {
  const testDate = args.join(' ');
  if (!testDate) {
    await sock.sendMessage(chatId, {
      text: `🎂 *Birthday Parser Test*\n\nUsage: .attendance testbirthday [date]`
    }, { quoted: message });
    return;
  }
  const parsed = parseBirthday(testDate);
  const result = parsed
    ? `🎂 *Birthday Parser Results*\n\n✅ Parsed Successfully:\n` +
      `📅 Date: ${parsed.displayDate}\n` +
      `🔍 Search Key: ${parsed.searchKey}\n` +
      `🗓 Month: ${parsed.monthName}\n` +
      `📌 Original: ${parsed.originalText}`
    : `🎂 *Birthday Parser Results*\n\n❌ Failed to parse birthday: ${testDate}`;

  await sock.sendMessage(chatId, { text: result }, { quoted: message });
}

async function handleAttendanceRecords(
  sock: any, chatId: string, senderId: string, message: any, args: string[]
): Promise<void> {
  try {
    const limit   = args[0] ? Math.min(Math.max(parseInt(args[0]), 1), 50) : 10;
    const records = await getAttendanceRecords(senderId, limit);

    if (records.length === 0) {
      await sock.sendMessage(chatId, {
        text: `📋 *No Attendance Records*\n\nYou haven't marked any attendance yet.`
      }, { quoted: message });
      return;
    }

    let recordsText = `📋 *YOUR ATTENDANCE HISTORY* 📋\n\n📊 Showing last ${records.length} records:\n\n`;
    records.forEach((record, index) => {
      recordsText +=
        `${index + 1}. 📅 ${record.date}\n` +
        `   💰 Reward: ₦${record.reward.toLocaleString()}\n` +
        `   🔥 Streak: ${record.streak} days\n` +
        `   📸 Image: ${record.hasImage ? 'Yes' : 'No'}\n` +
        (record.extractedData?.name ? `   👤 Name: ${record.extractedData.name}\n` : '') +
        `   ⏰ ${moment(record.timestamp).tz('Africa/Lagos').format('DD/MM/YYYY HH:mm')}\n\n`;
    });
    recordsText += `💡 *Use: .attendance records [number]* to show more/less records (max 50)`;
    await sock.sendMessage(chatId, { text: recordsText }, { quoted: message });
  } catch (error) {
    await sock.sendMessage(chatId, { text: '❌ *Error loading attendance records. Please try again.*' }, { quoted: message });
    console.error('[ATTENDANCE] Records error:', error);
  }
}

async function handleCleanup(sock: any, chatId: string, senderId: string, message: any): Promise<void> {
  const isOwner = await isOwnerOrSudo(senderId, sock, chatId);
  let isSenderAdmin = false;
  if (chatId.endsWith('@g.us')) {
    try {
      const result = await isAdmin(sock, chatId, senderId);
      isSenderAdmin = result.isSenderAdmin;
    } catch {}
  }

  if (!isOwner && !isSenderAdmin) {
    await sock.sendMessage(chatId, { text: '🚫 Only admins can use this command.' }, { quoted: message });
    return;
  }

  try {
    await sock.sendMessage(chatId, {
      text: '🧹 Starting cleanup of old attendance records (90+ days)...'
    }, { quoted: message });
    const deletedCount = await cleanupRecords();
    await sock.sendMessage(chatId, {
      text: `✅ Cleanup completed! Deleted ${deletedCount} old records.`
    }, { quoted: message });
  } catch (error) {
    await sock.sendMessage(chatId, { text: '❌ *Error during cleanup. Please try again.*' }, { quoted: message });
    console.error('[ATTENDANCE] Cleanup error:', error);
  }
}

// ── Plugin export ─────────────────────────────────────────────────────────────

const attendancePlugin = {
  command:     'attendance',
  aliases:     ['att', 'attendstats', 'mystats'],
  category:    'utility',
  description: 'Advanced attendance system with form validation and streaks',
  usage:       '.attendance [stats|settings|test|records|help]',

  async onLoad(sock: any): Promise<void> {
    await loadSettings();
    console.log('[ATTENDANCE] Plugin loaded.');
  },

  // onMessage kept for forward compatibility if pluginLoader gets wired into
  // messageHandler.ts in future. Auto-detection currently runs via the direct
  // handleAutoAttendance import added to messageHandler.ts (see note below).
  async onMessage(sock: any, message: any, _context: any): Promise<void> {
    if (!attendanceSettings.autoDetection) return;
    await handleAutoAttendance(message, sock);
  },

  async handler(sock: any, message: any, args: string[], context: any): Promise<void> {
    const chatId   = context.chatId || message.key.remoteJid;
    const senderId = message.key.participant || message.key.remoteJid;
    const subCommand = args[0]?.toLowerCase();

    if (!subCommand) {
      await showAttendanceMenu(sock, chatId, message);
      return;
    }

    switch (subCommand) {
      case 'stats':
        await handleStats(sock, chatId, senderId, message);
        break;
      case 'settings':
        await handleSettingsCmd(sock, chatId, senderId, message, args.slice(1));
        break;
      case 'test':
        await handleTest(sock, chatId, message, args.slice(1));
        break;
      case 'testbirthday':
        await handleTestBirthday(sock, chatId, message, args.slice(1));
        break;
      case 'records':
        await handleAttendanceRecords(sock, chatId, senderId, message, args.slice(1));
        break;
      case 'cleanup':
        await handleCleanup(sock, chatId, senderId, message);
        break;
      case 'help':
        await showAttendanceMenu(sock, chatId, message);
        break;
      default:
        await sock.sendMessage(chatId, {
          text: `❓ Unknown attendance command: *${subCommand}*\n\nUse *.attendance help* to see available commands.`
        }, { quoted: message });
    }
  }
};

export default attendancePlugin;

// Named utility exports (consumed by activitytracker.ts and birthday.ts)
export {
  handleAutoAttendance,
  parseBirthday,
  validateAttendanceForm,
  hasImage,
  getCurrentDate,
  getNigeriaTime
};
