// ============================================================
//  Connect Four — connect4.ts
//  Pure game, no economy, no wagers, no DB persistence.
//
//  INTEGRATION (add to lib/messageHandler.ts):
//
//  1. Import at top of file (with other imports):
//       import { c4OnMessage } from '../plugins/connect4.js';
//
//  2. Inside handleMessages(), after the wcgOnMessage block:
//       const c4Handled = await c4OnMessage(sock, message, context);
//       if (c4Handled) return;
//
//  That's it. The command `.c4` is handled by the command system.
//  c4OnMessage handles prefixless gameplay (join, 1-9).
// ============================================================

// ── Constants ─────────────────────────────────────────────────────────────────

const GAME_CONFIG = {
    ROWS:         7,
    COLS:         9,
    JOIN_TIMEOUT: 60_000,   // 60 s lobby window
    TURN_TIMEOUT: 120_000,  // 2 min per turn
} as const;

const EMOJIS = {
    EMPTY:   '⚪',
    PLAYER1: '🔴',
    PLAYER2: '🔵',
    WIN:     '✨',
    NUMBERS: ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣'],
} as const;

// ── Types ─────────────────────────────────────────────────────────────────────

interface PlayerSlot {
    id:   string;
    disc: string;
}

interface MoveRecord {
    player: number;
    row:    number;
    col:    number;
    time:   Date;
}

interface MoveResult {
    success:  boolean;
    message?: string;
    win?:     boolean;
    draw?:    boolean;
    row?:     number;
    col?:     number;
}

interface CreateResult {
    success:  boolean;
    game?:    Connect4Game;
    message?: string;
}

interface JoinResult {
    success:  boolean;
    game?:    Connect4Game;
    message?: string;
}

interface MakeMoveResult {
    success:  boolean;
    game?:    Connect4Game;
    result?:  MoveResult;
    message?: string;
}

interface CancelResult {
    success:  boolean;
    game?:    Connect4Game;
    message?: string;
}

// ── Game Logic ────────────────────────────────────────────────────────────────

class Connect4Game {
    gameId:      string;
    player1:     PlayerSlot;
    player2:     PlayerSlot | null;
    chatId:      string;
    board:       number[][];
    currentTurn: 1 | 2;
    status:      'waiting' | 'active' | 'finished' | 'cancelled';
    winner:      number | null;   // 1, 2, or 0 for draw
    createdAt:   Date;
    lastMove:    Date | null;
    moveHistory: MoveRecord[];

    constructor(gameId: string, player1Id: string, chatId: string) {
        this.gameId      = gameId;
        this.player1     = { id: player1Id, disc: EMOJIS.PLAYER1 };
        this.player2     = null;
        this.chatId      = chatId;
        this.board       = Array.from({ length: GAME_CONFIG.ROWS }, () =>
                               Array(GAME_CONFIG.COLS).fill(0));
        this.currentTurn = 1;
        this.status      = 'waiting';
        this.winner      = null;
        this.createdAt   = new Date();
        this.lastMove    = null;
        this.moveHistory = [];
    }

    join(player2Id: string): { success: boolean; message?: string } {
        if (this.status !== 'waiting')
            return { success: false, message: 'Game already started or finished.' };
        if (this.player1.id === player2Id)
            return { success: false, message: 'You cannot play against yourself!' };

        this.player2  = { id: player2Id, disc: EMOJIS.PLAYER2 };
        this.status   = 'active';
        this.lastMove = new Date();
        return { success: true };
    }

