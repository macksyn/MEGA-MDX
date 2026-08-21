/**
 * scripts/resetLevel2Grace.ts
 *
 * ONE-OFF SUPPORT SCRIPT. Manually restores specific member(s) to Level 2
 * with a fresh 7-day grace period starting now (or a time you specify).
 *
 * Use case: a member legitimately reached Level 2 (exchangeCount >= 25),
 * but a bug (e.g. the attendance-bonus level gate) meant they didn't get
 * credit they were entitled to, their rolling volume dropped, and by the
 * time the bug was fixed their original grace window had already expired
 * — so backfillLevel2SinceTs.ts won't touch them (it only fills in NULL
 * values, and theirs is already set to a stale timestamp). This script
 * force-resets level2SinceTs for just the member(s) you name, giving them
 * a clean 7-day window from this moment.
 *
 * It does NOT change exchangeCount and will refuse (per-user, logged, does
 * not abort the rest) if a given user's lifetime exchangeCount is below
 * the Level 2 threshold — this restores grace, it doesn't grant levels
 * someone hasn't actually earned.
 *
 * Usage (from your bot's project root):
 *
 *   npx tsx scripts/resetLevel2Grace.ts <jidOrPhone1> <jidOrPhone2> ...
 *
 * Accepts either full JIDs (2348012345678@s.whatsapp.net) or bare numbers
 * (2348012345678) — bare numbers are normalized to @s.whatsapp.net before
 * cleanJid() is applied, matching how wallets are keyed elsewhere in this
 * codebase. If your two members are actually keyed by @lid ids instead of
 * phone-based jids, pass the exact @lid string as it appears in your DB —
 * check with `.balance @them` (fastest) or your admin wallet lookup tool
 * if you're not sure which form is on record.
 *
 * Optional: --backdate-days=N to backdate the anchor (e.g. treat them as
 * already 2 days into the new window instead of starting fresh):
 *
 *   npx tsx scripts/resetLevel2Grace.ts <jid1> <jid2> --backdate-days=2
 *
 * Safe to run again later for a different member; re-running for the same
 * member just re-anchors their window again (not idempotent by design —
 * this is a manual support action, not an automatic backfill).
 */

// Load the same env vars your main bot process uses (MONGO_URI, db name,
// etc.) BEFORE importing economy.js, which reads config at import time.
// If your entry point (index.js) sets these up differently — e.g. via a
// process manager / docker env rather than a .env file — replace this
// line with however your project actually bootstraps env vars.
import 'dotenv/config';

import { resetLevel2Grace, getWallet, getSettings } from './lib/economy.js';
import { cleanJid } from './lib/isOwner.js';

function normalizeToJid(raw: string): string {
  if (raw.includes('@')) return raw;
  return `${raw.replace(/[^\d]/g, '')}@s.whatsapp.net`;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const backdateArg = rawArgs.find((a) => a.startsWith('--backdate-days='));
  const targets = rawArgs.filter((a) => !a.startsWith('--'));

  if (targets.length === 0) {
    console.error('[reset-grace] Usage: npx tsx scripts/resetLevel2Grace.ts <jidOrPhone1> [jidOrPhone2 ...] [--backdate-days=N]');
    process.exit(1);
  }

  const backdateDays = backdateArg ? Number(backdateArg.split('=')[1]) : 0;
  const anchorTs = Number.isFinite(backdateDays) && backdateDays > 0
    ? Date.now() - backdateDays * 24 * 60 * 60 * 1000
    : Date.now();

  console.log(`[reset-grace] Anchoring to: ${new Date(anchorTs).toISOString()}`);

  // ── Sanity check: are we even looking at the right database? ──────────
  // If this prints 0 (or a suspiciously low number) while you know real
  // members exist, this script is connected to a different Mongo
  // database/collection than your running bot — check that MONGO_URI (and
  // any db-name env var) match between your bot's runtime env and
  // whatever env this script is picking up (see the dotenv import above).
  try {
    const settings = await getSettings();
    console.log(`[reset-grace] Connectivity check: getSettings() succeeded (exchangeAllowedAmounts=${JSON.stringify(settings.exchangeAllowedAmounts)}). If that list looks wrong/default, you're likely on the wrong DB.`);
  } catch (e) {
    console.warn(`[reset-grace] Connectivity check: getSettings() failed — ${e}`);
  }

  for (const raw of targets) {
    const userId = cleanJid(normalizeToJid(raw));
    const before = await getWallet(userId);

    if (!before.name && !before.phone && before.exchangeCount === 0) {
      console.warn(`[reset-grace] ⚠️  ${raw} -> ${userId}: no existing wallet data found (empty/default wallet). Double-check this is the right id before trusting the result below.`);
    }

    const result = await resetLevel2Grace(userId, anchorTs);

    if (!result.success) {
      console.error(`[reset-grace] ❌ ${raw} -> ${userId}: SKIPPED — lifetime exchangeCount is ${before.exchangeCount}, below the Level 2 threshold (25). Not restoring grace for a level they haven't reached.`);
      continue;
    }

    console.log(
      `[reset-grace] ✅ ${raw} -> ${userId}` +
      (before.name ? ` (${before.name})` : '') +
      `: exchangeCount=${before.exchangeCount}, level2SinceTs ${before.level2SinceTs ?? 'null'} -> ${anchorTs} (${new Date(anchorTs).toISOString()})`
    );
  }

  console.log('[reset-grace] Done. Have them run .balance to confirm Level 2 + fresh grace window.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[reset-grace] Failed:', err);
  process.exit(1);
});