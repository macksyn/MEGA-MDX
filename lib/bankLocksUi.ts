// @ts-nocheck
/***
 * lib/bankLocksUi.ts
 *
 * Money Lock screens for the bank menu. Presentation and navigation only — the
 * engine (plans, interest, maturity, early break, the reserve) is lib/bankLocks.ts.
 *
 *   home ─▶ locks (plans) ─▶ lockPlan (amount) ─▶ lockConfirm ─▶ (locked, back to home)
 *             ├─ myLocks ─▶ lockDetail ─▶ lockBreak ─▶ (broken early, back to home)
 *             └─ lockInfo
 *
 * promptMenu prints each screen's `title` as the bold header and uses it as the
 * list-button label (keep it ≤ ~20 chars), so card text never repeats it.
 */
import { formatNumber } from './economy.js';
import config from '../config.js';
import { getAvailableSavings } from './bankLedger.js';
import {
  LOCK_CONFIG, getPlan, planApr, breakFee, createLock, breakLock, getLockSummary, getLock,
} from './bankLocks.js';
import { askAmount, type Screen } from './bankUi.js';

const fmt = formatNumber;
const pct = (r: number, d = 0) => `${(r * 100).toFixed(d)}%`;
const aprText = (p: any) => `≈${Math.round(planApr(p) * 100)}% a year`;

function dateText(ts: number): string {
  return new Date(ts).toLocaleDateString('en-GB', { timeZone: config.timeZone || 'Africa/Lagos', day: '2-digit', month: 'short', year: 'numeric' });
}
function shortDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-GB', { timeZone: config.timeZone || 'Africa/Lagos', day: '2-digit', month: 'short' });
}
function duration(ms: number): string {
  const hrs = Math.max(0, Math.round(Math.abs(ms) / 3_600_000));
  const d = Math.floor(hrs / 24);
  return d > 0 ? `${d}d ${hrs % 24}h` : `${hrs}h`;
}
function bar(percent: number, size = 10): string {
  const filled = Math.max(0, Math.min(size, Math.round((percent / 100) * size)));
  return `${'█'.repeat(filled)}${'░'.repeat(size - filled)}`;
}
const planRate = (p: any) => (p.rate * 100) % 1 === 0 ? `${p.rate * 100}%` : `${(p.rate * 100).toFixed(1)}%`;

function failureText(r: any): string {
  switch (r.reason) {
    case 'below_minimum':        return `❌ Minimum lock is ${fmt(r.min ?? LOCK_CONFIG.MIN_LOCK)} coins.`;
    case 'insufficient_savings': return `❌ Not enough in your savings — you can lock up to ${fmt(r.available ?? 0)}.`;
    case 'held':                 return `❌ ${fmt(r.held ?? 0)} of your savings is held as security for your loan — you can lock up to ${fmt(r.available ?? 0)}.`;
    case 'member_cap':           return `❌ Lock limit reached — you can lock ${fmt(r.room ?? 0)} more coins right now.`;
    case 'bank_cap':             return `❌ Money Lock is full at the moment — try again later.`;
    case 'underwater':           return `❌ The bank is rebuilding its reserve, so new locks are paused for now. Check back soon.`;
    default:                     return `⚠️ That didn't go through. Your coins are safe — any stray amount is restored automatically.`;
  }
}

// ── Plans (hub) ──────────────────────────────────────────────────────────────

