// plugins/activity.ts
// Command interface for activity tracking system

import moment from 'moment-timezone';

import isAdmin       from '../lib/isAdmin.js';
import isOwnerOrSudo from '../lib/isOwner.js';
import config        from '../config.js';

import {
  isGroupEnabled,
  enableGroupTracking,
  disableGroupTracking,
  getEnabledGroups,
  getSettings,
  saveSettings,
  getUserActivity,
  getUserRank,
  getMonthlyLeaderboard,
  getInactiveMembers
} from '../lib/activitytracker.js';

const TZ = config.timeZone;
moment.tz.setDefault(TZ);

// ── Helper ────────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours   = Math.floor(minutes / 60);
  const days    = Math.floor(hours / 24);
  if (days > 0)    return `${days}d ${hours % 24}h`;
  if (hours > 0)   return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

// ── Sub-handlers ──────────────────────────────────────────────────────────────

async function showActivityMenu(sock: any, chatId: string, message: any, prefix: string): Promise<void> {
  await sock.sendMessage(chatId, {
    text:
      `📊 *ACTIVITY TRACKER* 📊\n\n` +
      `👤 *User Commands:*\n` +
      `• *${prefix}activity stats* - View your activity stats\n` +
      `• *${prefix}activity rank* - Check your current rank\n` +
      `• *${prefix}activity leaderboard* - View top 10 members\n` +
      `• *${prefix}activity inactives* - View least active members\n` +
      `• *${prefix}activity points* - View point values\n\n` +
      `👑 *Admin Commands:*\n` +
      `• *${prefix}activity enable* - Enable tracking in this group\n` +
      `• *${prefix}activity disable* - Disable tracking in this group\n` +
      `• *${prefix}activity status* - Check if tracking is enabled\n` +
      `• *${prefix}activity settings* - Configure point values\n` +
      `• *${prefix}activity groups* - List all enabled groups (owner only)\n\n` +
      `🤖 *Auto-Tracking:*\n` +
      `All activities tracked automatically in enabled groups!\n\n` +
      `💡 *Usage:* ${prefix}activity [command]`
  }, { quoted: message });
}

async function handleStats(sock: any, message: any, context: any): Promise<void> {
  const { chatId } = context;
  let targetUserId: string = message.key.participant || message.key.remoteJid;

  if (!chatId.endsWith('@g.us')) {
    return sock.sendMessage(chatId, { text: '❌ This command only works in groups.' }, { quoted: message });
  }

  if (!await isGroupEnabled(chatId)) {
    return sock.sendMessage(chatId, {
      text: '❌ Activity tracking is not enabled in this group.\n\n💡 Admins can enable it with: .activity enable'
    }, { quoted: message });
  }

  try {
    if (message.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
      targetUserId = message.message.extendedTextMessage.contextInfo.mentionedJid[0];
    } else if (message.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
      targetUserId = message.message.extendedTextMessage.contextInfo.participant || message.key.participant;
    }

    const activity = await getUserActivity(targetUserId, chatId);
    if (!activity) {
      const phone = targetUserId.split('@')[0];
      return sock.sendMessage(chatId, {
        text: `❌ No activity data found for @${phone}. They haven't participated yet.`,
        mentions: [targetUserId]
      }, { quoted: message });
    }

    const currentMonth  = moment.tz(TZ).format('MMMM YYYY');
    const stats         = activity.stats;
    const phone         = targetUserId.split('@')[0];
    const isSelf        = targetUserId === (message.key.participant || message.key.remoteJid);
    const totalMessages = activity.totalMessages || 0;

    let lastSeenText = 'N/A';
    try {
      if (activity.lastSeen) {
        const diffMs = Date.now() - new Date(activity.lastSeen).getTime();
        lastSeenText = diffMs <= 10 * 60 * 1000 ? '🟢 Online' : `${formatDuration(diffMs)} ago`;
      }
    } catch { lastSeenText = 'N/A'; }

    const header = isSelf ? `📊 *YOUR ACTIVITY STATS* 📊` : `📊 *ACTIVITY STATS - @${phone}* 📊`;

    await sock.sendMessage(chatId, {
      text:
        `${header}\n\n` +
        `📅 Month: ${currentMonth}\n` +
        `⭐ Total Points: ${activity.points || 0}\n` +
        `📝 Total Messages: ${totalMessages}\n\n` +
        `   💬 Text: ${stats.messages || 0}\n` +
        `   🎨 Stickers: ${stats.stickers || 0}\n` +
        `   🎥 Videos: ${stats.videos || 0}\n` +
        `   🎤 Voice Notes: ${stats.voiceNotes || 0}\n` +
        `   📊 Polls: ${stats.polls || 0}\n` +
        `   📸 Photos: ${stats.photos || 0}\n` +
        `   ✅ Attendance: ${stats.attendance || 0}\n\n` +
        `👁️ Last Seen: ${lastSeenText}\n` +
        `📅 First Seen: ${moment(activity.firstSeen).tz(TZ).format('DD/MM/YYYY')}`,
      mentions: [targetUserId]
    }, { quoted: message });
  } catch (error) {
    console.error('Stats error:', error);
    await sock.sendMessage(chatId, { text: '❌ Error loading stats. Please try again.' }, { quoted: message });
  }
}

