import type { BotContext } from '../types.js';
import store from '../lib/lightweight_store.js';
import { runModeration, hasAIProvider, getProviderName } from '../lib/aimoderation.js';
import { incrementWarningCount, resetWarningCount } from '../lib/antibadword.js';

interface AntitoxicSettings {
    enabled: boolean;
    action: 'delete' | 'warn' | 'kick';
    sensitivity: 'low' | 'medium' | 'high';
    warnThreshold: number;
}

const SENSITIVITY_THRESHOLDS: Record<string, number> = {
    low:    0.85,
    medium: 0.65,
    high:   0.45
};

const SENSITIVITY_DESC: Record<string, string> = {
    low:    'Only very obvious violations (fewer false positives)',
    medium: 'Balanced detection — recommended',
    high:   'Catches more content (may flag edge cases)'
};

async function getSettings(chatId: string): Promise<AntitoxicSettings> {
    const s = await store.getSetting(chatId, 'antitoxic');
    return s || {
        enabled:       false,
        action:        'warn',
        sensitivity:   'medium',
        warnThreshold: 3
    };
}

async function saveSettings(chatId: string, settings: AntitoxicSettings): Promise<void> {
    await store.saveSetting(chatId, 'antitoxic', settings);
}

// ── Cached group metadata ────────────────────────────────────────────────────
const metaCache = new Map<string, { participants: any[]; ts: number }>();
const META_TTL  = 3 * 60 * 1000;

async function getParticipants(sock: any, chatId: string): Promise<any[]> {
    const c = metaCache.get(chatId);
    if (c && Date.now() - c.ts < META_TTL) return c.participants;
    const meta = await sock.groupMetadata(chatId);
    const participants = meta?.participants || [];
    metaCache.set(chatId, { participants, ts: Date.now() });
    return participants;
}

// ── Core detection — called from messageHandler ──────────────────────────────
export async function handleAIToxicDetection(
    sock: any,
    chatId: string,
    message: any,
    userMessage: string,
    senderId: string
): Promise<boolean> {
    if (!chatId.endsWith('@g.us'))        return false;
    if (message.key.fromMe)               return false;
    if (!userMessage || userMessage.trim().length < 4) return false;

    const settings = await getSettings(chatId);
    if (!settings.enabled) return false;
    if (!hasAIProvider())  return false;

    // Check participant roles
    let isBotAdmin    = false;
    let isSenderAdmin = false;
    try {
        const participants = await getParticipants(sock, chatId);
        const botJid       = sock.user.id.split(':')[0] + '@s.whatsapp.net';
        isBotAdmin         = !!participants.find((p: any) => p.id === botJid)?.admin;
        isSenderAdmin      = !!participants.find((p: any) => p.id === senderId)?.admin;
    } catch {
        return false;
    }

    // Never moderate admins
    if (isSenderAdmin) return false;

    // Run AI moderation
    const result = await runModeration(userMessage);
    if (!result.flagged) return false;

    const threshold = SENSITIVITY_THRESHOLDS[settings.sensitivity] ?? 0.65;
    if (result.score < threshold) return false;

    // Attempt to delete the offending message (requires bot admin)
    if (isBotAdmin) {
        try { await sock.sendMessage(chatId, { delete: message.key }); } catch { /* ignore */ }
    }

    const categoryText = result.categories.length
        ? result.categories.map(c => c.replace(/_/g, ' ')).join(', ')
        : 'toxic content';
    const displayNum = senderId.split('@')[0];

    switch (settings.action) {

        case 'delete':
            await sock.sendMessage(chatId, {
                text:
                    `🤖 *AI Moderation*\n\n` +
                    `@${displayNum}'s message was removed.\n` +
                    `_Detected: ${categoryText}_`,
                mentions: [senderId]
            });
            break;

        case 'kick':
            if (isBotAdmin) {
                try {
                    await sock.groupParticipantsUpdate(chatId, [senderId], 'remove');
                    await sock.sendMessage(chatId, {
                        text:
                            `🤖 *AI Moderation*\n\n` +
                            `@${displayNum} was removed for violating group rules.\n` +
                            `_Detected: ${categoryText}_`,
                        mentions: [senderId]
                    });
                } catch {
                    await sock.sendMessage(chatId, {
                        text:
                            `🤖 *AI Moderation*\n\n` +
                            `@${displayNum}'s message was flagged for ${categoryText}.`,
                        mentions: [senderId]
                    });
                }
            }
            break;

        case 'warn': {
            const warnCount = await incrementWarningCount(chatId, senderId);
            const limit     = settings.warnThreshold || 3;

            if (warnCount >= limit && isBotAdmin) {
                try {
                    await sock.groupParticipantsUpdate(chatId, [senderId], 'remove');
                    await resetWarningCount(chatId, senderId);
                    await sock.sendMessage(chatId, {
                        text:
                            `🤖 *AI Moderation*\n\n` +
                            `@${displayNum} reached ${limit} warnings and was removed.\n` +
                            `_Final violation: ${categoryText}_`,
                        mentions: [senderId]
                    });
                } catch {
                    await sock.sendMessage(chatId, {
                        text:
                            `🤖 *AI Moderation* ⚠️ Warning ${warnCount}/${limit}\n\n` +
                            `@${displayNum} your message was flagged for *${categoryText}*.\n` +
                            `${limit - warnCount} more warning(s) before removal.`,
                        mentions: [senderId]
                    });
                }
            } else {
                await sock.sendMessage(chatId, {
                    text:
                        `🤖 *AI Moderation* ⚠️ Warning ${warnCount}/${limit}\n\n` +
                        `@${displayNum} your message was flagged for *${categoryText}*.\n` +
                        `${Math.max(0, limit - warnCount)} more warning(s) before removal.`,
                    mentions: [senderId]
                });
            }
            break;
        }
    }

    return true;
}

