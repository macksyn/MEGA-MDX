// @ts-nocheck
/***
 * lib/insurance.ts
 *
 * The bank's insurance fund — the cushion that pays Money Lock members when the
 * playable reserve runs low.
 *
 * Total insurance = JACKPOT_SEED (the base floor, 2,000) + "insurance added".
 * Coins in the fund stay in the house pool but are held out of the pool the
 * games and loans can see (see lib/slotMachine.ts), so nothing can spend them.
 * Lock interest is paid out of the house pool; if the playable reserve is
 * exhausted it eats into this fund, and only when the fund itself is breached
 * is the bank "underwater" (new locks and loans pause until profit rebuilds it).
 *
 * Two ways to grow it:
 *   • by hand, any time:   addInsurance(n)  (admin: `.bank admin insurance add <n>`)
 *   • automatically:       every PERIOD (weekly or monthly) a percentage of the
 *                          house's game profit for that period is moved in.
 *
 * ── The automatic top-up ─────────────────────────────────────────────────
 * profit = Σ (coins staked − coins paid out) over the days since the last run
 * (the same daily house stats the reserve board shows; UTC days). The top-up is
 * rate × profit. Rules that keep it safe and predictable:
 *   • The first sweep only sets a baseline — nothing is taken retroactively.
 *   • A period with no profit tops up nothing (it never takes from a loss).
 *   • It comes out of the playable surplus; if the surplus is smaller than the
 *     top-up, the top-up is cut to fit (you can't insure coins that aren't there).
 *   • It stops at MAX_EXTRA so the fund can't swallow the whole reserve.
 *   • Every run — including zero ones — is recorded in the history.
 */
import { createStore } from './pluginStore.js';
import { addInsurance, getReserveSnapshot, getHouseProfitBetween } from './slotMachine.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export type InsurancePeriod = 'weekly' | 'monthly';

export const INSURANCE_CONFIG = {
  DEFAULT_RATE: 0.10,            // 10% of the period's house profit
  DEFAULT_PERIOD: 'weekly' as InsurancePeriod,
  PERIOD_DAYS: { weekly: 7, monthly: 30 } as Record<InsurancePeriod, number>,
  MAX_RATE: 0.5,                 // admin can't set it above 50%
  MAX_EXTRA: 50_000,             // the added insurance never grows past this
  MIN_CONTRIBUTION: 5,           // ignore dust
  HISTORY_KEEP: 12,
};

export interface InsuranceRun {
  at: number;
  from: string;            // first day counted ('YYYY-MM-DD', UTC)
  to: string;              // last day counted
  days: number;
  profit: number;          // house game profit over those days (can be negative)
  rate: number;
  wanted: number;          // rate × profit, before limits
  contributed: number;     // what was actually set aside
  extraAfter: number;
  note: string | null;     // why it was cut or skipped
}

export interface InsuranceSettings {
  enabled: boolean;
  rate: number;
  period: InsurancePeriod;
  lastRunDay: string | null;   // last UTC day already accounted for
  history: InsuranceRun[];     // newest first
}

const tbl = createStore('bank').table('insurance');

const utcDay = (ts: number) => new Date(ts).toISOString().split('T')[0];
const dayDiff = (fromDay: string, toDay: string) => Math.round((Date.parse(toDay + 'T00:00:00Z') - Date.parse(fromDay + 'T00:00:00Z')) / DAY_MS);
const addDays = (day: string, n: number) => utcDay(Date.parse(day + 'T00:00:00Z') + n * DAY_MS);

function normalize(raw: any): InsuranceSettings {
  const base: InsuranceSettings = {
    enabled: true, rate: INSURANCE_CONFIG.DEFAULT_RATE, period: INSURANCE_CONFIG.DEFAULT_PERIOD, lastRunDay: null, history: [],
  };
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base, ...raw,
    period: raw.period === 'monthly' ? 'monthly' : 'weekly',
    history: Array.isArray(raw.history) ? raw.history : [],
  };
}