const locks: Screen = {
  async view(ctx) {
    const summary = await getLockSummary(ctx.userId);          // settles anything matured first...
    const sav = await getAvailableSavings(ctx.userId);          // ...so the savings figure already includes it

    const lines: string[] = [];
    for (const ev of summary.settled) {
      lines.push(`🔓 *${ev.lock.planName}* matured — *${fmt(ev.credited)}* coins paid into your savings.`);
    }
    if (lines.length) lines.push('');
    lines.push(`🔐 Savings: *${fmt(sav.balance)}*  ·  🔒 Locked: *${fmt(summary.lockedPrincipal)}*`);
    if (summary.nextMaturity) {
      lines.push(`⏳ Next payout: ${shortDate(summary.nextMaturity)} · total interest due *+${fmt(summary.expectedInterest)}*`);
    }
    lines.push('');
    lines.push(`Lock coins for a fixed term and earn guaranteed interest, paid into your savings when it ends.`);
    if (sav.available < LOCK_CONFIG.MIN_LOCK) {
      lines.push(`_You need at least ${fmt(LOCK_CONFIG.MIN_LOCK)} coins free in savings to lock — deposit first._`);
    }

    const options: any[] = LOCK_CONFIG.PLANS.map(p => ({
      label: `${p.emoji} ${p.name}`,
      value: `plan:${p.id}`,
      description: `${planRate(p)} in ${p.days} days · ${aprText(p)}`,
    }));
    if (summary.active.length + summary.recent.length > 0) {
      options.push({ label: `📂 My locks${summary.active.length ? ` (${summary.active.length})` : ''}`, value: 'mine', description: 'Track and manage' });
    }
    options.push({ label: 'ℹ️ How it works', value: 'info' });

    return { title: '🔒 MONEY LOCK', subtitle: 'Save with a purpose', text: lines.join('\n'), options };
  },
  async select(value) {
    if (value.startsWith('plan:')) return { go: 'lockPlan', params: { planId: value.slice(5) } };
    if (value === 'mine') return { go: 'myLocks' };
    if (value === 'info') return { go: 'lockInfo' };
    return { stay: true };
  },
};

// ── Pick an amount ───────────────────────────────────────────────────────────

const lockPlan: Screen = {
  async view(ctx, params) {
    const plan = getPlan(params.planId);
    const sav = await getAvailableSavings(ctx.userId);
    const lines = [
      `Earn *${planRate(plan)}* in ${plan.days} days (${aprText(plan)}) — fixed, paid when the lock ends.`,
      `🔐 Free to lock: *${fmt(sav.available)}* coins`,
    ];
    if (sav.hold > 0) lines.push(`_${fmt(sav.hold)} of your savings is held as security for your loan._`);

    const presets = Array.from(new Set(
      [0.25, 0.5, 0.75, 1].map(f => Math.floor(sav.available * f)).filter(n => n >= LOCK_CONFIG.MIN_LOCK)
    )).sort((a, b) => a - b);

    const options: any[] = presets.map(a => ({
      label: `${fmt(a)} coins`, value: String(a),
      description: `Get ${fmt(a + Math.round(a * plan.rate))} back`,
    }));
    if (sav.available >= LOCK_CONFIG.MIN_LOCK) {
      options.push({ label: '✍️ Custom amount', value: 'custom' });
      lines.push('', 'How much would you like to lock?');
    } else {
      options.push({ label: '📥 Deposit to savings', value: 'deposit', description: 'Move coins from your wallet' });
      lines.push('', `You need at least ${fmt(LOCK_CONFIG.MIN_LOCK)} coins free in savings.`);
    }
    return { title: '🔒 LOCK COINS', subtitle: `${plan.name} · ${plan.days} days`, text: lines.join('\n'), options };
  },
  async select(value, ctx, params) {
    if (value === 'deposit') return { go: 'deposit' };
    let amount: number | 'all' | null;
    if (value === 'custom') {
      amount = await askAmount(ctx, { prompt: `✍️ *How much do you want to lock?*\n_Minimum ${fmt(LOCK_CONFIG.MIN_LOCK)} coins_` });
      if (amount === null) return { stay: true };
    } else {
      amount = parseInt(value, 10);
    }
    const sav = await getAvailableSavings(ctx.userId);
    if (amount < LOCK_CONFIG.MIN_LOCK) return { stay: true, notice: failureText({ reason: 'below_minimum' }) };
    if (amount > sav.balance) return { stay: true, notice: failureText({ reason: 'insufficient_savings', available: sav.available }) };
    if (amount > sav.available) return { stay: true, notice: failureText({ reason: 'held', held: sav.hold, available: sav.available }) };
    return { go: 'lockConfirm', params: { planId: params.planId, amount } };
  },
};

