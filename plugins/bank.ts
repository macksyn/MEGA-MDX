// @ts-nocheck
/***
 * plugins/bank.ts
 *
 * {prefix}bank — the community bank as a button-menu app. Phase 1: home
 * dashboard, deposit, withdraw, statement. Savings live in lib/bank/ledger.ts
 * (separate from the jackpot pool); see that file for the money model.
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
import { getRepayableLoan } from '../lib/loans.js';
import { getJackpotPool, JACKPOT_SEED } from '../lib/slotMachine.js';
import {
  BANK_CONFIG, getAccount, getStatement, getBankTotals, getUnfinishedMoves,
  deposit, withdraw, recoverPending,
} from '../lib/bank/ledger.js';
import { runApp, askAmount, parseAmount, type Screen, type BankCtx } from '../lib/bank/ui.js';

export const command = 'banktest';
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
  if (!loan) return `💳 Loan       none`;
  if (loan.status === 'defaulted') return `💳 Loan       owes ${fmt(loan.balance)} · 🔴 default`;
  const left = loan.dueAt - Date.now();
  return `💳 Loan       owes ${fmt(loan.balance)} · ${left >= 0 ? `due in ${duration(left)}` : '⚠️ overdue'}`;
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
    const [wallet, account, loan] = await Promise.all([
      getWallet(ctx.userId),
      getAccount(ctx.userId),
      getRepayableLoan(ctx.userId).catch(() => null),
    ]);
    return {
      title: '🏦 COMMUNITY BANK',
      text:
        `💰 Wallet     ${fmt(wallet.coins)}\n` +
        `🔐 Savings    ${fmt(account.balance)}\n` +
        `━━━━━━━━━━━━━━\n` +
        `📦 Total       ${fmt(wallet.coins + account.balance)}\n` +
        `${loanLine(loan)}`,
      options: [
        { label: '📥 Deposit', value: 'deposit', description: 'Wallet → savings' },
        { label: '📤 Withdraw', value: 'withdraw', description: 'Savings → wallet' },
        { label: '🧾 Statement', value: 'statement', description: 'Recent activity' },
      ],
    };
  },
  async select(value) {
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

const SCREENS = { home, deposit: depositScreen, withdraw: withdrawScreen, statement: statementScreen };

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
      return reply(sock, message, chatId, channelInfo, r.ok
        ? `✅ Deposited *${fmt(r.entry.amount)} coins*\nSavings balance: *${fmt(r.account.balance)}*`
        : failureText(r));
    }
    const amount = parseAmount(raw, true);
    if (!amount) return reply(sock, message, chatId, channelInfo, `❌ Usage: ${BANK} withdraw <amount|all>`);
    const r = await withdraw(userId, amount);
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

// Rolls forward any deposit/withdrawal that died halfway (see lib/bank/ledger.ts).
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
];
