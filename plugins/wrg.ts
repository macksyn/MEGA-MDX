// ============================================================
//  Word Challenge Game (wcg)
//  WhatsApp Bot Command — Baileys-compatible
// ============================================================

import fs from "fs";
import path from "path";

// ── Types ─────────────────────────────────────────────────────

interface Player {
    jid: string;
    score: number;
}

interface GameState {
    phase: "joining" | "active" | "ended";
    players: Map<string, Player>;   // jid → Player
    turnOrder: string[];            // shuffled jid list
    turnIndex: number;              // pointer into turnOrder
    round: number;
    letter: string;
    minLength: number;
    usedWords: Set<string>;
    timer: ReturnType<typeof setTimeout> | null;
    hostJid: string;
    startedAt: number;
}

// ── Constants ──────────────────────────────────────────────────

const MAX_PLAYERS  = 10;
const MIN_PLAYERS  = 2;
const JOIN_WINDOW  = 60_000;       // 60s lobby
const MAX_GAME_AGE = 30 * 60_000;  // 30min hard cap

// ── Word List ──────────────────────────────────────────────────

// Expects a JSON file at ./words.json shaped as a flat array:
//   ["apple", "banana", "crate", ...]
//
// Recommended source:
//   https://github.com/dwyl/english-words  →  words_alpha.txt → JSON
//
// Tip: pre-filter the list to words >= 3 letters to keep the Set lean.

let wordSet: Set<string> = new Set();

function loadWordList(): void {
    try {
        const filePath = path.resolve(__dirname, "words.json");
        const raw      = fs.readFileSync(filePath, "utf-8");
        const list     = JSON.parse(raw) as string[];
        wordSet        = new Set(list.map(w => w.toLowerCase().trim()));
        console.log(`[wcg] Loaded ${wordSet.size.toLocaleString()} words.`);
    } catch (err) {
        console.error("[wcg] words.json not found — word validation disabled.", err);
    }
}

loadWordList();

function isValidWord(word: string): boolean {
    if (wordSet.size === 0) return true; // graceful degradation if file missing
    return wordSet.has(word);
}

// ── Store ──────────────────────────────────────────────────────

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

// ── Difficulty ─────────────────────────────────────────────────

function getDifficulty(round: number): { time: number; minLength: number } {
    return {
        time:      Math.max(10_000, 45_000 - round * 2_000),
        minLength: Math.min(12, 3 + Math.floor(round / 3)),
    };
}

// ── Helpers ────────────────────────────────────────────────────

function randomLetter(): string {
    // Skews away from rare letters (q, x, z) for fairness
    const pool = "aaabbbcccdddeeefffggghhh" +
                 "iiijjjkkkllllmmmnnnoooppp" +
                 "rrrssssttttuuuvvvwwwyyyy";
    return pool[Math.floor(Math.random() * pool.length)];
}

function mention(jid: string): string {
    return `@${jid.split("@")[0]}`;
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
    if (game.timer) clearTimeout(game.timer);
    games.delete(chatId);
}

// ── Turn Orchestration ─────────────────────────────────────────

async function startTurn(
    sock: any,
    chatId: string,
    channelInfo: any
): Promise<void> {
    const game = games.get(chatId);
    if (!game || game.phase !== "active") return;

    if (game.timer) clearTimeout(game.timer);

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

    // Only a timeout eliminates — wrong answers just prompt a retry
    game.timer = setTimeout(async () => {
        await eliminatePlayer(sock, chatId, turnJid, "⏱️ Time's up!", channelInfo);
    }, time);
}

// ── Elimination (timeout only) ─────────────────────────────────

async function eliminatePlayer(
    sock: any,
    chatId: string,
    loserJid: string,
    reason: string,
    channelInfo: any
): Promise<void> {
    const game = games.get(chatId);
    if (!game || game.phase !== "active") return;

    if (game.timer) clearTimeout(game.timer);
    game.timer = null;

    const idx = game.turnOrder.indexOf(loserJid);
    if (idx !== -1) game.turnOrder.splice(idx, 1);

    // Keep index in bounds after the splice
    if (game.turnIndex >= game.turnOrder.length) {
        game.turnIndex = 0;
    }

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
        return sock.sendMessage(chatId, {
            text: "🤝 It's a draw — everyone ran out of time!",
            ...channelInfo,
        });
    }

    await startTurn(sock, chatId, channelInfo);
}

// ── End Game ───────────────────────────────────────────────────