    makeMove(playerId: string, column: number): MoveResult {
        if (this.status !== 'active')
            return { success: false, message: 'Game is not active.' };

        const currentPlayer = this.currentTurn === 1 ? this.player1 : this.player2!;
        if (currentPlayer.id !== playerId)
            return { success: false, message: 'Not your turn!' };

        if (column < 0 || column >= GAME_CONFIG.COLS)
            return { success: false, message: 'Invalid column.' };

        // Find lowest empty row in the chosen column
        let row = -1;
        for (let r = GAME_CONFIG.ROWS - 1; r >= 0; r--) {
            if (this.board[r][column] === 0) { row = r; break; }
        }
        if (row === -1)
            return { success: false, message: 'Column is full!' };

        this.board[row][column] = this.currentTurn;
        this.moveHistory.push({ player: this.currentTurn, row, col: column, time: new Date() });
        this.lastMove = new Date();

        if (this.checkWin(row, column)) {
            this.status = 'finished';
            this.winner = this.currentTurn;
            return { success: true, win: true, row, col: column };
        }
        if (this.isBoardFull()) {
            this.status = 'finished';
            this.winner = 0;
            return { success: true, draw: true, row, col: column };
        }

        this.currentTurn = this.currentTurn === 1 ? 2 : 1;
        return { success: true, row, col: column };
    }

    checkWin(row: number, col: number): boolean {
        return (
            this.checkDirection(row, col, 0,  1) ||  // horizontal
            this.checkDirection(row, col, 1,  0) ||  // vertical
            this.checkDirection(row, col, 1,  1) ||  // diagonal ↘
            this.checkDirection(row, col, 1, -1)     // diagonal ↙
        );
    }

    private checkDirection(row: number, col: number, rd: number, cd: number): boolean {
        const player = this.board[row][col];
        let count    = 1;

        for (let i = 1; i < 4; i++) {
            const r = row + rd * i, c = col + cd * i;
            if (r < 0 || r >= GAME_CONFIG.ROWS || c < 0 || c >= GAME_CONFIG.COLS) break;
            if (this.board[r][c] !== player) break;
            count++;
        }
        for (let i = 1; i < 4; i++) {
            const r = row - rd * i, c = col - cd * i;
            if (r < 0 || r >= GAME_CONFIG.ROWS || c < 0 || c >= GAME_CONFIG.COLS) break;
            if (this.board[r][c] !== player) break;
            count++;
        }
        return count >= 4;
    }

    private isBoardFull(): boolean {
        return this.board[0].every(cell => cell !== 0);
    }

    getBoardString(): string {
        let s = '\n  ' + EMOJIS.NUMBERS.join(' ') + '\n';
        for (let row = 0; row < GAME_CONFIG.ROWS; row++) {
            s += '  ';
            for (let col = 0; col < GAME_CONFIG.COLS; col++) {
                const cell = this.board[row][col];
                s += (cell === 0 ? EMOJIS.EMPTY : cell === 1 ? EMOJIS.PLAYER1 : EMOJIS.PLAYER2) + ' ';
            }
            s += '\n';
        }
        return s;
    }
}

// ── In-memory Stats ───────────────────────────────────────────────────────────

interface PlayerStats {
    wins:        number;
    losses:      number;
    draws:       number;
    gamesPlayed: number;
}

const statsStore = new Map<string, PlayerStats>();

function getStats(userId: string): PlayerStats {
    return statsStore.get(userId) ?? { wins: 0, losses: 0, draws: 0, gamesPlayed: 0 };
}

function recordResult(p1Id: string, p2Id: string, winner: number): void {
    if (winner === 0) {
        // Draw
        for (const id of [p1Id, p2Id]) {
            const s = getStats(id);
            statsStore.set(id, { ...s, draws: s.draws + 1, gamesPlayed: s.gamesPlayed + 1 });
        }
    } else {
        const winnerId = winner === 1 ? p1Id : p2Id;
        const loserId  = winner === 1 ? p2Id : p1Id;
        const ws       = getStats(winnerId);
        const ls       = getStats(loserId);
        statsStore.set(winnerId, { ...ws, wins: ws.wins + 1, gamesPlayed: ws.gamesPlayed + 1 });
        statsStore.set(loserId,  { ...ls, losses: ls.losses + 1, gamesPlayed: ls.gamesPlayed + 1 });
    }
}

