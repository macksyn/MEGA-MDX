// @ts-nocheck
/***
 * plugins/eco_topactive.ts
 *
 * Two things live here:
 *  1. A manual "!topactive" command so anyone can preview today's tally
 *     without waiting for the scheduled payout.
 *  2. A `schedules` export (picked up by pluginLoader) that runs once a
 *     day just after midnight (Africa/Lagos by default) and pays out coins
 *     to yesterday's top-3 most active members of every group the bot is in.
 */
import moment from 'moment-timezone';
import { payoutTopActive, formatNumber, getSettings, withEconomyGuard } from '../lib/economy.js';
import { getTopActiveForDay, isGroupEnabled } from '../lib/activitytracker.js';
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
      text: `❌ Activity tracking isn't enabled in this group, so there's no daily payout here.\n\n💡 An admin can turn it on with *${config.prefix}activity enable*.`,
      ...channelInfo
    }, { quoted: message });
  }

  const today = moment().tz(TZ).format('YYYY-MM-DD');
  const top3 = await getTopActiveForDay(chatId, today, 3);

  if (top3.length === 0) {
    return sock.sendMessage(chatId, { text: '📭 No activity recorded yet today.', ...channelInfo }, { quoted: message });
  }

  const settings = await getSettings();
  const medals = ['🥇', '🥈', '🥉'];
  const lines = top3.map((entry, i) =>
    `${medals[i]} @${entry.userId} — ${entry.count} messages (would earn ${formatNumber(settings.top3Rewards[i] || 0)} coins)`
  );

  await sock.sendMessage(chatId, {
    text: `📊 *Today's most active (so far)*\n\n${lines.join('\n')}\n\n_Payouts run automatically shortly after midnight._`,
    mentions: top3.map(e => `${e.userId}@s.whatsapp.net`),
    ...channelInfo
  }, { quoted: message });
}

// ── Scheduled payout ──────────────────────────────────────────────────────────

export const schedules = [
  {
    at: '00:05',
    handler: async (sock: any) => {
      try {
        const yesterday = moment().tz(TZ).subtract(1, 'day').format('YYYY-MM-DD');

        // groupFetchAllParticipating() is a standard Baileys sock method that
        // returns every group the bot is currently a participant in.
        const groups = await sock.groupFetchAllParticipating?.();
        if (!groups) return;

        for (const chatId of Object.keys(groups)) {
          const results = await payoutTopActive(chatId, yesterday);
          if (results.length === 0) continue;

          const medals = ['🥇', '🥈', '🥉'];
          const lines = results.map(r => `${medals[r.rank - 1]} @${r.userId} — ${r.count} messages — +${r.reward} coins 🪙`);

          await sock.sendMessage(chatId, {
            text: `🎉 *Yesterday's most active members!*\n\n${lines.join('\n')}\n\n_Keep chatting to make tomorrow's list!_`,
            mentions: results.map(r => `${r.userId}@s.whatsapp.net`),
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
