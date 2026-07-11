import type { BotContext } from '../types.js';
import { createStore, getAdapter } from '../lib/pluginStore.js';
import {
    detectInsult,
    getGrudge,
    setGrudge,
    clearGrudge,
    getGrudgeClapback,
    getThawMessage,
    type GrudgeRecord
} from '../lib/grudge.js';
import { classifyIntent, compressHistory, extractPreferences, extractQuotedContext, getClarificationHint, getConfidenceLevel, getIntentInstruction, summarizeGroupHistory, summarizeProfile, type ChatIntent } from '../lib/intentRouter.js';

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

const processingLock = new Set<string>();

// ── OPT 1: groupMetadata TTL cache ───────────────────────────────────────────
// sock.groupMetadata() is a live WhatsApp network call. Without caching it fires
// on EVERY chatbot message — extremely wasteful since group membership barely
// changes between turns. A 10-minute TTL eliminates the round-trip for ~99% of
// messages while still reflecting kicks/joins promptly.
const GROUP_META_TTL_MS = 10 * 60 * 1000; // 10 minutes
interface GroupMetaEntry { meta: any; ts: number }
const groupMetaCache = new Map<string, GroupMetaEntry>();

async function getCachedGroupMeta(sock: any, chatId: string): Promise<any> {
    const cached = groupMetaCache.get(chatId);
    if (cached && Date.now() - cached.ts < GROUP_META_TTL_MS) {
        return cached.meta;
    }
    // Cache miss or TTL expired — fetch live and store
    const meta = await (sock as any).groupMetadata(chatId).catch(() => null);
    if (meta) groupMetaCache.set(chatId, { meta, ts: Date.now() });
    return meta;
}

// Invalidate a group's cached metadata immediately (call this on
// group-participants.update so kicks/joins are reflected without waiting for TTL)
export function invalidateGroupMetaCache(chatId: string): void {
    groupMetaCache.delete(chatId);
}

// ── OPT 2: per-connection botJids cache ──────────────────────────────────────
// sock.user.id / sock.user.lid never change after the WA connection is open.
// Rebuilding botJids on every single message is pure waste. We cache it once
// when the bot connects (via setBotJidsCache) and reuse it until a reconnect.
let _cachedBotJids: string[] | null = null;

export function setBotJidsCache(sock: any): void {
    const botId     = sock.user?.id ?? '';
    const botNumber = botId.split(':')[0];
    const botLid    = sock.user?.lid ?? '';
    _cachedBotJids = [
        botId,
        `${botNumber}@s.whatsapp.net`,
        `${botNumber}@whatsapp.net`,
    ];
    if (botLid) _cachedBotJids.push(botLid, `${botLid.split(':')[0]}@lid`);
    console.log(`[CHATBOT] botJids cached: ${_cachedBotJids.join(', ')}`);
}

function getBotJids(sock: any): string[] {
    // Return the cached array if available; fall back to building it live
    // (covers the rare case where handleChatbotResponse is called before
    // setBotJidsCache, e.g. in tests or an edge reconnect race).
    if (_cachedBotJids) return _cachedBotJids;
    const botId     = sock.user?.id ?? '';
    const botNumber = botId.split(':')[0];
    const botLid    = sock.user?.lid ?? '';
    const jids = [botId, `${botNumber}@s.whatsapp.net`, `${botNumber}@whatsapp.net`];
    if (botLid) jids.push(botLid, `${botLid.split(':')[0]}@lid`);
    return jids;
}

const CACHE_TTL_MS       = 2 * 60 * 60 * 1000;
const INACTIVE_DAYS      = 180;
const INACTIVE_MS        = INACTIVE_DAYS * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const cacheLastAccessed  = new Map<string, number>();

// ── Conversation session gap ─────────────────────────────────────────────────
// Personal/group history used to be plain string[] with no timestamp, so a
// reply from 3 days ago would get fed straight back into the prompt as if the
// conversation never stopped — confusing once the in-memory cache had been
// evicted (CACHE_TTL_MS) and the read fell through to raw DB data. Now every
// stored thread carries an `updatedAt`, and a thread older than the gap below
// is treated as a fresh conversation on next load. This ONLY affects the
// recent back-and-forth context — the user's profile (name, age, location,
// preferences) is untouched, so the bot still "remembers" the person, it just
// doesn't drag a stale, finished conversation into a new one.
const SESSION_GAP_HOURS       = Number(process.env.CHATBOT_SESSION_GAP_HOURS) || 4;
const SESSION_GAP_MS          = SESSION_GAP_HOURS * 60 * 60 * 1000;
const GROUP_SESSION_GAP_HOURS = Number(process.env.CHATBOT_GROUP_SESSION_GAP_HOURS) || SESSION_GAP_HOURS;
const GROUP_SESSION_GAP_MS    = GROUP_SESSION_GAP_HOURS * 60 * 60 * 1000;

