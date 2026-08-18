# pokemon-price-relay

Denní cenový relay pro CARDFOLIO (Pokémon Investment Portfolio Tracker). Stahuje ceny z PokemonPriceTracker API a publikuje statické CSV feedy, které konzumuje Google Sheets produkt (`IMPORTDATA`) a později HTML app.

## Jak to funguje

- **Sealed**: každý den kompletně všechny sety (probe `setId` → exact fetch). ~2 600 kreditů.
- **PSA karty**: nejdřív **backfill** celého katalogu po setech (`fetchAllInSet` + `includeEbay`, cap 12k kreditů/den → hotovo za ~4 dny), pak **steady state**: „hot" karty (≥12 prodejů v gradech 8–10) denně, zbytek rotačně 1× za 7 dní.
- Ceny gradů: **medián prodejů** primárně, `smartMarketPrice` jen jako cross-check (odchylka >20 % → medián). Viz Phase 0 research.
- Výstup: `feed/sealed*.csv`, `feed/psa-*.csv` (chunky ≤1,4 MB kvůli IMPORTDATA), `feed/meta.json`, denní snapshot do `history/YYYY-MM-DD/` (základ pro grafy historie portfolia).
- Obrázky: sloupec `img` = tcgPlayerId → `https://tcgplayer-cdn.tcgplayer.com/product/{id}_in_200x200.jpg` (v produkci zvážit vlastní cache).

## Nasazení (jednorázově)

1. Vytvořit GitHub repo `pokemon-price-relay` (public — feed má být veřejně čitelný), pushnout tento adresář.
2. V repo Settings → Secrets and variables → Actions přidat secret **`POKEPRICE_API_KEY`** (API tier $9.99 — komerční licence).
3. Actions → daily-feed → Run workflow (první ruční běh = start backfillu).
4. Feed URL pro Sheets: `https://raw.githubusercontent.com/<owner>/pokemon-price-relay/main/feed/sealed.csv` atd.

## Lokální běh

```bash
POKEPRICE_API_KEY=... node src/fetch-feed.mjs
```

## API pravidla (z Phase 0, dodržovat!)

- Vždy explicitní `limit` — default 50 a účtuje se limit, ne výsledky.
- 429 = rate limit NEBO došlé denní kredity; client má guard (stop pod 500) a backoff.
- Sealed filtr přes **numerické `setId`** (slug v dokumentaci nefunguje).
- Throttle ~1,6 s mezi requesty.
