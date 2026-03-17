import type { BotContext } from '../types.js';
import fs from 'fs';
import path from 'path';
import { dataFile } from '../lib/paths.js';
import store from '../lib/lightweight_store.js';
import { createStore } from '../lib/pluginStore.js';
import {
    detectInsult,
    getGrudge,
    setGrudge,
    clearGrudge,
    getGrudgeClapback,
    getThawMessage,
    GRUDGE_DURATIONS,
    type GrudgeRecord
} from '../lib/grudge.js';

const MONGO_URL    = process.env.MONGO_URL;
const POSTGRES_URL = process.env.POSTGRES_URL;
const MYSQL_URL    = process.env.MYSQL_URL;
const SQLITE_URL   = process.env.DB_URL;
const HAS_DB       = !!(MONGO_URL || POSTGRES_URL || MYSQL_URL || SQLITE_URL);

const USER_GROUP_DATA = dataFile('userGroupData.json');

const db        = createStore('chatbot');
const dbUsers   = db.table!('users');
const dbHistory = db.table!('history');
const dbConfig  = db.table!('config');

const profileCache = new Map<string, Record<string, any>>();
const historyCache = new Map<string, string[]>();

// ── Per-user processing lock ──────────────────────────────────────────────────
const processingLock = new Set<string>();

// ── Profile / history helpers ─────────────────────────────────────────────────

async function loadProfile(senderId: string): Promise<Record<string, any>> {
    if (profileCache.has(senderId)) return profileCache.get(senderId)!;
    const stored = await dbUsers.get(senderId) ?? {};
    profileCache.set(senderId, stored);
    return stored;
}

async function saveProfile(senderId: string, profile: Record<string, any>): Promise<void> {
    profileCache.set(senderId, profile);
    await dbUsers.set(senderId, profile);
}

async function loadHistory(senderId: string): Promise<string[]> {
    if (historyCache.has(senderId)) return historyCache.get(senderId)!;
    const stored = await dbHistory.get(senderId) ?? [];
    historyCache.set(senderId, stored);
    return stored;
}

async function saveHistory(senderId: string, messages: string[]): Promise<void> {
    historyCache.set(senderId, messages);
    await dbHistory.set(senderId, messages);
}

// ── API endpoints ─────────────────────────────────────────────────────────────

const API_ENDPOINTS = [
    {
        name:  'GPT-5',
        url:   (text: string) => `https://malvin-api.vercel.app/ai/gpt-5?text=${encodeURIComponent(text)}`,
        parse: (data: any) => data?.result
    },
    {
        name:  'Copilot',
        url:   (text: string) => `https://malvin-api.vercel.app/ai/copilot?text=${encodeURIComponent(text)}`,
        parse: (data: any) => data?.result
    },
    {
        name:  'Venice AI',
        url:   (text: string) => `https://malvin-api.vercel.app/ai/venice?text=${encodeURIComponent(text)}`,
        parse: (data: any) => data?.result
    },
    {
        name:  'SparkAPI',
        url:   (text: string) => `https://discardapi.dpdns.org/api/chat/spark?apikey=guru&text=${encodeURIComponent(text)}`,
        parse: (data: any) => data?.result?.answer
    },
    {
        name:  'LlamaAPI',
        url:   (text: string) => `https://discardapi.dpdns.org/api/bot/llama?apikey=guru&text=${encodeURIComponent(text)}`,
        parse: (data: any) => data?.result
    }
];

const API_FAILURE_RESET_MS = 5 * 60 * 1000;

const apiStats: Record<string, { count: number; lastFailAt: number; lastSuccessAt: number }> = {};
API_ENDPOINTS.forEach(api => {
    apiStats[api.name] = { count: 0, lastFailAt: 0, lastSuccessAt: 0 };
});