// ── Admin command plugin ─────────────────────────────────────────────────────
export default {
    command:     'antitoxic',
    aliases:     ['aitoxic', 'aimod', 'toxicfilter'],
    category:    'admin',
    description: 'AI-powered toxic content filter (hate speech, threats, harassment, etc.)',
    usage:       '.antitoxic <on|off|action|sensitivity|warns|status>',
    groupOnly:   true,
    adminOnly:   true,

    async handler(sock: any, message: any, args: any, context: BotContext) {
        const chatId   = context.chatId || message.key.remoteJid;
        const match    = args.join(' ').trim().toLowerCase();
        const settings = await getSettings(chatId);
        const provider = getProviderName();

        // ── status (default) ──────────────────────────────────────────────
        if (!match || match === 'status') {
            await sock.sendMessage(chatId, {
                text:
                    `🤖 *AI Anti-Toxic Filter*\n\n` +
                    `Status: ${settings.enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
                    `Action: *${settings.action}*\n` +
                    `Sensitivity: *${settings.sensitivity}* — _${SENSITIVITY_DESC[settings.sensitivity]}_\n` +
                    `Warn Threshold: *${settings.warnThreshold}*\n` +
                    `AI Provider: ${provider}\n\n` +
                    `*Commands:*\n` +
                    `• \`.antitoxic on\` — Enable filter\n` +
                    `• \`.antitoxic off\` — Disable filter\n` +
                    `• \`.antitoxic action <delete|warn|kick>\`\n` +
                    `• \`.antitoxic sensitivity <low|medium|high>\`\n` +
                    `• \`.antitoxic warns <1-10>\` — Warn limit before kick\n\n` +
                    `_Catches: hate speech, harassment, threats, sexual content, violence, self-harm, radicalization_`
            }, { quoted: message });
            return;
        }

        // ── on ────────────────────────────────────────────────────────────
        if (match === 'on') {
            if (!hasAIProvider()) {
                await sock.sendMessage(chatId, {
                    text:
                        `⚠️ *No AI Key Configured*\n\n` +
                        `Set *OPENAI_API_KEY* (recommended, free) or *GROQ_API_KEY* in your environment variables to use AI moderation.\n\n` +
                        `OpenAI key: https://platform.openai.com/api-keys`
                }, { quoted: message });
                return;
            }
            settings.enabled = true;
            await saveSettings(chatId, settings);
            await sock.sendMessage(chatId, {
                text:
                    `✅ *AI Anti-Toxic Filter Enabled*\n\n` +
                    `Provider: ${provider}\n` +
                    `Action: *${settings.action}*\n` +
                    `Sensitivity: *${settings.sensitivity}*\n\n` +
                    `All group messages will now be scanned by AI.`
            }, { quoted: message });
            return;
        }

        // ── off ───────────────────────────────────────────────────────────
        if (match === 'off') {
            settings.enabled = false;
            await saveSettings(chatId, settings);
            await sock.sendMessage(chatId, {
                text: '❌ *AI Anti-Toxic Filter Disabled*\n\nMessages will no longer be AI-scanned.'
            }, { quoted: message });
            return;
        }

        // ── action ────────────────────────────────────────────────────────
        if (match.startsWith('action ')) {
            const action = match.split(' ')[1] as 'delete' | 'warn' | 'kick';
            if (!['delete', 'warn', 'kick'].includes(action)) {
                await sock.sendMessage(chatId, {
                    text: '❌ Invalid action. Choose: *delete*, *warn*, or *kick*'
                }, { quoted: message });
                return;
            }
            settings.action = action;
            await saveSettings(chatId, settings);
            await sock.sendMessage(chatId, {
                text: `✅ Action set to: *${action}*`
            }, { quoted: message });
            return;
        }

        // ── sensitivity ───────────────────────────────────────────────────
        if (match.startsWith('sensitivity ')) {
            const sensitivity = match.split(' ')[1] as 'low' | 'medium' | 'high';
            if (!['low', 'medium', 'high'].includes(sensitivity)) {
                await sock.sendMessage(chatId, {
                    text: '❌ Invalid sensitivity. Choose: *low*, *medium*, or *high*'
                }, { quoted: message });
                return;
            }
            settings.sensitivity = sensitivity;
            await saveSettings(chatId, settings);
            await sock.sendMessage(chatId, {
                text: `✅ Sensitivity set to: *${sensitivity}*\n_${SENSITIVITY_DESC[sensitivity]}_`
            }, { quoted: message });
            return;
        }

        // ── warns ─────────────────────────────────────────────────────────
        if (match.startsWith('warns ')) {
            const num = parseInt(match.split(' ')[1], 10);
            if (isNaN(num) || num < 1 || num > 10) {
                await sock.sendMessage(chatId, {
                    text: '❌ Please provide a number between *1* and *10*'
                }, { quoted: message });
                return;
            }
            settings.warnThreshold = num;
            await saveSettings(chatId, settings);
            await sock.sendMessage(chatId, {
                text: `✅ Warn limit set to: *${num}* — members will be removed after ${num} warnings.`
            }, { quoted: message });
            return;
        }

        await sock.sendMessage(chatId, {
            text: '❌ Unknown option. Use `.antitoxic status` to see all commands.'
        }, { quoted: message });
    }
};