async function handleRank(sock: any, message: any, context: any): Promise<void> {
  const { chatId, senderId } = context;

  if (!chatId.endsWith('@g.us')) {
    return sock.sendMessage(chatId, { text: '❌ This command only works in groups.' }, { quoted: message });
  }
  if (!await isGroupEnabled(chatId)) {
    return sock.sendMessage(chatId, {
      text: '❌ Activity tracking is not enabled in this group.\n\n💡 Admins can enable it with: .activity enable'
    }, { quoted: message });
  }

  try {
    let allGroupMembers: string[] = [];
    try {
      const meta  = await sock.groupMetadata(chatId);
      allGroupMembers = meta.participants.map((p: any) => p.id);
    } catch {
      return sock.sendMessage(chatId, { text: '❌ Unable to fetch group members. Please try again.' }, { quoted: message });
    }

    const rankData = await getUserRank(senderId, chatId);
    if (!rankData?.activity) {
      return sock.sendMessage(chatId, { text: '❌ No ranking data available yet.' }, { quoted: message });
    }

    const currentMonth     = moment.tz(TZ).format('MMMM YYYY');
    const totalGroupMembers = allGroupMembers.length;

    let rankMessage =
      `🏆 *YOUR RANK* 🏆\n\n` +
      `📅 Month: ${currentMonth}\n` +
      `🥇 Rank: #${rankData.rank} out of ${totalGroupMembers}\n` +
      `⭐ Points: ${rankData.activity.points || 0}\n\n`;

    rankMessage +=
      rankData.rank === 1 ? `🎉 *You're #1! Keep it up!*` :
      rankData.rank <= 3  ? `🔥 *You're in top 3! Great job!*` :
      rankData.rank <= 10 ? `💪 *You're in top 10! Keep climbing!*` :
                            `📈 *Keep participating to climb the ranks!*`;

    await sock.sendMessage(chatId, { text: rankMessage }, { quoted: message });
  } catch (error) {
    console.error('Rank error:', error);
    await sock.sendMessage(chatId, { text: '❌ Error loading rank. Please try again.' }, { quoted: message });
  }
}