// ── Game Manager ──────────────────────────────────────────────────────────────

type TimerCallback = (msg: string, mentions?: string[]) => void;

class Connect4Manager {
    private games    = new Map<string, Connect4Game>();
    private timers   = new Map<string, ReturnType<typeof setTimeout>[]>();

    private generateId(): string {
        return `c4_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }

    getActiveGame(chatId: string): Connect4Game | undefined {
        return [...this.games.values()].find(g =>
            g.chatId === chatId &&
            g.status !== 'finished' &&
            g.status !== 'cancelled'
        );
    }

    getPlayerGame(playerId: string): Connect4Game | undefined {
        return [...this.games.values()].find(g =>
            (g.player1.id === playerId || g.player2?.id === playerId) &&
            g.status !== 'finished' &&
            g.status !== 'cancelled'
        );
    }

    createGame(player1Id: string, chatId: string, onReminder: (msg: string) => void): CreateResult {
        if (this.getActiveGame(chatId))
            return { success: false, message: 'A game is already running in this chat!' };
        if (this.getPlayerGame(player1Id))
            return { success: false, message: 'You already have an active game! Finish it or use `.c4 cancel`.' };

        const gameId = this.generateId();
        const game   = new Connect4Game(gameId, player1Id, chatId);
        this.games.set(gameId, game);

        const notify = (msg: string) => { try { onReminder(msg); } catch {} };

        const t: ReturnType<typeof setTimeout>[] = [
            setTimeout(() => {
                const g = this.games.get(gameId);
                if (g?.status === 'waiting') notify('⏳ *45s remaining!* Someone join the Connect Four game!');
            }, 15_000),
            setTimeout(() => {
                const g = this.games.get(gameId);
                if (g?.status === 'waiting') notify('⏳ *30s remaining!* Still waiting for a challenger...');
            }, 30_000),
            setTimeout(() => {
                const g = this.games.get(gameId);
                if (g?.status === 'waiting') notify('⏳ *15s remaining!* Last call to join!');
            }, 45_000),
            setTimeout(() => {
                const g = this.games.get(gameId);
                if (g?.status === 'waiting') {
                    g.status = 'cancelled';
                    this.clearTimers(gameId);
                    this.games.delete(gameId);
                    notify('🚫 *Connect Four game expired.* No one joined in time.');
                }
            }, GAME_CONFIG.JOIN_TIMEOUT),
        ];

        this.timers.set(gameId, t);
        return { success: true, game };
    }

    joinGame(gameId: string, player2Id: string, onTimeout: TimerCallback): JoinResult {
        const game = this.games.get(gameId);
        if (!game) return { success: false, message: 'Game not found!' };

        const result = game.join(player2Id);
        if (!result.success) return { success: false, message: result.message };

        this.clearTimers(gameId);
        this.setTurnTimer(gameId, onTimeout);
        return { success: true, game };
    }

    makeMove(gameId: string, playerId: string, column: number, onTimeout: TimerCallback): MakeMoveResult {
        const game = this.games.get(gameId);
        if (!game) return { success: false, message: 'Game not found!' };

        const result = game.makeMove(playerId, column);
        if (!result.success) return { success: false, message: result.message };

        if (game.status === 'active') {
            this.setTurnTimer(gameId, onTimeout);
        } else {
            this.clearTimers(gameId);
            if (game.player2 && game.winner !== null) {
                recordResult(game.player1.id, game.player2.id, game.winner);
            }
        }

        return { success: true, game, result };
    }

    cancelGame(gameId: string): CancelResult {
        const game = this.games.get(gameId);
        if (!game)                      return { success: false, message: 'Game not found!' };
        if (game.status === 'finished') return { success: false, message: 'Game already finished!' };

        this.clearTimers(gameId);
        game.status = 'cancelled';
        this.games.delete(gameId);
        return { success: true, game };
    }

    private setTurnTimer(gameId: string, callback: TimerCallback): void {
        this.clearTimers(gameId);

        const timer = setTimeout(() => {
            const game = this.games.get(gameId);
            if (!game || game.status !== 'active') return;

            const loser  = game.currentTurn === 1 ? game.player1 : game.player2!;
            const winner = game.currentTurn === 1 ? game.player2! : game.player1;

            game.status = 'finished';
            game.winner = game.currentTurn === 1 ? 2 : 1;

            if (game.player2) {
                recordResult(game.player1.id, game.player2.id, game.winner);
            }

            this.games.delete(gameId);

            callback(
                `⏱️ *Turn Timeout!*\n\n` +
                `@${loser.id.split('@')[0]} took too long!\n\n` +
                `🏆 Winner: @${winner.id.split('@')[0]} ${winner.disc}`,
                [loser.id, winner.id]
            );
        }, GAME_CONFIG.TURN_TIMEOUT);

        this.timers.set(gameId, [timer]);
    }

    private clearTimers(gameId: string): void {
        const existing = this.timers.get(gameId);
        if (existing) {
            existing.forEach(t => clearTimeout(t));
            this.timers.delete(gameId);
        }
    }
}

const manager = new Connect4Manager();

// ── Helpers ───────────────────────────────────────────────────────────────────

function tag(userId: string): string {
    return '@' + userId.split('@')[0];
}

function getPlayerMentions(game: Connect4Game): string[] {
    const ids = [game.player1.id];
    if (game.player2) ids.push(game.player2.id);
    return ids;
}

function gameCard(game: Connect4Game): string {
    const p2Label = game.player2 ? tag(game.player2.id) : 'Waiting...';
    let s = `🎮 *Connect Four*\n\n`;
    s    += `${EMOJIS.PLAYER1} Player 1: ${tag(game.player1.id)}\n`;
    s    += `${EMOJIS.PLAYER2} Player 2: ${p2Label}\n`;

    if (game.status === 'waiting') {
        s += `\n⏳ Waiting for opponent...\nType *join* to enter!`;
    } else if (game.status === 'active') {
        const cur = game.currentTurn === 1 ? game.player1 : game.player2!;
        s += `\n🎯 Current turn: ${tag(cur.id)} ${cur.disc}`;
        s += game.getBoardString();
        s += `\n💡 _Type a number (1-9) to drop your disc_`;
    }
    return s;
}

// ── Prefixless Message Hook ───────────────────────────────────────────────────
//
//  Handles "join" (lobby) and "1"-"9" (moves) without a command prefix.
//  Returns true if the message was consumed so messageHandler can return early.

export async function c4OnMessage(sock: any, message: any, context: any): Promise<boolean> {
    const { chatId, senderId, userMessage, channelInfo } = context;
    const raw = (userMessage as string).trim().toLowerCase();

    const activeGame = manager.getActiveGame(chatId);
    if (!activeGame) return false;

    // ── Join (lobby) ──────────────────────────────────────────────────────────
    if (activeGame.status === 'waiting' && raw === 'join') {
        await sock.sendMessage(chatId, { react: { text: '⏳', key: message.key } });

        const onTimeout = async (msg: string, mentions: string[] = []) => {
            await sock.sendMessage(chatId, { text: msg, mentions, ...channelInfo });
        };

        const result = manager.joinGame(activeGame.gameId, senderId, onTimeout);
        if (!result.success) {
            await sock.sendMessage(chatId, { react: { text: '❌', key: message.key } });
            await sock.sendMessage(chatId,
                { text: `❌ ${result.message}`, ...channelInfo },
                { quoted: message }
            );
            return true;
        }

        const game = result.game!;
        await sock.sendMessage(chatId, { react: { text: '✅', key: message.key } });
        await sock.sendMessage(chatId, {
            text:
                `✅ *Game Started!*\n\n${gameCard(game)}\n\n` +
                `${EMOJIS.PLAYER1} ${tag(game.player1.id)} goes first!\n\n` +
                `💡 _Just type a number (1-9) to drop your disc!_`,
            mentions: getPlayerMentions(game),
            ...channelInfo,
        }, { quoted: message });
        return true;
    }

    // ── Move (active game) ────────────────────────────────────────────────────
    if (activeGame.status === 'active' && /^[1-9]$/.test(raw)) {
        const playerGame = manager.getPlayerGame(senderId);
        if (!playerGame || playerGame.gameId !== activeGame.gameId) return false;

        const col = parseInt(raw, 10) - 1;
        await sock.sendMessage(chatId, { react: { text: '⏳', key: message.key } });

        const onTimeout = async (msg: string, mentions: string[] = []) => {
            await sock.sendMessage(chatId, { text: msg, mentions, ...channelInfo });
        };

        const res = manager.makeMove(activeGame.gameId, senderId, col, onTimeout);
        if (!res.success) {
            await sock.sendMessage(chatId, { react: { text: '❌', key: message.key } });
            await sock.sendMessage(chatId,
                { text: `❌ ${res.message}`, ...channelInfo },
                { quoted: message }
            );
            return true;
        }

        const { game, result } = res as { game: Connect4Game; result: MoveResult };

        if (result.win) {
            const winner = game.winner === 1 ? game.player1 : game.player2!;
            await sock.sendMessage(chatId, { react: { text: '🎉', key: message.key } });
            await sock.sendMessage(chatId, {
                text:
                    `${EMOJIS.WIN} *CONNECT FOUR!* ${EMOJIS.WIN}\n` +
                    `${game.getBoardString()}\n` +
                    `🏆 Winner: ${tag(winner.id)} ${winner.disc}\n\n` +
                    `Congratulations! 🎊`,
                mentions: getPlayerMentions(game),
                ...channelInfo,
            });
        } else if (result.draw) {
            await sock.sendMessage(chatId, { react: { text: '🤝', key: message.key } });
            await sock.sendMessage(chatId, {
                text:
                    `🤝 *Draw!*\n` +
                    `${game.getBoardString()}\n` +
                    `The board is full — no winner!`,
                mentions: getPlayerMentions(game),
                ...channelInfo,
            });
        } else {
            const next = game.currentTurn === 1 ? game.player1 : game.player2!;
            await sock.sendMessage(chatId, { react: { text: '✅', key: message.key } });
            await sock.sendMessage(chatId, {
                text:
                    `✅ *Move made!*\n` +
                    `${game.getBoardString()}\n` +
                    `🎯 Next turn: ${tag(next.id)} ${next.disc}\n\n` +
                    `💡 _Type a number (1-9) to play_`,
                mentions: getPlayerMentions(game),
                ...channelInfo,
            });
        }
        return true;
    }

    return false;
}

// ── Plugin Export ─────────────────────────────────────────────────────────────

export default {
    command:     'c4',
    aliases:     ['connect4'],
    category:    'games',
    description: 'Play Connect Four — drop discs and get 4 in a row to win!',
    usage:       '.c4 [cancel|board|stats|help]',
    groupOnly:   true,
    cooldown:    3,

    async handler(sock: any, message: any, args: any[], context: any = {}) {
        const { chatId, senderId, channelInfo } = context;
        const sub = (args[0] ?? '').toLowerCase();

        const reply = async (text: string, mentions: string[] = []) =>
            sock.sendMessage(chatId, { text, mentions, ...channelInfo }, { quoted: message });

        // ── .c4 cancel ───────────────────────────────────────────────────────
        if (sub === 'cancel') {
            const game = manager.getPlayerGame(senderId);
            if (!game)
                return reply('❌ You are not in an active game!');
            if (game.status === 'active' && game.player1.id !== senderId)
                return reply('❌ Only the game creator can cancel an active game.');

            const result = manager.cancelGame(game.gameId);
            if (!result.success) return reply(`❌ ${result.message}`);

            await sock.sendMessage(chatId, { react: { text: '🚫', key: message.key } });
            return reply(`🚫 *Game cancelled.*`, getPlayerMentions(result.game!));
        }

        // ── .c4 board ────────────────────────────────────────────────────────
        if (sub === 'board') {
            const game = manager.getPlayerGame(senderId);
            if (!game) return reply('❌ You are not in an active game!');
            return reply(gameCard(game), getPlayerMentions(game));
        }

        // ── .c4 stats [mention] ───────────────────────────────────────────────
        if (sub === 'stats') {
            // Pull mentioned user from raw message context info
            const mentionedJid =
                message.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            const targetId = mentionedJid ?? senderId;

            const s    = getStats(targetId);
            const rate = s.gamesPlayed > 0
                ? ((s.wins / s.gamesPlayed) * 100).toFixed(1)
                : '0.0';

            return reply(
                `📊 *Connect Four Stats*\n` +
                `👤 Player: ${tag(targetId)}\n\n` +
                `🎮 Games Played: ${s.gamesPlayed}\n` +
                `🏆 Wins:   ${s.wins}\n` +
                `💔 Losses: ${s.losses}\n` +
                `🤝 Draws:  ${s.draws}\n` +
                `📈 Win Rate: ${rate}%`,
                [targetId]
            );
        }

        // ── .c4 help ─────────────────────────────────────────────────────────
        if (sub === 'help') {
            return reply(
                `🎮 *Connect Four — Help*\n\n` +
                `Drop coloured discs into a 9-column, 7-row grid.\n` +
                `Get 4 discs in a row (horizontal, vertical, or diagonal) to win!\n\n` +
                `*Commands:*\n` +
                `• \`.c4\` — Start a new game\n` +
                `• *join* — Join the waiting game\n` +
                `• *1-9* — Drop your disc in that column\n` +
                `• \`.c4 board\` — Show the current board\n` +
                `• \`.c4 cancel\` — Cancel your game\n` +
                `• \`.c4 stats\` — Your stats\n` +
                `• \`.c4 stats @user\` — Someone else's stats\n` +
                `• \`.c4 help\` — This message\n\n` +
                `*Rules:*\n` +
                `• Join window: ${GAME_CONFIG.JOIN_TIMEOUT / 1000}s\n` +
                `• Turn timeout: ${GAME_CONFIG.TURN_TIMEOUT / 1000}s (player is eliminated)\n` +
                `• Draw: both players get a draw recorded\n\n` +
                `${EMOJIS.PLAYER1} = Player 1 | ${EMOJIS.PLAYER2} = Player 2`
            );
        }

        // ── .c4 (default → start game) ────────────────────────────────────────
        const existing = manager.getActiveGame(chatId);
        if (existing) {
            if (existing.status === 'waiting') {
                return reply(
                    `⚠️ *Game already waiting!*\n\n` +
                    `A game by ${tag(existing.player1.id)} is waiting for an opponent.\n` +
                    `👉 Type *join* to enter!`,
                    [existing.player1.id]
                );
            }
            return reply('⚠️ *Game in progress!* Wait for the current game to finish.');
        }

        const onReminder = async (msg: string) => {
            await sock.sendMessage(chatId, { text: msg, ...channelInfo });
        };

        const create = manager.createGame(senderId, chatId, onReminder);
        if (!create.success) return reply(`❌ ${create.message}`);

        await sock.sendMessage(chatId, { react: { text: '🎮', key: message.key } });
        return reply(
            `${gameCard(create.game!)}\n\n` +
            `⏱️ Game expires in *${GAME_CONFIG.JOIN_TIMEOUT / 1000}s* if no one joins.\n` +
            `*Game ID:* \`${create.game!.gameId}\``,
            [senderId]
        );
    },
};