// ── Confirm ──────────────────────────────────────────────────────────────────

const lockConfirm: Screen = {
  async view(ctx, params) {
    const plan = getPlan(params.planId);
    const amount = params.amount;
    const interest = Math.round(amount * plan.rate);
    const matures = Date.now() + plan.days * 86_400_000;
    return {
      title: '🔒 CONFIRM LOCK',
      subtitle: plan.name,
      text: [
        `Lock: *${fmt(amount)}* coins for *${plan.days} days*`,
        `Interest: *+${fmt(interest)}* (${planRate(plan)}) — fixed`,
        `You'll receive: *${fmt(amount + interest)}* on ${dateText(matures)}`,
        ``,
        `⚠️ Locked coins can't be withdrawn until then. Break early and you forfeit the interest and pay a ${pct(LOCK_CONFIG.BREAK_FEE_RATE)} fee (${fmt(breakFee(amount))}).`,
        `_Locked coins support the bank's loans and game payouts; the bank always holds back ${pct(LOCK_CONFIG.RESERVE_REQUIREMENT)} as reserve._`,
      ].join('\n'),
      options: [{ label: '✅ Lock it', value: 'confirm' }],
    };
  },
  async select(value, ctx, params) {
    if (value !== 'confirm') return { stay: true };
    const r = await createLock(ctx.userId, params.planId, params.amount);
    if (r.ok) {
      const l = r.lock;
      return {
        go: 'home', reset: true,
        notice: `🔒 *COINS LOCKED*\n*${fmt(l.principal)}* for ${l.days} days · earns *+${fmt(l.interest)}*\nPays out *${fmt(l.principal + l.interest)}* on ${dateText(l.maturesAt)}.`,
      };
    }
    return { back: true, notice: failureText(r) };
  },
};

// ── My locks ─────────────────────────────────────────────────────────────────

const myLocks: Screen = {
  async view(ctx) {
    const s = await getLockSummary(ctx.userId);
    const lines: string[] = [];
    for (const ev of s.settled) lines.push(`🔓 *${ev.lock.planName}* matured — *${fmt(ev.credited)}* paid into your savings.`);
    if (lines.length) lines.push('');

    lines.push(s.active.length
      ? `🔒 *${fmt(s.lockedPrincipal)}* locked · interest due *+${fmt(s.expectedInterest)}*`
      : `_No active locks._`);

    if (s.recent.length) {
      lines.push('', '*Recent*');
      for (const l of s.recent.slice(0, 4)) {
        lines.push(l.status === 'matured'
          ? `✅ ${shortDate(l.settledAt || l.maturesAt)} — ${l.planName}: +${fmt(l.principal + l.interest)} paid`
          : `⚠️ ${shortDate(l.settledAt || l.maturesAt)} — ${l.planName}: broken early (fee ${fmt(l.fee)})`);
      }
    }
    const shown = s.active.slice(0, 6);
    if (s.active.length > shown.length) lines.push('', `_…and ${s.active.length - shown.length} more, soonest-first shown above._`);

    const options = shown.map(l => ({
      label: `🔒 ${fmt(l.principal)} · ${l.days}d`, value: `l:${l.id}`,
      description: `Pays ${fmt(l.principal + l.interest)} on ${shortDate(l.maturesAt)}`,
    }));
    return { title: '📂 MY LOCKS', text: lines.join('\n'), options };
  },
  async select(value) {
    if (value.startsWith('l:')) return { go: 'lockDetail', params: { lockId: value.slice(2) } };
    return { stay: true };
  },
};

