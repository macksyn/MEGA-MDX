// @ts-nocheck
/***
 * plugins/eco_topactive.ts
 *
 * Pays coins to whoever currently holds the top 3 spots on THIS MONTH's
 * activity leaderboard (lib/activitytracker.ts's points-based monthly
 * leaderboard — the same one behind !activity leaderboard). This is
 * deliberately NOT a daily-reset counter: rank is re-checked fresh every
 * time the payout runs, so whoever is top-3 *today* gets paid *today*.
 *
 * No streak state to track. Hold your spot → keep earning it every day.
 * Get overtaken → you simply won't be in the top 3 next time this runs,
 * and the person who overtook you starts earning that spot immediately.
 * The leaderboard position itself is the streak.
 *
 * Two things live here:
 *  1. A manual "!topactive" command so anyone can preview the current
 *     top 3 and what they're earning right now.
 *  2. A `schedules` export (picked up by pluginLoader) that runs once a
 *     day just after midnight (Africa/Lagos by default) and actually
 *     credits coins to the current top 3 of every economy-enabled group.
 */
import moment from 'moment-timezone';
import { payoutMonthlyTop3, formatNumber, getSettings, withEconomyGuard } from '../lib/economy.js';
import { getMonthlyLeaderboard, getEnabledGroups, isGroupEnabled } from '../lib/activitytracker.js';
import { resolveParticipant } from '../lib/contactUtil.js';
import config from '../config.js';
import { channelInfo } from '../lib/messageConfig.js';

const TZ = config.timeZone || 'Africa/Lagos';

export const command = 'topactive';
export const aliases = ['mostactive'];
export const category = 'economy';
export const cooldown = 3000;
export const groupOnly = true;

async function _handler(sock: any, message: any, _args: string[], context: any) {
  const { chatId } = context;

  if (!await isGroupEnabled(chatId)) {
    return sock.sendMessage(chatId, {
      text: `❌ Activity tracking isn't enabled in this group, so there's no daily top-3 payout here.\n\n💡 An admin can turn it on with *${config.prefix}activity enable*.`,
      ...channelInfo
    }, { quoted: message });
  }

  const top3 = await getMonthlyLeaderboard(chatId, null, 3);

  if (top3.length === 0) {
    return sock.sendMessage(chatId, { text: '📭 No activity recorded yet this month.', ...channelInfo }, { quoted: message });
  }

  const settings = await getSettings();
  const medals = ['🥇', '🥈', '🥉'];

  // entry.userId may be a @lid — resolve to a real jid + phone number
  // before building mentions (same fix applied across the economy plugins).
  const resolved = top3.map(entry => resolveParticipant(entry.userId, sock));

  const lines = top3.map((entry, i) => {
    const { phoneNumber } = resolved[i];
    const reward = settings.top3Rewards[i] || 0;
    return `${medals[i]} @${phoneNumber} — ${formatNumber(entry.points)} pts (earning ${formatNumber(reward)} coins/day while ranked here)`;
  });

  const currentMonth = moment().tz(TZ).format('MMMM YYYY');

  await sock.sendMessage(chatId, {
    text:
      `📊 *This month's top 3 — ${currentMonth}*\n\n${lines.join('\n')}\n\n` +
      `_Paid out automatically every day just after midnight, for as long as you hold your spot._`,
    mentions: resolved.map(r => `${r.phoneNumber}@s.whatsapp.net`),
    ...channelInfo
  }, { quoted: message });
}

// ── Scheduled payout ──────────────────────────────────────────────────────────

export const schedules = [
  {
    at: '00:05',
    handler: async (sock: any) => {
      try {
        const dateStr = moment().tz(TZ).format('YYYY-MM-DD');
        const groups = await getEnabledGroups();

        for (const group of groups) {
          const results = await payoutMonthlyTop3(group.groupId, dateStr);
          if (results.length === 0) continue;

          const medals = ['🥇', '🥈', '🥉'];
          const resolved = results.map(r => resolveParticipant(r.userId, sock));
          const lines = results.map((r, i) =>
            `${medals[r.rank - 1]} @${resolved[i].phoneNumber} — ${formatNumber(r.points)} pts — +${formatNumber(r.reward)} coins 🪙`
          );

          await sock.sendMessage(group.groupId, {
            text:
              `🎉 *Today's top 3 on the monthly leaderboard!*\n\n${lines.join('\n')}\n\n` +
              `_Keep your spot to keep earning daily!_`,
            mentions: resolved.map(r => `${r.phoneNumber}@s.whatsapp.net`),
            ...channelInfo
          });
        }
      } catch (err: any) {
        console.error('[eco_topactive] scheduled payout error:', err.message);
      }
    }
  }
];

export const handler = withEconomyGuard(_handler);