// FIX: history turns used to be hard-truncated to 80 chars at SAVE time, on
// top of buildContextBlock's own char-budget trimming at PROMPT time. That
// double truncation was a major cause of "drift" on repeated questions — the
// model literally couldn't see the full text of what it said last time, so
// it re-derived a fresh (and often different) answer instead of recognising
// "I already answered this." 300 chars keeps a real answer intact while
// buildContextBlock still governs the overall prompt size.
const HISTORY_TURN_CHAR_LIMIT = 300;

setInterval(() => {
    const now   = Date.now();
    let evicted = 0;
    for (const [senderId, lastAt] of cacheLastAccessed.entries()) {
        if (now - lastAt > CACHE_TTL_MS) {
            profileCache.delete(senderId);
            for (const hKey of historyCache.keys()) {
                if (hKey.startsWith(`${senderId}__`)) historyCache.delete(hKey);
            }
            cacheLastAccessed.delete(senderId);
            evicted++;
        }
    }
    if (evicted > 0) console.log(`[CACHE] Evicted ${evicted} idle user(s) from cache`);
}, CACHE_TTL_MS);

// ── BUG FIX #6: track actually-pruned count, not raw history.length ──────────
async function pruneInactiveData(): Promise<void> {
    try {
        const adapter = await getAdapter();

        // FIX: file adapter returns ts:0 for every entry — pruning is a no-op and
        // wastes a full scan every 6 hours. Skip it entirely for the file backend.
        if ((adapter as any).name === 'file') return;

        const users   = await adapter.getAllWithMeta?.('chatbot_users')   ?? [];
        const history = await adapter.getAllWithMeta?.('chatbot_history') ?? [];
        const now     = Date.now();

        const inactiveUsers = new Set<string>();
        for (const entry of users) {
            const lastSeen = typeof entry.value?.lastSeen === 'number' ? entry.value.lastSeen : entry.ts;
            if (lastSeen && now - lastSeen > INACTIVE_MS) {
                inactiveUsers.add(entry.key);
            }
        }

        for (const key of inactiveUsers) {
            await dbUsers.del(key);
            profileCache.delete(key);
            cacheLastAccessed.delete(key);
            for (const hKey of historyCache.keys()) {
                if (hKey.startsWith(`${key}__`)) historyCache.delete(hKey);
            }
        }

        // FIX: count actually pruned history entries instead of using history.length
        let prunedHistory = 0;
        for (const entry of history) {
            const lastSeen = typeof entry.value?.lastSeen === 'number' ? entry.value.lastSeen : entry.ts;
            if (lastSeen && now - lastSeen > INACTIVE_MS) {
                await dbHistory.del(entry.key);
                historyCache.delete(entry.key);
                prunedHistory++;
            }
        }

        // Only log when something was actually removed
        if (inactiveUsers.size > 0 || prunedHistory > 0) {
            console.log(`[CLEANUP] Pruned ${inactiveUsers.size} inactive profile(s) and ${prunedHistory} history entry(s) older than ${INACTIVE_DAYS} days`);
        }
    } catch (error: any) {
        console.error('[CLEANUP] Failed to prune inactive data:', error.message);
    }
}

setInterval(() => { void pruneInactiveData(); }, CLEANUP_INTERVAL_MS);
void pruneInactiveData();

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

function historyKey(senderId: string, chatId: string): string {
    return `${senderId}__${chatId}`;
}

function groupHistoryKey(chatId: string): string {
    return `group__${chatId}`;
}

// Stored shape is now { messages, updatedAt } instead of a bare array, so we
// can tell how long ago a thread last had a turn added to it.
interface StoredHistory { messages: string[]; updatedAt: number }

function normalizeStoredHistory(raw: any): StoredHistory {
    if (Array.isArray(raw)) {
        // Legacy format from before session-gap tracking existed: a bare
        // string[] with no timestamp. Treat it as "just now" rather than
        // "unknown/ancient" so we don't yank an in-flight conversation out
        // from under someone the moment this ships — it naturally gains a
        // real timestamp on the very next save either way.
        return { messages: raw, updatedAt: Date.now() };
    }
    if (raw && typeof raw === 'object' && Array.isArray(raw.messages)) {
        return {
            messages:  raw.messages,
            updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now()
        };
    }
    return { messages: [], updatedAt: 0 };
}

async function loadHistory(senderId: string, chatId: string): Promise<string[]> {
    const key = historyKey(senderId, chatId);
    cacheLastAccessed.set(senderId, Date.now());
    if (historyCache.has(key)) return historyCache.get(key)!;

    const { messages, updatedAt } = normalizeStoredHistory(await dbHistory.get(key));

    if (messages.length > 0 && Date.now() - updatedAt > SESSION_GAP_MS) {
        // Long enough since the last turn — start this thread fresh. We don't
        // need to delete it from the DB: the next saveHistory() call will
        // overwrite it with the new thread anyway.
        console.log(`[HISTORY] Session gap (${SESSION_GAP_HOURS}h) exceeded for ${key} — starting fresh thread`);
        historyCache.set(key, []);
        return [];
    }

    historyCache.set(key, messages);
    return messages;
}