const lockDetail: Screen = {
  async view(ctx, params) {
    const l = await getLock(ctx.userId, params.lockId);
    if (!l) return { title: '🔒 LOCK', text: `That lock is no longer active.`, options: [] };
    const now = Date.now();
    const elapsed = Math.max(0, Math.min(1, (now - l.startedAt) / (l.maturesAt - l.startedAt)));
    const lines = [
      `Plan: *${l.planName}*`,
      `Locked: *${fmt(l.principal)}* · Interest: *+${fmt(l.interest)}* (${planRate(l)})`,
      `Pays out: *${fmt(l.principal + l.interest)}* on ${dateText(l.maturesAt)}`,
      `${bar(elapsed * 100)} ${Math.round(elapsed * 100)}% · ${l.maturesAt > now ? `${duration(l.maturesAt - now)} to go` : 'ready'}`,
    ];
    if (l.status !== 'active') lines.push('', `Status: _${l.status}_`);
    const options = l.status === 'active'
      ? [{ label: '⚠️ Break early', value: 'break', description: `Forfeit interest · ${fmt(breakFee(l.principal))} fee` }]
      : [];
    return { title: '🔒 LOCK DETAILS', text: lines.join('\n'), options };
  },
  async select(value, ctx, params) {
    if (value === 'break') return { go: 'lockBreak', params };
    return { stay: true };
  },
};

const lockBreak: Screen = {
  async view(ctx, params) {
    const l = await getLock(ctx.userId, params.lockId);
    if (!l || l.status !== 'active') return { title: '⚠️ BREAK LOCK', text: `That lock is no longer active.`, options: [] };
    const fee = breakFee(l.principal);
    return {
      title: '⚠️ BREAK LOCK',
      text: [
        `You'd get *${fmt(l.principal - fee)}* back in savings now.`,
        `• Fee: *${fmt(fee)}* (${pct(LOCK_CONFIG.BREAK_FEE_RATE)} of the lock)`,
        `• Interest forfeited: *${fmt(l.interest)}*`,
        ``,
        `Staying locked until ${dateText(l.maturesAt)} pays *${fmt(l.principal + l.interest)}*. This can't be undone.`,
      ].join('\n'),
      options: [{ label: '⚠️ Break the lock', value: 'confirm' }],
    };
  },
  async select(value, ctx, params) {
    if (value !== 'confirm') return { stay: true };
    const r = await breakLock(ctx.userId, params.lockId);
    if (!r.ok) return { go: 'home', reset: true, notice: r.reason === 'not_active' ? `That lock is no longer active.` : failureText({ reason: 'move_failed' }) };
    if (r.matured) return { go: 'home', reset: true, notice: `🔓 That lock had just matured — *${fmt(r.credited)}* coins paid into your savings, no fee.` };
    return {
      go: 'home', reset: true,
      notice: `🔓 *LOCK BROKEN*\n*${fmt(r.payout)}* coins returned to your savings (fee ${fmt(r.fee)}, interest forfeited).`,
    };
  },
};

// ── How it works ─────────────────────────────────────────────────────────────

const lockInfo: Screen = {
  async view() {
    const plans = LOCK_CONFIG.PLANS.map(p => `${p.emoji} ${p.name} — ${p.days} days · *${planRate(p)}* (${aprText(p)})`).join('\n');
    return {
      title: 'ℹ️ MONEY LOCK',
      subtitle: 'How it works',
      text: [
        `Lock coins from your savings for a fixed term. You earn fixed interest, paid into your savings automatically when the term ends.`,
        ``,
        plans,
        ``,
        `• Locked coins can't be withdrawn early without a penalty: you forfeit the interest and pay a ${pct(LOCK_CONFIG.BREAK_FEE_RATE)} fee.`,
        `• They're put to work — they support the bank's loans and game payouts — and the bank always holds back ${pct(LOCK_CONFIG.RESERVE_REQUIREMENT)} as reserve.`,
        `• Saving regularly and locking coins also build your credit score for loans.`,
        `• ${fmt(LOCK_CONFIG.MIN_LOCK)}+ coins per lock, up to ${fmt(LOCK_CONFIG.MAX_PER_MEMBER)} in total.`,
      ].join('\n'),
      options: [],
    };
  },
  async select() { return { back: true }; },
};

export const LOCK_SCREENS = { locks, lockPlan, lockConfirm, myLocks, lockDetail, lockBreak, lockInfo };
