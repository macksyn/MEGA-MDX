import type { BotContext } from '../types.js';
import store from '../lib/lightweight_store.js';

/**
 * Interface representing standard settings items retrieved from the store.
 */
interface BotSetting {
    enabled?: boolean;
    [key: string]: any;
}

export default {
    command: 'stealth',
    aliases: ['alwaysonline', 'stealthmode'],
    category: 'owner',
    description: 'Toggle online status - bot will not send presence updates if off',
    usage: '.stealth <on|off>',
    ownerOnly: true,

    async handler(sock: any, message: any, args: any, context: BotContext) {
        const { chatId } = context;
        const action = args[0]?.toLowerCase();

        // 1. If no valid action is provided, retrieve and display the current status and warning messages
        if (!action || !['on', 'off'].includes(action)) {
            // Run settings retrievals in parallel to improve performance
            const [currentState, autotypingState, autoreadState] = await Promise.allSettled([
                store.getSetting('global', 'stealthMode'),
                store.getSetting('global', 'autotyping'),
                store.getSetting('global', 'autoread')
            ]);

            const isStealthEnabled = currentState.status === 'fulfilled' && (currentState.value as BotSetting)?.enabled;
            const isAutotypingEnabled = autotypingState.status === 'fulfilled' && (autotypingState.value as BotSetting)?.enabled;
            const isAutoreadEnabled = autoreadState.status === 'fulfilled' && (autoreadState.value as BotSetting)?.enabled;

            const status = isStealthEnabled ? 'ON' : 'OFF';

            let autotypingWarning = '';
            if (isAutotypingEnabled && isStealthEnabled) {
                autotypingWarning = '\n\n⚠️ *Autotyping is enabled* but will be blocked by stealth mode.';
            }

            let autoreadWarning = '';
            if (isAutoreadEnabled && isStealthEnabled) {
                autoreadWarning = '\n⚠️ *Autoread is enabled* but will be blocked by stealth mode.';
            }

            return await sock.sendMessage(chatId, {
                text: `👻 *Stealth Mode Status:* ${status}\n\n` +
                      `*Usage:* .stealth <on|off>\n\n` +
                      `*What it does:*\n` +
                      `• Blocks all presence updates (typing, online, last seen)\n` +
                      `• Makes the bot completely invisible\n\n` +
                      `*When enabled:*\n` +
                      `✓ No "typing..." indicator\n` +
                      `✓ No "online" status\n` +
                      `✓ Complete stealth mode` +
                      `${autotypingWarning}` +
                      `${autoreadWarning}`
            }, { quoted: message });
        }

        // 2. Perform the save action
        const enabled = action === 'on';
        await store.saveSetting('global', 'stealthMode', { enabled });

        // 3. Fetch warnings for the success response
        let warnings = '';
        if (enabled) {
            const [autotypingState, autoreadState] = await Promise.allSettled([
                store.getSetting('global', 'autotyping'),
                store.getSetting('global', 'autoread')
            ]);

            const isAutotypingEnabled = autotypingState.status === 'fulfilled' && (autotypingState.value as BotSetting)?.enabled;
            const isAutoreadEnabled = autoreadState.status === 'fulfilled' && (autoreadState.value as BotSetting)?.enabled;

            if (isAutotypingEnabled || isAutoreadEnabled) {
                warnings = '\n\n*⚠️ Note:*\n';
                if (isAutotypingEnabled) {
                    warnings += '• Autotyping is enabled but will be blocked\n';
                }
                if (isAutoreadEnabled) {
                    warnings += '• Autoread is enabled but will be blocked\n';
                }
            }
        }

        const detailsText = enabled 
            ? '✓ Bot is now in complete stealth mode\n✓ No presence updates\n✓ No typing indicators' 
            : '✓ Presence updates enabled\n✓ Typing indicators enabled (if autotyping is on)';

        await sock.sendMessage(chatId, {
            text: `👻 Stealth mode has been turned *${enabled ? 'ON' : 'OFF'}*\n\n${detailsText}${warnings}`
        }, { quoted: message });
    }
};
