import { describe, expect, it, vi, afterEach } from 'vitest';
import { resolveDiceOutcome } from '../../lib/slotMachine.js';

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
});
