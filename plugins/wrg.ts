// ============================================================
//  Word Challenge Game — wcg.ts
//  Plugin for MEGA-MD / Baileys bot
//
//  INTEGRATION (two steps, both required):
//
//  STEP 1 — This file goes in:  plugins/wcg.ts
//
//  STEP 2 — In lib/messageHandler.ts, add these two lines:
//
//    Import at the top of the file (with the other imports):
//      import { wcgOnMessage } from '../plugins/wcg.js';
//
//    Inside handleMessages(), right after the TicTacToe block:
//      const wcgHandled = await wcgOnMessage(sock, message, context);
//      if (wcgHandled) return;
//
//  That's it. The command trigger (.wcg / wcg) is handled
//  automatically by the command system. The onMessage export
//  handles prefixless gameplay (join, words, endgame).
// ============================================================

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Types ──────────────────────────────────────────────────────────────────────

interface Player {
    jid:   string;
    score: number;
}

interface GameState {
    phase:     'joining' | 'active' | 'ended';
    players:   Map<string, Player>;  // jid → Player
    turnOrder: string[];             // shuffled jid list
    turnIndex: number;
    round:     number;
    letter:    string;
    minLength: number;
    usedWords: Set<string>;
    hostJid:   string;
    startedAt: number;
    // All timers stored so cleanupGame() can clear every one
    joinTimer:   ReturnType<typeof setTimeout> | null;
    reminder30:  ReturnType<typeof setTimeout> | null;
    reminder15:  ReturnType<typeof setTimeout> | null;
    turnTimer:   ReturnType<typeof setTimeout> | null;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const MAX_PLAYERS  = 10;
const MIN_PLAYERS  = 2;
const JOIN_WINDOW  = 60_000;        // 60 s lobby
const MAX_GAME_AGE = 30 * 60_000;   // 30 min hard cap

// ── Word list ──────────────────────────────────────────────────────────────────
//
//  Place words.json next to this file (or adjust the path below).
//  Shape: a flat JSON array of lowercase strings — ["apple","banana",...]
//
//  Recommended source: https://github.com/dwyl/english-words
//  Convert words_alpha.txt to JSON with:
//
//    node -e "
//      const w = require('fs').readFileSync('words_alpha.txt','utf8')
//        .split('\n').map(s=>s.trim().toLowerCase()).filter(s=>s.length>=3);
//      require('fs').writeFileSync('words.json', JSON.stringify(w));
//    "

let wordSet: Set<string> = new Set();

(function loadWordList() {
    try {
        const fp   = path.resolve(__dirname, 'words.json');
        const list = JSON.parse(fs.readFileSync(fp, 'utf-8')) as string[];
        wordSet    = new Set(list.map(w => w.toLowerCase().trim()));
        console.log(`[wcg] ✅ Loaded ${wordSet.size.toLocaleString()} words.`);
    } catch {
        console.warn('[wcg] ⚠️  words.json not found — word validation disabled (accepts everything).');
    }
})();

function isValidWord(word: string): boolean {
    if (wordSet.size === 0) return true; // graceful degradation
    return wordSet.has(word);
}

// ── Game store ─────────────────────────────────────────────────────────────────

const games = new Map<string, GameState>();

// Stale-game sweeper — runs every 10 min
setInterval(() => {
    const now = Date.now();
    for (const [chatId, game] of games) {
        if (now - game.startedAt > MAX_GAME_AGE) {
            cleanupGame(chatId);
        }
    }
}, 10 * 60_000);

// ── Difficulty ─────────────────────────────────────────────────────────────────

function getDifficulty(round: number): { time: number; minLength: number } {
    return {
        time:      Math.max(10_000, 45_000 - round * 2_000),
        minLength: Math.min(12, 3 + Math.floor(round / 3)),
    };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Skews away from rare letters (q, x, z) for fairness */
function randomLetter(): string {
    const pool = 'aaabbbcccdddeeefffggghhh' +
                 'iiijjjkkkllllmmmnnnoooppp' +
                 'rrrssssttttuuuvvvwwwyyyy';
    return pool[Math.floor(Math.random() * pool.length)];
}

function mention(jid: string): string {
    return `@${jid.split('@')[0]}`;
}

function currentPlayer(game: GameState): string {
    return game.turnOrder[game.turnIndex];
}

function advanceTurn(game: GameState): void {
    game.turnIndex = (game.turnIndex + 1) % game.turnOrder.length;
    game.round++;
}

function cleanupGame(chatId: string): void {
    const game = games.get(chatId);
    if (!game) return;
    clearTimeout(game.joinTimer  ?? undefined);
    clearTimeout(game.reminder30 ?? undefined);
    clearTimeout(game.reminder15 ?? undefined);
    clearTimeout(game.turnTimer  ?? undefined);
    games.delete(chatId);
}

// ── Turn orchestration ─────────────────────────────────────────────────────────

async function startTurn(sock: any, chatId: string, channelInfo: any): Promise<void> {
    const game = games.get(chatId);
    if (!game || game.phase !== 'active') return;

    // Always clear any running turn timer before setting a new one
    if (game.turnTimer) clearTimeout(game.turnTimer);

    const { time, minLength } = getDifficulty(game.round);
    const letter              = randomLetter();

    game.letter    = letter;
    game.minLength = minLength;

    const turnJid = currentPlayer(game);

    await sock.sendMessage(chatId, {
        text:
            `🎯 *Round ${game.round}*\n\n` +
            `${mention(turnJid)} your turn!\n\n` +
            `Start with: *${letter.toUpperCase()}*\n` +
            `Min letters: *${minLength}*\n` +
            `Time: *${time / 1000}s* ⏱️`,
        mentions: [turnJid],
        ...channelInfo,
    });

    // Only timeout eliminates — wrong answers just prompt retries
    game.turnTimer = setTimeout(async () => {
        await eliminatePlayer(sock, chatId, turnJid, '⏱️ Time\'s up!', channelInfo);
    }, time);
}

// ── Elimination ────────────────────────────────────────────────────────────────

async function eliminatePlayer(
    sock: any,
    chatId: string,
    loserJid: string,
    reason: string,
    channelInfo: any,
): Promise<void> {
    const game = games.get(chatId);
    if (!game || game.phase !== 'active') return;

    if (game.turnTimer) clearTimeout(game.turnTimer);
    game.turnTimer = null;

    const idx = game.turnOrder.indexOf(loserJid);
    if (idx !== -1) game.turnOrder.splice(idx, 1);

    // Keep index in bounds after splice
    if (game.turnIndex >= game.turnOrder.length) game.turnIndex = 0;

    await sock.sendMessage(chatId, {
        text:
            `💀 ${mention(loserJid)} has been *eliminated!*\n` +
            `Reason: ${reason}\n\n` +
            `${game.turnOrder.length} player(s) remaining.`,
        mentions: [loserJid],
        ...channelInfo,
    });

    if (game.turnOrder.length === 1) {
        await endGame(sock, chatId, game.turnOrder[0], channelInfo);
        return;
    }

    if (game.turnOrder.length === 0) {
        cleanupGame(chatId);
        await sock.sendMessage(chatId, {
            text: '🤝 It\'s a draw — everyone ran out of time!',
            ...channelInfo,
        });
        return;
    }

    await startTurn(sock, chatId, channelInfo);
}

// ── End game ───────────────────────────────────────────────────────────────────

async function endGame(
    sock: any,
    chatId: string,
    winnerJid: string,
    channelInfo: any,
): Promise<void> {
    const game = games.get(chatId);
    if (!game) return;

    game.phase = 'ended';
    if (game.turnTimer) clearTimeout(game.turnTimer);

    const medals = ['🥇', '🥈', '🥉'];
    const board  = [...game.players.values()]
        .sort((a, b) => b.score - a.score)
        .map((p, i) => `${medals[i] ?? '▪️'} ${mention(p.jid)} — ${p.score} pts`)
        .join('\n');

    await sock.sendMessage(chatId, {
        text:
            `🏆 *Game Over!*\n\n` +
            `Winner: ${mention(winnerJid)} 🎉\n\n` +
            `*Scoreboard:*\n${board}`,
        mentions: [...game.players.keys()],
        ...channelInfo,
    });

    cleanupGame(chatId);
}

// ── Prefixless message hook ────────────────────────────────────────────────────
//
//  Called from messageHandler.ts on every group message.
//  Returns true if the message was consumed (so the caller can return early).

export async function wcgOnMessage(
    sock: any,
    message: any,
    context: any = {},
): Promise<boolean> {
    const { chatId, senderId, userMessage, channelInfo } = context;

    const game = games.get(chatId);
    if (!game) return false;   // no active game → not our message

    const msg = (userMessage as string).trim().toLowerCase();

    // ── Join (lobby phase) ──────────────────────────────────────────────────
    if (game.phase === 'joining' && msg === 'join') {
        if (game.players.has(senderId)) {
            await sock.sendMessage(chatId, {
                text: `⚠️ ${mention(senderId)} you're already in!`,
                mentions: [senderId],
                ...channelInfo,
            });
            return true;
        }
        if (game.players.size >= MAX_PLAYERS) {
            await sock.sendMessage(chatId, {
                text: `⛔ Game is full! (max ${MAX_PLAYERS} players)`,
                ...channelInfo,
            });
            return true;
        }

        game.players.set(senderId, { jid: senderId, score: 0 });
        await sock.sendMessage(chatId, {
            text: `✅ ${mention(senderId)} joined! (${game.players.size}/${MAX_PLAYERS})`,
            mentions: [senderId],
            ...channelInfo,
        });
        return true;
    }

    // ── Force-end (host only, any phase) ───────────────────────────────────
    if (msg === 'endgame' && senderId === game.hostJid) {
        cleanupGame(chatId);
        await sock.sendMessage(chatId, {
            text: '🛑 Game ended by host.',
            ...channelInfo,
        });
        return true;
    }

    // ── Gameplay ────────────────────────────────────────────────────────────
    if (game.phase !== 'active') return false;
    if (currentPlayer(game) !== senderId) return false;  // not your turn — don't consume

    const word = msg;

    // Format check — feedback but timer keeps running
    if (!/^[a-z]+$/.test(word)) {
        await sock.sendMessage(chatId, {
            text: '❌ Letters only — no spaces or special characters. Try again!',
            ...channelInfo,
        });
        return true;
    }

    if (word[0] !== game.letter) {
        await sock.sendMessage(chatId, {
            text: `❌ Must start with *${game.letter.toUpperCase()}*. Try again!`,
            ...channelInfo,
        });
        return true;
    }

    if (word.length < game.minLength) {
        await sock.sendMessage(chatId, {
            text: `❌ Too short! Need at least *${game.minLength}* letters. Try again!`,
            ...channelInfo,
        });
        return true;
    }

    if (game.usedWords.has(word)) {
        await sock.sendMessage(chatId, {
            text: `❌ *${word}* was already used! Try a different word.`,
            ...channelInfo,
        });
        return true;
    }

    if (!isValidWord(word)) {
        await sock.sendMessage(chatId, {
            text: `❌ *${word}* isn't in the dictionary. Try again!`,
            ...channelInfo,
        });
        return true;
    }

    // ── Word accepted ───────────────────────────────────────────────────────
    if (game.turnTimer) clearTimeout(game.turnTimer);
    game.turnTimer = null;

    game.usedWords.add(word);

    const player = game.players.get(senderId)!;
    const points = word.length;
    player.score += points;

    await sock.sendMessage(chatId, {
        text:
            `✅ *${word}* accepted! (+${points} pts)\n` +
            `${mention(senderId)}: ${player.score} pts total`,
        mentions: [senderId],
        ...channelInfo,
    });

    advanceTurn(game);
    await startTurn(sock, chatId, channelInfo);
    return true;
}

// ── Command export ─────────────────────────────────────────────────────────────
//
//  isPrefixless: true  →  both ".wcg" and "wcg" trigger this command.
//  commandHandler.getCommand() handles prefix-stripping automatically,
//  and registers "wcg" in prefixlessCommands so bare "wcg" also matches.

export default {
    command:     'wcg',
    aliases:     ['wordgame'],
    category:    'games',
    description: 'Start Word Challenge Game',
    usage:       '.wcg',

    groupOnly:    true,
    isPrefixless: true,

    async handler(
        sock: any,
        message: any,
        _args: any[],
        context: any = {},
    ) {
        const { chatId, senderId, channelInfo } = context;

        if (games.has(chatId)) {
            return sock.sendMessage(chatId, {
                text: '⚠️ A game is already running in this group!',
                ...channelInfo,
            });
        }

        const newGame: GameState = {
            phase:     'joining',
            players:   new Map(),
            turnOrder: [],
            turnIndex: 0,
            round:     1,
            letter:    '',
            minLength: 3,
            usedWords: new Set(),
            hostJid:   senderId,
            startedAt: Date.now(),
            joinTimer:  null,
            reminder30: null,
            reminder15: null,
            turnTimer:  null,
        };

        // Host is auto-joined
        newGame.players.set(senderId, { jid: senderId, score: 0 });
        games.set(chatId, newGame);

        await sock.sendMessage(chatId, {
            text:
                `🎮 *Random Word Game*\n\n` +
                `${mention(senderId)} has started the game!\n` +
                `👥 Needs 2 or more players 🙋‍♂️🙋‍♀️\n`+
                `Type *join* to enter.\n` +
                `⏱️ *60 seconds* left to join`,
            mentions: [senderId],
            ...channelInfo,
        });

        // ── 30s reminder ──────────────────────────────────────────────────────
        newGame.reminder30 = setTimeout(async () => {
            const g = games.get(chatId);
            if (!g || g.phase !== 'joining') return;
            await sock.sendMessage(chatId, {
                text:
                    `⏳ *30 seconds left to join!*\n` +
                    `Players so far: ${g.players.size}/${MAX_PLAYERS}\n` +
                    `Type *join* to enter!`,
                ...channelInfo,
            });
        }, 30_000);

        // ── 15s reminder ──────────────────────────────────────────────────────
        newGame.reminder15 = setTimeout(async () => {
            const g = games.get(chatId);
            if (!g || g.phase !== 'joining') return;
            await sock.sendMessage(chatId, {
                text:
                    `🚨 *15 seconds left!*\n` +
                    `Players so far: ${g.players.size}/${MAX_PLAYERS}\n` +
                    `Last chance to *join!*`,
                ...channelInfo,
            });
        }, 45_000);

        // ── Game start at 60s ──────────────────────────────────────────────────
        newGame.joinTimer = setTimeout(async () => {
            const g = games.get(chatId);
            if (!g || g.phase !== 'joining') return;

            if (g.players.size < MIN_PLAYERS) {
                cleanupGame(chatId);
                return sock.sendMessage(chatId, {
                    text: `❌ Not enough players, game terminated. Need at least ${MIN_PLAYERS}.`,
                    ...channelInfo,
                });
            }

            g.phase     = 'active';
            g.turnOrder = [...g.players.keys()].sort(() => 0.5 - Math.random());
            g.turnIndex = 0;

            const names = g.turnOrder.map(mention).join(', ');

            await sock.sendMessage(chatId, {
                text:
                    `✅ *Game starting with ${g.turnOrder.length} players!*\n\n` +
                    `Turn order: ${names}\n\n` +
                    `⚠️ Wrong answers are *allowed* — only running out of time gets you eliminated!`,
                mentions: g.turnOrder,
                ...channelInfo,
            });

            await startTurn(sock, chatId, channelInfo);
        }, JOIN_WINDOW);
    },
};