async function handleLeaderboard(sock: any, message: any, context: any): Promise<void> {
  const { chatId } = context;

  if (!chatId.endsWith('@g.us')) {
    return sock.sendMessage(chatId, { text: '❌ This command only works in groups.' }, { quoted: message });
  }
  if (!await isGroupEnabled(chatId)) {
    return sock.sendMessage(chatId, {
      text: '❌ Activity tracking is not enabled in this group.\n\n💡 Admins can enable it with: .activity enable'
    }, { quoted: message });
  }

  try {
    const leaderboard = await getMonthlyLeaderboard(chatId);
    if (!leaderboard?.length) {
      return sock.sendMessage(chatId, { text: '❌ No leaderboard data available yet.' }, { quoted: message });
    }

    const currentMonth = moment.tz(TZ).format('MMMM YYYY');
    const mentions     = leaderboard.map(u => u.userId);

    let text = `🏆 *MONTHLY LEADERBOARD* 🏆\n\n📅 Month: ${currentMonth}\n\n`;
    leaderboard.forEach((user, index) => {
      const medal         = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
      const phone         = user.userId.split('@')[0];
      const totalMessages = user.totalMessages || 0;
      const attendance    = user.stats.attendance || 0;
      text += `${medal} @${phone}\n   ⭐ ${user.points} pts | 📝 ${totalMessages} total | ✅ ${attendance} att\n\n`;
    });
    text += `💡 *Use .activity stats to see your detailed stats*`;

    await sock.sendMessage(chatId, { text, mentions }, { quoted: message });
  } catch (error) {
    console.error('Leaderboard error:', error);
    await sock.sendMessage(chatId, { text: '❌ Error loading leaderboard. Please try again.' }, { quoted: message });
  }
}

async function handleInactives(sock: any, message: any, args: string[], context: any): Promise<void> {
  const { chatId } = context;

  if (!chatId.endsWith('@g.us')) {
    return sock.sendMessage(chatId, { text: '❌ This command only works in groups.' }, { quoted: message });
  }
  if (!await isGroupEnabled(chatId)) {
    return sock.sendMessage(chatId, {
      text: '❌ Activity tracking is not enabled in this group.\n\n💡 Admins can enable it with: .activity enable'
    }, { quoted: message });
  }

  try {
    const limit = args[0] ? Math.min(Math.max(parseInt(args[0]), 1), 50) : 10;

    let allGroupMembers: string[] = [];
    try {
      const meta  = await sock.groupMetadata(chatId);
      allGroupMembers = meta.participants.map((p: any) => p.id);
    } catch {
      return sock.sendMessage(chatId, { text: '❌ Unable to fetch group members. Please try again.' }, { quoted: message });
    }

    const allActivityMembers = await getInactiveMembers(chatId, 1000);
    const inactivityData: any[] = [];

    allActivityMembers.forEach(member => {
      if (!member.lastSeen) return;
      const daysInactive = (Date.now() - new Date(member.lastSeen).getTime()) / (24 * 60 * 60 * 1000);
      if (daysInactive >= 7) inactivityData.push({ ...member, daysInactive, isSilent: false });
    });

    const activeMemberIds = new Set(allActivityMembers.map(m => m.userId));
    allGroupMembers
      .filter(id => !activeMemberIds.has(id))
      .forEach(userId => inactivityData.push({
        userId, points: 0,
        stats: { messages: 0, stickers: 0, videos: 0, voiceNotes: 0, polls: 0, photos: 0, attendance: 0 },
        totalMessages: 0, daysInactive: Infinity, isSilent: true, lastSeen: null
      }));

    inactivityData.sort((a, b) => b.daysInactive - a.daysInactive);
    const inactives = inactivityData.slice(0, limit);

    if (inactives.length === 0) {
      return sock.sendMessage(chatId, { text: '✅ Great! All members have been active.' }, { quoted: message });
    }

    const currentMonth = moment.tz(TZ).format('MMMM YYYY');
    const mentions     = inactives.map((u: any) => u.userId);

    let text =
      `😴 *INACTIVE MEMBERS* 😴\n\n` +
      `📅 Month: ${currentMonth}\n` +
      `📊 Showing ${inactives.length} members\n\n`;

    inactives.forEach((user: any) => {
      let badge: string, durationText: string;
      if (user.isSilent) {
        badge = '⚫'; durationText = '(Never chatted)';
      } else {
        const days = Math.floor(user.daysInactive);
        badge        = days >= 30 ? '⚫' : days >= 21 ? '🔴' : days >= 14 ? '🟠' : '🟡';
        durationText = `(${days} days ago)`;
      }
      const phone         = user.userId.split('@')[0];
      const totalMessages = user.totalMessages || 0;
      text += `${badge} @${phone} ${durationText}\n   📝 ${totalMessages} total | ⭐ ${user.points} pts\n\n`;
    });

    text += `\n📌 *Legend:* 🟡 7-14 days | 🟠 2-3 weeks | 🔴 3-4 weeks | ⚫ 1+ month or never chatted\n` +
            `💡 *Use .activity stats to see full details*`;

    await sock.sendMessage(chatId, { text, mentions }, { quoted: message });
  } catch (error) {
    console.error('Inactives error:', error);
    await sock.sendMessage(chatId, { text: '❌ Error loading inactives. Please try again.' }, { quoted: message });
  }
}