async function saveHistory(senderId: string, chatId: string, messages: string[]): Promise<void> {
    const key = historyKey(senderId, chatId);
    cacheLastAccessed.set(senderId, Date.now());
    historyCache.set(key, messages);
    await dbHistory.set(key, { messages, updatedAt: Date.now() } as any);
}

async function clearHistory(senderId: string, chatId: string): Promise<void> {
    const key = historyKey(senderId, chatId);
    historyCache.delete(key);
    await dbHistory.del(key);
}

// ── BUG FIX #4: store raw messages; summarise only on load ───────────────────
async function loadGroupHistory(chatId: string): Promise<string[]> {
    const key = groupHistoryKey(chatId);
    const { messages, updatedAt } = normalizeStoredHistory(await dbHistory.get(key));

    if (messages.length > 0 && Date.now() - updatedAt > GROUP_SESSION_GAP_MS) {
        console.log(`[HISTORY] Group session gap (${GROUP_SESSION_GAP_HOURS}h) exceeded for ${key} — starting fresh thread`);
        return [];
    }

    // Summarise on load only — never on save
    return summarizeGroupHistory(messages);
}

async function saveGroupHistory(chatId: string, messages: string[]): Promise<void> {
    const key = groupHistoryKey(chatId);
    // FIX: store raw messages — no summariseGroupHistory() call here.
    // loadGroupHistory() handles the summarisation on read.
    await dbHistory.set(key, { messages, updatedAt: Date.now() } as any);
    // Also keep the in-memory cache in sync (store raw so load can summarise)
    // No historyCache entry for group keys — group history is always fetched from DB.
}

// ── Groq API config ───────────────────────────────────────────────────────────
// Single provider now: Groq's Compound system (built-in web search + code
// execution, no more juggling three flaky third-party proxies). We keep a
// primary/fallback pair so the existing health-tracking/circuit-breaker logic
// still has something useful to do if the primary compound model is degraded.

const GROQ_API_KEY = process.env.GROQ_API_KEY ?? '';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const GROQ_MODELS = [
    {
        name:  'groq/compound',       // primary — multi-tool-call agentic model
        model: process.env.GROQ_MODEL ?? 'groq/compound'
    },
    {
        name:  'groq/compound-mini',  // fallback — single-tool-call, lower latency
        model: process.env.GROQ_FALLBACK_MODEL ?? 'groq/compound-mini'
    }
];

const API_FAILURE_RESET_MS = 5 * 60 * 1000;
const API_SKIP_THRESHOLD   = 3;

// ── Temperature by intent ─────────────────────────────────────────────────────
// A single flat temperature (0.85) was applied to every reply regardless of
// intent. That's fine for banter, but it's exactly why factual/realtime
// questions "drifted" on repeat: high sampling temperature on top of the
// compound model's own live web-search variance meant two runs of the same
// question could land on different phrasing AND different facts. Casual chat
// keeps a high temperature for personality; anything where getting the facts
// right matters gets a much lower one so it converges on a consistent answer.
const TEMPERATURE_BY_INTENT: Record<ChatIntent, number> = {
    casual:     0.8,
    help:       0.4,
    moderation: 0.3,
    learning:   0.4,
    realtime:   0.3
};