async function endGame(
    sock: any,
    chatId: string,
    winnerJid: string,
    channelInfo: any
): Promise<void> {
    const game = games.get(chatId);
    if (!game) return;

    game.phase = "ended";
    if (game.timer) clearTimeout(game.timer);

    const medals = ["🥇", "🥈", "🥉"];
    const board  = [...game.players.values()]
        .sort((a, b) => b.score - a.score)
        .map((p, i) => `${medals[i] ?? "▪️"} ${mention(p.jid)} — ${p.score} pts`)
        .join("\n");

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

// ── Main Handler ───────────────────────────────────────────────

export default {
    command:     "wcg",
    aliases:     ["wordgame"],
    category:    "games",
    description: "Start Word Challenge Game",
    usage:       ".wcg",

    groupOnly:    true,
    isPrefixless: true,

    async handler(
        sock: any,
        message: any,
        _args: any[],
        context: any = {}
    ) {
        const { chatId, senderId, userMessage, channelInfo } = context;

        const msg  = userMessage.trim().toLowerCase();
        const game = games.get(chatId);

        // ── Start ──────────────────────────────────────────────
        if (!game && msg === "wcg") {
            const newGame: GameState = {
                phase:     "joining",
                players:   new Map(),
                turnOrder: [],
                turnIndex: 0,
                round:     1,
                letter:    "",
                minLength: 3,
                usedWords: new Set(),
                timer:     null,
                hostJid:   senderId,
                startedAt: Date.now(),
            };

            // Host is auto-joined
            newGame.players.set(senderId, { jid: senderId, score: 0 });
            games.set(chatId, newGame);

            await sock.sendMessage(chatId, {
                text:
                    `🎮 *Word Challenge Game*\n\n` +
                    `${mention(senderId)} started a game!\n` +
                    `Type *join* to enter. (max ${MAX_PLAYERS} players)\n\n` +
                    `⏱️ Game kicks off in 60 seconds`,
                mentions: [senderId],
                ...channelInfo,
            });

            newGame.timer = setTimeout(async () => {
                const g = games.get(chatId);
                if (!g || g.phase !== "joining") return;

                if (g.players.size < MIN_PLAYERS) {
                    cleanupGame(chatId);
                    return sock.sendMessage(chatId, {
                        text: `❌ Not enough players. Need at least ${MIN_PLAYERS}.`,
                        ...channelInfo,
                    });
                }

                g.phase     = "active";
                g.turnOrder = [...g.players.keys()].sort(() => 0.5 - Math.random());
                g.turnIndex = 0;

                const names = g.turnOrder.map(mention).join(", ");

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

            return;
        }

        if (!game) return;

        // ── Join ───────────────────────────────────────────────
        if (game.phase === "joining" && msg === "join") {
            if (game.players.has(senderId)) {
                return sock.sendMessage(chatId, {
                    text: `⚠️ ${mention(senderId)} you're already in!`,
                    mentions: [senderId],
                    ...channelInfo,
                });
            }
            if (game.players.size >= MAX_PLAYERS) {
                return sock.sendMessage(chatId, {
                    text: `⛔ Game is full! (max ${MAX_PLAYERS} players)`,
                    ...channelInfo,
                });
            }

            game.players.set(senderId, { jid: senderId, score: 0 });

            return sock.sendMessage(chatId, {
                text: `✅ ${mention(senderId)} joined! (${game.players.size}/${MAX_PLAYERS})`,
                mentions: [senderId],
                ...channelInfo,
            });
        }

        // ── Force-end (host only) ──────────────────────────────
        if (msg === "endgame" && senderId === game.hostJid) {
            cleanupGame(chatId);
            return sock.sendMessage(chatId, {
                text: "🛑 Game ended by host.",
                ...channelInfo,
            });
        }

        // ── Gameplay ───────────────────────────────────────────
        if (game.phase !== "active") return;
        if (currentPlayer(game) !== senderId) return; // not your turn — ignore silently

        const word = msg;

        // Format check — send feedback but keep timer running
        if (!/^[a-z]+$/.test(word)) {
            return sock.sendMessage(chatId, {
                text: `❌ Letters only — no spaces or special characters. Try again!`,
                ...channelInfo,
            });
        }

        if (word[0] !== game.letter) {
            return sock.sendMessage(chatId, {
                text: `❌ Must start with *${game.letter.toUpperCase()}*. Try again!`,
                ...channelInfo,
            });
        }

        if (word.length < game.minLength) {
            return sock.sendMessage(chatId, {
                text: `❌ Too short! Need at least *${game.minLength}* letters. Try again!`,
                ...channelInfo,
            });
        }

        if (game.usedWords.has(word)) {
            return sock.sendMessage(chatId, {
                text: `❌ *${word}* was already used! Try a different word.`,
                ...channelInfo,
            });
        }

        if (!isValidWord(word)) {
            return sock.sendMessage(chatId, {
                text: `❌ *${word}* isn't in the dictionary. Try again!`,
                ...channelInfo,
            });
        }

        // ── Word accepted ──────────────────────────────────────
        if (game.timer) clearTimeout(game.timer);
        game.timer = null;

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
    },
};