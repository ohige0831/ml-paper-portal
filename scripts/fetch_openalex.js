#!/usr/bin/env node
/**
 * fetch_openalex.js — 層別サンプリング版
 * [TRIAL B案 2026-04-22〜2026-04-29]
 *
 * 公開時期 × 被引用数で 8 層に分けてランダムサンプリング。
 * OpenAlex の sample=N パラメータ（seed なし）を使い、
 * 毎回異なる候補が来るようにする（同じ顔ぶれを踏みにくい）。
 *
 * 層配分 (計 50 件/回):
 *   新着 (last 90 days):    uncited(8) + low1-19(10) + cited20+(7)  = 25
 *   中間 (91d〜730d):       low0-9(4)  + mid10-49(6) + high50+(5)   = 15
 *   定番 (731d+):           mid20-99(4) + high100+(6)                = 10
 *
 * 元に戻すには: git checkout scripts/fetch_openalex.js
 *
 * Required env vars:
 *   WORKER_URL       e.g. https://ml-paper-portal-worker.*.workers.dev
 *   INGEST_TOKEN     Bearer token (matches wrangler secret INGEST_TOKEN)
 *   OPENALEX_MAILTO  e.g. kagerou5100@gmail.com
 */

const WORKER_URL = process.env.WORKER_URL;
const INGEST_TOKEN = process.env.INGEST_TOKEN;
const MAILTO = process.env.OPENALEX_MAILTO ?? 'kagerou5100@gmail.com';

if (!WORKER_URL || !INGEST_TOKEN) {
  console.error('ERROR: WORKER_URL and INGEST_TOKEN must be set');
  process.exit(1);
}

const OPENALEX_BASE = 'https://api.openalex.org';
// AI subfield (id:1702) within CS (field:17) — tighter than the ML concept filter
const SUBFIELD_FILTER = 'primary_topic.subfield.id:1702';
const SELECT_FIELDS = [
  'id', 'doi', 'title', 'authorships', 'publication_date',
  'cited_by_count', 'open_access', 'primary_location', 'best_oa_location',
  'primary_topic', 'topics', 'abstract_inverted_index',
].join(',');

// --- Date helpers ---

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

// --- Layer definitions ---

function buildLayers() {
  const d90  = daysAgo(90);
  const d91  = daysAgo(91);   // exclusive lower bound for 中間層
  const d730 = daysAgo(730);
  const d731 = daysAgo(731);  // exclusive lower bound for 定番層

  return [
    // 新着層 (last 90 days) — 25 papers
    { label: 'new-uncited',   from: d90,  to: null, citMin: null, citMax: 0,    n: 8  },
    { label: 'new-low',       from: d90,  to: null, citMin: 1,    citMax: 19,   n: 10 },
    { label: 'new-cited',     from: d90,  to: null, citMin: 20,   citMax: null, n: 7  },
    // 中間層 (91〜730 days ago) — 15 papers
    { label: 'mid-low',       from: d730, to: d91,  citMin: null, citMax: 9,    n: 4  },
    { label: 'mid-mid',       from: d730, to: d91,  citMin: 10,   citMax: 49,   n: 6  },
    { label: 'mid-high',      from: d730, to: d91,  citMin: 50,   citMax: null, n: 5  },
    // 定番層 (731+ days ago) — 10 papers
    { label: 'classic-mid',   from: null, to: d731, citMin: 20,   citMax: 99,   n: 4  },
    { label: 'classic-high',  from: null, to: d731, citMin: 100,  citMax: null, n: 6  },
  ];
}

function buildFilter(layer) {
  const parts = [SUBFIELD_FILTER, 'is_oa:true'];
  if (layer.from) parts.push(`from_publication_date:${layer.from}`);
  if (layer.to)   parts.push(`to_publication_date:${layer.to}`);
  // cited_by_count:>N means strictly > N, so citMin=1 → ">0"
  if (layer.citMin != null) parts.push(`cited_by_count:>${layer.citMin - 1}`);
  // cited_by_count:<N means strictly < N, so citMax=19 → "<20"
  if (layer.citMax != null) parts.push(`cited_by_count:<${layer.citMax + 1}`);
  return parts.join(',');
}

// --- OpenAlex fetch ---

async function fetchLayer(layer) {
  const params = new URLSearchParams({
    filter: buildFilter(layer),
    sample: String(layer.n),  // random N from matching set; no seed = different each run
    select: SELECT_FIELDS,
    mailto: MAILTO,
  });
  const url = `${OPENALEX_BASE}/works?${params.toString()}`;
  console.log(`  [${layer.label}] n=${layer.n}`);

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const wait = 3000 * attempt;
      console.log(`  [${layer.label}] 429, retry in ${wait}ms...`);
      await new Promise((r) => setTimeout(r, wait));
    }
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const results = data.results ?? [];
      console.log(`  [${layer.label}] → ${results.length} works`);
      return results;
    }
    if (res.status === 429 && attempt < 2) continue;
    // Layer failure is non-fatal: log and continue with other layers
    console.warn(`  [${layer.label}] fetch failed: ${res.status} — skipping`);
    return [];
  }
  return [];
}

// --- Ingest ---

async function ingest(works) {
  const res = await fetch(`${WORKER_URL}/api/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify({ works }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ingest failed: ${res.status} ${body}`);
  }
  return res.json();
}

// --- Main ---

async function main() {
  console.log('[fetch_openalex] mode=auto (stratified sampling)');
  const layers = buildLayers();
  console.log(`[fetch_openalex] ${layers.length} layers, target 50 papers`);

  const layerCounts = {};
  const allWorks = [];
  const seen = new Set();

  for (const layer of layers) {
    if (allWorks.length > 0) {
      // Polite delay between API calls (OpenAlex polite pool: 10 req/s)
      await new Promise((r) => setTimeout(r, 300));
    }

    const works = await fetchLayer(layer);
    let added = 0;
    for (const work of works) {
      if (!seen.has(work.id)) {
        seen.add(work.id);
        allWorks.push(work);
        added++;
      }
    }
    layerCounts[layer.label] = added;
  }

  // Layer summary
  console.log('[fetch_openalex] Layer results:');
  let total = 0;
  for (const [label, count] of Object.entries(layerCounts)) {
    console.log(`  ${label}: ${count}`);
    total += count;
  }
  console.log(`[fetch_openalex] Total unique: ${total}`);

  if (allWorks.length === 0) {
    console.log('[fetch_openalex] No works to ingest.');
    return;
  }

  console.log('[fetch_openalex] Posting to Worker ingest endpoint...');
  const result = await ingest(allWorks);
  console.log(
    `[fetch_openalex] Done: ` +
    `inserted=${result.inserted} skipped=${result.skipped} ` +
    `quarantined=${result.quarantined ?? 0} rejected=${result.rejected ?? 0}`,
  );
}

main().catch((err) => {
  console.error('[fetch_openalex] Fatal error:', err);
  process.exit(1);
});
