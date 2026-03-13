// plugins/activitytracker.ts
// Extends the bot's built-in message counting with activity type tracking.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const moment  = require('moment-timezone');

import config        from '../config.js';
import { createStore } from '../lib/pluginStore.js';

const TZ = config.timeZone;
moment.tz.setDefault(TZ);

// ── Storage ───────────────────────────────────────────────────────────────────

const db              = createStore('activitytracker');
const dbStats         = db.table!('stats');    // key: userId__groupId__YYYY-MM
const dbGroupSettings = db.table!('groups');   // key: groupId
const dbSettings      = db.table!('settings'); // key: 'config'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ActivitySettings {
  pointsPerMessage:    number;
  pointsPerSticker:    number;
  pointsPerVideo:      number;
  pointsPerVoiceNote:  number;
  pointsPerPoll:       number;
  pointsPerPhoto:      number;
  pointsPerAttendance: number;
}

interface ActivityStats {
  messages:   number;
  stickers:   number;
  videos:     number;
  voiceNotes: number;
  polls:      number;
  photos:     number;
  attendance: number;
}

interface ActivityRecord {
  userId:    string;
  groupId:   string;
  month:     string;
  stats:     ActivityStats;
  points:    number;
  lastSeen:  string;
  firstSeen: string;
}

interface EnrichedRecord extends ActivityRecord {
  totalMessages: number;
}

