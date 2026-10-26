// @ts-nocheck
/***
 * lib/bankLock.ts
 *
 * Per-key async mutex. pluginStore's mutate() only protects ONE record at a
 * time; a bank operation touches several (wallet + savings account + journal),
 * so the whole operation runs under one lock per user instead. Two taps, two
 * typed commands, or a tap racing a scheduled sweep for the same user are
 * serialized rather than interleaved.
 *
 * NOT re-entrant: calling withUserLock() with the same key from inside a task
 * already holding it deadlocks. Public ledger functions take the lock; the
 * internal helpers they call never do. Never hold a lock across a user prompt
 * (menu tap / typed amount) — lock only around the money movement itself.
 */
const tails = new Map<string, Promise<unknown>>();

export function withUserLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(task);              // prev never rejects (see tail below)
  const tail = run.then(() => {}, () => {}); // swallow here so one failure can't poison the chain
  tails.set(key, tail);
  // Drop the map entry once nobody queued behind us — keeps the Map from growing forever.
  tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return run;
}
