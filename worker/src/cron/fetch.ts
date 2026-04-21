import type { D1Database } from '@cloudflare/workers-types';
import type { OpenAlexWork } from '../types';
import { insertPaper, paperExists, insertFetchLog } from '../db/queries';
import {
  reconstructAbstract,
  extractPdfUrl,
  extractOaUrl,
  normalizeId,
} from '../lib/openalex';

const OPENALEX_BASE = 'https://api.openalex.org';
const ML_CONCEPT_ID = 'C41008148';
const MAILTO = 'kagerou5100@gmail.com';

async function fetchWorks(params: URLSearchParams): Promise<OpenAlexWork[]> {
  // mailto= param identifies us to OpenAlex polite pool (100k req/day)
  params.set('mailto', MAILTO);
  const url = `${OPENALEX_BASE}/works?${params.toString()}`;

  // Retry up to 3 times on 429 with exponential backoff
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
      console.warn(`[fetch] OpenAlex 429, retrying (attempt ${attempt + 1})`);
      continue;
    }
    throw new Error(`OpenAlex fetch failed: ${res.status}`);
  }
  return [];
}

async function fetchRecentWorks(): Promise<OpenAlexWork[]> {
  const params = new URLSearchParams({
    filter: `concepts.id:${ML_CONCEPT_ID},is_oa:true`,
    sort: 'publication_date:desc',
    'per-page': '25',
    select: 'id,doi,title,authorships,publication_date,cited_by_count,open_access,primary_location,best_oa_location,primary_topic,topics,abstract_inverted_index',
  });
  return fetchWorks(params);
}

async function fetchPopularWorks(): Promise<OpenAlexWork[]> {
  // Popular among papers from the last 2 years
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const fromDate = twoYearsAgo.toISOString().split('T')[0];

  const params = new URLSearchParams({
    filter: `concepts.id:${ML_CONCEPT_ID},is_oa:true,from_publication_date:${fromDate}`,
    sort: 'cited_by_count:desc',
    'per-page': '25',
    select: 'id,doi,title,authorships,publication_date,cited_by_count,open_access,primary_location,best_oa_location,primary_topic,topics,abstract_inverted_index',
  });
  return fetchWorks(params);
}

export async function runFetch(db: D1Database): Promise<{ fetched: number; newCount: number }> {
  let fetched = 0;
  let newCount = 0;

  try {
    // Sequential to respect OpenAlex rate limits (polite pool: 10 req/s)
    const recentWorks = await fetchRecentWorks();
    const popularWorks = await fetchPopularWorks();

    // Deduplicate by ID
    const seen = new Set<string>();
    const allWorks: OpenAlexWork[] = [];
    for (const work of [...recentWorks, ...popularWorks]) {
      const id = normalizeId(work.id);
      if (!seen.has(id)) {
        seen.add(id);
        allWorks.push(work);
      }
    }

    fetched = allWorks.length;

    for (const work of allWorks) {
      const id = normalizeId(work.id);

      if (await paperExists(db, id)) continue;

      const abstract = work.abstract_inverted_index
        ? reconstructAbstract(work.abstract_inverted_index)
        : null;

      const authors = JSON.stringify(
        work.authorships.slice(0, 10).map((a) => ({ name: a.author.display_name })),
      );

      const topics = JSON.stringify(
        (work.topics ?? []).slice(0, 5).map((t) => t.display_name),
      );

      await insertPaper(db, {
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
      });

      newCount++;
    }

    await insertFetchLog(db, fetched, newCount, 'ok');
    return { fetched, newCount };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await insertFetchLog(db, fetched, newCount, 'error', message).catch(() => {});
    throw err;
  }
}
