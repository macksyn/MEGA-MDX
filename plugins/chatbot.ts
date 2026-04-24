import type { BotContext } from '../types.js';
import { createStore } from '../lib/pluginStore.js';
import {
    detectInsult,
    getGrudge,
    setGrudge,
    clearGrudge,
    getGrudgeClapback,
    getThawMessage,
    type GrudgeRecord
} from '../lib/grudge.js';

const MONGO_URL    = process.env.MONGO_URL;
const POSTGRES_URL = process.env.POSTGRES_URL;
const MYSQL_URL    = process.env.MYSQL_URL;
const SQLITE_URL   = process.env.DB_URL;
const HAS_DB       = !!(MONGO_URL || POSTGRES_URL || MYSQL_URL || SQLITE_URL);

const db        = createStore('chatbot');
const dbUsers   = db.table!('users');
const dbHistory = db.table!('history');
const dbConfig  = db.table!('config');

const profileCache = new Map<string, Record<string, any>>();
const historyCache = new Map<string, string[]>();

// ── Per-user processing lock ──────────────────────────────────────────────────
const processingLock = new Set<string>();

// ── FIX #6: Cache eviction — prune idle entries every 2 hours ────────────────
const CACHE_TTL_MS      = 2 * 60 * 60 * 1000;
const cacheLastAccessed = new Map<string, number>();

setInterval(() => {
    const now   = Date.now();
    let evicted = 0;
    for (const [senderId, lastAt] of cacheLastAccessed.entries()) {
        if (now - lastAt > CACHE_TTL_MS) {
            // evict profile
            profileCache.delete(senderId);
            // evict ALL history entries belonging to this user (keyed as senderId__chatId)
            for (const hKey of historyCache.keys()) {
                if (hKey.startsWith(`${senderId}__`)) historyCache.delete(hKey);
            }
            cacheLastAccessed.delete(senderId);
            evicted++;
        }
    }
    if (evicted > 0) console.log(`[CACHE] Evicted ${evicted} idle user(s) from cache`);
}, CACHE_TTL_MS);

// ── Profile / history helpers ─────────────────────────────────────────────────

async function loadProfile(senderId: string): Promise<Record<string, any>> {
    cacheLastAccessed.set(senderId, Date.now());
    if (profileCache.has(senderId)) return profileCache.get(senderId)!;
    const stored = await dbUsers.get(senderId) ?? {};
    profileCache.set(senderId, stored);
    return stored;
}

async function saveProfile(senderId: string, profile: Record<string, any>): Promise<void> {
    cacheLastAccessed.set(senderId, Date.now());
    profileCache.set(senderId, profile);
    await dbUsers.set(senderId, profile);
}

// ── FIX #3: History keyed per user per group — prevents cross-group bleed ─────

function historyKey(senderId: string, chatId: string): string {
    return `${senderId}__${chatId}`;
}

async function loadHistory(senderId: string, chatId: string): Promise<string[]> {
    const key = historyKey(senderId, chatId);
    cacheLastAccessed.set(senderId, Date.now());
    if (historyCache.has(key)) return historyCache.get(key)!;
    const stored = await dbHistory.get(key) ?? [];
    historyCache.set(key, stored);
    return stored;
}

async function saveHistory(senderId: string, chatId: string, messages: string[]): Promise<void> {
    const key = historyKey(senderId, chatId);
    cacheLastAccessed.set(senderId, Date.now());
    historyCache.set(key, messages);
    await dbHistory.set(key, messages);
}

async function clearHistory(senderId: string, chatId: string): Promise<void> {
    const key = historyKey(senderId, chatId);
    historyCache.delete(key);
    await dbHistory.del(key);
}

// ── API endpoints ─────────────────────────────────────────────────────────────

