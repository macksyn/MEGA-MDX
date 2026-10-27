// @ts-nocheck
/***
 * plugins/bank.ts
 *
 * {prefix}bank — the community bank as a button-menu app. Phase 1: home
 * dashboard, deposit, withdraw, statement. Savings live in lib/bankLedger.ts
 * (separate from the jackpot pool); see that file for the money model.
 *
 * Loans are part of this menu (lib/bankLoans.ts) and nowhere else: the Loans
 * button only appears for members who are eligible or already hold a loan.
 *
 * The HOME screen is the public reserve board players already know from
 * {prefix}reserve (pool, protected floor, available, today's flow, house
 * mood) with the member's own wallet / savings / loan underneath and the menu
 * buttons below. Same disclosure rules as {prefix}reserve: nothing here names
 * the solvency level, pressure, RTP or the mood mechanic — that stays admin-only.
 *
 * Bare `{prefix}bank` opens the menu. Typed shortcuts skip it:
 *   {prefix}bank deposit <amount|all>     {prefix}bank withdraw <amount|all>
 *   {prefix}bank statement                {prefix}bank admin   (owner/sudo)
 *
 * {prefix}reserve (eco_jackpot.ts) stays the public stats board for the
 * house bankroll — remove 'bank' from ITS aliases so the two don't collide.
 */
import { formatNumber, getWallet, withEconomyGuard } from '../lib/economy.js';
import config from '../config.js';
import isOwnerOrSudo, { cleanJid } from '../lib/isOwner.js';
import { getLoanAccess, loanMenuOption, LOAN_SCREENS } from '../lib/bankLoans.js';
import { getJackpotPool, getTodayStats, getHouseMood, JACKPOT_SEED } from '../lib/slotMachine.js';
import {
  BANK_CONFIG, getAccount, getStatement, getBankTotals, getUnfinishedMoves,
  deposit, withdraw, recoverPending,
} from '../lib/bankLedger.js';
import { runApp, askAmount, parseAmount, type Screen, type BankCtx } from '../lib/bankUi.js';
import { ingestAllWagers } from '../lib/wagers.js';

export const command = 'bank';
export const aliases = ['atm', 'savings'];
export const category = 'economy';
export const cooldown = 3000;

const PREFIX = config.prefix || '.';
const BANK = `${PREFIX}bank`;
const fmt = formatNumber;

// ── Formatting ───────────────────────────────────────────────────────────────

function duration(ms: number): string {
  const hrs = Math.max(0, Math.round(Math.abs(ms) / 3_600_000));
  const d = Math.floor(hrs / 24);
  return d > 0 ? `${d}d ${hrs % 24}h` : `${hrs}h`;
}

function loanLine(loan: any): string {
  if (!loan) return `💳 Loan: none`;
  if (loan.status === 'defaulted') return `💳 Loan: owes *${fmt(loan.balance)}* · 🔴 in default`;
  const left = loan.dueAt - Date.now();
  return `💳 Loan: owes *${fmt(loan.balance)}* · ${left >= 0 ? `due in ${duration(left)}` : '⚠️ overdue'}`;
}

// Same ambient copy as the public {prefix}reserve board — deliberately vague so the board can't be
// used to time bets around the house mood window.
const MOOD_FLAVOR: Record<string, string> = {
  hot:     `🌤️ The bank's been feeling generous lately.`,
  cold:    `🌥️ The bank's been playing it a little safe lately.`,
  neutral: `⛅ The bank's running steady as usual.`,
};

const BAR_SIZE = 10;
const RULE = '━━━━━━━━━━━━━━';
// Interactive message bodies are capped (~1024 chars on WhatsApp); stay safely under it.
const BODY_LIMIT = 980;

const bar = (fraction: number) => {
  const filled = Math.max(0, Math.min(BAR_SIZE, Math.round(fraction * BAR_SIZE)));
  return `${'█'.repeat(filled)}${'░'.repeat(BAR_SIZE - filled)}`;
};

// Member-savings total scans every account, so cache it briefly. Bank moves in THIS plugin
// invalidate it so a player never sees their own deposit missing from the board.
let totalsCache = { at: 0, value: { accounts: 0, totalDeposits: 0 } };
async function cachedTotals() {
  if (Date.now() - totalsCache.at < 15_000) return totalsCache.value;
  const value = await getBankTotals();
  totalsCache = { at: Date.now(), value };
  return value;
}
const invalidateTotals = () => { totalsCache.at = 0; };

function boardStamp(): string {
  return new Date().toLocaleString('en-GB', {
    timeZone: config.timeZone || 'Africa/Lagos', weekday: 'short', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit',
  });
}

