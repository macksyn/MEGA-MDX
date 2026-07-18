import { describe, expect, it, vi, afterEach } from 'vitest';
import { resolveDiceOutcome, rollGuessResult } from '../../lib/slotMachine.js';

describe('resolveDiceOutcome', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a win when the weighted roll lands in the win band', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.15);

    expect(resolveDiceOutcome(10, 1, 100)).toMatchObject({
      win: true,
      multiplier: 1.9,
    });
  });

  it('returns a loss when the weighted roll lands outside the win band', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);

    expect(resolveDiceOutcome(10, 1, 100)).toMatchObject({
      win: false,
      multiplier: 0,
    });
  });

  it('builds a dice roll that matches the guess when the outcome is a win', () => {
    const result = rollGuessResult(4, true);

    expect(result.total).toBe(4);
    expect(result.faces.reduce((sum, face) => sum + face, 0)).toBe(4);
  });

  it('builds a dice roll that does not match the guess when the outcome is a loss', () => {
    const result = rollGuessResult(4, false);

    expect(result.total).not.toBe(4);
    expect(result.faces.length).toBe(2);
  });
});
