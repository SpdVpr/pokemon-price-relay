// Feed writing: CSV files consumed by Google Sheets IMPORTDATA and (later) the HTML app.
// Keep columns compact; chunk big files so each stays comfortably under IMPORTDATA limits.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function csvField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
}

export function toCsv(header, rows) {
  const lines = [header.join(',')];
  for (const r of rows) lines.push(header.map(h => csvField(r[h])).join(','));
  return lines.join('\n') + '\n';
}

/** Write rows as 1..N chunk files, each at most maxBytes. Returns file names. */
export function writeChunked(dir, baseName, header, rows, maxBytes = 1_400_000) {
  mkdirSync(dir, { recursive: true });
  const files = [];
  let chunk = [], size = header.join(',').length + 1, idx = 0;
  const flush = () => {
    if (chunk.length === 0) return;
    const name = files.length === 0 && idx === 0 && chunk.length === rows.length
      ? `${baseName}.csv`
      : `${baseName}-${String.fromCharCode(97 + idx)}.csv`;   // -a, -b, -c…
    writeFileSync(join(dir, name), toCsv(header, chunk), 'utf8');
    files.push(name); idx++; chunk = []; size = header.join(',').length + 1;
  };
  for (const r of rows) {
    const line = header.map(h => csvField(r[h])).join(',') + '\n';
    if (size + line.length > maxBytes && chunk.length > 0) flush();
    chunk.push(r); size += line.length;
  }
  flush();
  return files;
}

/** Pick the price we trust: median primary, smart as cross-check (Phase 0 rule). */
export function trustedGradePrice(bucket) {
  if (!bucket) return { price: null, n: 0, confidence: null };
  const median = bucket.medianPrice ?? null;
  const smart = bucket.smartMarketPrice?.price ?? null;
  let price = median ?? smart;
  if (median !== null && smart !== null && median > 0) {
    const dev = Math.abs(smart - median) / median;
    if (dev > 0.2) price = median;          // short-window smart failed → median
  }
  return {
    price,
    n: bucket.count ?? 0,
    confidence: bucket.smartMarketPrice?.confidence ?? null,
  };
}