const KIND_ICON: Record<string, string> = {
  deposit: '📥', withdraw: '📤', interest: '📈', lock: '🔒', unlock: '🔓', adjust: '🔧',
};

function stamp(ts: number): string {
  return new Date(ts).toLocaleString('en-GB', {
    timeZone: config.timeZone || 'Africa/Lagos', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function failureText(r: any): string {
  switch (r.reason) {
    case 'below_minimum':       return `❌ Minimum is ${fmt(r.min ?? BANK_CONFIG.MIN_TXN)} coins.`;
    case 'insufficient_funds':  return `❌ Not enough coins in your wallet.`;
    case 'insufficient_savings':return `❌ Not enough in your savings.`;
    case 'empty':               return `❌ Your savings are empty.`;
    case 'over_cap':            return `❌ Savings cap reached — room for ${fmt(r.room ?? 0)} more coins.`;
    default:                    return `⚠️ That didn't go through. Your coins are safe — any stray amount is restored automatically.`;
  }
}

function chipAmounts(base: number, ceiling = Infinity): number[] {
  return Array.from(new Set(
    [0.25, 0.5, 1].map(f => Math.floor(base * f))
  )).filter(n => n >= BANK_CONFIG.MIN_TXN && n <= ceiling).sort((a, b) => a - b);
}

// ── Screens ──────────────────────────────────────────────────────────────────

const home: Screen = {
  async view(ctx) {
    const [wallet, account, access, pool, today, mood, totals] = await Promise.all([
      getWallet(ctx.userId),
      getAccount(ctx.userId),
      getLoanAccess(ctx.userId),
      getJackpotPool(),
      getTodayStats(),
      getHouseMood().catch(() => null),
      cachedTotals().catch(() => null),
    ]);

    // Loans live in this menu now. The button (and this hint) only exist for members who are eligible
    // right now or already hold a loan — everyone else sees nothing.
    const loan = access.loan;
    const loanOption = loanMenuOption(access);
    const loanHint = !loan && access.eligibility?.eligible
      ? `✨ _You can borrow up to ${fmt(access.eligibility.maxAmount)} coins — tap *💳 Get a loan* below_`
      : '';

    const surplus = Math.max(0, pool - JACKPOT_SEED);
    const insured = pool > 0 ? Math.min(1, JACKPOT_SEED / pool) : 1;
    const netSign = today.net > 0 ? '+' : '';

    // ── Reserve board ──
    const reserve = [
      `🏛️ *RESERVE*`,
      `💰 Balance: *${fmt(pool)}* coins`,
      `🛡️ Protected floor: ${fmt(JACKPOT_SEED)}`,
      `🎯 Available to win: *${fmt(surplus)}*`,
      `${bar(insured)} ${Math.round(insured * 100)}% insured`,
    ].join('\n');

    const todayBlock = [
      `📊 *TODAY*`,
      `⬆️ Wagered ${fmt(today.bet)}  ·  ⬇️ Paid out ${fmt(today.won)}`,
      `⚖️ Net: *${netSign}${fmt(today.net)}*`,
    ].join('\n');

    const moodLine = mood ? (MOOD_FLAVOR[mood.mood] || MOOD_FLAVOR.neutral) : '';
    const heldLine = totals && totals.totalDeposits > 0
      ? `🔐 Member savings held: *${fmt(totals.totalDeposits)}* _(kept apart from the reserve)_`
      : '';

    // ── Your account ──
    const you = [
      `👤 *YOUR ACCOUNT*`,
      `💰 Wallet: ${fmt(wallet.coins)}`,
      `🔐 Savings: *${fmt(account.balance)}*`,
      `📦 Total: *${fmt(wallet.coins + account.balance)}*`,
      loanLine(loan),
    ].join('\n');

    // Required sections first; optional extras are dropped (last-added first) if the body runs long.
    const optional = { mood: moodLine, held: heldLine, hint: loanHint };
    const compose = () => [
      reserve,
      [todayBlock, optional.mood].filter(Boolean).join('\n'),
      optional.held,
      `${RULE}\n${you}${optional.hint ? `\n${optional.hint}` : ''}`,
    ].filter(Boolean).join('\n\n');

    let text = compose();
    for (const key of ['hint', 'held', 'mood'] as const) {
      if (text.length <= BODY_LIMIT) break;
      optional[key] = '';
      text = compose();
    }

    return {
      title: '🏦 COMMUNITY BANK',          // doubles as the list-button label — keep short
      subtitle: `Live board · ${boardStamp()}`,
      text,
      footer: 'Fed by Jungle Hunt · Coinflip · Dice',
      options: [
        { label: '📥 Deposit', value: 'deposit', description: 'Wallet → savings' },
        { label: '📤 Withdraw', value: 'withdraw', description: 'Savings → wallet' },
        ...(loanOption ? [loanOption] : []),
        { label: '🧾 Statement', value: 'statement', description: 'Your recent activity' },
        { label: '🔄 Refresh', value: 'refresh', description: 'Update the live numbers' },
      ],
    };
  },
  async select(value) {
    if (value === 'refresh') return { stay: true };
    return { go: value };
  },
};

const depositScreen: Screen = {
  async view(ctx) {
    const [wallet, account] = await Promise.all([getWallet(ctx.userId), getAccount(ctx.userId)]);
    const room = Math.max(0, BANK_CONFIG.MAX_SAVINGS - account.balance);
    const chips = chipAmounts(wallet.coins, room);
    const options = chips.map(n => ({
      label: `${fmt(n)} coins`, value: String(n),
      description: n === wallet.coins ? 'Entire wallet' : undefined,
    }));
    options.push({ label: '✍️ Custom amount', value: 'custom' });
    return {
      title: '📥 DEPOSIT',
      subtitle: `Wallet ${fmt(wallet.coins)} · Savings ${fmt(account.balance)}`,
      text: wallet.coins < BANK_CONFIG.MIN_TXN
        ? `You need at least ${fmt(BANK_CONFIG.MIN_TXN)} coins in your wallet to deposit.`
        : 'How much would you like to deposit?',
      options: wallet.coins < BANK_CONFIG.MIN_TXN ? [] : options,
    };
  },
  async select(value, ctx) {
    let amount: number | 'all' | null;
    if (value === 'custom') {
      amount = await askAmount(ctx, { prompt: '✍️ *How much do you want to deposit?*' });
      if (amount === null) return { stay: true };
    } else {
      amount = parseInt(value, 10);
    }
    const r = await deposit(ctx.userId, amount as number);
    invalidateTotals();
    if (!r.ok) return { stay: true, notice: failureText(r) };
    return {
      go: 'home', reset: true,
      notice: `✅ Deposited *${fmt(r.entry.amount)} coins*\nSavings balance: *${fmt(r.account.balance)}*`,
    };
  },
};

const withdrawScreen: Screen = {
  async view(ctx) {
    const [wallet, account] = await Promise.all([getWallet(ctx.userId), getAccount(ctx.userId)]);
    const chips = chipAmounts(account.balance);
    // A balance under the minimum is still fully withdrawable as one "all" chip.
    if (account.balance > 0 && account.balance < BANK_CONFIG.MIN_TXN) chips.push(account.balance);
    const options = chips.map(n => ({
      label: `${fmt(n)} coins`, value: String(n),
      description: n === account.balance ? 'Everything' : undefined,
    }));
    if (account.balance >= BANK_CONFIG.MIN_TXN) options.push({ label: '✍️ Custom amount', value: 'custom' });
    return {
      title: '📤 WITHDRAW',
      subtitle: `Savings ${fmt(account.balance)} · Wallet ${fmt(wallet.coins)}`,
      text: account.balance > 0 ? 'How much would you like to withdraw?' : 'Your savings are empty.',
      options,
    };
  },
  async select(value, ctx) {
    let amount: number | 'all' | null;
    if (value === 'custom') {
      amount = await askAmount(ctx, { prompt: '✍️ *How much do you want to withdraw?*', allowAll: true });
      if (amount === null) return { stay: true };
    } else {
      amount = parseInt(value, 10);
    }
    const r = await withdraw(ctx.userId, amount);
    invalidateTotals();
    if (!r.ok) return { stay: true, notice: failureText(r) };
    return {
      go: 'home', reset: true,
      notice: `✅ Withdrew *${fmt(Math.abs(r.entry.amount))} coins*\nSavings balance: *${fmt(r.account.balance)}*`,
    };
  },
};

const statementScreen: Screen = {
  async view(ctx) {
    const entries = await getStatement(ctx.userId, 10);
    const lines = entries.length === 0
      ? '_No activity yet._'
      : entries.map(e =>
          `${KIND_ICON[e.kind] || '•'} ${e.amount > 0 ? '+' : ''}${fmt(e.amount)} · ${stamp(e.ts)}\n    ${e.note || e.kind} → bal ${fmt(e.balanceAfter)}`
        ).join('\n');
    return { title: '🧾 STATEMENT', subtitle: 'Last 10 transactions', text: lines, options: [] };
  },
  async select() {
    return { back: true };
  },
};

const SCREENS = { home, deposit: depositScreen, withdraw: withdrawScreen, statement: statementScreen, ...LOAN_SCREENS };

// ── Typed shortcuts + admin ──────────────────────────────────────────────────

async function reply(sock: any, message: any, chatId: string, channelInfo: any, text: string) {
  return sock.sendMessage(chatId, { text, ...channelInfo }, { quoted: message });
}

async function handleAdmin(sock: any, message: any, chatId: string, channelInfo: any) {
  const [pool, totals, stuck] = await Promise.all([getJackpotPool(), getBankTotals(), getUnfinishedMoves()]);
  const surplus = Math.max(0, pool - JACKPOT_SEED);
  const stuckLines = stuck.slice(0, 8).map(j => `  • ${j.kind} ${fmt(j.amount)} · ${j.userId} · ${j.stage}`);
  return reply(sock, message, chatId, channelInfo,
    `🏦 *BANK — ADMIN VIEW*\n\n` +
    `🔐 Customer deposits (liability): *${fmt(totals.totalDeposits)}* across ${totals.accounts} accounts\n` +
    `💰 House reserve: *${fmt(pool)}*  (floor ${fmt(JACKPOT_SEED)}, surplus ${fmt(surplus)})\n` +
    `_Deposits are held separately — the reserve never pays winnings out of them._\n\n` +
    (stuck.length ? `⚠️ *Unfinished moves (${stuck.length}):*\n${stuckLines.join('\n')}` : `✅ No unfinished moves.`));
}

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, senderId, channelInfo } = context;
  const userId = cleanJid(senderId);
  const sub = (args[0] || '').toLowerCase();

  if (sub === 'admin') {
    if (!(await isOwnerOrSudo(senderId, sock, chatId))) return reply(sock, message, chatId, channelInfo, `❌ That view is for admins only.`);
    return handleAdmin(sock, message, chatId, channelInfo);
  }

  if (sub === 'deposit' || sub === 'withdraw') {
    const raw = (args[1] || '').toLowerCase();
    if (sub === 'deposit') {
      const wallet = await getWallet(userId);
      const amount = raw === 'all' ? wallet.coins : parseAmount(raw);
      if (!amount) return reply(sock, message, chatId, channelInfo, `❌ Usage: ${BANK} deposit <amount|all>`);
      const r = await deposit(userId, amount as number);
      invalidateTotals();
      return reply(sock, message, chatId, channelInfo, r.ok
        ? `✅ Deposited *${fmt(r.entry.amount)} coins*\nSavings balance: *${fmt(r.account.balance)}*`
        : failureText(r));
    }
    const amount = parseAmount(raw, true);
    if (!amount) return reply(sock, message, chatId, channelInfo, `❌ Usage: ${BANK} withdraw <amount|all>`);
    const r = await withdraw(userId, amount);
    invalidateTotals();
    return reply(sock, message, chatId, channelInfo, r.ok
      ? `✅ Withdrew *${fmt(Math.abs(r.entry.amount))} coins*\nSavings balance: *${fmt(r.account.balance)}*`
      : failureText(r));
  }

  if (sub === 'statement' || sub === 'history') {
    const view = await statementScreen.view({ userId } as BankCtx);
    return reply(sock, message, chatId, channelInfo, `*${view.title}*\n_${view.subtitle}_\n\n${view.text}`);
  }

  const ctx: BankCtx = { sock, message, chatId, userId, channelInfo };
  return runApp(ctx, SCREENS, 'home');
}

export const handler = withEconomyGuard(_handler);
export const usage = `${BANK} — opens the bank. Or: ${BANK} <deposit|withdraw|statement> [amount|all]`;

// 1) Rolls forward any deposit/withdrawal that died halfway (see lib/bankLedger.ts).
// 2) Folds everyone's new game / Sportybet stakes into the play ledger that loan eligibility is
//    judged on (lib/wagers.ts). It also runs per member whenever their credit is assessed; this
//    hourly sweep just keeps members who aren't opening the bank from falling out of the
//    200-entry transaction log.
export const schedules = [
  {
    every: 5 * 60 * 1000,
    handler: async () => {
      const report = await recoverPending();
      if (report.recovered || report.needsReview) {
        console.warn(`[bank] recovery sweep: ${report.recovered} recovered, ${report.needsReview} need review`);
      }
    },
  },
  {
    every: 60 * 60 * 1000,
    handler: async () => { await ingestAllWagers(); },
  },
];