async function handlePoints(sock: any, message: any, context: any): Promise<void> {
  const { chatId } = context;
  const settings   = await getSettings();
  await sock.sendMessage(chatId, {
    text:
      `⭐ *POINT VALUES* ⭐\n\n` +
      `📝 Message: ${settings.pointsPerMessage} pt\n` +
      `🎨 Sticker: ${settings.pointsPerSticker} pts\n` +
      `🎥 Video: ${settings.pointsPerVideo} pts\n` +
      `🎤 Voice Note: ${settings.pointsPerVoiceNote} pts\n` +
      `📊 Poll: ${settings.pointsPerPoll} pts\n` +
      `📸 Photo: ${settings.pointsPerPhoto} pts\n` +
      `✅ Attendance: ${settings.pointsPerAttendance} pts\n\n` +
      `💡 *Admins can modify these values with .activity settings*`
  }, { quoted: message });
}

async function handleEnable(sock: any, message: any, context: any): Promise<void> {
  const { chatId, senderId } = context;

  if (!chatId.endsWith('@g.us')) {
    return sock.sendMessage(chatId, { text: '❌ This command only works in groups.' }, { quoted: message });
  }

  const { isSenderAdmin }    = await isAdmin(sock, chatId, senderId);
  const senderIsOwnerOrSudo  = await isOwnerOrSudo(senderId, sock, chatId);
  if (!isSenderAdmin && !senderIsOwnerOrSudo) {
    return sock.sendMessage(chatId, { text: '🚫 Only admins can use this command.' }, { quoted: message });
  }

  try {
    if (await isGroupEnabled(chatId)) {
      return sock.sendMessage(chatId, { text: '✅ Activity tracking is already enabled in this group.' }, { quoted: message });
    }

    let groupName = 'Unknown Group';
    try {
      const meta = await sock.groupMetadata(chatId);
      groupName  = meta.subject;
    } catch {}

    const result = await enableGroupTracking(chatId, groupName);
    if (result.success) {
      await sock.sendMessage(chatId, {
        text:
          `✅ *Activity tracking enabled!*\n\n` +
          `📊 From now on, all group activities will be tracked:\n` +
          `• Messages, stickers, photos\n` +
          `• Videos, voice notes, polls\n` +
          `• Attendance records\n\n` +
          `💡 Use *.activity stats* to view your progress!`
      }, { quoted: message });
    } else {
      await sock.sendMessage(chatId, { text: `❌ Failed to enable tracking: ${result.error}` }, { quoted: message });
    }
  } catch (error) {
    console.error('Enable error:', error);
    await sock.sendMessage(chatId, { text: '❌ An error occurred while enabling tracking.' }, { quoted: message });
  }
}

