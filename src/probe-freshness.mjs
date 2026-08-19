// Hourly freshness probe. Answers one question the full job is far too expensive to ask
// repeatedly: WHEN does the provider actually re-scrape sealed prices?
//
// Background: the daily job costs ~3.6k credits, so it can only sample once or twice a day.
// Two guesses have already been wrong - the catalog's own updatedAt moves daily at ~12:01 UTC
// but the products' lastScrapedAt did not follow, and runs at 14:36 and 18:15 UTC on
// 2026-08-19 both still returned 2026-08-18 prices. This probe costs ~5 credits, so it can
// run every hour and simply record the answer instead of us inferring it.
//
// It writes nothing and commits nothing - the log line IS the output.
// Run:  POKEPRICE_API_KEY=... node src/probe-freshness.mjs

import { api } from './lib/api.mjs';

// Big, liquid sets that reliably carry sealed products. First one that answers wins.
const CANDIDATES = [
  { id: 23237, label: 'SV: Scarlet & Violet 151' },
  { id: 23228, label: 'SV03: Obsidian Flames' },
];

const now = new Date().toISOString();
let reported = false;

for (const c of CANDIDATES) {
  let items;
  try {
    const j = await api('/sealed-products', { setId: c.id, limit: 5 });
    items = j.data ?? [];
  } catch (e) {
    console.error(`probe ${c.label}: ${e.message}`);
    continue;
  }
  if (!items.length) continue;

  const scraped = items.map(p => p.lastScrapedAt).filter(Boolean).sort();
  const newest = scraped[scraped.length - 1] ?? 'none';
  console.log(`PROBE ${now} | set=${c.label} | sampled=${items.length} | newest lastScrapedAt=${newest}`);
  reported = true;
  break;
}

if (!reported) {
  console.error(`PROBE ${now} | no candidate set returned sealed products - check the API`);
  process.exit(1);
}
