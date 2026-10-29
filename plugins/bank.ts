// @ts-nocheck
/***
 * plugins/bank.ts
 *
 * {prefix}bank — the community bank as a button-menu app. Phase 1: home
 * dashboard, deposit, withdraw, statement. Savings live in lib/bankLedger.ts
 * (separate from the jackpot pool); see that file for the money model.
 *
 * Loans (lib/bankLoans.ts) and Money Lock (lib/bankLocksUi.ts) are part of this
 * menu. The Loans button only appears for members whose credit score qualifies or
 * who already hold a loan; Money Lock is open to everyone.
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
import { getLoanAccess, loanMenuOption, LOAN_SCREENS, payLoanFromSavings } from '../lib/bankLoans.js';
import { LOCK_SCREENS } from '../lib/bankLocksUi.js';
import { LOCK_CONFIG, getLockSummary, getLockTotals, getLockedPrincipal, sweepLocks, recoverLocks } from '../lib/bankLocks.js';
import { noteBalance } from '../lib/bankActivity.js';
import { getAllDefaultedLoans } from '../lib/loans.js';
import { getReserveSnapshot, addInsurance, getTodayStats, getHouseMood, JACKPOT_SEED } from '../lib/slotMachine.js';
import { INSURANCE_CONFIG, getInsuranceSettings, setAutoInsurance, nextRunDay, sweepInsurance } from '../lib/insurance.js';
import {
  BANK_CONFIG, getAccount, getStatement, getBankTotals, getUnfinishedMoves, getAvailableSavings, listAccountBalances,
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
let totalsCache = { at: 0, value: { accounts: 0, totalDeposits: 0, lockedPrincipal: 0 } };
async function cachedTotals() {
  if (Date.now() - totalsCache.at < 15_000) return totalsCache.value;
  const [bank, locks] = await Promise.all([getBankTotals(), getLockTotals()]);
  const value = { ...bank, lockedPrincipal: locks.lockedPrincipal };
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
    case 'held':                return `❌ ${fmt(r.held ?? 0)} of your savings is held as security for your loan — you can withdraw up to ${fmt(r.available ?? 0)}.`;
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
    if (ctx.notice) invalidateTotals();   // we just moved money: don't show a stale board total next to the receipt
    // Pay out any lock that has matured BEFORE reading balances, so the savings figure and the
    // "matured" line can never disagree.
    const locks: any = await getLockSummary(ctx.userId).catch(() => ({ lockedPrincipal: 0, settled: [] }));
    const [wallet, account, access, res, today, mood, totals, sav] = await Promise.all([
      getWallet(ctx.userId),
      getAccount(ctx.userId),
      getLoanAccess(ctx.userId),
      getReserveSnapshot(),
      getTodayStats(),
      getHouseMood().catch(() => null),
      cachedTotals().catch(() => null),
      getAvailableSavings(ctx.userId).catch(() => ({ hold: 0 })),
    ]);

    // Loans live in this menu now. The button (and this hint) only exist for members who are eligible
    // right now or already hold a loan — everyone else sees nothing.
    const loan = access.loan;
    const loanOption = loanMenuOption(access);
    const loanHint = !loan && access.eligibility?.eligible
      ? `✨ _You can borrow up to ${fmt(access.eligibility.maxAmount)} coins — *💳 Get a loan* below_`
      : '';

    const surplus = res.available;
    const insured = res.total > 0 ? Math.min(1, res.insurance / res.total) : 1;   // insurance = base floor + whatever has been set aside
    const netSign = today.net > 0 ? '+' : '';

    // ── Reserve board ──
    const reserve = [
      `🏛️ *RESERVE*`,
      `💰 Balance: *${fmt(res.total)}* coins`,
      `🛡️ Insurance: ${fmt(res.insurance)}`,
      `🎯 Available to win: *${fmt(surplus)}*`,
      `${bar(insured)} ${Math.round(insured * 100)}% insured`,
    ].join('\n');

    const todayBlock = [
      `📊 *TODAY*`,
      `⬆️ Income ${fmt(today.bet)}  ·  ⬇️ Paid out ${fmt(today.won)}`,
      `⚖️ Profit: *${netSign}${fmt(today.net)}*`,
    ].join('\n');

    const moodLine = mood ? (MOOD_FLAVOR[mood.mood] || MOOD_FLAVOR.neutral) : '';
    const heldLine = totals && totals.totalDeposits > 0
      ? `🔐 Member savings vault: *${fmt(totals.totalDeposits)}* _(kept apart from the reserve)_`
      : '';
    const lockedLine = totals && totals.lockedPrincipal > 0
      ? `🔒 Locked savings: *${fmt(totals.lockedPrincipal)}* _(working for the bank · ${Math.round(LOCK_CONFIG.RESERVE_REQUIREMENT * 100)}% held in reserve)_`
      : '';
    const maturedLines = (locks.settled || []).map((s: any) => `🔓 *${s.lock.planName}* matured — *${fmt(s.credited)}* coins paid into your savings.`);

    // ── Your account ──
    const lockedMine = locks.lockedPrincipal || 0;
    const you = [
      `👤 *YOUR ACCOUNT*`,
    //`💰 Wallet: ${fmt(wallet.coins)}`,
      `🔐 Savings: *${fmt(account.balance)}*${sav.hold > 0 ? ` _(${fmt(sav.hold)} held as loan security)_` : ''}`,
      ...(lockedMine > 0 ? [`🔒 Locked: *${fmt(lockedMine)}*`] : []),
      `📦 Total: *${fmt(account.balance + lockedMine)}*`,
      loanLine(loan),
    ].join('\n');

    // Required sections first; optional extras are dropped (last-added first) if the body runs long.
    const optional = { mood: moodLine, held: heldLine, locked: lockedLine, hint: loanHint, matured: maturedLines.join('\n') };
    const compose = () => [
      optional.matured,
      reserve,
      [todayBlock, optional.mood].filter(Boolean).join('\n'),
      [optional.held, optional.locked].filter(Boolean).join('\n'),
      `${RULE}\n${you}${optional.hint ? `\n${optional.hint}` : ''}`,
    ].filter(Boolean).join('\n\n');

    let text = compose();
    for (const key of ['hint', 'held', 'locked', 'mood'] as const) {
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
        { label: '🔒 Money Lock', value: 'locks', description: `Earn up to ${Math.max(...LOCK_CONFIG.PLANS.map(p => p.rate * 100))}% on locked coins` },
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
    const [wallet, sav] = await Promise.all([getWallet(ctx.userId), getAvailableSavings(ctx.userId)]);
    const free = sav.available;
    const chips = chipAmounts(free);
    // A balance under the minimum is still fully withdrawable as one "all" chip.
    if (free > 0 && free < BANK_CONFIG.MIN_TXN) chips.push(free);
    const options = chips.map(n => ({
      label: `${fmt(n)} coins`, value: String(n),
      description: n === free ? (sav.hold > 0 ? 'Everything free' : 'Everything') : undefined,
    }));
    if (free >= BANK_CONFIG.MIN_TXN) options.push({ label: '✍️ Custom amount', value: 'custom' });
    const lines = [free > 0 ? 'How much would you like to withdraw?' : (sav.balance > 0 ? 'Your savings are all held as security for your loan.' : 'Your savings are empty.')];
    if (sav.hold > 0) lines.push(`_🔐 ${fmt(sav.hold)} is held as security for your loan until it's repaid._`);
    return {
      title: '📤 WITHDRAW',
      subtitle: `Savings ${fmt(sav.balance)} · Wallet ${fmt(wallet.coins)}`,
      text: lines.join('\n'),
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

const SCREENS = { home, deposit: depositScreen, withdraw: withdrawScreen, statement: statementScreen, ...LOAN_SCREENS, ...LOCK_SCREENS };

// ── Typed shortcuts + admin ──────────────────────────────────────────────────

async function reply(sock: any, message: any, chatId: string, channelInfo: any, text: string) {
  return sock.sendMessage(chatId, { text, ...channelInfo }, { quoted: message });
}

function pctOf(n: number, d: number) { return d > 0 ? `${(n / d).toFixed(1)}×` : '—'; }

async function handleAdmin(sock: any, message: any, chatId: string, channelInfo: any) {
  const [res, totals, locks, stuck] = await Promise.all([getReserveSnapshot(), getBankTotals(), getLockTotals(), getUnfinishedMoves()]);
  const stuckLines = stuck.slice(0, 8).map(j => `  • ${j.kind} ${fmt(j.amount)} · ${j.userId} · ${j.stage}`);
  return reply(sock, message, chatId, channelInfo,
    `🏦 *BANK — ADMIN VIEW*\n\n` +
    `*Reserve*\n` +
    `💰 Total held: *${fmt(res.total)}*  ·  playable (games + loans see this): *${fmt(res.visible)}*  (available ${fmt(res.available)})\n` +
    `🛡️ Insurance: *${fmt(res.insurance)}*  (base ${fmt(JACKPOT_SEED)} + added ${fmt(res.extra)})  ·  covers interest owed ${pctOf(res.insurance, locks.expectedInterest)}\n` +
    `🏛️ House pool alone: ${fmt(res.house)}  ·  customer capital in use: ${fmt(res.depositCapital)}\n` +
    (res.underwater ? `🔴 *UNDERWATER* — the playable pool is ${fmt(JACKPOT_SEED - res.visible)} below the floor, so the insurance is being drawn on. Games are in emergency mode; new locks and loans are paused until house profits rebuild it.\n` : `✅ Insurance intact.\n`) +
    `\n*Liabilities*\n` +
    `🔐 Savings (held 1:1, never lent): *${fmt(totals.totalDeposits)}* across ${totals.accounts} accounts\n` +
    `🔒 Locked: *${fmt(locks.lockedPrincipal)}* in ${locks.count} locks (${locks.members} members)\n` +
    `   ├ in use by the bank: ${fmt(locks.depositCapital)}\n` +
    `   ├ held in reserve (${Math.round(LOCK_CONFIG.RESERVE_REQUIREMENT * 100)}%): ${fmt(locks.protectedAmount)}\n` +
    `   └ interest owed at maturity: *${fmt(locks.expectedInterest)}*\n\n` +
    (stuck.length ? `⚠️ *Unfinished moves (${stuck.length}):*\n${stuckLines.join('\n')}\n\n` : `✅ No unfinished moves.\n\n`) +
    `_${BANK} admin insurance — fund, top-ups and settings_`);
}

const shortDay = (day: string) => new Date(day + 'T00:00:00Z').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });

async function handleInsurance(sock: any, message: any, chatId: string, channelInfo: any, args: string[]) {
  const action = (args[2] || '').toLowerCase();

  if (action === 'add') {
    const amount = parseAmount(args[3] || '');
    if (!amount || amount === 'all') return reply(sock, message, chatId, channelInfo, `❌ Usage: ${BANK} admin insurance add <amount>`);
    const r = await addInsurance(amount);
    return reply(sock, message, chatId, channelInfo, r.ok
      ? `🛡️ Set aside *${fmt(amount)}* more as insurance.\nAdded so far: *${fmt(r.extra)}* · total insurance *${fmt(JACKPOT_SEED + r.extra)}* · still available to win: ${fmt(r.available)}`
      : r.reason === 'no_surplus'
        ? `❌ Only ${fmt(r.available)} coins of playable surplus are available — you can't insure coins the bank doesn't have yet. Try a smaller amount.`
        : `❌ Enter a positive amount.`);
  }

  if (action === 'auto') {
    const first = (args[3] || '').toLowerCase();
    if (first === 'off') {
      await setAutoInsurance(0);
      return reply(sock, message, chatId, channelInfo, `🛡️ Automatic insurance top-up is *off*. Add coins by hand with: ${BANK} admin insurance add <amount>`);
    }
    const pct = parseFloat(first);
    const period = (args[4] || '').toLowerCase();
    if (!Number.isFinite(pct) || pct <= 0 || (period !== 'weekly' && period !== 'monthly')) {
      return reply(sock, message, chatId, channelInfo, `❌ Usage: ${BANK} admin insurance auto <percent> <weekly|monthly>   (or: auto off)\nExample: ${BANK} admin insurance auto 10 weekly`);
    }
    const r = await setAutoInsurance(pct, period as any);
    if (!r.ok) return reply(sock, message, chatId, channelInfo, `❌ Use a percentage between 1 and ${INSURANCE_CONFIG.MAX_RATE * 100}.`);
    return reply(sock, message, chatId, channelInfo,
      `🛡️ Automatic top-up: *${pct}%* of the house's game profit, every *${period === 'weekly' ? 'week' : 'month'}*.\n_Counting starts from the next completed day; the first top-up arrives after a full ${period === 'weekly' ? 'week' : 'month'}._`);
  }

  // status
  const [res, locks, s] = await Promise.all([getReserveSnapshot(), getLockTotals(), getInsuranceSettings()]);
  const next = nextRunDay(s);
  const last = s.history[0];
  const lines = [
    `🛡️ *INSURANCE FUND*\n`,
    `Total: *${fmt(res.insurance)}*  (base ${fmt(JACKPOT_SEED)} + added ${fmt(res.extra)}, max added ${fmt(INSURANCE_CONFIG.MAX_EXTRA)})`,
    `Covers the interest owed on locks (${fmt(locks.expectedInterest)}) ${pctOf(res.insurance, locks.expectedInterest)} over`,
    `Playable surplus: ${fmt(res.available)}${res.underwater ? '  🔴 UNDERWATER' : ''}`,
    ``,
    s.enabled
      ? `Auto top-up: *${(s.rate * 100).toFixed(0)}%* of game profit, *${s.period}*${next ? ` · next ${shortDay(next)}` : ' · baseline is set at the next sweep'}`
      : `Auto top-up: *off*`,
  ];
  if (last) {
    lines.push(`Last run: ${shortDay(last.from)}–${shortDay(last.to)} · profit ${fmt(last.profit)} → *+${fmt(last.contributed)}*${last.note ? ` _(${last.note})_` : ''}`);
  }
  if (s.history.length > 1) {
    lines.push('', '*History*', ...s.history.slice(0, 5).map(h => `• ${shortDay(h.to)}: profit ${fmt(h.profit)} → +${fmt(h.contributed)}`));
  }
  lines.push('', `_${BANK} admin insurance add <amount>  ·  auto <percent> <weekly|monthly>  ·  auto off_`);
  return reply(sock, message, chatId, channelInfo, lines.join('\n'));
}

async function _handler(sock: any, message: any, args: string[], context: any) {
  const { chatId, senderId, channelInfo } = context;
  const userId = cleanJid(senderId);
  const sub = (args[0] || '').toLowerCase();

  if (sub === 'admin') {
    if (!(await isOwnerOrSudo(senderId, sock, chatId))) return reply(sock, message, chatId, channelInfo, `❌ That view is for admins only.`);
    if ((args[1] || '').toLowerCase() === 'insurance') return handleInsurance(sock, message, chatId, channelInfo, args);
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

// ── Scheduled jobs ───────────────────────────────────────────────────────────

async function dm(sock: any, userId: string, text: string) {
  try {
    const w = await getWallet(userId);
    if (w.jid) await sock.sendMessage(w.jid, { text });   // wallet.jid is the only field that reliably builds a DM target
  } catch (err) { console.error('[bank] DM failed:', err); }
}

/** Keeps the credit file's savings history current for accounts that existed before it was tracked. */
async function syncBankActivity() {
  for (const { userId, balance } of await listAccountBalances()) {
    try { await noteBalance(userId, { savings: balance, locked: await getLockedPrincipal(userId) }); }
    catch (err) { console.error('[bank] activity sync failed for', userId, err); }
  }
}

