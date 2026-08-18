// PokemonPriceTracker API client — throttled, retrying, credit-guarded.
// Rules learned in Phase 0 (see etsy-shop/research/pokemon-tracker-phase0-api-test.md):
//  - ALWAYS pass explicit limit (default is 50 and you are billed by limit, not results)
//  - 429 can mean "out of daily credits", not just rate limit
//  - sealed filter works via numeric setId=, NOT the set= slug
//  - one cards call with includeEbay returns ALL grade buckets (2 credits/card)

const BASE = 'https://www.pokemonpricetracker.com/api/v2';
const THROTTLE_MS = 1600;
const CREDIT_FLOOR = 500;          // stop before burning the whole day

let lastCall = 0;
let remaining = Infinity;

export function creditsRemaining() { return remaining; }

async function throttle() {
  const wait = lastCall + THROTTLE_MS - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
}

export async function api(path, params = {}) {
  if (remaining < CREDIT_FLOOR) {
    throw new Error(`credit guard: only ${remaining} credits left`);
  }
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  for (let attempt = 1; attempt <= 3; attempt++) {
    await throttle();
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.POKEPRICE_API_KEY}` },
    });
    const rem = res.headers.get('x-ratelimit-daily-remaining');
    if (rem !== null) remaining = Number(rem);

    if (res.status === 429) {
      // could be minute limit or exhausted daily credits — back off, then re-check
      await new Promise(r => setTimeout(r, 30000 * attempt));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url.pathname}${url.search}`);
    return res.json();
  }
  throw new Error(`repeated 429 for ${url.pathname} (remaining=${remaining})`);
}

/** Probe pattern: 1-credit call that reads metadata.total. */
export async function probeTotal(path, params) {
  const j = await api(path, { ...params, limit: 1 });
  return j.metadata?.total ?? 0;
}

/** Fetch every row of a filtered collection with explicit paging. */
export async function fetchAll(path, params, total, pageSize = 100) {
  const rows = [];
  for (let offset = 0; offset < total; offset += pageSize) {
    const limit = Math.min(pageSize, total - offset);
    const j = await api(path, { ...params, limit, offset });
    const data = j.data ?? [];
    rows.push(...data);
    if (data.length === 0) break;
  }
  return rows;
}
