import type { D1Database } from '@cloudflare/workers-types';
import type { OpenAlexWork } from '../types';
import { insertPaper, paperExists, insertFetchLog, setPublishState } from '../db/queries';
import {
  reconstructAbstract,
  extractPdfUrl,
  extractOaUrl,
  normalizeId,
} from '../lib/openalex';
import { validateWork } from '../lib/validate';

const OPENALEX_BASE = 'https://api.openalex.org';
const SUBFIELD_FILTER = 'primary_topic.subfield.id:1702,is_oa:true';
const MAILTO = 'kagerou5100@gmail.com';
const SELECT_FIELDS = [
  'id', 'doi', 'title', 'authorships', 'publication_date',
  'cited_by_count', 'open_access', 'primary_location', 'best_oa_location',
  'primary_topic', 'topics', 'abstract_inverted_index',
].join(',');

// Manual mode citation threshold.
// 20+ balances "中堅〜定番" coverage without drowning in noise.
// To tighten quality: raise to 50. To widen discovery: lower to 10.
const MANUAL_CIT_MIN = 20;

async function fetchWorks(params: URLSearchParams): Promise<OpenAlexWork[]> {
  params.set('mailto', MAILTO);
  const url = `${OPENALEX_BASE}/works?${params.toString()}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json<{ results: OpenAlexWork[] }>();
      return data.results ?? [];
    }
    if (res.status === 429 && attempt < 2) {
      console.warn(`[fetch:manual] OpenAlex 429, retrying (attempt ${attempt + 1})`);
      continue;
    }
    throw new Error(`OpenAlex fetch failed: ${res.status}`);
  }
  return [];
}

// Recent (last year) + cited >= MANUAL_CIT_MIN — catches newly trending papers
async function fetchManualRecent(): Promise<OpenAlexWork[]> {
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const fromDate = oneYearAgo.toISOString().split('T')[0];

  const params = new URLSearchParams({
    filter: `${SUBFIELD_FILTER},from_publication_date:${fromDate},cited_by_count:>${MANUAL_CIT_MIN - 1}`,
    sample: '25',
    select: SELECT_FIELDS,
  });
  return fetchWorks(params);
}

// Older classics + cited >= 50 — avoids low-quality older papers
async function fetchManualClassic(): Promise<OpenAlexWork[]> {
  const params = new URLSearchParams({
    filter: `${SUBFIELD_FILTER},cited_by_count:>49`,
    sample: '25',
    select: SELECT_FIELDS,
  });
  return fetchWorks(params);
}

async function saveWork(
  db: D1Database,
  work: OpenAlexWork,
  today: string,
): Promise<'new' | 'quarantined' | 'rejected' | 'duplicate'> {
  const id = normalizeId(work.id);

  if (await paperExists(db, id)) return 'duplicate';

  const validation = validateWork(work, today);

  const abstract = work.abstract_inverted_index
    ? reconstructAbstract(work.abstract_inverted_index)
    : null;
  const authors = JSON.stringify(
    work.authorships.slice(0, 10).map((a) => ({ name: a.author.display_name })),
  );
  const topics = JSON.stringify(
    (work.topics ?? []).slice(0, 5).map((t) => t.display_name),
  );
  const row = {
    id,
    doi: work.doi,
    title: work.title,
    authors,
    published_date: work.publication_date,
    citation_count: work.cited_by_count,
    oa_url: extractOaUrl(work),
    pdf_url: extractPdfUrl(work),
    openalex_url: work.id,
    primary_topic: work.primary_topic?.display_name ?? null,
    topics,
    abstract,
  };

  if (!validation.ok) {
    if (validation.quarantine) {
      await insertPaper(db, row);
      await setPublishState(db, id, 'quarantined', validation.reason);
      console.log(`[fetch:manual] quarantined ${id}: ${validation.reason}`);
      return 'quarantined';
    }
    console.log(`[fetch:manual] rejected ${id}: ${validation.reason}`);
    return 'rejected';
  }

  await insertPaper(db, row);
  return 'new';
}

export async function runFetch(
  db: D1Database,
): Promise<{ fetched: number; newCount: number; rejected: number; quarantined: number; mode: string }> {
  let newCount = 0;
  let rejected = 0;
  let quarantined = 0;
  let duplicates = 0;

  try {
    console.log(`[fetch:manual] Starting (citation>=${MANUAL_CIT_MIN}, random 50)`);

    const recentWorks = await fetchManualRecent();
    console.log(`[fetch:manual] recent-cited: ${recentWorks.length} works`);

    await new Promise((r) => setTimeout(r, 1000));

    const classicWorks = await fetchManualClassic();
    console.log(`[fetch:manual] classic-high: ${classicWorks.length} works`);

    // Deduplicate within this run
    const seen = new Set<string>();
    const allWorks: OpenAlexWork[] = [];
    for (const work of [...recentWorks, ...classicWorks]) {
      const id = normalizeId(work.id);
      if (!seen.has(id)) {
        seen.add(id);
        allWorks.push(work);
      }
    }

    const fetched = allWorks.length;
    const today = new Date().toISOString().split('T')[0];

    for (const work of allWorks) {
      const outcome = await saveWork(db, work, today);
      if (outcome === 'new')         newCount++;
      else if (outcome === 'quarantined') quarantined++;
      else if (outcome === 'rejected')    rejected++;
      else                               duplicates++;
    }

    await insertFetchLog(db, fetched, newCount, 'ok');
    console.log(
      `[fetch:manual] fetched=${fetched} new=${newCount} ` +
      `duplicate=${duplicates} quarantined=${quarantined} rejected=${rejected}`,
    );
    return { fetched, newCount, rejected, quarantined, mode: 'manual' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await insertFetchLog(db, 0, newCount, 'error', message).catch(() => {});
    throw err;
  }
}