async function handleDisable(sock: any, message: any, context: any): Promise<void> {
  const { chatId, senderId } = context;

  if (!chatId.endsWith('@g.us')) {
    return sock.sendMessage(chatId, { text: '❌ This command only works in groups.' }, { quoted: message });
  }

  const { isSenderAdmin }   = await isAdmin(sock, chatId, senderId);
  const senderIsOwnerOrSudo = await isOwnerOrSudo(senderId, sock, chatId);
  if (!isSenderAdmin && !senderIsOwnerOrSudo) {
    return sock.sendMessage(chatId, { text: '🚫 Only admins can use this command.' }, { quoted: message });
  }

  try {
    if (!await isGroupEnabled(chatId)) {
      return sock.sendMessage(chatId, { text: '❌ Activity tracking is already disabled in this group.' }, { quoted: message });
    }

    const result = await disableGroupTracking(chatId);
    if (result.success) {
      await sock.sendMessage(chatId, {
        text:
          `❌ *Activity tracking disabled.*\n\n` +
          `📊 Tracking has stopped. Existing data is preserved.\n\n` +
          `💡 Re-enable anytime with *.activity enable*`
      }, { quoted: message });
    } else {
      await sock.sendMessage(chatId, { text: `❌ Failed to disable tracking: ${result.error}` }, { quoted: message });
    }
  } catch (error) {
    console.error('Disable error:', error);
    await sock.sendMessage(chatId, { text: '❌ An error occurred while disabling tracking.' }, { quoted: message });
  }
}

async function handleActivityStatus(sock: any, message: any, context: any): Promise<void> {
  const { chatId } = context;

  if (!chatId.endsWith('@g.us')) {
    return sock.sendMessage(chatId, { text: '❌ This command only works in groups.' }, { quoted: message });
  }

  try {
    const enabled = await isGroupEnabled(chatId);
    await sock.sendMessage(chatId, {
      text: enabled
        ? `✅ *Activity tracking is ENABLED*\n\n📊 All activities are being tracked.\n\n💡 Use *.activity stats* to view your progress!`
        : `❌ *Activity tracking is DISABLED*\n\n📊 No activities are being tracked.\n\n💡 Admins can enable with *.activity enable*`
    }, { quoted: message });
  } catch (error) {
    console.error('Status error:', error);
    await sock.sendMessage(chatId, { text: '❌ An error occurred while checking status.' }, { quoted: message });
  }
}

async function handleGroups(sock: any, message: any, context: any): Promise<void> {
  const { chatId, senderId } = context;

  const { isOwnerOnly } = await import('../lib/isOwner.js');
  if (!isOwnerOnly(senderId)) {
    return sock.sendMessage(chatId, { text: '🚫 This command is for the bot owner only.' }, { quoted: message });
  }

  try {
    const enabledGroups = await getEnabledGroups();
    if (!enabledGroups?.length) {
      return sock.sendMessage(chatId, { text: '❌ No groups have activity tracking enabled yet.' }, { quoted: message });
    }

    let text = `📊 *ACTIVITY TRACKING ENABLED GROUPS* 📊\n\nTotal: ${enabledGroups.length} groups\n\n`;
    enabledGroups.forEach((group, index) => {
      text += `${index + 1}. ${group.groupName || 'Unknown'}\n`;
      text += `   ID: ${group.groupId}\n`;
      text += `   Enabled: ${moment(group.enabledAt).tz(TZ).format('DD/MM/YYYY')}\n\n`;
    });

    await sock.sendMessage(chatId, { text }, { quoted: message });
  } catch (error) {
    console.error('Groups error:', error);
    await sock.sendMessage(chatId, { text: '❌ An error occurred while fetching groups.' }, { quoted: message });
  }
}