setInterval(() => {
    const now = Date.now();
    for (const name of Object.keys(apiStats)) {
        if (apiStats[name].count > 0 && now - apiStats[name].lastFailAt > API_FAILURE_RESET_MS) {
            apiStats[name].count = 0;
        }
    }
}, API_FAILURE_RESET_MS);

// ── Chatbot config storage ────────────────────────────────────────────────────

async function loadUserGroupData() {
    try {
        const enabled = await dbConfig.getAll();
        return { groups: [], chatbot: enabled };
    } catch (error: any) {
        console.error('Error loading chatbot config:', error.message);
        return { groups: [], chatbot: {} };
    }
}

async function saveUserGroupData(data: any) {
    try {
        const current = await dbConfig.getAll();
        for (const [chatId, val] of Object.entries(data.chatbot ?? {})) {
            await dbConfig.set(chatId, val);
        }
        for (const chatId of Object.keys(current)) {
            if (!(chatId in (data.chatbot ?? {}))) {
                await dbConfig.del(chatId);
            }
        }
    } catch (error: any) {
        console.error('Error saving chatbot config:', error.message);
    }
}

// ── Typing indicator ──────────────────────────────────────────────────────────

async function showTyping(sock: any, chatId: string, estimatedResponseLength = 80) {
    try {
        const base  = Math.min(Math.max(estimatedResponseLength * 40, 1500), 6000);
        const delay = Math.round(base * (0.7 + Math.random() * 0.6));
        await sock.presenceSubscribe(chatId);
        await sock.sendPresenceUpdate('composing', chatId);
        await new Promise(resolve => setTimeout(resolve, delay));
        if (Math.random() < 0.25) {
            await sock.sendPresenceUpdate('paused', chatId);
            await new Promise(resolve => setTimeout(resolve, 400 + Math.random() * 600));
            await sock.sendPresenceUpdate('composing', chatId);
            await new Promise(resolve => setTimeout(resolve, 600 + Math.random() * 800));
        }
    } catch (error: any) {
        console.error('Typing indicator error:', error.message);
    }
}

// ── User info extractor ───────────────────────────────────────────────────────