const apiStats: Record<string, { count: number; lastFailAt: number; lastSuccessAt: number }> = {};
GROQ_MODELS.forEach(m => {
    apiStats[m.name] = { count: 0, lastFailAt: 0, lastSuccessAt: 0 };
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
        return { chatbot: enabled };
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

// ── Name helpers ──────────────────────────────────────────────────────────────

/**
 * Extract the first real name word from a WhatsApp pushName.
 * Returns null if the name is absent, too short, or consists only of
 * emoji / non-letter characters.
 */
function extractFirstName(pushName: string | undefined): string | null {
    if (!pushName) return null;
    // Split into whitespace-delimited tokens, then strip every non-letter character
    // (emoji, symbols, punctuation) from each token. Return the first token that
    // still has ≥2 Unicode letters after stripping.
    // This handles cases like "👑Alex 👑", "👑 Alex", "Alex👑", "~Tunde~", etc.
    const tokens = pushName.trim().split(/\s+/);
    for (const token of tokens) {
        const letters = token.replace(/[^\p{L}'\-]/gu, '');
        if (letters.length >= 2) {
            return letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase();
        }
    }
    return null;
}

/** True if the text looks like an affirmative confirmation */
function isAffirmative(text: string): boolean {
    return /^\s*(yes|yeah|yep|yup|yh|yas|correct|right|sure|ok|okay|that'?s (right|correct|me)|absolutely|exactly|confirmed?|go ahead|perfect|true)\b/i.test(text.trim());
}

/** True if the text looks like a denial */
function isNegative(text: string): boolean {
    return /^\s*(no|nope|nah|nah+|not (right|correct|me|really)|wrong|that'?s (wrong|not (right|me))|different|change it|incorrect)\b/i.test(text.trim());
}

/**
 * Try to pull a name out of a short reply during name-collection flow.
 * Works for formal patterns ("My name is X") and bare short replies ("just call me Tunde").
 */
function parseNameFromReply(text: string): string | null {
    const t = text.trim();
    if (!t) return null;

    // Formal patterns from extractUserInfo
    const namePatterns = [
        /\bmy\s+name\s+is\s+([a-z][a-z'\-]{1,20})/i,
        /\bcall\s+me\s+([a-z][a-z'\-]{1,20})\b/i,
        /\bi\s+am\s+([a-z][a-z'\-]{1,20})\b/i,
        /\bI'm\s+([a-z][a-z'\-]{1,20})\b/i,
        /\bit'?s\s+([a-z][a-z'\-]{1,20})\b/i,
        /\bjust\s+(?:call\s+me\s+)?([a-z][a-z'\-]{1,20})\b/i,
    ];
    for (const p of namePatterns) {
        const m = t.match(p);
        if (m?.[1]) return m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    }

    // If the reply is short (1–3 words, only letters/hyphens/apostrophes), treat it as a name
    const words = t.split(/\s+/);
    if (words.length >= 1 && words.length <= 3) {
        const onlyNameChars = words.every(w => /^[a-zA-Z'\-]+$/.test(w));
        if (onlyNameChars && words[0].length >= 2) {
            return words[0].charAt(0).toUpperCase() + words[0].slice(1).toLowerCase();
        }
    }

    return null;
}

// ── User info extractor ───────────────────────────────────────────────────────

function extractUserInfo(message: string) {
    const text = message.trim();
    const info: Record<string, any> = {};

    const namePatterns = [
        /\bmy\s+name\s+is\s+([a-z][a-z'-]{1,20})/i,
        /\bi\s+am\s+([a-z][a-z'-]{1,20})\b/i,
        /\bcall\s+me\s+([a-z][a-z'-]{1,20})\b/i,
        /\bI'm\s+([a-z][a-z'-]{1,20})\b/i
    ];
    for (const pattern of namePatterns) {
        const match = text.match(pattern);
        if (match?.[1]) {
            info.name = match[1].replace(/^./, c => c.toUpperCase());
            break;
        }
    }

    const ageMatch = text.match(/\b(?:i am|i'm|i'm|my age is)\s*(\d{1,3})\b/i)
        ?? text.match(/\b(\d{1,3})\s*(?:years?|yrs?)\s+old\b/i);
    if (ageMatch?.[1]) info.age = ageMatch[1];

    const locationMatch = text.match(/\b(?:i live in|i'm from|i'm from|my city is|my country is|i am from)\s+([a-z][a-z ,.-]{1,40})/i)
        ?? text.match(/\b(?:from|in)\s+([a-z][a-z ,.-]{1,40})\b/i);
    if (locationMatch?.[1]) {
        info.location = locationMatch[1].replace(/[.,!?]+$/g, '').trim();
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
): { systemPrompt: string; intent: ChatIntent } {
    const info = userInfo || {};

    const nameLine = info.name
        ? `The user's name is ${info.name}. Use their name naturally and occasionally without forcing it.`
        : '';

    const extraInfo = [
        info.age      ? `age: ${info.age}`           : '',
        info.location ? `location: ${info.location}` : ''
    ].filter(Boolean).join(', ');
    const memoryLine       = summarizeProfile(info);
    const groupContextLine = info.groupContext  ? `Group context: ${info.groupContext} ` : '';
    const quotedContextLine = info.quotedContext
        ? `Quoted follow-up context: the user is replying to a previous bot message: "${info.quotedContext.substring(0, 80)}". Treat pronouns like "that", "him", "her", "it", or "they" as references to this quoted message when relevant. Answer as a direct follow-up to that exchange, not as a new topic. `
        : '';

    const intent            = classifyIntent(userMessage);
    const confidence        = getConfidenceLevel(userMessage);
    const clarification     = getClarificationHint(intent, confidence);
    const needsWeb          = requiresLiveData(userMessage) || intent === 'realtime';
    const webInstruction    = needsWeb
        ? 'IMPORTANT: This question requires current real-time information — search the web before responding. Do not guess. '
        : '';
    const intentInstruction = getIntentInstruction(intent);
    // FIX: repeated questions were "drifting" — the model had no instruction
    // to check its own prior answers, so identical questions asked minutes
    // apart could get different facts each time. Point it at the history
    // block explicitly. IMPORTANT: this must not read as "defend whatever
    // you said before" — the goal is consistent behaviour on facts you're
    // actually confident about, not stubbornness on facts you got wrong. If
    // a fresh search turns up different/better information, or you can tell
    // the earlier answer was a mistake, correct it plainly instead of
    // repeating the error.
    const consistencyLine =
        'If "Recent Chat" above shows you already answered this same or a very similar question, ' +
        'stay consistent — don\'t restate it differently just for variety, and don\'t contradict yourself ' +
        'for no reason. But if you now have better information, or you can tell your earlier answer was ' +
        'actually wrong, correct it plainly like a person admitting a mistake — don\'t repeat an error just ' +
        'to seem consistent. ';

    const systemPrompt =
        'You are a wise, super intelligent and straight forward human in GHQ WhatsApp group. Name: Groq. ' +
        'Keep replies to 1-7 lines max, emojis ok. Always reply in English. ' +
        'You live in Lagos, Nigeria. ' +
        intentInstruction + ' ' +
        `Confidence: ${confidence}. ${clarification} ` +
        'Match the energy of whoever you\'re talking to — chill and warm for greetings, ' +
        'sarcastic when they\'re joking, savage when they\'re rude, supportive when they\'re down. ' +
        'Explain deeply when a curiosity is shown, but don\'t over-explain. ' +
        'Never force humour. Never admit being AI or robot. ' +
        (nameLine  ? nameLine  + ' ' : '') +
        (extraInfo ? `Other info: ${extraInfo}. ` : '') +
        groupContextLine +
        quotedContextLine +
        memoryLine + ' ' +
        webInstruction +
        consistencyLine;

    return { systemPrompt, intent };
}

// ── Context block builder ─────────────────────────────────────────────────────
// Groq's chat completions endpoint takes a JSON body (no URL length limit), so
// this is just a sane token/cost budget rather than a hard URL constraint.
// History is dropped oldest-first if it doesn't fit.

function buildContextBlock(
    summary: string | null,
    recentHistory: string[],
    userMessage: string,
    maxChars: number = 6000
): string {
    const baseLength   = `User: ${userMessage}`.length + 20;
    let availableSpace = maxChars - baseLength;

    const safeHistory: string[] = [];
    for (let i = recentHistory.length - 1; i >= 0; i--) {
        const msg = recentHistory[i];
        const len = msg.length + 1;
        if (availableSpace >= len) {
            safeHistory.unshift(msg);
            availableSpace -= len;
        } else {
            break;
        }
    }

    let finalSummary = '';
    if (summary) {
        const len = summary.length + 2;
        if (availableSpace >= len) finalSummary = summary;
    }

    return [
        finalSummary ? finalSummary : '',
        safeHistory.length > 0 ? `Recent Chat:\n${safeHistory.join('\n')}` : '',
        `User: ${userMessage}`
    ].filter(Boolean).join('\n\n');
}

// ── Single Groq call ──────────────────────────────────────────────────────────

async function callGroq(
    modelEntry: typeof GROQ_MODELS[number],
    systemPrompt: string,
    contextBlock: string,
    temperature: number
): Promise<{ text: string }> {
    if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY is not set');

    const controller = new AbortController();
    // Compound models can take longer than a plain chat model since they may
    // run a web search or code execution round-trip before answering.
    const timeoutId = setTimeout(() => controller.abort(), 25000);
    try {
        const response = await fetch(GROQ_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model: modelEntry.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user',   content: contextBlock }
                ],
                temperature,
                max_completion_tokens: 500,
                // Compound systems can auto-append web-search citations; we want
                // short, clean WhatsApp replies rather than footnoted answers.
                citation_options: 'disabled'
            }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!response.ok) {
            const errBody = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status}${errBody ? `: ${errBody.slice(0, 200)}` : ''}`);
        }
        const data = await response.json() as any;
        const text = data?.choices?.[0]?.message?.content;
        if (typeof text !== 'string' || !text.trim()) throw new Error('Empty response from Groq');
        return { text };
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
        .replace(/By the way, to unlock the full functionality of all Apps, enable\s*\[?Gemini Apps Activity\]?[^\n]*/gi, '')
        .replace(/\[Gemini Apps Activity\]\(https?:\/\/[^)]+\)/gi, '')
        .replace(/https?:\/\/myactivity\.\S+\/product\/gemini\S*/gi, '')
        .replace(/\n{2,}/g,  '\n')
        .trim();
}

// ── AI call ───────────────────────────────────────────────────────────────────

async function getAIResponse(
    userMessage: string,
    userContext: { messages: string[]; userInfo: Record<string, any> },
    _chatId: string,
    _senderId: string
): Promise<string | null> {
    const { systemPrompt, intent } = buildPrompt(userMessage, userContext.userInfo);
    const temperature = TEMPERATURE_BY_INTENT[intent];

    const compressed  = compressHistory(userContext.messages, 6);
    const contextBlock = buildContextBlock(
        compressed.summary || null,
        compressed.recent,
        userMessage
    );

    const recordSuccess = (name: string) => {
        apiStats[name].count         = 0;
        apiStats[name].lastSuccessAt = Date.now();
    };
    const recordFailure = (name: string) => {
        apiStats[name].count++;
        apiStats[name].lastFailAt = Date.now();
    };

    const healthyModels = GROQ_MODELS.filter(m => isApiHealthy(m.name));
    if (healthyModels.length === 0) {
        console.error('[GROQ] No healthy models available');
        return null;
    }

    // Sequential primary → fallback. Groq is fast enough on its own that
    // racing multiple models in parallel just burns extra rate-limit quota
    // for no real latency win — try compound first, fall back to
    // compound-mini only if the primary actually fails.
    for (const modelEntry of healthyModels) {
        try {
            const result = await callGroq(modelEntry, systemPrompt, contextBlock, temperature);
            recordSuccess(modelEntry.name);
            console.log(`[GROQ] ${modelEntry.name} responded (intent=${intent}, temp=${temperature})`);
            return cleanResponse(result.text);
        } catch (err: any) {
            recordFailure(modelEntry.name);
            console.log(`[GROQ] ${modelEntry.name} failed: ${err?.message}`);
        }
    }

    console.error('[GROQ] All models failed');
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
        // ── OPT 2: use pre-resolved botJids (cached at connection time) ─────
        // getBotJids() returns the module-level _cachedBotJids set by
        // setBotJidsCache() when the socket connected. Falls back to building
        // it live if called before the cache was populated (edge case only).
        const botJids  = getBotJids(sock);
        const botId     = sock.user?.id ?? '';
        const botNumber = botId.split(':')[0];

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

        // Resolve @mentions to display names
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

        // ── OPT 1: use TTL-cached groupMetadata (10-minute window) ──────────
        // Avoids a live WA network fetch on every chatbot message. The cache is
        // invalidated immediately by invalidateGroupMetaCache() on participant
        // updates so kicks/joins are still reflected promptly.
        const groupMeta = await getCachedGroupMeta(sock, chatId);
        const memberNames = (groupMeta?.participants || [])
            .map((p: any) => p?.notify || p?.name || p?.subject || p?.id)
            .filter(Boolean)
            .slice(0, 10);
        const groupLabel = memberNames.length
            ? `Group context: this chat includes ${memberNames.join(', ')}. Keep replies anchored to the current topic and the member asking the question.`
            : 'Group context: this is a group chat. Keep replies anchored to the current topic and the person asking the question.';

        // Grudge check
        const activeGrudge = await getGrudge(chatId, senderId, profileCache);
        if (activeGrudge) {
            console.log(`[GRUDGE] Silent treatment: ${senderId.split('@')[0]} (expires in ${Math.round((activeGrudge.expiresAt - Date.now()) / 3600000)}h)`);
            return;
        }

        // ── BUG FIX #1: processing lock is now INSIDE the try so the finally
        //    that removes it is always reachable, even if startTyping() throws. ──
        try {
            processingLock.add(senderId);

            if (processingLock.size > 1 && processingLock.has(senderId)) {
                // senderId was already in the lock before we added it — concurrent call
                // Note: Set.add is idempotent, so check before adding instead
            }

            // Insult detection
            const insult = detectInsult(cleanedMessage);
            if (insult.hit) {
                const grudge   = await setGrudge(chatId, senderId, insult.severity, cleanedMessage, profileCache);
                const clapback = getGrudgeClapback(insult.severity);
                const hoursLeft = Math.round((grudge.expiresAt - Date.now()) / 3600000);
                console.log(`[GRUDGE] Set for ${senderId.split('@')[0]} — severity: ${insult.severity}, matched: ${insult.matchedLabels.join(', ')}, duration: ${hoursLeft}h, strikes: ${grudge.strikes}`);
                await new Promise(r => setTimeout(r, 1200 + Math.random() * 1000));
                await sock.sendMessage(chatId, { text: clapback }, { quoted: message });
                return;
            }

            // Thaw check
            const profile    = await loadProfile(senderId);
            const wasGrudged = profile._justThawed?.[chatId];
            if (wasGrudged) {
                if (profile._justThawed) delete profile._justThawed[chatId];
                await saveProfile(senderId, profile);
                await showTyping(sock, chatId, 20);
                await sock.sendMessage(chatId, { text: getThawMessage() }, { quoted: message });
                return;
            }

            // Normal flow
            const sharedMessages = await loadGroupHistory(chatId);
            const userMessages   = await loadHistory(senderId, chatId);
            const messages       = [...sharedMessages, ...userMessages].slice(-8);

            // ── Name resolution: WhatsApp first name takes priority ───────────
            // 1. Try to extract a clean first name from WhatsApp's pushName.
            // 2. If that yields nothing (absent / emoji-only), enter a name-collection
            //    state machine so we ask the user directly and confirm before saving.
            const pushName: string | undefined = message.pushName;
            const waFirstName = extractFirstName(pushName);

            if (waFirstName && !profile.name) {
                // Got a real name from WhatsApp — use it directly, no need to ask
                profile.name      = waFirstName;
                profile.pushName  = pushName;
                profile.firstSeen = profile.firstSeen ?? Date.now();
            }
            profile.lastSeen = Date.now();

            // ── Name state machine (runs only when WA name is unavailable) ────
            // States stored on profile:
            //   _nameState  : 'awaiting_name' | 'confirming_name' | undefined
            //   _namePending: candidate name waiting for user confirmation

            if (!profile.name) {
                if (profile._nameState === 'confirming_name') {
                    // User replied to our "is your name X?" question
                    if (isAffirmative(cleanedMessage)) {
                        profile.name = profile._namePending as string;
                        delete profile._nameState;
                        delete profile._namePending;
                        await saveProfile(senderId, profile);
                        await showTyping(sock, chatId, 30);
                        await sock.sendMessage(chatId, {
                            text: `Got it, ${profile.name}! Nice to meet you 😊`
                        }, { quoted: message });
                        return;
                    } else if (isNegative(cleanedMessage)) {
                        profile._nameState = 'awaiting_name';
                        delete profile._namePending;
                        await saveProfile(senderId, profile);
                        await showTyping(sock, chatId, 30);
                        await sock.sendMessage(chatId, {
                            text: `My bad! What should I call you then?`
                        }, { quoted: message });
                        return;
                    } else {
                        // Unclear reply — try parsing it as a name directly
                        const candidate = parseNameFromReply(cleanedMessage);
                        if (candidate) {
                            profile._namePending = candidate;
                            await saveProfile(senderId, profile);
                            await showTyping(sock, chatId, 40);
                            await sock.sendMessage(chatId, {
                                text: `Just to confirm — should I call you *${candidate}*?`
                            }, { quoted: message });
                            return;
                        }
                        // Still unclear — re-confirm the original candidate
                        await showTyping(sock, chatId, 40);
                        await sock.sendMessage(chatId, {
                            text: `Sorry, didn't catch that! Is *${profile._namePending}* your name? (yes/no)`
                        }, { quoted: message });
                        return;
                    }
                }

                if (profile._nameState === 'awaiting_name') {
                    // User replied to our "what's your name?" question
                    const candidate = parseNameFromReply(cleanedMessage);
                    if (candidate) {
                        profile._nameState  = 'confirming_name';
                        profile._namePending = candidate;
                        await saveProfile(senderId, profile);
                        await showTyping(sock, chatId, 40);
                        await sock.sendMessage(chatId, {
                            text: `Just to confirm — should I call you *${candidate}*?`
                        }, { quoted: message });
                        return;
                    }
                    // Couldn't parse a name — ask again
                    await showTyping(sock, chatId, 30);
                    await sock.sendMessage(chatId, {
                        text: `Hmm, what's your name? Just drop it here and I'll remember you 😄`
                    }, { quoted: message });
                    return;
                }

                // No name and no active state — first time talking, ask politely
                profile._nameState = 'awaiting_name';
                profile.firstSeen  = profile.firstSeen ?? Date.now();
                await saveProfile(senderId, profile);
                await showTyping(sock, chatId, 50);
                await sock.sendMessage(chatId, {
                    text: `Hey! Before we chat — what's your name? 😊`
                }, { quoted: message });
                return;
            }

            // ── OPT 3: skip extractUserInfo when profile is already complete ──
            // The regex scan across name/age/location patterns runs on every single
            // message. Short-circuit as soon as all three fields are known — users
            // rarely re-state their own name/age/location mid-conversation.
            const profileNeedsExtraction = !profile.age || !profile.location;
            if (profileNeedsExtraction) {
                const extracted = extractUserInfo(cleanedMessage);
                if (extracted.age)      profile.age      = extracted.age;
                if (extracted.location) profile.location = extracted.location;
            }

            const preferences = extractPreferences(cleanedMessage);
            if (Object.keys(preferences).length > 0) {
                profile.preferences = { ...(profile.preferences ?? {}), ...preferences };
            }

            await saveProfile(senderId, profile);

            // Typing starts BEFORE the API call
            await startTyping(sock, chatId);

            const quotedContext = extractQuotedContext(message);
            const response = await getAIResponse(cleanedMessage, {
                messages,
                userInfo: { ...profile, groupContext: groupLabel, quotedContext }
            }, chatId, senderId);

            await stopTyping(sock, chatId);

            if (!response) {
                await showTyping(sock, chatId, 40);
                await sock.sendMessage(chatId, {
                    text: "Hmm... I lost my train of thought there 🤔 try again?"
                }, { quoted: message });
                return;
            }

            await showTyping(sock, chatId, response.length);

            // ── BUG FIX #2: send the message FIRST, save history only after
            //    successful delivery — prevents persisting undelivered bot turns. ──
            await sock.sendMessage(chatId, { text: response }, { quoted: message });

            // Build updated history threads
            const userTurn     = `User (${senderId.split('@')[0]}): ${cleanedMessage.length > HISTORY_TURN_CHAR_LIMIT ? cleanedMessage.slice(0, HISTORY_TURN_CHAR_LIMIT) + '...' : cleanedMessage}`;
            const botTurn      = `Bot: ${response.length > HISTORY_TURN_CHAR_LIMIT ? response.slice(0, HISTORY_TURN_CHAR_LIMIT) + '...' : response}`;
            const sharedThread   = [...sharedMessages, userTurn, botTurn].slice(-8);
            const personalThread = [...userMessages,   userTurn, botTurn].slice(-8);

            // Parallel save — both writes happen simultaneously (optimisation bonus)
            await Promise.all([
                saveGroupHistory(chatId, sharedThread),
                saveHistory(senderId, chatId, personalThread),
            ]);

        } finally {
            // FIX #1: this finally is guaranteed to run even if startTyping() throws
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
                    `*Model:* Groq Compound (web search + code execution built in)\n\n` +
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
                    `Uses groq/compound first, falls back to groq/compound-mini if it's unhealthy.\n` +
                    `A model is skipped automatically after ${API_SKIP_THRESHOLD} failures.\n` +
                    `Insult the bot → it claps back once then ignores you for hours.\n\n` +
                    `*Grudge tiers:*\n` +
                    `• Mild insult → 2 hours silent treatment\n` +
                    `• Medium insult → 6 hours silent treatment\n` +
                    `• Heavy insult → 24 hours silent treatment\n` +
                    `• Repeat offender → duration multiplies per strike`
            }, { quoted: message });
        }

        const data = await loadUserGroupData();

        if (match === 'on') {
            if (data.chatbot[chatId]) {
                return sock.sendMessage(chatId, { text: '⚠️ *Chatbot is already enabled for this group*' }, { quoted: message });
            }
            data.chatbot[chatId] = true;
            await saveUserGroupData(data);
            return sock.sendMessage(chatId, { text: '✅ *Chatbot enabled!*\n\nMention me or reply to my messages to chat.' }, { quoted: message });
        }

        if (match === 'off') {
            if (!data.chatbot[chatId]) {
                return sock.sendMessage(chatId, { text: '⚠️ *Chatbot is already disabled for this group*' }, { quoted: message });
            }
            delete data.chatbot[chatId];
            await saveUserGroupData(data);
            return sock.sendMessage(chatId, { text: '❌ *Chatbot disabled!*\n\nI will no longer respond to mentions.' }, { quoted: message });
        }

        if (match.startsWith('pardon')) {
            const mentioned = message.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!mentioned) {
                return sock.sendMessage(chatId, { text: '❌ Mention the user to pardon. Example: `.chatbot pardon @username`' }, { quoted: message });
            }
            await clearGrudge(chatId, mentioned, profileCache);
            const tag = `@${mentioned.split('@')[0]}`;
            return sock.sendMessage(chatId, { text: `✅ Grudge cleared for ${tag}. They can talk to me again.`, mentions: [mentioned] }, { quoted: message });
        }

        if (match.startsWith('reset')) {
            const mentioned = message.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!mentioned) {
                return sock.sendMessage(chatId, { text: '❌ Mention the user to reset. Example: `.chatbot reset @username`' }, { quoted: message });
            }
            await clearHistory(mentioned, chatId);
            const tag = `@${mentioned.split('@')[0]}`;
            return sock.sendMessage(chatId, { text: `✅ Conversation history cleared for ${tag}. Fresh start 🧹`, mentions: [mentioned] }, { quoted: message });
        }

        if (match.startsWith('history')) {
            const mentioned = message.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!mentioned) {
                return sock.sendMessage(chatId, { text: '❌ Mention the user to inspect. Example: `.chatbot history @username`' }, { quoted: message });
            }
            const hist = await loadHistory(mentioned, chatId);
            if (hist.length === 0) {
                return sock.sendMessage(chatId, { text: `📭 No conversation history stored for @${mentioned.split('@')[0]}`, mentions: [mentioned] }, { quoted: message });
            }
            return sock.sendMessage(chatId, { text: `*📜 HISTORY FOR @${mentioned.split('@')[0]}*\n\n${hist.join('\n')}\n\n_(${hist.length} entries)_`, mentions: [mentioned] }, { quoted: message });
        }

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
                return sock.sendMessage(chatId, { text: '✅ *No active grudges in this group.*\n\nEveryone has been behaving 🙂' }, { quoted: message });
            }
            return sock.sendMessage(chatId, { text: `*😒 ACTIVE GRUDGES (${entries.length})*\n\n${entries.join('\n')}\n\nUse \`.chatbot pardon @user\` to clear one.` }, { quoted: message });
        }

        if (match === 'stats') {
            const now      = Date.now();
            const apiLines = GROQ_MODELS.map(m => {
                const s        = apiStats[m.name];
                const icon     = s.count === 0 ? '✅' : s.count < API_SKIP_THRESHOLD ? '⚠️' : '❌';
                const skipped  = !isApiHealthy(m.name) ? ' [SKIPPED]' : '';
                const lastFail = s.lastFailAt  ? `last fail ${Math.round((now - s.lastFailAt)  / 60000)}m ago` : 'no failures recorded';
                const lastOk   = s.lastSuccessAt ? `last ok ${Math.round((now - s.lastSuccessAt) / 60000)}m ago` : 'never succeeded this session';
                return `${icon} *${m.name}*${skipped}: ${s.count} failure(s)\n   ${lastFail} · ${lastOk}`;
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

        return sock.sendMessage(chatId, { text: '❌ *Invalid command*\n\nUse: `.chatbot on/off/stats/pardon/grudges/reset/history`' }, { quoted: message });
    },

    handleChatbotResponse,
    loadUserGroupData,
    saveUserGroupData
};