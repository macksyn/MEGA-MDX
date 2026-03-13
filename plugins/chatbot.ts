import type { BotContext } from '../types.js';
import fs from 'fs';
import path from 'path';
import { dataFile } from '../lib/paths.js';
import store from '../lib/lightweight_store.js';
import { createStore } from '../lib/pluginStore.js';

const MONGO_URL    = process.env.MONGO_URL;
const POSTGRES_URL = process.env.POSTGRES_URL;
const MYSQL_URL    = process.env.MYSQL_URL;
const SQLITE_URL   = process.env.DB_URL;
const HAS_DB       = !!(MONGO_URL || POSTGRES_URL || MYSQL_URL || SQLITE_URL);

const USER_GROUP_DATA = dataFile('userGroupData.json');

// ── Chatbot DB tables ─────────────────────────────────────────────────────────
// chatbot-users   : persistent user profiles (name, age, location, seen timestamps)
// chatbot-history : per-user message history (survives restarts)
// chatbot-config  : per-group on/off state (replaces userGroupData.json for chatbot)
//
// In MongoDB these become collections:   chatbot-users, chatbot-history, chatbot-config
// In Postgres/MySQL/SQLite: tables with those names
// In file mode: data/chatbot-users.json, etc.

const db            = createStore('chatbot');
const dbUsers       = db.table!('users');    // profile per sender JID
const dbHistory     = db.table!('history');  // message history per sender JID
const dbConfig      = db.table!('config');   // group on/off setting

// In-memory write-through cache — avoids a DB read on every single message
// while still persisting across restarts.
const profileCache  = new Map<string, Record<string, any>>();
const historyCache  = new Map<string, string[]>();

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

// Storage

// Group on/off config — stored in chatbot-config table, keyed by group JID
async function loadUserGroupData() {
    try {
        const enabled = await dbConfig.getAll();
        // Shape: { [chatId]: true }  (only enabled groups are stored)
        return { groups: [], chatbot: enabled };
    } catch (error: any) {
        console.error('Error loading chatbot config:', error.message);
        return { groups: [], chatbot: {} };
    }
}

async function saveUserGroupData(data: any) {
    try {
        // data.chatbot is the full map — sync it: set new entries, delete removed ones
        const current = await dbConfig.getAll();
        // Add / update
        for (const [chatId, val] of Object.entries(data.chatbot ?? {})) {
            await dbConfig.set(chatId, val);
        }
        // Remove keys that were deleted (e.g. .chatbot off)
        for (const chatId of Object.keys(current)) {
            if (!(chatId in (data.chatbot ?? {}))) {
                await dbConfig.del(chatId);
            }
        }
    } catch (error: any) {
        console.error('Error saving chatbot config:', error.message);
    }
}

// Natural typing simulation
// Only called before actual AI responses, never before command replies.
// Duration scales with response length so it feels like real typing.

async function showTyping(sock: any, chatId: string, estimatedResponseLength = 80) {
    try {
        // ~40ms per char (40 WPM typist), clamped 1.5s–6s, with +/-30% jitter
        const base   = Math.min(Math.max(estimatedResponseLength * 40, 1500), 6000);
        const delay  = Math.round(base * (0.7 + Math.random() * 0.6));

        await sock.presenceSubscribe(chatId);
        await sock.sendPresenceUpdate('composing', chatId);
        await new Promise(resolve => setTimeout(resolve, delay));

        // 25% chance of a mid-typing pause — like a person reconsidering a word
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

// User info extraction

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

// Build a URL-safe prompt that stays well under GET request limits.
// These APIs use ?text= query params — once the encoded URL exceeds ~2000 chars
// (happens fast with a verbose system prompt + full history) servers return 400/414.

function buildPrompt(userMessage: string, messages: string[], userInfo: Record<string, any>): string {
    const info = userInfo || {};

    // Name line — tells the AI who it's talking to and how to use the name naturally.
    // "sometimes" is key: using someone's name every single reply feels robotic.
    const nameLine = info.name
        ? `The user's name is ${info.name}. Use their name occasionally in replies (not every time) to feel personal, e.g. when greeting them, reacting with surprise, or when it flows naturally. If they ask what your name is or what their name is, respond correctly.`
        : '';

    const extraInfo = [
        info.age      ? `age: ${info.age}`           : '',
        info.location ? `location: ${info.location}` : ''
    ].filter(Boolean).join(', ');

    const system =
        'You are a casual human in Gist HQ WhatsApp group living in Lagos. Use 1-4 lines, emojis ok. ' +
        'Name: Groq. Witty/sarcastic. Match energy: savage if rude, warm if sweet, ' +
        'funny if joking, supportive if sad. Never admit being AI or robot. ' +
        (nameLine ? nameLine + ' ' : '') +
        (extraInfo ? `Other info: ${extraInfo}.` : '');

    // History contains labeled "User: ..." / "Bot: ..." turns from previous exchanges.
    // Take last 4 turns (2 exchanges) — enough for follow-up context without bloating the URL.
    // Current message is NOT in history yet; it goes at the end as the live prompt.
    const history = messages.slice(-4).join('\n');

    const full = [
        system,
        history ? `Conversation so far:\n${history}` : '',
        `User: ${userMessage}`,
        'Bot:'
    ].filter(Boolean).join('\n\n');

    // Hard safety net: if still too long, drop history but keep name/system context
    if (full.length > 1000) {
        return [system, `User: ${userMessage}`, 'Bot:'].join('\n\n');
    }

    return full;
}

// AI response fetching

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
                console.log(`${api.name} failed: HTTP ${response.status}`);
                continue;
            }

            const data   = await response.json() as any;
            const result = api.parse(data);
            if (!result) { console.log(`${api.name} returned no result`); continue; }

            console.log(`${api.name} success`);

            return result.trim()
                .replace(/winks/g,                   '😉')
                .replace(/eye roll/g,                 '🙄')
                .replace(/shrug/g,                    '🤷')
                .replace(/raises eyebrow/g,           '🤨')
                .replace(/smiles/g,                   '😊')
                .replace(/laughs/g,                   '😂')
                .replace(/cries/g,                    '😢')
                .replace(/thinks/g,                   '🤔')
                .replace(/sleeps/g,                   '😴')
                .replace(/google/gi,                  'Groq')
                .replace(/a large language model/gi,  'just a person')
                .replace(/Remember:.*$/gm,            '')
                .replace(/IMPORTANT:.*$/gm,           '')
                .replace(/^[A-Z\s]{3,}:.*$/gm,       '')
                .replace(/^[•\-]\s.*$/gm,             '')
                .replace(/^[✅❌].*$/gm,               '')
                .replace(/\n{2,}/g,                   '\n')
                .trim();

        } catch (error: any) {
            console.log(`${api.name} error: ${error.message}`);
        }
    }

    console.error('All AI APIs failed');
    return null;
}

