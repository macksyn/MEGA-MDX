/**
 * scripts/backfillLevel2SinceTs.ts
 *
 * ONE-OFF maintenance script. Run this once after deploying the
 * level2SinceTs grace-period fix, to stamp a grace-period anchor onto
 * every wallet that's already Level 2+ but predates the fix (so its
 * level2SinceTs is still null and it would otherwise get zero grace
 * period going forward).
 *
 * Usage (from your bot's project root, adjust the path to match your
 * actual folder layout — this assumes the standard lib/economy.ts
 * location referenced elsewhere in this codebase):
 *
 *   npx tsx scripts/backfillLevel2SinceTs.ts
 *
 * or, if you compile to JS first / run via ts-node:
 *
 *   npx ts-node scripts/backfillLevel2SinceTs.ts
 *
 * It is safe to run more than once — the function only touches wallets
 * where level2SinceTs is still null, so re-running is a no-op for
 * anything it already fixed.
 *
 * By default every affected wallet gets a FRESH 7-day grace period
 * starting from the moment you run this (their real original
 * promotion date isn't recoverable — it was never recorded). If you'd
 * rather backdate it (e.g. treat everyone as already 3 days into their
 * grace period, so they only get 4 more days), pass a timestamp:
 *
 *   npx tsx scripts/backfillLevel2SinceTs.ts --backdate-days=3
 */

import { backfillLevel2SinceTs } from './lib/economy.js';

async function main() {
  const backdateArg = process.argv.find((a) => a.startsWith('--backdate-days='));
  const backdateDays = backdateArg ? Number(backdateArg.split('=')[1]) : 0;

  const anchorTs = Number.isFinite(backdateDays) && backdateDays > 0
    ? Date.now() - backdateDays * 24 * 60 * 60 * 1000
    : Date.now();

  console.log(`[backfill] Starting level2SinceTs backfill (anchor: ${new Date(anchorTs).toISOString()})...`);

  const result = await backfillLevel2SinceTs(anchorTs);

  console.log(`[backfill] Scanned ${result.scanned} wallet(s).`);
  console.log(`[backfill] Updated ${result.updated} wallet(s) that were Level 2+ with no level2SinceTs.`);
  if (result.updated > 0) {
    console.log(`[backfill] Updated user IDs:`);
    for (const id of result.updatedUserIds) console.log(`  - ${id}`);
  }
  console.log('[backfill] Done. Safe to delete/ignore this script now — it has no effect on wallets it has already fixed.');

  process.exit(0);
}

main().catch((err) => {
  console.error('[backfill] Failed:', err);
  process.exit(1);
});