function extractUserInfo(message: string) {
    const info: Record<string, any> = {};
    if (message.toLowerCase().includes('my name is')) {
        info.name = message.split('my name is')[1].trim().split(' ')[0];
    }
    if (message.toLowerCase().includes('i am') && message.toLowerCase().includes('years old')) {
        info.age = message.match(/\d+/)?.[0];
    }
    if (message.toLowerCase().includes('i live in') || message.toLowerCase().includes('i am from')) {
        info.location = message.split(/(?:i live in|i am from)/i)[1].trim().split(/[.,!?]/)[0];
    }
    return info;
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPrompt(userMessage: string, messages: string[], userInfo: Record<string, any>): string {
    const info = userInfo || {};

    const nameLine = info.name
        ? `The user's name is ${info.name}. Use their name very occasionally — at most once in 3 conversation, only when it flows completely naturally (e.g. a greeting or a moment of surprise). Never force it. If they ask what their name is, answer correctly.`
        : '';

    const extraInfo = [
        info.age      ? `age: ${info.age}`           : '',
        info.location ? `location: ${info.location}` : ''
    ].filter(Boolean).join(', ');

    const system =
        'You are an intellectual tech-savvy human in GHQ WhatsApp group. Name: Groq. 1-4 lines, emojis ok. ' +
        'You live in Lagos, Nigeria. ' +
        ' If you are being asked questions requiring current real-time information, search the web for the answer before responding. Never guess.  ' +
        'Match the energy of whoever you\'re talking to — chill and warm for greetings, ' +
        'Sacarstic when they\'re joking, savage when they\'re rude, supportive when they\'re down. ' +
        'Never force humour. Never admit being AI or robot. ' +
        (nameLine ? nameLine + ' ' : '') +
        (extraInfo ? `Other info: ${extraInfo}.` : '');

    const history = messages.slice(-4).join('\n');

    const full = [
        system,
        history ? `Conversation so far:\n${history}` : '',
        `User: ${userMessage}`,
        'Bot:'
    ].filter(Boolean).join('\n\n');

    if (full.length > 1300) {
        return [system, `User: ${userMessage}`, 'Bot:'].join('\n\n');
    }

    return full;
}

// ── AI call ───────────────────────────────────────────────────────────────────

async function getAIResponse(
    userMessage: string,
    userContext: { messages: string[]; userInfo: Record<string, any> }
): Promise<string | null> {
    const prompt = buildPrompt(userMessage, userContext.messages, userContext.userInfo);

    for (const api of API_ENDPOINTS) {
        try {
            console.log(`Trying ${api.name} (prompt: ${prompt.length} chars)...`);
            const controller = new AbortController();
            const timeoutId  = setTimeout(() => controller.abort(), 10000);
            const response   = await fetch(api.url(prompt), { method: 'GET', signal: controller.signal });
            clearTimeout(timeoutId);

            if (!response.ok) {
                apiStats[api.name].count++;
                apiStats[api.name].lastFailAt = Date.now();
                console.log(`${api.name} failed: HTTP ${response.status}`);
                continue;
            }

            const data   = await response.json() as any;
            const result = api.parse(data);

            if (!result) {
                apiStats[api.name].count++;
                apiStats[api.name].lastFailAt = Date.now();
                console.log(`${api.name} returned no result`);
                continue;
            }

            apiStats[api.name].count         = 0;
            apiStats[api.name].lastSuccessAt = Date.now();
            console.log(`${api.name} success`);

            return result.trim()
                .replace(/winks/g,                                '😉')
                .replace(/eye roll/g,                              '🙄')
                .replace(/shrug/g,                                 '🤷')
                .replace(/raises eyebrow/g,                        '🤨')
                .replace(/smiles/g,                                '😊')
                .replace(/laughs/g,                                '😂')
                .replace(/cries/g,                                 '😢')
                .replace(/thinks/g,                                '🤔')
                .replace(/sleeps/g,                                '😴')
                .replace(/google/gi,                               'Groq')
                .replace(/a large language model/gi,               'just a person')
                .replace(/Remember:.*$/gm,                         '')
                .replace(/IMPORTANT:.*$/gm,                        '')
                .replace(/^(Groq|Bot|AI|Assistant)\s*:\s*/gim,    '')
                .replace(/^[•\-]\s.*$/gm,                         '')
                .replace(/^[✅❌].*$/gm,                            '')
                .replace(/\n{2,}/g,                                '\n')
                .trim();

        } catch (error: any) {
            apiStats[api.name].count++;
            apiStats[api.name].lastFailAt = Date.now();
            console.log(`${api.name} error: ${error.message}`);
        }
    }

    console.error('All AI APIs failed');
    return null;
}

// ── Main chatbot handler ──────────────────────────────────────────────────────

export async function handleChatbotResponse(
    sock: any,
    chatId: string,
    message: any,
    userMessage: string,
    senderId: string
) {
    const data = await loadUserGroupData();
    if (!data.chatbot[chatId]) return;

    try {
        const botId     = sock.user.id;
        const botNumber = botId.split(':')[0];
        const botLid    = sock.user.lid;
        const botJids   = [
            botId,
            `${botNumber}@s.whatsapp.net`,
            `${botNumber}@whatsapp.net`,
            `${botNumber}@lid`,
            botLid,
            `${botLid.split(':')[0]}@lid`
        ];

        let isBotMentioned = false;
        let isReplyToBot   = false;

        if (message.message?.extendedTextMessage) {
            const mentionedJid      = message.message.extendedTextMessage.contextInfo?.mentionedJid || [];
            const quotedParticipant = message.message.extendedTextMessage.contextInfo?.participant;

            isBotMentioned = mentionedJid.some((jid: string) => {
                const n = jid.split('@')[0].split(':')[0];
                return botJids.some((b: string) => b.split('@')[0].split(':')[0] === n);
            });

            if (quotedParticipant) {
                const cleanQuoted = quotedParticipant.replace(/[:@].*$/, '');
                isReplyToBot = botJids.some((b: string) => b.replace(/[:@].*$/, '') === cleanQuoted);
            }
        } else if (message.message?.conversation) {
            isBotMentioned = userMessage.includes(`@${botNumber}`);
        }

        if (!isBotMentioned && !isReplyToBot) return;

        let cleanedMessage = userMessage;
        if (isBotMentioned) cleanedMessage = cleanedMessage.replace(new RegExp(`@${botNumber}`, 'g'), '').trim();

        // ── RESOLVE @MENTIONS to names ────────────────────────────────────────
        const allMentioned: string[] = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const contacts = (sock as any).store?.contacts || {};
        for (const jid of allMentioned) {
            const numPart = jid.split('@')[0].split(':')[0];
            const isBotJid = botJids.some((b: string) => b.split('@')[0].split(':')[0] === numPart);
            if (isBotJid) continue;
            const contact = contacts[jid] || contacts[`${numPart}@s.whatsapp.net`] || contacts[`${numPart}@lid`];
            const displayName = contact?.notify || contact?.name || contact?.pushName;
            if (displayName) {
                cleanedMessage = cleanedMessage.replace(new RegExp(`@${numPart}`, 'g'), `@${displayName}`);
            }
        }

        // ── GRUDGE CHECK ──────────────────────────────────────────────────────
        const activeGrudge = await getGrudge(chatId, senderId, profileCache);
        if (activeGrudge) {
            console.log(`[GRUDGE] Silent treatment: ${senderId.split('@')[0]} (expires in ${Math.round((activeGrudge.expiresAt - Date.now()) / 3600000)}h)`);
            return;
        }

        // ── PROCESSING LOCK ───────────────────────────────────────────────────
        if (processingLock.has(senderId)) return;
        processingLock.add(senderId);

        try {

            // ── INSULT DETECTION ──────────────────────────────────────────────
            const insult = detectInsult(cleanedMessage);

            if (insult.hit) {
                const grudge    = await setGrudge(chatId, senderId, insult.severity, cleanedMessage, profileCache);
                const clapback  = getGrudgeClapback(insult.severity);
                const hoursLeft = Math.round((grudge.expiresAt - Date.now()) / 3600000);

                console.log(`[GRUDGE] Set for ${senderId.split('@')[0]} — severity: ${insult.severity}, matched: ${insult.matchedLabels.join(', ')}, duration: ${hoursLeft}h, strikes: ${grudge.strikes}`);

                await new Promise(r => setTimeout(r, 1200 + Math.random() * 1000));
                await sock.sendMessage(chatId, { text: clapback }, { quoted: message });
                return;
            }

            // ── THAW CHECK ────────────────────────────────────────────────────
            const profile    = await loadProfile(senderId);
            const wasGrudged = profile._justThawed?.[chatId];

            if (wasGrudged) {
                if (profile._justThawed) delete profile._justThawed[chatId];
                await saveProfile(senderId, profile);
                await showTyping(sock, chatId, 20);
                await sock.sendMessage(chatId, { text: getThawMessage() }, { quoted: message });
                return;
            }

            // ── NORMAL FLOW ───────────────────────────────────────────────────
            const messages = await loadHistory(senderId);

            const pushName: string | undefined = message.pushName;
            if (pushName && !profile.name) {
                profile.name      = pushName.trim().split(/\s+/)[0];
                profile.pushName  = pushName;
                profile.firstSeen = profile.firstSeen ?? Date.now();
            }
            profile.lastSeen = Date.now();

            const extracted = extractUserInfo(cleanedMessage);
            if (extracted.name)     profile.name     = extracted.name;
            if (extracted.age)      profile.age      = extracted.age;
            if (extracted.location) profile.location = extracted.location;

            await saveProfile(senderId, profile);

            const response = await getAIResponse(cleanedMessage, {
                messages,
                userInfo: profile
            });

            if (!response) {
                await showTyping(sock, chatId, 40);
                await sock.sendMessage(chatId, {
                    text: "Hmm... I lost my train of thought there 🤔 try again?"
                }, { quoted: message });
                return;
            }

            const userTurn = `User: ${cleanedMessage.length > 120 ? cleanedMessage.slice(0, 120) + '...' : cleanedMessage}`;
            const botTurn  = `Bot: ${response.length > 120 ? response.slice(0, 120) + '...' : response}`;
            messages.push(userTurn, botTurn);
            while (messages.length > 6) messages.shift();
            await saveHistory(senderId, messages);

            await showTyping(sock, chatId, response.length);
            await sock.sendMessage(chatId, { text: response }, { quoted: message });

        } finally {
            // Always release the lock — whether success, early return, or error
            processingLock.delete(senderId);
        }

    } catch (error: any) {
        console.error('Error in chatbot response:', error.message);
        if (error.message?.includes('No sessions')) return;
        try {
            await sock.sendMessage(chatId, {
                text: "Oops! 😅 Got a bit confused there. Try again?"
            }, { quoted: message });
        } catch (sendError: any) {
            console.error('Failed to send chatbot error message:', sendError.message);
        }
    }
}

// ── Command handler ───────────────────────────────────────────────────────────

export default {
    command:     'chatbot',
    aliases:     ['bot', 'ai', 'achat'],
    category:    'admin',
    description: 'Enable or disable AI chatbot for the group',
    usage:       '.chatbot <on|off|stats|pardon|grudges>',
    groupOnly:   true,
    adminOnly:   true,

    async handler(sock: any, message: any, args: any, context: BotContext) {
        const chatId = context.chatId || message.key.remoteJid;
        const match  = args.join(' ').toLowerCase().trim();

        if (!match) {
            return sock.sendMessage(chatId, {
                text:
                    `*🤖 CHATBOT SETUP*\n\n` +
                    `*Storage:* ${HAS_DB ? 'Database' : 'File System'}\n` +
                    `*APIs:* ${API_ENDPOINTS.length} endpoints with fallback\n\n` +
                    `*Commands:*\n` +
                    `• \`.chatbot on\` — Enable chatbot\n` +
                    `• \`.chatbot off\` — Disable chatbot\n` +
                    `• \`.chatbot stats\` — API health & memory stats\n` +
                    `• \`.chatbot pardon @user\` — Lift a grudge early\n` +
                    `• \`.chatbot grudges\` — List active grudges in this group\n\n` +
                    `*How it works:*\n` +
                    `When enabled, bot responds when mentioned or replied to.\n` +
                    `Insult the bot → it claps back once then ignores you for hours.\n\n` +
                    `*Grudge tiers:*\n` +
                    `• Mild insult → 2 hours silent treatment\n` +
                    `• Medium insult → 6 hours silent treatment\n` +
                    `• Heavy insult → 24 hours silent treatment\n` +
                    `• Repeat offender → duration multiplies per strike`
            }, { quoted: message });
        }

        const data = await loadUserGroupData();

        // ── on ────────────────────────────────────────────────────────────────
        if (match === 'on') {
            if (data.chatbot[chatId]) {
                return sock.sendMessage(chatId, {
                    text: '⚠️ *Chatbot is already enabled for this group*'
                }, { quoted: message });
            }
            data.chatbot[chatId] = true;
            await saveUserGroupData(data);
            return sock.sendMessage(chatId, {
                text: '✅ *Chatbot enabled!*\n\nMention me or reply to my messages to chat.'
            }, { quoted: message });
        }

        // ── off ───────────────────────────────────────────────────────────────
        if (match === 'off') {
            if (!data.chatbot[chatId]) {
                return sock.sendMessage(chatId, {
                    text: '⚠️ *Chatbot is already disabled for this group*'
                }, { quoted: message });
            }
            delete data.chatbot[chatId];
            await saveUserGroupData(data);
            return sock.sendMessage(chatId, {
                text: '❌ *Chatbot disabled!*\n\nI will no longer respond to mentions.'
            }, { quoted: message });
        }

        // ── pardon @user ──────────────────────────────────────────────────────
        if (match.startsWith('pardon')) {
            const mentioned = message.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!mentioned) {
                return sock.sendMessage(chatId, {
                    text: '❌ Mention the user to pardon. Example: `.chatbot pardon @username`'
                }, { quoted: message });
            }
            await clearGrudge(chatId, mentioned, profileCache);
            const tag = `@${mentioned.split('@')[0]}`;
            return sock.sendMessage(chatId, {
                text: `✅ Grudge cleared for ${tag}. They can talk to me again.`,
                mentions: [mentioned]
            }, { quoted: message });
        }

        // ── grudges ───────────────────────────────────────────────────────────
        if (match === 'grudges') {
            const now     = Date.now();
            const entries: string[] = [];

            for (const [uid, profile] of profileCache.entries()) {
                const g: GrudgeRecord | undefined = profile.grudges?.[chatId];
                if (g && g.active && now < g.expiresAt) {
                    const hoursLeft = ((g.expiresAt - now) / 3600000).toFixed(1);
                    const name      = profile.name || uid.split('@')[0];
                    entries.push(`• @${uid.split('@')[0]} (${name}) — ${hoursLeft}h left [${g.severity}, strike ${g.strikes}]`);
                }
            }

            if (entries.length === 0) {
                return sock.sendMessage(chatId, {
                    text: '✅ *No active grudges in this group.*\n\nEveryone has been behaving 🙂'
                }, { quoted: message });
            }

            return sock.sendMessage(chatId, {
                text: `*😒 ACTIVE GRUDGES (${entries.length})*\n\n${entries.join('\n')}\n\nUse \`.chatbot pardon @user\` to clear one.`
            }, { quoted: message });
        }

        // ── stats ─────────────────────────────────────────────────────────────
        if (match === 'stats') {
            const now      = Date.now();
            const apiLines = API_ENDPOINTS.map(api => {
                const s        = apiStats[api.name];
                const icon     = s.count === 0 ? '✅' : s.count < 3 ? '⚠️' : '❌';
                const lastFail = s.lastFailAt
                    ? `last fail ${Math.round((now - s.lastFailAt) / 60000)}m ago`
                    : 'no failures recorded';
                const lastOk   = s.lastSuccessAt
                    ? `last ok ${Math.round((now - s.lastSuccessAt) / 60000)}m ago`
                    : 'never succeeded this session';
                return `${icon} *${api.name}*: ${s.count} failure(s)\n   ${lastFail} · ${lastOk}`;
            }).join('\n');

            let totalGrudges = 0;
            for (const [, profile] of profileCache.entries()) {
                for (const g of Object.values(profile.grudges ?? {})) {
                    if ((g as GrudgeRecord).active && Date.now() < (g as GrudgeRecord).expiresAt) totalGrudges++;
                }
            }

            return sock.sendMessage(chatId, {
                text:
                    `*📊 CHATBOT STATS*\n\n` +
                    `*Users cached in memory:* ${profileCache.size}\n` +
                    `*History entries cached:* ${historyCache.size}\n` +
                    `*Active grudges (all groups):* ${totalGrudges}\n` +
                    `*Failure auto-reset:* every ${API_FAILURE_RESET_MS / 60000}m\n\n` +
                    `*API Health:*\n${apiLines}`
            }, { quoted: message });
        }

        return sock.sendMessage(chatId, {
            text: '❌ *Invalid command*\n\nUse: `.chatbot on/off/stats/pardon/grudges`'
        }, { quoted: message });
    },

    handleChatbotResponse,
    loadUserGroupData,
    saveUserGroupData
};