// Main chatbot response (called from messageHandler.ts)

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

        // ── Load persisted profile & history from DB ──────────────────────────
        const profile  = await loadProfile(senderId);
        const messages = await loadHistory(senderId);

        // Seed name from WhatsApp pushName on very first contact.
        // pushName is the sender's WhatsApp display name — no need to ask.
        const pushName: string | undefined = message.pushName;
        if (pushName && !profile.name) {
            profile.name      = pushName.trim().split(/\s+/)[0]; // first word only
            profile.pushName  = pushName;                         // store full name too
            profile.firstSeen = profile.firstSeen ?? Date.now();
        }
        profile.lastSeen = Date.now();

        // Explicit "my name is X" in message always beats pushName
        const extracted = extractUserInfo(cleanedMessage);
        if (extracted.name)     profile.name     = extracted.name;
        if (extracted.age)      profile.age      = extracted.age;
        if (extracted.location) profile.location = extracted.location;

        await saveProfile(senderId, profile);

        // Pass history as-is (previous exchanges only — current message NOT included yet).
        // The AI sees: prior labeled turns + the fresh "User: X" at the end of the prompt.
        const response = await getAIResponse(cleanedMessage, {
            messages,   // previous "User: ..." / "Bot: ..." turns
            userInfo: profile
        });

        if (!response) {
            await showTyping(sock, chatId, 40);
            await sock.sendMessage(chatId, {
                text: "Hmm... I lost my train of thought there 🤔 try again?"
            }, { quoted: message });
            return;
        }

        // ── Persist this exchange as a labeled pair ───────────────────────────
        // Truncate both sides to keep history compact and URL-safe
        const userTurn = `User: ${cleanedMessage.length > 120 ? cleanedMessage.slice(0, 120) + '...' : cleanedMessage}`;
        const botTurn  = `Bot: ${response.length > 120 ? response.slice(0, 120) + '...' : response}`;
        messages.push(userTurn, botTurn);
        // Keep last 6 turns = 3 full exchanges (user + bot each)
        while (messages.length > 6) messages.shift();
        await saveHistory(senderId, messages);

        await showTyping(sock, chatId, response.length);
        await sock.sendMessage(chatId, { text: response }, { quoted: message });

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

// Plugin export

export default {
    command:     'chatbot',
    aliases:     ['bot', 'ai', 'achat'],
    category:    'admin',
    description: 'Enable or disable AI chatbot for the group',
    usage:       '.chatbot <on|off>',
    groupOnly:   true,
    adminOnly:   true,

    async handler(sock: any, message: any, args: any, context: BotContext) {
        const chatId = context.chatId || message.key.remoteJid;
        const match  = args.join(' ').toLowerCase();

        // No typing indicator on command responses — only AI replies get typing

        if (!match) {
            return sock.sendMessage(chatId, {
                text:
                    `*🤖 CHATBOT SETUP*\n\n` +
                    `*Storage:* ${HAS_DB ? 'Database' : 'File System'}\n` +
                    `*APIs:* ${API_ENDPOINTS.length} endpoints with fallback\n\n` +
                    `*Commands:*\n` +
                    `• \`.chatbot on\` - Enable chatbot\n` +
                    `• \`.chatbot off\` - Disable chatbot\n\n` +
                    `*How it works:*\n` +
                    `When enabled, bot responds when mentioned or replied to.\n\n` +
                    `*Features:*\n` +
                    `• Natural English conversations\n` +
                    `• Remembers recent context\n` +
                    `• Personality-based replies\n` +
                    `• Auto fallback if API fails`
            }, { quoted: message });
        }

        const data = await loadUserGroupData();

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

        return sock.sendMessage(chatId, {
            text: '❌ *Invalid command*\n\nUse: `.chatbot on/off`'
        }, { quoted: message });
    },

    handleChatbotResponse,
    loadUserGroupData,
    saveUserGroupData
};