/**
 * Default setoff: a member whose loan is in default has their savings used to clear it (the savings
 * were held as security for exactly this). Locked coins aren't touched — once a lock matures the
 * coins land in savings and the next sweep applies them.
 */
async function sweepDefaultSetoffs(sock: any) {
  for (const loan of await getAllDefaultedLoans()) {
    try {
      const r = await payLoanFromSavings(loan.userId, 'all');
      if (r.success && r.paid > 0) {
        invalidateTotals();
        await dm(sock, loan.userId,
          `🔴 *LOAN IN DEFAULT*\n\n*${fmt(r.paid)} coins* of your savings were used to repay your defaulted loan` +
          (r.fullyRepaid ? ` — it's now cleared.` : `. *${fmt(r.remaining)}* is still owed; type *${BANK}* → *My loan* to see it.`));
      }
    } catch (err) { console.error('[bank] default setoff failed for', loan.userId, err); }
  }
}

export const schedules = [
  {
    // Rolls forward any deposit / withdrawal / lock that died halfway (lib/bankLedger.ts, lib/bankLocks.ts).
    every: 5 * 60 * 1000,
    handler: async () => {
      const report = await recoverPending();
      if (report.recovered || report.needsReview) {
        console.warn(`[bank] recovery sweep: ${report.recovered} recovered, ${report.needsReview} need review`);
      }
      await recoverLocks();
    },
  },
  {
    // Folds everyone's new game / Sportybet stakes into the play ledger loan eligibility is judged on
    // (lib/wagers.ts), and syncs savings history. Both also happen per member when their credit is
    // assessed; this keeps members who aren't opening the bank from falling out of the 200-entry log.
    every: 60 * 60 * 1000,
    handler: async () => { await ingestAllWagers(); await syncBankActivity(); },
  },
  {
    // Pays out matured Money Locks and tells the member. (Opening the bank also settles them instantly.)
    every: 30 * 60 * 1000,
    handler: async (sock: any) => {
      const events = await sweepLocks();
      for (const ev of events) {
        invalidateTotals();
        await dm(sock, ev.userId,
          `🔓 *MONEY LOCK MATURED*\n\nYour *${ev.lock.planName}* has paid out: *${fmt(ev.credited)} coins* are now in your savings ` +
          `(${fmt(ev.lock.principal)} + ${fmt(ev.lock.interest)} interest).\n\nType *${BANK}* to see it, or lock it again to keep earning.`);
      }
    },
  },
  {
    every: 60 * 60 * 1000,
    handler: async (sock: any) => {
      await sweepDefaultSetoffs(sock);
      await sweepInsurance();   // moves the weekly/monthly share of game profit into the insurance fund when it falls due
    },
  },
];
