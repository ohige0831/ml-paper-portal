#!/usr/bin/env node
/**
 * fetch_openalex.js
 * Fetches ML papers from OpenAlex and POSTs them to the Worker ingest endpoint.
 * Runs via GitHub Actions (non-Cloudflare IP → not blocked by OpenAlex).
 *
 * Required env vars:
 *   WORKER_URL    e.g. https://ml-paper-portal-worker.kagerou5100.workers.dev
 *   INGEST_TOKEN  Bearer token (matches wrangler secret INGEST_TOKEN)
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
// Artificial Intelligence subfield (OpenAlex topic taxonomy)
// primary_topic.field.id:17 = Computer Science
// Using CS field filter is much more targeted than concept-based filter
const FIELDS_FILTER = 'primary_topic.field.id:17';
const SELECT_FIELDS = [
  'id', 'doi', 'title', 'authorships', 'publication_date',
  'cited_by_count', 'open_access', 'primary_location', 'best_oa_location',
  'primary_topic', 'topics', 'abstract_inverted_index',
].join(',');

async function fetchWorks(params) {
  params.set('mailto', MAILTO);
  const url = `${OPENALEX_BASE}/works?${params.toString()}`;
  console.log(`  GET ${url}`);

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const wait = 3000 * attempt;
      console.log(`  429 received, retrying in ${wait}ms...`);
      await new Promise((r) => setTimeout(r, wait));
    }
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      return data.results ?? [];
    }
    if (res.status === 429 && attempt < 2) continue;
    throw new Error(`OpenAlex fetch failed: ${res.status} ${await res.text()}`);
  }
  return [];
}

async function fetchRecentWorks() {
  const params = new URLSearchParams({
    filter: `${FIELDS_FILTER},is_oa:true`,
    sort: 'publication_date:desc',
    'per-page': '25',
    select: SELECT_FIELDS,
  });
  return fetchWorks(params);
}

async function fetchPopularWorks() {
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const fromDate = twoYearsAgo.toISOString().split('T')[0];

  const params = new URLSearchParams({
    filter: `${FIELDS_FILTER},is_oa:true,from_publication_date:${fromDate}`,
    sort: 'cited_by_count:desc',
    'per-page': '25',
    select: SELECT_FIELDS,
  });
  return fetchWorks(params);
}

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

async function main() {
  console.log('[fetch_openalex] Starting...');

  console.log('[fetch_openalex] Fetching recent CS papers...');
  const recent = await fetchRecentWorks();
  console.log(`  → ${recent.length} works`);

  // Small delay between requests to be polite
  await new Promise((r) => setTimeout(r, 1000));

  console.log('[fetch_openalex] Fetching popular CS papers...');
  const popular = await fetchPopularWorks();
  console.log(`  → ${popular.length} works`);

  // Deduplicate by ID
  const seen = new Set();
  const allWorks = [];
  for (const work of [...recent, ...popular]) {
    if (!seen.has(work.id)) {
      seen.add(work.id);
      allWorks.push(work);
    }
  }
  console.log(`[fetch_openalex] ${allWorks.length} unique works after dedup`);

  console.log('[fetch_openalex] Posting to Worker ingest endpoint...');
  const result = await ingest(allWorks);
  console.log(`[fetch_openalex] Done: ${result.inserted} inserted, ${result.skipped} skipped`);
}

main().catch((err) => {
  console.error('[fetch_openalex] Fatal error:', err);
  process.exit(1);
});