const API_ENDPOINTS = [
    {
        name:   'GeminiRealtime',
        url:    'https://rynekoo-api.hf.space/text.gen/gemini/realtime',
        body:   (text: string, systemPrompt: string, sessionId?: string) => ({
            text,
            systemPrompt,
            ...(sessionId ? { sessionId } : {})
        }),
        parse:  (data: any) => data?.result?.text
            ? { text: data.result.text, sessionId: data.result.sessionId }
            : null
    },
    {
        name:   'CopilotAI',
        url:    'https://rynekoo-api.hf.space/text.gen/copilot',
        body:   (text: string, systemPrompt: string, _sessionId?: string) => ({
            text: `${systemPrompt}\n\n${text}`
        }),
        parse:  (data: any) => typeof data?.result?.text === 'string' && data.result.text
            ? { text: data.result.text }
            : null
    },
    {
        name:   'VeniceAI',
        url:    'https://rynekoo-api.hf.space/text.gen/venice',
        body:   (text: string, systemPrompt: string, _sessionId?: string) => ({
            text: `${systemPrompt}\n\n${text}`
        }),
        parse:  (data: any) => typeof data?.result === 'string' && data.result
            ? { text: data.result }
            : null
    },
    {
        name:   'FeloAI',
        url:    'https://rynekoo-api.hf.space/text.gen/feloai',
        body:   (text: string, systemPrompt: string, _sessionId?: string) => ({
            text: `${systemPrompt}\n\n${text}`
        }),
        parse:  (data: any) => typeof data?.result?.text === 'string' && data.result.text
            ? { text: data.result.text }
            : null
    }
];

const GEMINI_GRACE_MS = 10000;

const API_FAILURE_RESET_MS = 5 * 60 * 1000;
const API_SKIP_THRESHOLD   = 3;  // skip API once it hits this many recent failures

const apiStats: Record<string, { count: number; lastFailAt: number; lastSuccessAt: number }> = {};
API_ENDPOINTS.forEach(api => {
    apiStats[api.name] = { count: 0, lastFailAt: 0, lastSuccessAt: 0 };
});

setInterval(() => {
    const now = Date.now();
    for (const name of Object.keys(apiStats)) {
        if (apiStats[name].count > 0 && now - apiStats[name].lastFailAt > API_FAILURE_RESET_MS) {
            apiStats[name].count = 0;
            console.log(`[API] Reset failure count for ${name}`);
        }
    }
}, API_FAILURE_RESET_MS);

// ── FIX #4/#9: Skip APIs with too many recent failures ───────────────────────

function isApiHealthy(name: string): boolean {
    const s   = apiStats[name];
    const now = Date.now();
    if (s.count >= API_SKIP_THRESHOLD && now - s.lastFailAt < API_FAILURE_RESET_MS) {
        console.log(`[API] Skipping ${name} — ${s.count} recent failures`);
        return false;
    }
    return true;
}

// ── Chatbot config storage ────────────────────────────────────────────────────