async function handleSettingsCmd(sock: any, message: any, args: string[], context: any): Promise<void> {
  const { chatId, senderId } = context;

  const { isSenderAdmin }   = await isAdmin(sock, chatId, senderId);
  const senderIsOwnerOrSudo = await isOwnerOrSudo(senderId, sock, chatId);
  if (!isSenderAdmin && !senderIsOwnerOrSudo) {
    return sock.sendMessage(chatId, { text: '🚫 Only admins can use this command.' }, { quoted: message });
  }

  const settings = await getSettings();

  if (args.length === 0) {
    return sock.sendMessage(chatId, {
      text:
        `⚙️ *ACTIVITY SETTINGS* ⚙️\n\n` +
        `📝 Message: ${settings.pointsPerMessage} pt\n` +
        `🎨 Sticker: ${settings.pointsPerSticker} pts\n` +
        `🎥 Video: ${settings.pointsPerVideo} pts\n` +
        `🎤 Voice Note: ${settings.pointsPerVoiceNote} pts\n` +
        `📊 Poll: ${settings.pointsPerPoll} pts\n` +
        `📸 Photo: ${settings.pointsPerPhoto} pts\n` +
        `✅ Attendance: ${settings.pointsPerAttendance} pts\n\n` +
        `🔧 *Change Settings:*\n` +
        `• *message [points]*\n• *sticker [points]*\n` +
        `• *video [points]*\n• *voicenote [points]*\n` +
        `• *poll [points]*\n• *photo [points]*\n• *attendance [points]*`
    }, { quoted: message });
  }

  const setting = args[0].toLowerCase();
  const value   = parseInt(args[1]);

  if (isNaN(value) || value < 0) {
    return sock.sendMessage(chatId, { text: '⚠️ Please specify a valid point value (0 or higher).' }, { quoted: message });
  }

  const settingMap: Record<string, keyof typeof settings> = {
    message:    'pointsPerMessage',
    sticker:    'pointsPerSticker',
    video:      'pointsPerVideo',
    voicenote:  'pointsPerVoiceNote',
    poll:       'pointsPerPoll',
    photo:      'pointsPerPhoto',
    attendance: 'pointsPerAttendance'
  };

  if (settingMap[setting]) {
    (settings as any)[settingMap[setting]] = value;
    await saveSettings(settings);
    await sock.sendMessage(chatId, { text: `✅ ${setting} points set to ${value}` }, { quoted: message });
  } else {
    await sock.sendMessage(chatId, { text: `❓ Unknown setting: *${setting}*` }, { quoted: message });
  }
}

// ── Plugin export ─────────────────────────────────────────────────────────────

const activityPlugin = {
  command:     'activity',
  aliases:     ['act', 'leaderboard', 'rank'],
  category:    'utility',
  description: 'Activity tracking system for groups',
  groupOnly:   true,

  async handler(sock: any, message: any, args: string[], context: any): Promise<void> {
    const { chatId } = context;

    if (args.length === 0) {
      return showActivityMenu(sock, chatId, message, config.prefix);
    }

    const subCommand = args[0].toLowerCase();
    const subArgs    = args.slice(1);

    switch (subCommand) {
      case 'stats':
        await handleStats(sock, message, context);
        break;
      case 'rank':
        await handleRank(sock, message, context);
        break;
      case 'leaderboard':
      case 'top':
        await handleLeaderboard(sock, message, context);
        break;
      case 'inactives':
      case 'inactive':
        await handleInactives(sock, message, subArgs, context);
        break;
      case 'points':
        await handlePoints(sock, message, context);
        break;
      case 'enable':
        await handleEnable(sock, message, context);
        break;
      case 'disable':
        await handleDisable(sock, message, context);
        break;
      case 'status':
        await handleActivityStatus(sock, message, context);
        break;
      case 'groups':
        await handleGroups(sock, message, context);
        break;
      case 'settings':
        await handleSettingsCmd(sock, message, subArgs, context);
        break;
      case 'help':
        await showActivityMenu(sock, chatId, message, config.prefix);
        break;
      default:
        await sock.sendMessage(chatId, {
          text: `❓ Unknown activity command: *${subCommand}*\n\nUse *${config.prefix}activity help* to see available commands.`
        }, { quoted: message });
    }
  }
};

export default activityPlugin;
