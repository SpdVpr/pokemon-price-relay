# pokemon-price-relay

Denní cenový relay pro CARDFOLIO (Pokémon Investment Portfolio Tracker). Stahuje ceny z PokemonPriceTracker API a publikuje statické CSV feedy, které konzumuje Google Sheets produkt (`IMPORTDATA`) a později HTML app.

## ⏰ Načasování: co víme a co ne (stav 19. 8. 2026)

**Job může doběhnout zeleně a nepřinést nová data.** Přesně to se stalo 19. 8.: cron byl na
09:20 UTC, běh prošel, commitnul — a `sealed.csv` vyšel **bajt po bajtu shodný** s předchozím
dnem. V tabulce se proto stamp „Prices last updated" nepohnul.

**Pozor na past, na kterou jsme naletěli:** `sets[].updatedAt` **není** čas scrapu cen.
Katalogová metadata se osahávají denně (19. 8. ve 12:01 UTC), ale `lastScrapedAt` u samotných
produktů se tím nehne. Posun cronu za 12:20 UTC proto problém **nevyřešil** — běh ve 14:08 UTC
pořád přinesl ceny z 18. 8.

Co je změřené:

| kdy | max `lastScrapedAt` u sealed |
|---|---|
| 18. 8., 19:34 UTC | 2026-08-18 (2 109 z 2 322 produktů z téhož dne) |
| 19. 8., 14:36 UTC | 2026-08-18 |

→ Scrape cen padá **později než 14:36 UTC**, nebo není spolehlivě denní. Zatím neuzavřeno.

- Naplánováno **13:30 UTC** (hlavní) a **17:30 UTC** (záchranná síť). `--skip-if-fresh` u té
  druhé stojí nula kreditů, když hlavní běh přinesl dnešní ceny — a když ne, udělá plný fetch,
  takže zároveň slouží jako vzorek pozdější hodiny.
- GitHub přidává **zpoždění fronty 0–40 min** (naměřeno 38 min), proto hodinová rezerva.
- `meta.json` rozlišuje **`date`** (kdy jsme běželi) a **`pricesAsOf`** (jaké datum nesou ceny).
  To je jediný signál, na který se dá spolehnout — sleduj ho, ne `date`.
- Když se rozejdou o 2+ dny, `src/check-freshness.mjs` shodí workflow → přijde e-mail.

**Nedořešené a obchodně důležité:** listing i tabulka slibují denní aktualizaci cen. Pokud se
ukáže, že poskytovatel sealed ceny denně nepřeskrapuje, je potřeba buď změnit ten slib, nebo
zdroj dat.

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