async function loadUserGroupData() {
    try {
        const enabled = await dbConfig.getAll();
        return { chatbot: enabled };  // FIX #7: removed dead groups:[]
    } catch (error: any) {
        console.error('Error loading chatbot config:', error.message);
        return { chatbot: {} };
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

// ── Typing helpers ────────────────────────────────────────────────────────────

// FIX #1: startTyping fires BEFORE the API call so users see activity immediately
async function startTyping(sock: any, chatId: string): Promise<void> {
    try {
        await sock.presenceSubscribe(chatId);
        await sock.sendPresenceUpdate('composing', chatId);
    } catch (error: any) {
        console.error('Typing start error:', error.message);
    }
}

async function stopTyping(sock: any, chatId: string): Promise<void> {
    try {
        await sock.sendPresenceUpdate('paused', chatId);
    } catch (_) {}
}

async function showTyping(sock: any, chatId: string, estimatedResponseLength = 80): Promise<void> {
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

// ── Live query detector ───────────────────────────────────────────────────────

function requiresLiveData(message: string): boolean {
    const lower = message.toLowerCase();
    const livePatterns = [
        /\b(playing|match|game|score|fixture|result|vs\.?|versus|kickoff|kick.off|lineup|squad|today.s (game|match|fixture))\b/,
        /\b(today|tonight|right now|current(ly)?|live|latest|just now|this (week|month|season))\b/,
        /\b(news|headline|price|stock|weather|forecast|transfer|announce(d|ment)?|winner|champion)\b/,
        /\b(who is|who are|what is|what are|when is|when did|did .+ (win|lose|score|play))\b/,
        /\b(psg|chelsea|arsenal|barcelona|real madrid|man (city|utd|united)|liverpool|champions league|premier league|laliga|serie a|bundesliga|nba|nfl|nhl|uefa|fifa)\b/i
    ];
    return livePatterns.some(p => p.test(lower));
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPrompt(
    userMessage: string,
    userInfo: Record<string, any>
): { systemPrompt: string } {
    const info = userInfo || {};

    const nameLine = info.name
        ? `The user's name is ${info.name}. Use their name very occasionally — at most once in 3 conversations, only when it flows completely naturally. Never force it. If they ask what their name is, answer correctly.`
        : '';

    const extraInfo = [
        info.age      ? `age: ${info.age}`           : '',
        info.location ? `location: ${info.location}` : ''
    ].filter(Boolean).join(', ');

    const needsWeb       = requiresLiveData(userMessage);
    const webInstruction = needsWeb
        ? 'IMPORTANT: This question requires current real-time information — search the web before responding. Do not guess. '
        : '';

    // FIX #5: "Always reply in English" prevents FeloAI/others responding in wrong language
    // FIX #8: "1-4 lines" only stated once here, removed from textWithHistory
    const systemPrompt =
        'You are an intellectual social-savvy human in GHQ WhatsApp group. Name: Groq. ' +
        'Keep replies to 1-4 lines max, emojis ok. Always reply in English. ' +
        'You live in Lagos, Nigeria. ' +
        'Match the energy of whoever you\'re talking to — chill and warm for greetings, ' +
        'sarcastic when they\'re joking, savage when they\'re rude, supportive when they\'re down. ' +
        'Never force humour. Never admit being AI or robot. ' +
        (nameLine  ? nameLine  + ' ' : '') +
        (extraInfo ? `Other info: ${extraInfo}. ` : '') +
        webInstruction;

    return { systemPrompt };
}

// ── Single API attempt ────────────────────────────────────────────────────────

async function tryApi(
    api: typeof API_ENDPOINTS[number],
    textWithHistory: string,
    systemPrompt: string,
    sessionId: string | undefined
): Promise<{ text: string; sessionId?: string }> {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 15000);
    try {
        const response = await fetch(api.url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            signal:  controller.signal,
            body:    JSON.stringify(api.body(textWithHistory, systemPrompt, sessionId))
        });
        clearTimeout(timeoutId);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data   = await response.json() as any;
        const result = api.parse(data);
        if (!result) throw new Error('No result in response');
        return result;
    } catch (err) {
        clearTimeout(timeoutId);
        throw err;
    }
}

// ── Response cleaner ──────────────────────────────────────────────────────────

function cleanResponse(text: string): string {
    return text
        .trim()
        .replace(/winks/g,                             '😉')
        .replace(/eye roll/g,                           '🙄')
        .replace(/shrug/g,                              '🤷')
        .replace(/raises eyebrow/g,                     '🤨')
        .replace(/smiles/g,                             '😊')
        .replace(/laughs/g,                             '😂')
        .replace(/cries/g,                              '😢')
        .replace(/thinks/g,                             '🤔')
        .replace(/sleeps/g,                             '😴')
        .replace(/google/gi,                            'Groq')
        .replace(/a large language model/gi,            'just a person')
        .replace(/Remember:.*$/gm,                      '')
        .replace(/IMPORTANT:.*$/gm,                     '')
        .replace(/^(Groq|Bot|AI|Assistant)\s*:\s*/gim, '')
        // Strip Gemini promo leak — ordered safest to broadest
        .replace(/By the way, to unlock the full functionality of all Apps, enable\s*\[?Gemini Apps Activity\]?[^\n]*/gi, '')
        .replace(/\[Gemini Apps Activity\]\(https?:\/\/[^)]+\)/gi, '')
        .replace(/https?:\/\/myactivity\.\S+\/product\/gemini\S*/gi, '')
        .replace(/\n{2,}/g,  '\n')
        .trim();
}

// ── Promise.any polyfill (compatible with ES2019 and below) ─────────────────

function promiseAny<T>(promises: Promise<T>[]): Promise<T> {
    return new Promise((resolve, reject) => {
        let rejectedCount = 0;
        const errors: any[] = new Array(promises.length);
        promises.forEach((p, i) => {
            p.then(resolve).catch(err => {
                errors[i] = err;
                rejectedCount++;
                if (rejectedCount === promises.length) {
                    reject(new Error('All promises were rejected'));
                }
            });
        });
    });
}

// ── Real-time query detection ─────────────────────────────────────────────────
const REALTIME_PATTERNS = [
    /\b(match|fixture|score|result|epl|premier league|champions league|ucl|la liga|serie a|bundesliga)\b/i,
    /\b(playing (today|tonight|next|now)|next (match|game)|who (are|is) .+ playing)\b/i,
    /\b(latest|breaking|today'?s? news|current(ly)?|right now|as of today)\b/i,
    /\b(stock|crypto|bitcoin|price of|exchange rate|weather in)\b/i,
    /\b(who (won|scored|beat)|final score|live score|standings|table)\b/i,
];

function needsRealTimeSearch(message: string): boolean {
    return REALTIME_PATTERNS.some(p => p.test(message));
}

// ── AI call ───────────────────────────────────────────────────────────────────

async function getAIResponse(
    userMessage: string,
    userContext: { messages: string[]; userInfo: Record<string, any> },
    chatId: string,
    senderId: string
): Promise<string | null> {
    const { systemPrompt } = buildPrompt(userMessage, userContext.userInfo);

    const history = userContext.messages.slice(-4).join('\n');
    // FIX #8: Removed duplicate "1-4 lines" from here — it's in systemPrompt already
    const textWithHistory = [
        history ? `Conversation so far:\n${history}` : '',
        `User: ${userMessage}`,
        'Reply as Groq:'
    ].filter(Boolean).join('\n\n');

    const sessionKey   = `_sid_${chatId}`;
    const sessionId    = userContext.userInfo[sessionKey] as string | undefined;
    const healthyApis  = API_ENDPOINTS.filter(api => isApiHealthy(api.name));

    if (healthyApis.length === 0) {
        console.error('[API] No healthy APIs available');
        return null;
    }

    // ── Staggered race: Gemini gets a solo grace period, then others join ─────
    const gemini = healthyApis.find(api => api.name === 'GeminiRealtime');
    const others = healthyApis.filter(api => api.name !== 'GeminiRealtime');

    const startedApis: typeof API_ENDPOINTS = [];
    const inFlight: Promise<{ result: any; api: typeof API_ENDPOINTS[number] }>[] = [];

    const startApi = (api: typeof API_ENDPOINTS[number]) => {
        startedApis.push(api);
        return tryApi(api, textWithHistory, systemPrompt, sessionId)
            .then(result => ({ result, api }));
    };

    if (gemini) {
        const geminiPromise = startApi(gemini);
        console.log(`[API] ${gemini.name} started — solo grace period (${GEMINI_GRACE_MS}ms)`);

        type GraceOutcome =
            | { type: 'success'; winner: { result: any; api: typeof API_ENDPOINTS[number] } }
            | { type: 'fail'; err: any }
            | { type: 'timeout' };

        const graceResult: GraceOutcome = await Promise.race([
            geminiPromise
                .then(winner => ({ type: 'success' as const, winner }))
                .catch(err   => ({ type: 'fail'    as const, err })),
            new Promise<GraceOutcome>(resolve =>
                setTimeout(() => resolve({ type: 'timeout' }), GEMINI_GRACE_MS)
            )
        ]);

        if (graceResult.type === 'success') {
            const { winner } = graceResult;
            apiStats[winner.api.name].count         = 0;
            apiStats[winner.api.name].lastSuccessAt = Date.now();
            console.log(`[API] ${winner.api.name} won inside grace period`);

            if (winner.result.sessionId) {
                const profile = await loadProfile(senderId);
                profile[`_sid_${chatId}`] = winner.result.sessionId;
                await saveProfile(senderId, profile);
            }
            return cleanResponse(winner.result.text);
        }

        if (graceResult.type === 'fail') {
            apiStats[gemini.name].count++;
            apiStats[gemini.name].lastFailAt = Date.now();
            console.log(`[API] ${gemini.name} failed in grace period: ${graceResult.err?.message} — firing others now`);
            // Swallow any later state of the rejected gemini promise so we don't get an unhandled rejection
            geminiPromise.catch(() => {});
        } else {
            console.log(`[API] ${gemini.name} grace expired — firing others in parallel, ${gemini.name} stays in race`);
            // Keep Gemini in the race; ensure stats get recorded if it eventually rejects
            inFlight.push(geminiPromise);
            geminiPromise.catch(() => {
                apiStats[gemini.name].count++;
                apiStats[gemini.name].lastFailAt = Date.now();
                console.log(`[API] ${gemini.name} eventually failed after grace`);
            });
        }
    }

    // Fire the rest in parallel
    for (const api of others) {
        const p = startApi(api);
        inFlight.push(p);
        p.catch(err => {
            apiStats[api.name].count++;
            apiStats[api.name].lastFailAt = Date.now();
            console.log(`[API] ${api.name} failed in parallel race: ${err?.message}`);
        });
    }

    if (inFlight.length === 0) {
        console.error('[API] All APIs failed');
        return null;
    }

    try {
        const winner = await promiseAny(inFlight);

        apiStats[winner.api.name].count         = 0;
        apiStats[winner.api.name].lastSuccessAt = Date.now();
        console.log(`[API] ${winner.api.name} won parallel race`);

        if (winner.result.sessionId) {
            const profile = await loadProfile(senderId);
            profile[`_sid_${chatId}`] = winner.result.sessionId;
            await saveProfile(senderId, profile);
        }

        return cleanResponse(winner.result.text);
    } catch (_err) {
        console.error('[API] All APIs failed');
        return null;
    }
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
            const numPart  = jid.split('@')[0].split(':')[0];
            const isBotJid = botJids.some((b: string) => b.split('@')[0].split(':')[0] === numPart);
            if (isBotJid) continue;
            const contact     = contacts[jid] || contacts[`${numPart}@s.whatsapp.net`] || contacts[`${numPart}@lid`];
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
            const messages = await loadHistory(senderId, chatId);  // FIX #3

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

            // ── FIX #1: Typing starts BEFORE the API call ─────────────────────
            await startTyping(sock, chatId);

            const response = await getAIResponse(cleanedMessage, {
                messages,
                userInfo: profile
            }, chatId, senderId);

            await stopTyping(sock, chatId);

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
            await saveHistory(senderId, chatId, messages);  // FIX #3

            await showTyping(sock, chatId, response.length);
            await sock.sendMessage(chatId, { text: response }, { quoted: message });

        } finally {
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
    usage:       '.chatbot <on|off|stats|pardon|grudges|reset|history>',
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
                    `*APIs:* ${API_ENDPOINTS.length} endpoints with parallel + fallback\n\n` +
                    `*Commands:*\n` +
                    `• \`.chatbot on\` — Enable chatbot\n` +
                    `• \`.chatbot off\` — Disable chatbot\n` +
                    `• \`.chatbot stats\` — API health & memory stats\n` +
                    `• \`.chatbot pardon @user\` — Lift a grudge early\n` +
                    `• \`.chatbot grudges\` — List active grudges in this group\n` +
                    `• \`.chatbot reset @user\` — Clear a user's conversation history\n` +
                    `• \`.chatbot history @user\` — View a user's stored context\n\n` +
                    `*How it works:*\n` +
                    `When enabled, bot responds when mentioned or replied to.\n` +
                    `Top 2 APIs run in parallel — fastest wins. Others are sequential fallback.\n` +
                    `Failing APIs are skipped automatically after ${API_SKIP_THRESHOLD} failures.\n` +
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

        // ── FIX #10: reset @user ──────────────────────────────────────────────
        if (match.startsWith('reset')) {
            const mentioned = message.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!mentioned) {
                return sock.sendMessage(chatId, {
                    text: '❌ Mention the user to reset. Example: `.chatbot reset @username`'
                }, { quoted: message });
            }
            await clearHistory(mentioned, chatId);
            const tag = `@${mentioned.split('@')[0]}`;
            return sock.sendMessage(chatId, {
                text: `✅ Conversation history cleared for ${tag}. Fresh start 🧹`,
                mentions: [mentioned]
            }, { quoted: message });
        }

        // ── FIX #13: history @user ────────────────────────────────────────────
        if (match.startsWith('history')) {
            const mentioned = message.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!mentioned) {
                return sock.sendMessage(chatId, {
                    text: '❌ Mention the user to inspect. Example: `.chatbot history @username`'
                }, { quoted: message });
            }
            const hist = await loadHistory(mentioned, chatId);
            if (hist.length === 0) {
                return sock.sendMessage(chatId, {
                    text: `📭 No conversation history stored for @${mentioned.split('@')[0]}`,
                    mentions: [mentioned]
                }, { quoted: message });
            }
            return sock.sendMessage(chatId, {
                text: `*📜 HISTORY FOR @${mentioned.split('@')[0]}*\n\n${hist.join('\n')}\n\n_(${hist.length} entries)_`,
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
            const apiLines = API_ENDPOINTS.map((api, i) => {
                const s       = apiStats[api.name];
                const icon    = s.count === 0 ? '✅' : s.count < API_SKIP_THRESHOLD ? '⚠️' : '❌';
                const skipped = !isApiHealthy(api.name) ? ' [SKIPPED]' : '';
                const role    = i < 2 ? ' (parallel)' : ' (fallback)';
                const lastFail = s.lastFailAt
                    ? `last fail ${Math.round((now - s.lastFailAt) / 60000)}m ago`
                    : 'no failures recorded';
                const lastOk = s.lastSuccessAt
                    ? `last ok ${Math.round((now - s.lastSuccessAt) / 60000)}m ago`
                    : 'never succeeded this session';
                return `${icon} *${api.name}*${role}${skipped}: ${s.count} failure(s)\n   ${lastFail} · ${lastOk}`;
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
                    `*Storage:* ${HAS_DB ? 'Database' : 'File System'}\n` +
                    `*Users cached:* ${profileCache.size}\n` +
                    `*History entries cached:* ${historyCache.size}\n` +
                    `*Active grudges (all groups):* ${totalGrudges}\n` +
                    `*Failure reset interval:* every ${API_FAILURE_RESET_MS / 60000}m\n` +
                    `*API skip threshold:* ${API_SKIP_THRESHOLD} failures\n\n` +
                    `*API Health:*\n${apiLines}`
            }, { quoted: message });
        }

        return sock.sendMessage(chatId, {
            text: '❌ *Invalid command*\n\nUse: `.chatbot on/off/stats/pardon/grudges/reset/history`'
        }, { quoted: message });
    },

    handleChatbotResponse,
    loadUserGroupData,
    saveUserGroupData
};