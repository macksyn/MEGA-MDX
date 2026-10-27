// @ts-nocheck
/***
 * lib/credit.ts
 *
 * Credit assessment — pure functions, no storage, no sockets. Decides whether
 * a member's recent play qualifies them for a loan and what limit it earns,
 * the way a lender underwrites an applicant: look at recent activity, check
 * it's consistent rather than a one-off burst, then price the line of credit.
 *
 *   Gate 1  Play volume  — coins staked on games + Sportybet over the last
 *                          WINDOW_DAYS must reach the first grade's minimum.
 *   Gate 2  Consistency  — stakes on at least MIN_ACTIVE_DAYS different days
 *                          in that window (a single big session doesn't qualify).
 *   Grade   Volume sets the credit grade and its base limit.
 *   Record  lib/loans.ts then scales the base limit by the member's on-time
 *           repayment streak (+15% per loan, capped at 2x). A member with an
 *           outstanding or defaulted loan is handled there, not here.
 *
 * Everything tunable is in CREDIT_CONFIG. The numbers below are sized for an
 * economy where stakes run 5–100 coins and work pays 50–300 an hour; run
 * `loan admin credit` to see how real members distribute, then adjust.
 */

export interface CreditGrade {
  name: string;
  minTurnover: number;     // coins staked in the window to earn this grade
  baseMaxAmount: number;   // credit limit before the repayment bonus
  termWeeks: number;
}

export const CREDIT_CONFIG = {
  WINDOW_DAYS: 30,
  MIN_ACTIVE_DAYS: 4,
  GRADES: [
    { name: 'Bronze',   minTurnover: 500,   baseMaxAmount: 100, termWeeks: 1 },
    { name: 'Silver',   minTurnover: 2000,  baseMaxAmount: 200, termWeeks: 1 },
    { name: 'Gold',     minTurnover: 6000,  baseMaxAmount: 350, termWeeks: 1 },
    { name: 'Platinum', minTurnover: 15000, baseMaxAmount: 500, termWeeks: 1 },
  ] as CreditGrade[],
};

export interface CreditSignals {
  turnover: number;
  activeDays: number;
  bets?: number;
  bySource?: { games: number; sportybet: number };
}

export interface CreditGate {
  key: 'volume' | 'days';
  label: string;
  have: number;
  need: number;
  met: boolean;
}

export interface CreditAssessment {
  qualifies: boolean;
  grade: CreditGrade | null;      // best grade this volume earns (null below the first grade)
  nextGrade: CreditGrade | null;  // what they're working toward (null at the top)
  gates: CreditGate[];
  progress: number;               // 0..1 toward nextGrade's volume (1 at the top)
  volumeToNext: number;           // coins of stake still needed for nextGrade (0 at the top)
}

export function assessCredit(signals: CreditSignals, cfg = CREDIT_CONFIG): CreditAssessment {
  const grades = [...cfg.GRADES].sort((a, b) => a.minTurnover - b.minTurnover);
  const turnover = Math.max(0, signals.turnover || 0);

  const grade = [...grades].reverse().find(g => turnover >= g.minTurnover) || null;
  const nextGrade = grades.find(g => turnover < g.minTurnover) || null;
  const floor = grade ? grade.minTurnover : 0;
  const progress = nextGrade ? Math.max(0, Math.min(1, (turnover - floor) / (nextGrade.minTurnover - floor))) : 1;

  const gates: CreditGate[] = [
    { key: 'volume', label: `Play volume (${cfg.WINDOW_DAYS} days)`, have: turnover, need: grades[0].minTurnover, met: turnover >= grades[0].minTurnover },
    { key: 'days', label: `Active days (${cfg.WINDOW_DAYS} days)`, have: signals.activeDays || 0, need: cfg.MIN_ACTIVE_DAYS, met: (signals.activeDays || 0) >= cfg.MIN_ACTIVE_DAYS },
  ];

  return {
    qualifies: !!grade && gates.every(g => g.met),
    grade,
    nextGrade,
    gates,
    progress,
    volumeToNext: nextGrade ? nextGrade.minTurnover - turnover : 0,
  };
}
