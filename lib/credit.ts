// @ts-nocheck
/***
 * lib/credit.ts
 *
 * Credit assessment — pure functions, no storage, no sockets. A member's loan
 * standing is a 0–100 CREDIT SCORE built from two pillars, the way a lender
 * looks at both how you transact and how you bank:
 *
 *   PLAY (45 pts)      volume staked on games + Sportybet, and how many
 *                      different days they played       (lib/wagers.ts)
 *   BANKING (55 pts)   average savings kept with the bank, how regularly they
 *                      pay in, and coins committed to a Money Lock
 *                                                          (lib/bankActivity.ts)
 *
 * Each factor earns points up to its max, scaling linearly until it reaches its
 * `full` mark. The score sets a credit grade; a grade sets the base limit.
 * Either pillar alone can qualify a member at the lower grades, but the top
 * grades need both — a pure gambler tops out at Silver, a pure saver at Gold.
 *
 * One gate sits outside the score: the member must have been ACTIVE (a day with
 * a stake or a bank transaction) on at least MIN_ACTIVITY_DAYS different days in
 * the window, so a single big session or one lump deposit can't buy a loan.
 *
 * lib/loans.ts then scales the base limit by the member's on-time repayment
 * streak (+15% per loan, capped at 2x). An outstanding or defaulted loan is
 * handled there, not here.
 *
 * Everything tunable is in CREDIT_CONFIG. The numbers are a first guess sized
 * for stakes of 5–100 coins and work pay of 50–300 an hour; run
 * `loan admin credit` to see how real members distribute, then adjust.
 */

export interface CreditGrade {
  name: string;
  minScore: number;        // credit score needed for this grade
  baseMaxAmount: number;   // credit limit before the repayment bonus
  termWeeks: number;
}

export interface CreditComponent {
  key: 'volume' | 'playDays' | 'balance' | 'saveDays' | 'locked';
  pillar: 'play' | 'banking';
  label: string;
  max: number;             // points available
  full: number;            // value of the underlying signal that earns the full points
}

export const CREDIT_CONFIG = {
  WINDOW_DAYS: 30,
  MIN_ACTIVITY_DAYS: 4,
  COMPONENTS: [
    { key: 'volume',   pillar: 'play',    label: 'Play volume',        max: 30, full: 3000 }, // coins staked
    { key: 'playDays', pillar: 'play',    label: 'Play consistency',   max: 15, full: 8 },    // days with a stake
    { key: 'balance',  pillar: 'banking', label: 'Average savings',    max: 25, full: 800 },  // avg daily savings + locked
    { key: 'saveDays', pillar: 'banking', label: 'Saving consistency', max: 15, full: 6 },    // days with a deposit / new lock
    { key: 'locked',   pillar: 'banking', label: 'Money Lock',         max: 15, full: 500 },  // coins currently locked
  ] as CreditComponent[],
  GRADES: [
    { name: 'Bronze',   minScore: 12, baseMaxAmount: 100, termWeeks: 1 },
    { name: 'Silver',   minScore: 30, baseMaxAmount: 200, termWeeks: 1 },
    { name: 'Gold',     minScore: 50, baseMaxAmount: 350, termWeeks: 1 },
    { name: 'Platinum', minScore: 75, baseMaxAmount: 500, termWeeks: 1 },
  ] as CreditGrade[],
};

export interface CreditSignals {
  turnover: number;        // coins staked in the window
  activeDays: number;      // days with a stake
  saveDays: number;        // days with a deposit or new lock
  avgBalance: number;      // average daily savings + locked
  lockedNow: number;       // coins currently locked
  activityDays: number;    // days with a stake OR a bank transaction (the gate)
}

export interface CreditComponentResult extends CreditComponent {
  have: number;
  points: number;
}

export interface CreditGate {
  key: 'score' | 'activity';
  label: string;
  have: number;
  need: number;
  met: boolean;
}

export interface CreditAssessment {
  qualifies: boolean;
  score: number;                       // 0..100
  grade: CreditGrade | null;           // best grade the score earns (null below the first)
  nextGrade: CreditGrade | null;       // what they're working toward (null at the top)
  pointsToNext: number;                // score still needed for nextGrade (0 at the top)
  progress: number;                    // 0..1 toward nextGrade (1 at the top)
  components: CreditComponentResult[];
  pillars: { play: { points: number; max: number }; banking: { points: number; max: number } };
  gates: CreditGate[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function assessCredit(signals: Partial<CreditSignals>, cfg = CREDIT_CONFIG): CreditAssessment {
  const value: Record<CreditComponent['key'], number> = {
    volume: signals.turnover || 0,
    playDays: signals.activeDays || 0,
    balance: signals.avgBalance || 0,
    saveDays: signals.saveDays || 0,
    locked: signals.lockedNow || 0,
  };

  const components: CreditComponentResult[] = cfg.COMPONENTS.map(c => ({
    ...c,
    have: Math.max(0, value[c.key]),
    points: round1(c.max * Math.max(0, Math.min(1, value[c.key] / c.full))),
  }));

  const pillar = (p: 'play' | 'banking') => ({
    points: round1(components.filter(c => c.pillar === p).reduce((s, c) => s + c.points, 0)),
    max: cfg.COMPONENTS.filter(c => c.pillar === p).reduce((s, c) => s + c.max, 0),
  });
  const score = round1(components.reduce((s, c) => s + c.points, 0));

  const grades = [...cfg.GRADES].sort((a, b) => a.minScore - b.minScore);
  const grade = [...grades].reverse().find(g => score >= g.minScore) || null;
  const nextGrade = grades.find(g => score < g.minScore) || null;
  const floor = grade ? grade.minScore : 0;
  const progress = nextGrade ? Math.max(0, Math.min(1, (score - floor) / (nextGrade.minScore - floor))) : 1;

  const activityDays = signals.activityDays || 0;
  const gates: CreditGate[] = [
    { key: 'score', label: 'Credit score', have: score, need: grades[0].minScore, met: score >= grades[0].minScore },
    { key: 'activity', label: `Active days (${cfg.WINDOW_DAYS} days)`, have: activityDays, need: cfg.MIN_ACTIVITY_DAYS, met: activityDays >= cfg.MIN_ACTIVITY_DAYS },
  ];

  return {
    qualifies: !!grade && gates.every(g => g.met),
    score,
    grade,
    nextGrade,
    pointsToNext: nextGrade ? round1(nextGrade.minScore - score) : 0,
    progress,
    components,
    pillars: { play: pillar('play'), banking: pillar('banking') },
    gates,
  };
}