interface GroupRecord {
  groupId:   string;
  groupName: string;
  enabled:   boolean;
  enabledAt: string;
  updatedAt: string;
  disabledAt?: string;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const defaultSettings: ActivitySettings = {
  pointsPerMessage:    1,
  pointsPerSticker:    2,
  pointsPerVideo:      5,
  pointsPerVoiceNote:  3,
  pointsPerPoll:       5,
  pointsPerPhoto:      3,
  pointsPerAttendance: 10
};

// ── In-memory caches ──────────────────────────────────────────────────────────

const enabledGroupsCache = new Set<string>();
const settingsCache: { data: ActivitySettings | null; timestamp: number } = { data: null, timestamp: 0 };
const CACHE_TTL = 60_000;

// ── Key / date helpers ────────────────────────────────────────────────────────

function statKey(userId: string, groupId: string, month: string): string {
  return `${userId}__${groupId}__${month}`;
}

function currentMonth(): string {
  return moment.tz(TZ).format('YYYY-MM');
}

function blankStats(): ActivityStats {
  return { messages: 0, stickers: 0, videos: 0, voiceNotes: 0, polls: 0, photos: 0, attendance: 0 };
}

function sumTotalMessages(stats: Partial<ActivityStats> = {}): number {
  return (stats.messages   || 0) +
         (stats.stickers   || 0) +
         (stats.videos     || 0) +
         (stats.voiceNotes || 0) +
         (stats.polls      || 0) +
         (stats.photos     || 0);
}

// ── Type maps ─────────────────────────────────────────────────────────────────

const STATS_TYPE_MAP: Record<keyof ActivityStats, string> = {
  messages:   'message',
  stickers:   'sticker',
  videos:     'video',
  voiceNotes: 'voiceNote',
  polls:      'poll',
  photos:     'photo',
  attendance: 'attendance'
};

const MESSAGE_STATS_KEY_MAP: Record<string, keyof ActivityStats> = {
  message:   'messages',
  sticker:   'stickers',
  video:     'videos',
  voiceNote: 'voiceNotes',
  poll:      'polls',
  photo:     'photos'
};

// ── Group tracking enable / disable ──────────────────────────────────────────

async function isGroupEnabled(groupId: string): Promise<boolean> {
  if (enabledGroupsCache.has(groupId)) return true;
  try {
    const rec = await dbGroupSettings.get(groupId) as GroupRecord | null;
    if (rec?.enabled) { enabledGroupsCache.add(groupId); return true; }
    return false;
  } catch { return false; }
}

async function enableGroupTracking(groupId: string, groupName = ''): Promise<{ success: boolean; error?: string }> {
  try {
    await dbGroupSettings.set(groupId, {
      groupId, groupName, enabled: true,
      enabledAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    enabledGroupsCache.add(groupId);
    console.log(`[ACTIVITY] ✅ Tracking enabled for group: ${groupId}`);
    return { success: true };
  } catch (error: any) {
    console.error('[ACTIVITY] enableGroupTracking error:', error);
    return { success: false, error: error.message };
  }
}

async function disableGroupTracking(groupId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const existing = (await dbGroupSettings.get(groupId) || {}) as Partial<GroupRecord>;
    await dbGroupSettings.set(groupId, {
      ...existing, enabled: false,
      disabledAt: new Date().toISOString(),
      updatedAt:  new Date().toISOString()
    });
    enabledGroupsCache.delete(groupId);
    console.log(`[ACTIVITY] ❌ Tracking disabled for group: ${groupId}`);
    return { success: true };
  } catch (error: any) {
    console.error('[ACTIVITY] disableGroupTracking error:', error);
    return { success: false, error: error.message };
  }
}

async function getEnabledGroups(): Promise<GroupRecord[]> {
  try {
    const all = await dbGroupSettings.getAll() as Record<string, GroupRecord>;
    return Object.values(all).filter(g => g.enabled === true);
  } catch { return []; }
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function getSettings(): Promise<ActivitySettings> {
  const now = Date.now();
  if (settingsCache.data && now - settingsCache.timestamp < CACHE_TTL) return settingsCache.data;
  try {
    const saved  = (await dbSettings.get('config') || {}) as Partial<ActivitySettings>;
    const merged = { ...defaultSettings, ...saved };
    settingsCache.data = merged;
    settingsCache.timestamp = now;
    return merged;
  } catch { return { ...defaultSettings }; }
}

async function saveSettings(settings: ActivitySettings): Promise<void> {
  try {
    await dbSettings.set('config', settings);
    settingsCache.data = null;
    settingsCache.timestamp = 0;
  } catch (error: any) {
    console.error('[ACTIVITY] saveSettings error:', error.message);
  }
}

// ── Points ────────────────────────────────────────────────────────────────────

function calculatePoints(activityType: string, settings: ActivitySettings): number {
  const map: Record<string, number> = {
    message:    settings.pointsPerMessage,
    sticker:    settings.pointsPerSticker,
    video:      settings.pointsPerVideo,
    voiceNote:  settings.pointsPerVoiceNote,
    poll:       settings.pointsPerPoll,
    photo:      settings.pointsPerPhoto,
    attendance: settings.pointsPerAttendance
  };
  return map[activityType] || 0;
}

// ── Core stat CRUD ────────────────────────────────────────────────────────────

async function getActivityStats(userId: string, groupId: string, month: string | null = null): Promise<ActivityRecord | null> {
  const mon = month || currentMonth();
  const key = statKey(userId, groupId, mon);
  try {
    let record = await dbStats.get(key) as ActivityRecord | null;
    if (!record) {
      record = {
        userId, groupId, month: mon,
        stats:     blankStats(),
        points:    0,
        lastSeen:  new Date().toISOString(),
        firstSeen: new Date().toISOString()
      };
      await dbStats.set(key, record);
    }
    return record;
  } catch (error: any) {
    console.error('[ACTIVITY] getActivityStats error:', error.message);
    return null;
  }
}

async function updateActivityStats(userId: string, groupId: string, updates: Partial<ActivityRecord>, month: string | null = null): Promise<void> {
  const mon = month || currentMonth();
  const key = statKey(userId, groupId, mon);
  try {
    const existing = await dbStats.get(key) as ActivityRecord | null || {
      userId, groupId, month: mon,
      stats: blankStats(), points: 0,
      lastSeen: new Date().toISOString(),
      firstSeen: new Date().toISOString()
    };
    await dbStats.set(key, {
      ...existing,
      ...updates,
      lastSeen: new Date().toISOString()
    });
  } catch (error: any) {
    console.error('[ACTIVITY] updateActivityStats error:', error.message);
  }
}

// ── Message type detection ────────────────────────────────────────────────────

function detectMessageType(message: any): string | null {
  try {
    if (!message) return null;
    if (message.imageMessage)                                 return 'photo';
    if (message.videoMessage)                                 return 'video';
    if (message.stickerMessage)                               return 'sticker';
    if (message.audioMessage?.ptt)                            return 'voiceNote';
    if (
      message.pollCreationMessage   ||
      message.pollCreationMessageV2 ||
      message.pollCreationMessageV3
    )                                                         return 'poll';
    if (message.conversation || message.extendedTextMessage)  return 'message';
    return null;
  } catch { return null; }
}

// ── User activity (consumed by activity.ts) ───────────────────────────────────

async function getUserActivity(userId: string, groupId: string, month: string | null = null): Promise<EnrichedRecord | null> {
  const mon = month || currentMonth();
  try {
    const [activity, settings] = await Promise.all([
      getActivityStats(userId, groupId, mon),
      getSettings()
    ]);
    if (!activity) return null;

    const totalMessages = sumTotalMessages(activity.stats);

    let points = 0;
    for (const [key, type] of Object.entries(STATS_TYPE_MAP)) {
      points += calculatePoints(type, settings) * (activity.stats[key as keyof ActivityStats] || 0);
    }

    return { ...activity, totalMessages, points };
  } catch (error: any) {
    console.error('[ACTIVITY] getUserActivity error:', error.message);
    return null;
  }
}

// ── Leaderboard / ranks ───────────────────────────────────────────────────────

async function getMonthlyLeaderboard(groupId: string, month: string | null = null, limit = 10): Promise<EnrichedRecord[]> {
  const mon = month || currentMonth();
  try {
    const [all, settings] = await Promise.all([dbStats.getAll(), getSettings()]);

    const groupRecords = Object.values(all as Record<string, ActivityRecord>).filter(
      r => r.groupId === groupId && r.month === mon
    );

    const enriched: EnrichedRecord[] = groupRecords.map(rec => {
      const totalMessages = sumTotalMessages(rec.stats || {});
      let points = 0;
      for (const [key, type] of Object.entries(STATS_TYPE_MAP)) {
        points += calculatePoints(type, settings) * (rec.stats?.[key as keyof ActivityStats] || 0);
      }
      return { ...rec, totalMessages, points };
    });

    return enriched.sort((a, b) => b.points - a.points).slice(0, limit);
  } catch (error: any) {
    console.error('[ACTIVITY] getMonthlyLeaderboard error:', error.message);
    return [];
  }
}

async function getUserRank(userId: string, groupId: string): Promise<{ rank: number; totalUsers: number; activity: EnrichedRecord } | null> {
  try {
    const leaderboard = await getMonthlyLeaderboard(groupId, null, 1000);
    const idx         = leaderboard.findIndex(u => u.userId === userId);
    if (idx === -1) return null;
    return { rank: idx + 1, totalUsers: leaderboard.length, activity: leaderboard[idx] };
  } catch (error: any) {
    console.error('[ACTIVITY] getUserRank error:', error.message);
    return null;
  }
}

async function getInactiveMembers(groupId: string, limit = 10): Promise<EnrichedRecord[]> {
  try {
    const [all, settings] = await Promise.all([dbStats.getAll(), getSettings()]);
    const mon = currentMonth();

    const groupRecords = Object.values(all as Record<string, ActivityRecord>).filter(
      r => r.groupId === groupId && r.month === mon
    );

    const enriched: EnrichedRecord[] = groupRecords.map(rec => {
      const totalMessages = sumTotalMessages(rec.stats || {});
      let points = 0;
      for (const [key, type] of Object.entries(STATS_TYPE_MAP)) {
        points += calculatePoints(type, settings) * (rec.stats?.[key as keyof ActivityStats] || 0);
      }
      return { ...rec, totalMessages, points };
    });

    return enriched
      .sort((a, b) => new Date(a.lastSeen).getTime() - new Date(b.lastSeen).getTime())
      .slice(0, limit);
  } catch (error: any) {
    console.error('[ACTIVITY] getInactiveMembers error:', error.message);
    return [];
  }
}

// ── Core tracking (called from messageHandler.ts) ─────────────────────────────

async function trackActivity(message: any): Promise<void> {
  try {
    const chatId = message.key?.remoteJid;
    if (!chatId?.endsWith('@g.us')) return;
    if (!await isGroupEnabled(chatId)) return;

    const senderId = message.key.participant || message.key.remoteJid;
    if (!senderId || message.key.fromMe) return;

    const settings = await getSettings();

    // Attendance event injected by attendance.ts
    if (message._attendanceEvent) {
      const activity = await getActivityStats(senderId, chatId);
      if (!activity) return;
      const stats = { ...activity.stats };
      stats.attendance = (stats.attendance || 0) + 1;
      const newPoints = (activity.points || 0) + calculatePoints('attendance', settings);
      await updateActivityStats(senderId, chatId, { stats, points: newPoints });
      console.log(`[ACTIVITY] ✅ Attendance +${calculatePoints('attendance', settings)}pts → ${senderId.split('@')[0]}`);
      return;
    }

    const messageType = detectMessageType(message.message);
    if (!messageType) return;

    const activity = await getActivityStats(senderId, chatId);
    if (!activity) return;

    const stats    = { ...activity.stats };
    const statsKey = MESSAGE_STATS_KEY_MAP[messageType];
    if (statsKey) stats[statsKey] = (stats[statsKey] || 0) + 1;

    const pts       = calculatePoints(messageType, settings);
    const newPoints = (activity.points || 0) + pts;

    await updateActivityStats(senderId, chatId, { stats, points: newPoints });
  } catch (error: any) {
    console.error('[ACTIVITY] trackActivity error:', error.message);
  }
}

// ── Direct attendance integration ─────────────────────────────────────────────

async function recordAttendance(userId: string, groupId: string): Promise<void> {
  try {
    if (!await isGroupEnabled(groupId)) return;
    const settings = await getSettings();
    const activity  = await getActivityStats(userId, groupId);
    if (!activity) return;

    const stats = { ...activity.stats };
    stats.attendance = (stats.attendance || 0) + 1;
    const pts       = calculatePoints('attendance', settings);
    const newPoints = (activity.points || 0) + pts;
    await updateActivityStats(userId, groupId, { stats, points: newPoints });
    console.log(`[ACTIVITY] ✅ Attendance tracked for ${userId.split('@')[0]} (+${pts} pts)`);
  } catch (error: any) {
    console.error('[ACTIVITY] recordAttendance error:', error.message);
  }
}

// ── Plugin export ─────────────────────────────────────────────────────────────

const activityTrackerPlugin = {
  command:     '_activitytracker',
  category:    'utility',
  description: 'Tracks per-type activity (messages, stickers, photos …) in enabled groups',

  // API for activity.ts
  isGroupEnabled,
  enableGroupTracking,
  disableGroupTracking,
  getEnabledGroups,
  getSettings,
  saveSettings,
  getUserActivity,
  getUserRank,
  getMonthlyLeaderboard,
  getInactiveMembers,
  recordAttendance,
  trackActivity
};

export default activityTrackerPlugin;

export {
  isGroupEnabled,
  enableGroupTracking,
  disableGroupTracking,
  getEnabledGroups,
  getSettings,
  saveSettings,
  getUserActivity,
  getUserRank,
  getMonthlyLeaderboard,
  getInactiveMembers,
  recordAttendance,
  trackActivity
};
