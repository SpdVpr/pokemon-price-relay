// Daily relay job: pull the full catalog worth of prices, publish feed CSVs,
// snapshot history. Designed for the $9.99 API tier (20k credits/day):
//   - all sealed products daily            (~2.6k credits incl. probes)
//   - PSA backfill until complete, capped  (~12k credits/day, done in ~4 days)
//   - then steady state: hot cards daily, tail rotated across 7 days
// Run:  POKEPRICE_API_KEY=... node src/fetch-feed.mjs

import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { api, probeTotal, fetchAll, creditsRemaining } from './lib/api.mjs';
import { writeChunked, trustedGradePrice } from './lib/feed.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CATALOG = join(ROOT, 'catalog');
const FEED = join(ROOT, 'feed');
const HISTORY = join(ROOT, 'history');
const TODAY = new Date().toISOString().slice(0, 10);
const PSA_DAILY_BUDGET = 12000;          // credits reserved for PSA work per run
const HOT_MIN_SALES_90D = 12;            // "hot" card = liquid enough for daily refresh

const state = existsSync(join(CATALOG, 'state.json'))
  ? JSON.parse(readFileSync(join(CATALOG, 'state.json'), 'utf8'))
  : { backfillDoneSets: [], rotationCursor: 0 };

function loadJson(p, fallback) {
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback;
}
function saveJson(p, v) { writeFileSync(p, JSON.stringify(v, null, 1), 'utf8'); }

// ---------------------------------------------------------------- sets

async function refreshSets() {
  const j = await api('/sets', { limit: 250 });
  saveJson(join(CATALOG, 'sets.json'), j);
  return j.data;
}

// ---------------------------------------------------------------- sealed (all, daily)

async function harvestSealed(sets) {
  const rows = [];
  for (const s of sets) {
    const sid = s.tcgPlayerNumericId;
    if (!sid) continue;
    let total;
    try { total = await probeTotal('/sealed-products', { setId: sid }); }
    catch (e) { console.error(`sealed probe ${s.tcgPlayerId}: ${e.message}`); continue; }
    if (total <= 0) continue;
    let items;
    try { items = await fetchAll('/sealed-products', { setId: sid }, total); }
    catch (e) { console.error(`sealed fetch ${s.tcgPlayerId}: ${e.message}`); continue; }
    for (const p of items) {
      rows.push({
        id: p.tcgPlayerId,
        name: p.name,
        set: p.setName,
        price: p.unopenedPrice ?? '',
        updated: (p.lastScrapedAt ?? '').slice(0, 10),
        img: p.tcgPlayerId,               // image = CDN/{id}_in_200x200.jpg
      });
    }
    console.log(`sealed ${s.tcgPlayerId}: ${items.length} (credits left ${creditsRemaining()})`);
  }
  return rows;
}

// ---------------------------------------------------------------- PSA cards

function cardRow(c) {
  const g = c.ebay?.salesByGrade ?? {};
  const p10 = trustedGradePrice(g.psa10);
  const p9 = trustedGradePrice(g.psa9);
  const p8 = trustedGradePrice(g.psa8);
  const sales90 = (g.psa10?.count ?? 0) + (g.psa9?.count ?? 0) + (g.psa8?.count ?? 0);
  return {
    id: c.tcgPlayerId,
    name: c.name,
    set: c.setName,
    num: c.cardNumber ?? '',
    raw: c.prices?.market ?? '',
    psa8: p8.price ?? '', n8: p8.n,
    psa9: p9.price ?? '', n9: p9.n,
    psa10: p10.price ?? '', n10: p10.n, conf10: p10.confidence ?? '',
    hot: sales90 >= HOT_MIN_SALES_90D ? 1 : 0,
    updated: TODAY,
    img: c.tcgPlayerId,
  };
}

async function backfillPsa(sets, store) {
  // one whole set at a time via fetchAllInSet (+ebay), until budget is spent
  const startCredits = creditsRemaining();
  for (const s of sets) {
    if (state.backfillDoneSets.includes(s.tcgPlayerId)) continue;
    if (startCredits - creditsRemaining() > PSA_DAILY_BUDGET) break;
    if (!s.cardCount) { state.backfillDoneSets.push(s.tcgPlayerId); continue; }
    try {
      const j = await api('/cards', { set: s.tcgPlayerId, fetchAllInSet: true, includeEbay: true });
      for (const c of j.data ?? []) store.set(c.tcgPlayerId, cardRow(c));
      state.backfillDoneSets.push(s.tcgPlayerId);
      console.log(`psa backfill ${s.tcgPlayerId}: ${j.data?.length ?? 0} cards (left ${creditsRemaining()})`);
    } catch (e) {
      console.error(`psa backfill ${s.tcgPlayerId}: ${e.message}`);
      if (/credit guard/.test(e.message)) break;
    }
  }
}

async function steadyPsaRefresh(store) {
  // hot cards daily; tail rotated so everything is at most ~7 days old
  const all = [...store.values()];
  const hot = all.filter(r => r.hot === 1);
  const tail = all.filter(r => r.hot !== 1);
  const slice = Math.ceil(tail.length / 7);
  const rotated = tail.slice(state.rotationCursor, state.rotationCursor + slice);
  state.rotationCursor = (state.rotationCursor + slice) % Math.max(tail.length, 1);
  const targets = [...hot, ...rotated];
  console.log(`psa steady refresh: ${hot.length} hot + ${rotated.length} rotated`);
  for (const t of targets) {
    if (creditsRemaining() < 600) break;
    try {
      const j = await api('/cards', { tcgPlayerId: t.id, limit: 1, includeEbay: true });
      const c = j.data?.[0];
      if (c) store.set(t.id, cardRow(c));
    } catch (e) { console.error(`psa refresh ${t.id}: ${e.message}`); }
  }
}

// ---------------------------------------------------------------- main

const sets = await refreshSets();
console.log(`sets: ${sets.length}, credits left ${creditsRemaining()}`);

const sealedRows = await harvestSealed(sets);
const sealedFiles = writeChunked(FEED, 'sealed',
  ['id', 'name', 'set', 'price', 'updated', 'img'], sealedRows);

const psaPath = join(CATALOG, 'psa-cards.json');
const store = new Map(Object.entries(loadJson(psaPath, {})));
const backfillComplete = state.backfillDoneSets.length >= sets.filter(s => s.cardCount).length;
if (!backfillComplete) await backfillPsa(sets, store);
else await steadyPsaRefresh(store);
saveJson(psaPath, Object.fromEntries(store));

const psaRows = [...store.values()].sort((a, b) => (b.n10 ?? 0) - (a.n10 ?? 0));
const psaFiles = writeChunked(FEED, 'psa',
  ['id', 'name', 'set', 'num', 'raw', 'psa8', 'n8', 'psa9', 'n9', 'psa10', 'n10', 'conf10', 'hot', 'updated', 'img'],
  psaRows);

mkdirSync(join(HISTORY, TODAY), { recursive: true });
cpSync(FEED, join(HISTORY, TODAY), { recursive: true });

saveJson(join(CATALOG, 'state.json'), state);
saveJson(join(FEED, 'meta.json'), {
  date: TODAY,
  sealed: sealedRows.length,
  psaCards: store.size,
  backfillComplete,
  files: [...sealedFiles, ...psaFiles],
  creditsRemaining: creditsRemaining(),
  source: 'PokemonPriceTracker API — TCGPlayer market (sealed/raw), eBay sale medians (graded). US market, USD.',
});
console.log(`DONE sealed=${sealedRows.length} psa=${store.size} backfillComplete=${backfillComplete} credits left ${creditsRemaining()}`);