export async function getInsuranceSettings(): Promise<InsuranceSettings> {
  return normalize(await tbl.get('settings'));
}

/** ratePct 0 turns the automatic top-up off. Returns the saved settings, or an error string. */
export async function setAutoInsurance(ratePct: number, period?: InsurancePeriod): Promise<{ ok: true; settings: InsuranceSettings } | { ok: false; reason: 'invalid_rate' | 'invalid_period' }> {
  const pct = Number(ratePct);
  if (!Number.isFinite(pct) || pct < 0 || pct / 100 > INSURANCE_CONFIG.MAX_RATE) return { ok: false, reason: 'invalid_rate' };
  if (period !== undefined && period !== 'weekly' && period !== 'monthly') return { ok: false, reason: 'invalid_period' };
  const settings = await tbl.mutate('settings', (cur: any) => {
    const s = normalize(cur);
    s.rate = pct / 100;
    s.enabled = pct > 0;
    if (period) s.period = period;
    return s;
  });
  return { ok: true, settings: normalize(settings) };
}

/** The UTC day the next automatic top-up becomes due (null until the first sweep has set the baseline). */
export function nextRunDay(s: InsuranceSettings): string | null {
  return s.lastRunDay ? addDays(s.lastRunDay, INSURANCE_CONFIG.PERIOD_DAYS[s.period] + 1) : null;
}

/**
 * Run hourly. Does nothing until a full period of completed days has passed, then moves the share of
 * that period's profit into the insurance fund and records it. Returns the run, or null if nothing was due.
 */
export async function sweepInsurance(now = Date.now()): Promise<InsuranceRun | null> {
  const s = await getInsuranceSettings();
  if (!s.enabled || s.rate <= 0) return null;

  const yesterday = utcDay(now - DAY_MS);

  // First ever sweep: start counting from today. No back-filling.
  if (!s.lastRunDay) {
    await tbl.mutate('settings', (cur: any) => ({ ...normalize(cur), lastRunDay: yesterday }));
    return null;
  }

  const periodDays = INSURANCE_CONFIG.PERIOD_DAYS[s.period];
  if (dayDiff(s.lastRunDay, yesterday) < periodDays) return null;

  const from = addDays(s.lastRunDay, 1);
  const to = yesterday;
  const { profit, days } = await getHouseProfitBetween(from, to);
  const snap = await getReserveSnapshot();

  const wanted = Math.round(Math.max(0, profit) * s.rate);
  let amount = Math.min(wanted, Math.max(0, INSURANCE_CONFIG.MAX_EXTRA - snap.extra), snap.available);
  let note: string | null = null;
  if (profit <= 0) note = 'no profit this period';
  else if (amount < wanted) note = amount === Math.max(0, INSURANCE_CONFIG.MAX_EXTRA - snap.extra) ? 'capped at the fund maximum' : 'cut to the available surplus';
  if (amount < INSURANCE_CONFIG.MIN_CONTRIBUTION) { amount = 0; note = note || 'below the minimum'; }

  let extraAfter = snap.extra;
  if (amount > 0) {
    const r = await addInsurance(amount);
    if (r.ok) extraAfter = r.extra; else { amount = 0; note = 'no surplus to set aside'; }
  }

  const run: InsuranceRun = { at: now, from, to, days, profit, rate: s.rate, wanted, contributed: amount, extraAfter, note };
  await tbl.mutate('settings', (cur: any) => {
    const next = normalize(cur);
    next.lastRunDay = to;
    next.history = [run, ...next.history].slice(0, INSURANCE_CONFIG.HISTORY_KEEP);
    return next;
  });
  if (amount > 0) console.warn(`[insurance] set aside ${amount} (${(s.rate * 100).toFixed(0)}% of ${profit} profit, ${from}..${to}); fund now +${extraAfter}`);
  return run;
}
