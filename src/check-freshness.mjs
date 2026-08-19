// Freshness guard. Runs after the feed job and FAILS the workflow when the prices the
// buyers read are too old - so a silent green check really does mean "prices are moving".
//
// Why this exists: the job can succeed while delivering nothing. On 2026-08-19 the cron
// ran, committed, and reported success, yet sealed.csv was byte-identical to the previous
// day because the run happened before the provider's own daily sweep. Green build, frozen
// product. This turns that into an email.
//
// Run:  node src/check-freshness.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const meta = JSON.parse(readFileSync(join(ROOT, 'feed', 'meta.json'), 'utf8'));

const MAX_AGE_DAYS = 2;          // 1 day of lag is normal; 2+ means something is wrong
const DAY = 86400000;

const today = new Date().toISOString().slice(0, 10);
const asOf = meta.pricesAsOf ?? '';
if (!asOf) {
  console.error('FAIL: meta.json has no pricesAsOf - is the feed job up to date?');
  process.exit(1);
}

const ageDays = Math.round((Date.parse(today) - Date.parse(asOf)) / DAY);
const line = `prices as of ${asOf}, today is ${today} -> ${ageDays} day(s) old`;

if (ageDays >= MAX_AGE_DAYS) {
  console.error(`FAIL: ${line}`);
  console.error('The job ran but the prices did not move. Most likely causes:');
  console.error('  1. the schedule drifted back in front of the provider sweep');
  console.error('     (it lands ~12:00-12:20 UTC; see "provider catalog last refreshed" in the log)');
  console.error('  2. the provider skipped a day or changed its cycle');
  console.error('  3. the API key ran out of credits mid-run, so old rows were kept');
  process.exit(1);
}

console.log(ageDays === 0 ? `OK: ${line}` : `OK (tolerated): ${line}`);
