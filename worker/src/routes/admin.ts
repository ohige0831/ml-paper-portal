import { Hono } from 'hono';
import type { Env, PaperWithSummary, OpenAlexWork } from '../types';
import {
  getPapersByStatus,
  getPaperById,
  setPublishState,
  withdrawPaper,
  rejectPaper,
  resummarizePaper,
  restorePaper,
  getTagsWithCount,
  paperExists,
  insertPaper,
  findPaperByDoi,
  findPaperByArxivId,
} from '../db/queries';
import { reconstructAbstract, extractPdfUrl, extractOaUrl, normalizeId } from '../lib/openalex';
import { runFetch } from '../cron/fetch';
import { runSummarize } from '../cron/summarize';

// ── Procure helpers ──────────────────────────────────────────────────────────

const PROC_BASE = 'https://api.openalex.org';
const PROC_MAILTO = 'kagerou5100@gmail.com';
const PROC_SELECT = [
  'id', 'doi', 'title', 'authorships', 'publication_date',
  'cited_by_count', 'open_access', 'primary_location', 'best_oa_location',
  'primary_topic', 'topics', 'abstract_inverted_index',
].join(',');

function extractArxivId(query: string): string | null {
  // arxiv.org URL: https://arxiv.org/abs/2401.12345 or /pdf/2401.12345.pdf
  const urlMatch = query.match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+)/i);
  if (urlMatch) {
    return urlMatch[1]
      .replace(/\.pdf$/i, '')   // strip .pdf extension from PDF URLs
      .replace(/v\d+$/, '');    // strip version suffix
  }

  // arXiv DOI: 10.48550/arXiv.2401.12345
  const doiMatch = query.match(/10\.48550\/arXiv\.([^\s]+)/i);
  if (doiMatch) return doiMatch[1].replace(/v\d+$/, '');

  // Bare new arXiv ID: 2401.12345 or 2401.12345v2
  if (/^\d{4}\.\d{4,5}(?:v\d+)?$/.test(query)) return query.replace(/v\d+$/, '');

  // Old arXiv format: hep-th/9901022
  if (/^[a-z-]+\/\d{7}$/.test(query)) return query;

  return null;
}

function parseProcureInput(query: string): {
  type: 'id' | 'doi' | 'arxiv' | 'title';
  normalized: string;
} {
  // OpenAlex ID: W followed by digits
  if (/^W\d+$/.test(query)) return { type: 'id', normalized: query };

  // openalex.org URL — extract W-id
  const oaMatch = query.match(/openalex\.org\/(W\d+)/);
  if (oaMatch) return { type: 'id', normalized: oaMatch[1] };

  // arXiv (before general DOI check, since arXiv DOIs start with 10.48550)
  const arxivId = extractArxivId(query);
  if (arxivId) return { type: 'arxiv', normalized: arxivId };

  // doi.org URL
  const doiUrlMatch = query.match(/doi\.org\/(.+)/);
  if (doiUrlMatch) return { type: 'doi', normalized: `https://doi.org/${doiUrlMatch[1]}` };

  // Raw DOI (10.xxx/...)
  if (/^10\.\d{4,}/.test(query)) return { type: 'doi', normalized: `https://doi.org/${query}` };

  // Normalized doi with https prefix
  if (query.startsWith('https://doi.org/')) return { type: 'doi', normalized: query };

  return { type: 'title', normalized: query };
}

async function openAlexFetch(url: string): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
    const res = await fetch(url);
    if (res.ok || res.status === 404) return res;
    if (res.status === 429 && attempt < 2) continue;
    throw new Error(`OpenAlex ${res.status}`);
  }
  return fetch(url); // unreachable but TypeScript needs it
}

async function fetchOpenAlexById(id: string): Promise<OpenAlexWork | null> {
  const url = `${PROC_BASE}/works/${id}?mailto=${PROC_MAILTO}&select=${PROC_SELECT}`;
  const res = await openAlexFetch(url);
  if (res.status === 404) return null;
  return res.json<OpenAlexWork>();
}

async function fetchOpenAlexByDoi(doi: string): Promise<OpenAlexWork | null> {
  const params = new URLSearchParams({ filter: `doi:${doi}`, mailto: PROC_MAILTO, select: PROC_SELECT });
  const res = await openAlexFetch(`${PROC_BASE}/works?${params}`);
  if (!res.ok) return null;
  const data = await res.json<{ results: OpenAlexWork[] }>();
  return data.results?.[0] ?? null;
}

async function fetchOpenAlexByTitle(title: string): Promise<OpenAlexWork | null> {
  const params = new URLSearchParams({
    search: title, 'per-page': '1', mailto: PROC_MAILTO, select: PROC_SELECT,
  });
  const res = await openAlexFetch(`${PROC_BASE}/works?${params}`);
  if (!res.ok) return null;
  const data = await res.json<{ results: OpenAlexWork[] }>();
  return data.results?.[0] ?? null;
}

async function fetchOpenAlexByArxivId(arxivId: string): Promise<OpenAlexWork | null> {
  // Primary: canonical arXiv preprint DOI (most reliable — documented OpenAlex filter)
  const viaDoi = await fetchOpenAlexByDoi(`https://doi.org/10.48550/arXiv.${arxivId}`);
  if (viaDoi) return viaDoi;

  // Fallback: ids.arxiv filter (catches papers where DOI differs from canonical form)
  // Wrapped in try/catch because OpenAlex may return 400 for this filter on some versions
  try {
    const params = new URLSearchParams({
      filter: `ids.arxiv:${arxivId}`,
      mailto: PROC_MAILTO,
      select: PROC_SELECT,
    });
    const res = await fetch(`${PROC_BASE}/works?${params}`);
    if (res.ok) {
      const data = await res.json<{ results: OpenAlexWork[] }>();
      if (data.results?.[0]) return data.results[0];
    }
  } catch { /* ids.arxiv filter not supported on this API version — ignore */ }

  return null;
}

interface ArxivAtomEntry {
  arxivId: string;
  title: string;
  authors: string[];
  abstract: string;
  published: string; // YYYY-MM-DD
}

async function fetchArxivAtom(arxivId: string): Promise<ArxivAtomEntry | null> {
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}&max_results=1`;
  let res: Response;
  try { res = await fetch(url); } catch { return null; }
  if (!res.ok) return null;
  const xml = await res.text();
  if (!xml.includes('<entry>')) return null;

  // Parse XML fields with regex (no DOMParser in Workers)
  const titleMatch = xml.match(/<entry>[\s\S]*?<title>([^<]+)<\/title>/);
  const summaryMatch = xml.match(/<summary[^>]*>([\s\S]*?)<\/summary>/);
  const publishedMatch = xml.match(/<published>(\d{4}-\d{2}-\d{2})/);
  const authorMatches = [...xml.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)];

  const title = titleMatch?.[1]?.trim();
  const published = publishedMatch?.[1];
  if (!title || !published) return null;

  return {
    arxivId,
    title,
    authors: authorMatches.map((m) => m[1].trim()),
    abstract: summaryMatch?.[1]?.trim() ?? '',
    published,
  };
}

function buildArxivOnlyPaperRow(entry: ArxivAtomEntry, source: string) {
  const safeId = entry.arxivId.replace(/[./]/g, '_');
  const doi = `10.48550/arXiv.${entry.arxivId}`;
  const absUrl = `https://arxiv.org/abs/${entry.arxivId}`;
  return {
    id: `ARXIV${safeId}`,
    doi,
    title: entry.title,
    authors: JSON.stringify(entry.authors.slice(0, 10).map((name) => ({ name }))),
    published_date: entry.published,
    citation_count: 0,
    oa_url: absUrl,
    pdf_url: `https://arxiv.org/pdf/${entry.arxivId}`,
    openalex_url: absUrl,
    primary_topic: null,
    topics: '[]',
    abstract: entry.abstract || null,
    source,
    arxiv_id: entry.arxivId,
    is_preprint: 1,
  };
}

async function searchOpenAlexKeyword(keyword: string): Promise<OpenAlexWork[]> {
  // sample=40 (no seed) gives random 40 each call; we filter to ≤10 new ones
  const params = new URLSearchParams({
    search: keyword,
    filter: 'primary_topic.subfield.id:1702,is_oa:true',
    sample: '40',
    mailto: PROC_MAILTO,
    select: PROC_SELECT,
  });
  const res = await openAlexFetch(`${PROC_BASE}/works?${params}`);
  if (!res.ok) return [];
  const data = await res.json<{ results: OpenAlexWork[] }>();
  return data.results ?? [];
}

function extractArxivIdFromWork(work: OpenAlexWork): string | null {
  if (!work.doi) return null;
  const m = work.doi.match(/10\.48550\/arXiv\.([^\s]+)/i);
  return m ? m[1].replace(/v\d+$/, '') : null;
}

function buildPaperRow(work: OpenAlexWork, source: string) {
  const arxiv_id = extractArxivIdFromWork(work);
  return {
    id: normalizeId(work.id),
    doi: work.doi,
    title: work.title,
    authors: JSON.stringify(work.authorships.slice(0, 10).map((a) => ({ name: a.author.display_name }))),
    published_date: work.publication_date,
    citation_count: work.cited_by_count,
    oa_url: extractOaUrl(work),
    pdf_url: extractPdfUrl(work),
    openalex_url: work.id,
    primary_topic: work.primary_topic?.display_name ?? null,
    topics: JSON.stringify((work.topics ?? []).slice(0, 5).map((t) => t.display_name)),
    abstract: work.abstract_inverted_index ? reconstructAbstract(work.abstract_inverted_index) : null,
    source,
    arxiv_id,
    is_preprint: arxiv_id ? 1 : 0,
  };
}

export const adminRouter = new Hono<{ Bindings: Env }>();

// Basic auth middleware for all admin routes
adminRouter.use('*', async (c, next) => {
  const auth = c.req.header('Authorization') ?? '';
  const valid = validateBasicAuth(auth, c.env.ADMIN_PASSWORD);
  if (!valid) {
    return c.text('Unauthorized', 401, {
      'WWW-Authenticate': 'Basic realm="ML Paper Portal Admin"',
    });
  }
  return next();
});

function validateBasicAuth(header: string, password: string): boolean {
  if (!header.startsWith('Basic ')) return false;
  try {
    const decoded = atob(header.slice(6));
    // Split only on the first colon — password may contain colons
    const colonIndex = decoded.indexOf(':');
    if (colonIndex === -1) return false;
    const pass = decoded.slice(colonIndex + 1);
    return pass === password;
  } catch {
    return false;
  }
}

// GET /admin → serve admin HTML
adminRouter.get('/admin', (c) => {
  const siteUrl = c.env.SITE_BASE_URL ?? '';
  return c.html(buildAdminHtml(siteUrl));
});

// GET /api/admin/papers?status=review_pending
adminRouter.get('/api/papers', async (c) => {
  const status = (c.req.query('status') ?? 'review_pending') as any;
  const papers = await getPapersByStatus(c.env.DB, status, 50);
  return c.json(papers.map(serializePaper));
});

// GET /api/admin/papers/:id
adminRouter.get('/api/papers/:id', async (c) => {
  const paper = await getPaperById(c.env.DB, c.req.param('id'));
  if (!paper) return c.json({ error: 'Not found' }, 404);
  return c.json(serializePaper(paper));
});

// POST /api/admin/papers/:id/approve
adminRouter.post('/api/admin/papers/:id/approve', async (c) => {
  const id = c.req.param('id');
  await setPublishState(c.env.DB, id, 'published');
  return c.json({ ok: true });
});

// POST /api/admin/papers/:id/reject  — dismiss to rejected (not re-summarized automatically)
adminRouter.post('/api/admin/papers/:id/reject', async (c) => {
  const id = c.req.param('id');
  let reason = 'admin rejection';
  try {
    const body = await c.req.json<{ reason?: string }>();
    if (body?.reason) reason = body.reason;
  } catch { /* reason stays default */ }
  await rejectPaper(c.env.DB, id, reason, 'admin');
  return c.json({ ok: true });
});

// POST /api/admin/papers/:id/resummarize  — move back to fetched for re-summarization
adminRouter.post('/api/admin/papers/:id/resummarize', async (c) => {
  const id = c.req.param('id');
  await resummarizePaper(c.env.DB, id);
  return c.json({ ok: true });
});

// POST /api/admin/papers/:id/withdraw
adminRouter.post('/api/admin/papers/:id/withdraw', async (c) => {
  const id = c.req.param('id');
  let reason = 'admin withdrawal';
  try {
    const body = await c.req.json<{ reason?: string }>();
    if (body?.reason) reason = body.reason;
  } catch { /* reason stays default */ }
  await withdrawPaper(c.env.DB, id, reason, 'admin');
  return c.json({ ok: true });
});

// POST /api/admin/papers/:id/restore
adminRouter.post('/api/admin/papers/:id/restore', async (c) => {
  const id = c.req.param('id');
  await restorePaper(c.env.DB, id);
  return c.json({ ok: true });
});

// POST /api/admin/papers/:id/quarantine-approve  (rescue a quarantined paper)
adminRouter.post('/api/admin/papers/:id/quarantine-approve', async (c) => {
  const id = c.req.param('id');
  await setPublishState(c.env.DB, id, 'fetched');
  return c.json({ ok: true });
});

// POST /api/admin/trigger/fetch
adminRouter.post('/api/trigger/fetch', async (c) => {
  const result = await runFetch(c.env.DB);
  return c.json(result);
});

// POST /api/admin/trigger/summarize
adminRouter.post('/api/trigger/summarize', async (c) => {
  const model = c.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  const result = await runSummarize(c.env.DB, c.env.OPENAI_API_KEY, model);
  return c.json(result);
});

// GET /api/admin/tags
adminRouter.get('/api/tags', async (c) => {
  const tags = await getTagsWithCount(c.env.DB);
  return c.json(tags);
});

// ── Procure endpoints ─────────────────────────────────────────────────────────

// POST /api/admin/procure/lookup — resolve DOI / OpenAlex ID / URL / title
adminRouter.post('/api/admin/procure/lookup', async (c) => {
  let query = '';
  try { query = ((await c.req.json<{ query: string }>()).query ?? '').trim(); } catch { /**/ }
  if (!query) return c.json({ error: 'query is required' }, 400);

  const parsed = parseProcureInput(query);
  console.log(`[procure:lookup] query="${query}" → type=${parsed.type} normalized="${parsed.normalized}"`);

  try {
    let work: OpenAlexWork | null = null;
    let arxivAtomEntry: ArxivAtomEntry | null = null;

    if (parsed.type === 'id') {
      if (await paperExists(c.env.DB, parsed.normalized)) {
        console.log(`[procure:lookup] already exists by OpenAlex ID`);
        return c.json({ found: true, alreadyExists: true, existingId: parsed.normalized });
      }
      work = await fetchOpenAlexById(parsed.normalized);
      console.log(`[procure:lookup] OpenAlex by ID → ${work ? work.id : 'null'}`);

    } else if (parsed.type === 'doi') {
      const existingId = await findPaperByDoi(c.env.DB, parsed.normalized);
      if (existingId) {
        console.log(`[procure:lookup] already exists by DOI`);
        return c.json({ found: true, alreadyExists: true, existingId });
      }
      work = await fetchOpenAlexByDoi(parsed.normalized);
      console.log(`[procure:lookup] OpenAlex by DOI → ${work ? work.id : 'null'}`);

    } else if (parsed.type === 'arxiv') {
      // Check existing by arXiv ID and DOI (both casings)
      const existingByArxiv = await findPaperByArxivId(c.env.DB, parsed.normalized);
      if (existingByArxiv) {
        console.log(`[procure:lookup] already exists by arxiv_id`);
        return c.json({ found: true, alreadyExists: true, existingId: existingByArxiv });
      }
      for (const doi of [
        `https://doi.org/10.48550/arXiv.${parsed.normalized}`,
        `https://doi.org/10.48550/arxiv.${parsed.normalized}`,
      ]) {
        const existingByDoi = await findPaperByDoi(c.env.DB, doi);
        if (existingByDoi) {
          console.log(`[procure:lookup] already exists by arXiv DOI`);
          return c.json({ found: true, alreadyExists: true, existingId: existingByDoi });
        }
      }

      // Step 1: arXiv Atom first — no rate limits, works even when OpenAlex is throttled
      console.log(`[procure:lookup] fetching arXiv Atom for "${parsed.normalized}"`);
      try { arxivAtomEntry = await fetchArxivAtom(parsed.normalized); } catch { /* ignore */ }
      console.log(`[procure:lookup] arXiv Atom → ${arxivAtomEntry ? `"${arxivAtomEntry.title}"` : 'null'}`);

      // Step 2: OpenAlex for enrichment (citation count, topics, W-ID)
      // Isolated try/catch: 429 / timeout / any error MUST NOT block the Atom result
      let openAlexStatus: 'ok' | 'not_found' | 'error' = 'not_found';
      console.log(`[procure:lookup] fetching OpenAlex for "${parsed.normalized}"`);
      try {
        work = await fetchOpenAlexByArxivId(parsed.normalized);
        openAlexStatus = work ? 'ok' : 'not_found';
      } catch (err) {
        openAlexStatus = 'error';
        console.log(`[procure:lookup] OpenAlex error (will use Atom if available): ${err instanceof Error ? err.message : String(err)}`);
      }
      console.log(`[procure:lookup] OpenAlex → ${work ? work.id : `null (${openAlexStatus})`}`);

      if (!work) {
        if (arxivAtomEntry) {
          // arXiv Atom succeeded — return preview regardless of why OpenAlex failed
          console.log(`[procure:lookup] returning arXiv Atom preview (openAlexStatus=${openAlexStatus})`);
          return c.json({ found: true, alreadyExists: false, arxivOnly: true, arxivEntry: arxivAtomEntry, openAlexStatus });
        }
        // Both failed
        console.log(`[procure:lookup] not found in OpenAlex or arXiv Atom`);
        return c.json({ found: false, debug: { type: parsed.type, normalized: parsed.normalized, openAlexStatus } });
      }

      // OpenAlex succeeded — fall through to common duplicate check + return below

    } else {
      work = await fetchOpenAlexByTitle(parsed.normalized);
      console.log(`[procure:lookup] OpenAlex by title → ${work ? work.id : 'null'}`);
    }

    if (!work) {
      console.log(`[procure:lookup] not found`);
      return c.json({ found: false, debug: { type: parsed.type, normalized: parsed.normalized } });
    }

    const id = normalizeId(work.id);
    if (await paperExists(c.env.DB, id)) {
      console.log(`[procure:lookup] already exists by W-ID after fetch`);
      return c.json({ found: true, alreadyExists: true, existingId: id });
    }
    if (work.doi) {
      const existingId = await findPaperByDoi(c.env.DB, work.doi);
      if (existingId) {
        console.log(`[procure:lookup] already exists by DOI after fetch`);
        return c.json({ found: true, alreadyExists: true, existingId });
      }
    }
    const workArxivId = extractArxivIdFromWork(work);
    if (workArxivId) {
      const existingId = await findPaperByArxivId(c.env.DB, workArxivId);
      if (existingId) {
        console.log(`[procure:lookup] already exists by arxiv_id after fetch`);
        return c.json({ found: true, alreadyExists: true, existingId });
      }
    }

    console.log(`[procure:lookup] returning work ${id} arxiv_id=${workArxivId ?? 'none'}`);
    return c.json({ found: true, alreadyExists: false, work });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[procure:lookup] unexpected error: ${msg}`);
    return c.json({ error: msg }, 500);
  }
});

// POST /api/admin/procure/import — save a single looked-up paper
// Accepts either { work: OpenAlexWork, source } or { arxivEntry: ArxivAtomEntry, source }
adminRouter.post('/api/admin/procure/import', async (c) => {
  const body = await c.req.json<{
    work?: OpenAlexWork;
    arxivEntry?: ArxivAtomEntry;
    source: string;
  }>();
  const today = new Date().toISOString().split('T')[0];

  if (body.arxivEntry) {
    // arXiv-only import (not found in OpenAlex)
    const entry = body.arxivEntry;
    const arxivDoi = `https://doi.org/10.48550/arXiv.${entry.arxivId}`;
    const syntheticId = `ARXIV${entry.arxivId.replace(/[./]/g, '_')}`;

    if (await paperExists(c.env.DB, syntheticId)) return c.json({ status: 'exists', id: syntheticId });
    if (await findPaperByDoi(c.env.DB, arxivDoi)) return c.json({ status: 'exists', id: syntheticId });
    if (await findPaperByArxivId(c.env.DB, entry.arxivId)) return c.json({ status: 'exists', id: syntheticId });

    if (!entry.title || !entry.published || entry.published > today) {
      return c.json({ status: 'rejected', reason: 'missing or invalid fields' });
    }

    await insertPaper(c.env.DB, buildArxivOnlyPaperRow(entry, body.source ?? 'manual'));
    return c.json({ status: 'added', id: syntheticId });
  }

  const { work, source } = body;
  if (!work?.id) return c.json({ error: 'work.id or arxivEntry is required' }, 400);

  const id = normalizeId(work.id);
  if (await paperExists(c.env.DB, id)) return c.json({ status: 'exists', id });
  if (work.doi) {
    const existingId = await findPaperByDoi(c.env.DB, work.doi);
    if (existingId) return c.json({ status: 'exists', id: existingId });
  }
  const workArxivId = extractArxivIdFromWork(work);
  if (workArxivId) {
    const existingId = await findPaperByArxivId(c.env.DB, workArxivId);
    if (existingId) return c.json({ status: 'exists', id: existingId });
  }

  // Hard-reject only (no ML-relevance quarantine — admin explicitly chose this paper)
  if (!work.title || work.title.trim().length < 5 || !work.publication_date || work.publication_date > today) {
    return c.json({ status: 'rejected', reason: 'missing or invalid fields' });
  }

  await insertPaper(c.env.DB, buildPaperRow(work, source ?? 'manual'));
  return c.json({ status: 'added', id });
});

// POST /api/admin/procure/keyword — search and return up to 10 new candidates
adminRouter.post('/api/admin/procure/keyword', async (c) => {
  let keyword = '';
  try { keyword = ((await c.req.json<{ keyword: string }>()).keyword ?? '').trim(); } catch { /**/ }
  if (!keyword) return c.json({ error: 'keyword is required' }, 400);

  try {
    const works = await searchOpenAlexKeyword(keyword);
    const today = new Date().toISOString().split('T')[0];

    // Shuffle for variety (different 10 from same 40 each call)
    const shuffled = [...works].sort(() => Math.random() - 0.5);

    const candidates: OpenAlexWork[] = [];
    for (const work of shuffled) {
      if (candidates.length >= 10) break;
      if (!work.title || !work.publication_date || work.publication_date > today) continue;
      const id = normalizeId(work.id);
      if (await paperExists(c.env.DB, id)) continue;
      if (work.doi && await findPaperByDoi(c.env.DB, work.doi)) continue;
      candidates.push(work);
    }

    return c.json({ candidates, total: works.length, filtered: works.length - candidates.length });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// POST /api/admin/procure/batch-import — save selected keyword candidates
adminRouter.post('/api/admin/procure/batch-import', async (c) => {
  const { works, source } = await c.req.json<{ works: OpenAlexWork[]; source: string }>();
  if (!Array.isArray(works) || works.length === 0) return c.json({ added: 0, skipped: 0, failed: 0 });

  const today = new Date().toISOString().split('T')[0];
  let added = 0; let skipped = 0; let failed = 0;

  for (const work of works) {
    try {
      if (!work?.id) { failed++; continue; }
      const id = normalizeId(work.id);
      if (await paperExists(c.env.DB, id)) { skipped++; continue; }
      if (work.doi && await findPaperByDoi(c.env.DB, work.doi)) { skipped++; continue; }
      const wArxivId = extractArxivIdFromWork(work);
      if (wArxivId && await findPaperByArxivId(c.env.DB, wArxivId)) { skipped++; continue; }
      if (!work.title || !work.publication_date || work.publication_date > today) { failed++; continue; }
      await insertPaper(c.env.DB, buildPaperRow(work, source ?? 'keyword_curated'));
      added++;
    } catch { failed++; }
  }

  console.log(`[procure:batch] added=${added} skipped=${skipped} failed=${failed}`);
  return c.json({ added, skipped, failed });
});

function serializePaper(p: PaperWithSummary) {
  return {
    ...p,
    paper: {
      ...p.paper,
      authors: JSON.parse(p.paper.authors),
      topics: JSON.parse(p.paper.topics),
    },
    summary: p.summary
      ? {
          ...p.summary,
          three_lines: JSON.parse(p.summary.three_lines),
          keywords: JSON.parse(p.summary.keywords),
        }
      : null,
    error_message: p.error_message ?? null,
    withdrawn_at: p.withdrawn_at ?? null,
    withdrawn_reason: p.withdrawn_reason ?? null,
    withdrawn_by: p.withdrawn_by ?? null,
    rejected_at: p.rejected_at ?? null,
    rejected_reason: p.rejected_reason ?? null,
    rejected_by: p.rejected_by ?? null,
  };
}

function buildAdminHtml(siteUrl: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ML Paper Portal - 管理画面</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #1a1a1a; }
  header { background: #1a1a2e; color: #fff; padding: 16px 24px; display: flex; align-items: center; gap: 16px; }
  header h1 { font-size: 18px; font-weight: 600; }
  header nav { margin-left: auto; display: flex; gap: 8px; }
  header nav button { background: rgba(255,255,255,0.15); color: #fff; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  header nav button:hover { background: rgba(255,255,255,0.25); }
  .container { max-width: 1100px; margin: 0 auto; padding: 24px 16px; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; align-items: center; }
  .toolbar label { font-size: 14px; font-weight: 500; }
  select { padding: 6px 10px; border: 1px solid #ddd; border-radius: 6px; background: #fff; font-size: 14px; }
  .btn { padding: 7px 14px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; transition: opacity 0.15s; }
  .btn:hover { opacity: 0.85; }
  .btn-primary { background: #2563eb; color: #fff; }
  .btn-success { background: #16a34a; color: #fff; }
  .btn-danger  { background: #dc2626; color: #fff; }
  .btn-outline { background: #fff; color: #333; border: 1px solid #ddd; }
  .btn-warning { background: #d97706; color: #fff; }
  .status-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
  .status-fetched { background: #e0f2fe; color: #0369a1; }
  .status-summarized { background: #fef9c3; color: #854d0e; }
  .status-review_pending { background: #fef3c7; color: #92400e; }
  .status-approved { background: #dcfce7; color: #166534; }
  .status-published { background: #d1fae5; color: #065f46; }
  .status-error { background: #fee2e2; color: #991b1b; }
  .status-quarantined { background: #fde68a; color: #78350f; }
  .status-withdrawn { background: #e5e7eb; color: #4b5563; }
  .status-rejected  { background: #fce7f3; color: #9d174d; }
  .paper-list { display: flex; flex-direction: column; gap: 12px; }
  .paper-card { background: #fff; border-radius: 10px; padding: 16px 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); cursor: pointer; border: 2px solid transparent; transition: border-color 0.15s; }
  .paper-card:hover { border-color: #2563eb; }
  .paper-card.selected { border-color: #2563eb; background: #eff6ff; }
  .paper-card-header { display: flex; align-items: flex-start; gap: 10px; }
  .paper-card-title { font-weight: 600; font-size: 15px; flex: 1; line-height: 1.4; }
  .paper-card-meta { font-size: 12px; color: #666; margin-top: 6px; display: flex; gap: 12px; flex-wrap: wrap; }
  .paper-card-summary { font-size: 13px; color: #444; margin-top: 8px; line-height: 1.5; }
  .tags { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 8px; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; background: #e0e7ff; color: #3730a3; }
  .detail-panel { background: #fff; border-radius: 10px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-top: 20px; }
  .detail-panel h2 { font-size: 18px; margin-bottom: 4px; line-height: 1.4; }
  .detail-section { margin-top: 18px; }
  .detail-section h3 { font-size: 13px; font-weight: 600; color: #666; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
  .detail-section p, .detail-section li { font-size: 14px; line-height: 1.7; color: #333; }
  .detail-section ul { padding-left: 16px; }
  .detail-actions { display: flex; gap: 10px; margin-top: 20px; padding-top: 16px; border-top: 1px solid #eee; }
  .msg { padding: 10px 16px; border-radius: 6px; font-size: 14px; margin-top: 12px; }
  .msg-ok { background: #dcfce7; color: #166534; }
  .msg-err { background: #fee2e2; color: #991b1b; }
  .empty { color: #888; font-size: 14px; padding: 32px 0; text-align: center; }
  .split { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  @media (max-width: 768px) { .split { grid-template-columns: 1fr; } }
  #loading { color: #888; font-size: 14px; padding: 20px 0; }
  .log-line { font-size: 13px; color: #555; padding: 4px 0; border-bottom: 1px solid #f0f0f0; }
  .section-title { font-size: 15px; font-weight: 600; margin-bottom: 14px; color: #1a1a2e; }
  .procure-hint { font-size: 13px; color: #666; margin-bottom: 12px; }
  .procure-row { display: flex; gap: 8px; }
  .procure-input { flex: 1; padding: 8px 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; }
  .candidate-item { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; background: #fff; border-radius: 8px; border: 1px solid #e5e7eb; margin-bottom: 8px; }
  .candidate-item input[type=checkbox] { margin-top: 3px; flex-shrink: 0; width: 16px; height: 16px; cursor: pointer; }
  .candidate-label { cursor: pointer; flex: 1; }
  .candidate-title { font-size: 13px; font-weight: 500; line-height: 1.4; color: #1a1a1a; }
  .candidate-meta { font-size: 12px; color: #888; margin-top: 4px; display: flex; gap: 10px; }
  .add-bar { display: flex; align-items: center; gap: 14px; margin-top: 14px; }
  .btn-active { background: #1a1a2e; color: #fff; }
</style>
</head>
<body>
<header>
  <h1>ML Paper Portal 管理画面</h1>
  <nav>
    ${siteUrl ? `<button onclick="window.open('${siteUrl}','_blank')">公開サイトを見る</button>` : ''}
    <button id="btn-fetch" onclick="triggerFetch()">取得実行</button>
    <button id="btn-summarize" onclick="triggerSummarize()">要約実行</button>
    <button id="btn-procure" onclick="toggleProcure()">仕入れ</button>
  </nav>
</header>
<div class="container">
  <div id="main-section">
    <div class="toolbar">
      <label>ステータス:</label>
      <select id="status-select" onchange="loadPapers()">
        <option value="review_pending">レビュー待ち</option>
        <option value="fetched">取得済み</option>
        <option value="summarized">要約済み</option>
        <option value="published">公開済み</option>
        <option value="rejected">却下保留</option>
        <option value="quarantined">検疫中</option>
        <option value="withdrawn">取り下げ済み</option>
        <option value="error">エラー</option>
      </select>
      <button class="btn btn-outline" onclick="loadPapers()">更新</button>
    </div>
    <div id="msg"></div>
    <div class="split">
      <div>
        <div id="paper-list" class="paper-list"><div class="empty">読み込み中...</div></div>
      </div>
      <div>
        <div id="detail-panel" class="detail-panel" style="display:none"></div>
      </div>
    </div>
  </div>

  <div id="procure-section" style="display:none">
    <div id="procure-msg" style="margin-bottom:14px"></div>
    <div class="split">
      <div>
        <div class="detail-panel">
          <div class="section-title">手動投入</div>
          <p class="procure-hint">DOI・OpenAlex ID・arXiv ID（2401.12345）・arXiv URL・論文タイトルを入力</p>
          <div class="procure-row">
            <input id="manual-input" class="procure-input" type="text"
              placeholder="例: 2401.12345 / arxiv.org/abs/2401.12345 / W2741809807">
            <button class="btn btn-primary" onclick="lookupPaper()">調べる</button>
          </div>
          <div id="manual-result" style="margin-top:16px"></div>
        </div>
      </div>
      <div>
        <div class="detail-panel">
          <div class="section-title">キーワード仕入れ</div>
          <p class="procure-hint">テーマキーワードで候補 10 件をランダム取得（毎回少し異なる顔ぶれ）</p>
          <div class="procure-row">
            <input id="keyword-input" class="procure-input" type="text"
              placeholder="例: ViT, diffusion, RAG, anomaly detection">
            <button class="btn btn-primary" onclick="searchKeyword()">候補取得</button>
          </div>
          <div id="keyword-loading" style="display:none;color:#888;margin-top:12px;font-size:14px">取得中...</div>
          <div id="keyword-candidates" style="margin-top:12px"></div>
          <div id="keyword-add-bar" class="add-bar" style="display:none">
            <button class="btn btn-success" onclick="addSelectedCandidates()">選択した論文を追加</button>
            <span id="selected-count" style="font-size:14px;color:#666">0件選択中</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
let papers = [];
let selectedId = null;

async function api(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function loadPapers() {
  const status = document.getElementById('status-select').value;
  document.getElementById('paper-list').innerHTML = '<div class="empty">読み込み中...</div>';
  document.getElementById('detail-panel').style.display = 'none';
  try {
    papers = await api('/api/papers?status=' + status);
    renderPaperList();
  } catch(e) {
    showMsg('読み込みエラー: ' + e.message, false);
  }
}

function renderPaperList() {
  const el = document.getElementById('paper-list');
  if (!papers.length) { el.innerHTML = '<div class="empty">論文がありません</div>'; return; }
  el.innerHTML = papers.map(p => {
    const title = p.summary?.title_ja || p.paper.title;
    const oneLine = p.summary?.one_line || '';
    const date = p.paper.published_date?.slice(0, 7) || '';
    const citations = p.paper.citation_count;
    const tags = (p.tags || []).map(t => \`<span class="tag">\${t.name}</span>\`).join('');
    return \`<div class="paper-card\${selectedId === p.paper.id ? ' selected' : ''}" onclick="selectPaper('\${p.paper.id}')">
      <div class="paper-card-header">
        <div class="paper-card-title">\${escHtml(title)}</div>
        <span class="status-badge status-\${p.status}">\${p.status}</span>
      </div>
      \${oneLine ? \`<div class="paper-card-summary">\${escHtml(oneLine)}</div>\` : ''}
      <div class="paper-card-meta">
        <span>\${date}</span>
        \${citations ? \`<span>被引用 \${citations}</span>\` : ''}
      </div>
      \${tags ? \`<div class="tags">\${tags}</div>\` : ''}
    </div>\`;
  }).join('');
}

function selectPaper(id) {
  selectedId = id;
  renderPaperList();
  const p = papers.find(x => x.paper.id === id);
  if (!p) return;
  renderDetail(p);
}

function renderDetail(p) {
  const panel = document.getElementById('detail-panel');
  panel.style.display = 'block';
  const s = p.summary;
  const paper = p.paper;
  const titleJa = s?.title_ja || paper.title;
  const authors = (paper.authors || []).slice(0, 5).map(a => a.name).join(', ');
  const threeLines = (s?.three_lines || []).map(l => \`<li>\${escHtml(l)}</li>\`).join('');
  const keywords = (s?.keywords || []).map(k => \`<span class="tag">\${escHtml(k)}</span>\`).join('');
  const tags = (p.tags || []).map(t => \`<span class="tag">\${escHtml(t.name)}</span>\`).join('');
  const status = p.status;

  panel.innerHTML = \`
    <h2>\${escHtml(titleJa)}</h2>
    <div style="margin-top:6px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
      <span class="status-badge status-\${status}">\${status}</span>
      <span style="font-size:12px;color:#888">\${paper.id}</span>
    </div>
    \${s?.one_line ? \`<div style="margin-top:12px;font-size:15px;color:#333;">\${escHtml(s.one_line)}</div>\` : ''}
    \${threeLines ? \`<div class="detail-section"><h3>3行まとめ</h3><ul>\${threeLines}</ul></div>\` : ''}
    \${keywords ? \`<div class="detail-section"><h3>キーワード</h3><div class="tags">\${keywords}</div></div>\` : ''}
    \${s?.long_summary ? \`<div class="detail-section"><h3>要約</h3><p>\${escHtml(s.long_summary)}</p></div>\` : ''}
    \${s?.audience ? \`<div class="detail-section"><h3>こんな人向け</h3><p>\${escHtml(s.audience)}</p></div>\` : ''}
    \${s?.difficulty ? \`<div class="detail-section"><h3>難易度</h3><p>\${escHtml(s.difficulty)}</p></div>\` : ''}
    \${tags ? \`<div class="detail-section"><h3>タグ</h3><div class="tags">\${tags}</div></div>\` : ''}
    <div class="detail-section">
      <h3>元論文情報</h3>
      <p style="font-size:13px;line-height:1.8;">
        原題: \${escHtml(paper.title)}<br>
        著者: \${escHtml(authors)}\${paper.authors?.length > 5 ? ' ほか' : ''}<br>
        公開: \${paper.published_date}<br>
        被引用: \${paper.citation_count}
        \${paper.openalex_url ? \`<br><a href="\${paper.openalex_url}" target="_blank">OpenAlex</a>\` : ''}
        \${paper.pdf_url ? \`<br><a href="\${paper.pdf_url}" target="_blank">PDF</a>\` : ''}
        \${paper.doi ? \`<br><a href="https://doi.org/\${paper.doi}" target="_blank">DOI</a>\` : ''}
      </p>
    </div>
    <div class="detail-actions">
      \${(status === 'review_pending' || status === 'summarized') ? \`
        <button class="btn btn-success" onclick="approve('\${paper.id}')">承認して公開</button>
        <button class="btn btn-danger" onclick="rejectWithReason('\${paper.id}')">却下して保留</button>
        <button class="btn btn-warning" onclick="resummarize('\${paper.id}')">再要約に回す</button>
      \` : ''}
      \${status === 'rejected' ? \`
        <div class="msg" style="background:#fce7f3;color:#9d174d;margin:0;">
          却下済み: \${escHtml(p.rejected_reason || '')}
          \${p.rejected_at ? \` (\${p.rejected_at.slice(0,10)})\` : ''}
        </div>
        <button class="btn btn-warning" onclick="resummarize('\${paper.id}')">再要約に回す</button>
        <button class="btn btn-outline" onclick="resummarizeToFetched('\${paper.id}')">取得済みに戻す</button>
        <button class="btn btn-danger" onclick="withdraw('\${paper.id}')">完全取り下げ</button>
      \` : ''}
      \${status === 'published' ? \`
        <span style="color:#16a34a;font-size:14px;">✓ 公開済み</span>
        <button class="btn btn-danger" onclick="withdraw('\${paper.id}')">公開取り下げ</button>
      \` : ''}
      \${status === 'quarantined' ? \`
        <div class="msg" style="background:#fde68a;color:#78350f;margin:0;">検疫理由: \${escHtml(p.error_message || '')}</div>
        <button class="btn btn-success" onclick="quarantineApprove('\${paper.id}')">救済（取得済みに戻す）</button>
        <button class="btn btn-danger" onclick="withdraw('\${paper.id}')">完全取り下げ</button>
      \` : ''}
      \${status === 'withdrawn' ? \`
        <div class="msg" style="background:#e5e7eb;color:#4b5563;margin:0;">取り下げ済み (\${escHtml(p.withdrawn_reason || '')})</div>
        <button class="btn btn-outline" onclick="restore('\${paper.id}')">レビュー待ちに復元</button>
      \` : ''}
      \${status === 'error' ? \`
        <div class="msg msg-err">\${escHtml(p.error_message || 'エラー')}</div>
        <button class="btn btn-warning" onclick="resummarize('\${paper.id}')">再要約に回す</button>
      \` : ''}
    </div>
  \`;
}

async function approve(id) {
  try {
    await api('/api/admin/papers/' + id + '/approve', 'POST');
    showMsg('公開しました', true);
    await loadPapers();
  } catch(e) { showMsg('エラー: ' + e.message, false); }
}

async function rejectWithReason(id) {
  const reason = prompt('却下理由を入力してください（省略可）:');
  if (reason === null) return; // cancelled
  try {
    await api('/api/admin/papers/' + id + '/reject', 'POST', { reason: reason || 'admin rejection' });
    showMsg('却下して保留しました（自動要約の対象外になります）', true);
    await loadPapers();
  } catch(e) { showMsg('エラー: ' + e.message, false); }
}

async function resummarize(id) {
  if (!confirm('この論文を再要約キューに戻しますか？（次回の要約 cron で処理されます）')) return;
  try {
    await api('/api/admin/papers/' + id + '/resummarize', 'POST');
    showMsg('取得済みに移動しました（次回の要約 cron で再処理されます）', true);
    await loadPapers();
  } catch(e) { showMsg('エラー: ' + e.message, false); }
}

async function resummarizeToFetched(id) {
  await resummarize(id);
}

async function withdraw(id) {
  const reason = prompt('取り下げ理由を入力してください（省略可）:') ?? 'admin withdrawal';
  try {
    await api('/api/admin/papers/' + id + '/withdraw', 'POST', { reason });
    showMsg('公開を取り下げました', true);
    await loadPapers();
  } catch(e) { showMsg('エラー: ' + e.message, false); }
}

async function restore(id) {
  try {
    await api('/api/admin/papers/' + id + '/restore', 'POST');
    showMsg('レビュー待ちに復元しました', true);
    await loadPapers();
  } catch(e) { showMsg('エラー: ' + e.message, false); }
}

async function quarantineApprove(id) {
  try {
    await api('/api/admin/papers/' + id + '/quarantine-approve', 'POST');
    showMsg('取得済みに移動しました（要約後に再レビューしてください）', true);
    await loadPapers();
  } catch(e) { showMsg('エラー: ' + e.message, false); }
}

async function triggerFetch() {
  const btn = document.getElementById('btn-fetch');
  btn.disabled = true; btn.textContent = '取得中...';
  try {
    const res = await api('/api/trigger/fetch', 'POST');
    const q = res.quarantined ?? 0;
    const r = res.rejected ?? 0;
    showMsg(\`取得完了 [手動/被引用20+]: \${res.fetched}件中 \${res.newCount}件が新規 (検疫:\${q} 却下:\${r})\`, true);
    loadPapers();
  } catch(e) { showMsg('取得エラー: ' + e.message, false); }
  finally { btn.disabled = false; btn.textContent = '取得実行'; }
}

async function triggerSummarize() {
  const btn = document.getElementById('btn-summarize');
  btn.disabled = true; btn.textContent = '処理中...';
  try {
    const res = await api('/api/trigger/summarize', 'POST');
    showMsg(\`要約完了: \${res.processed}件 (エラー: \${res.errors}件)\`, true);
    loadPapers();
  } catch(e) { showMsg('要約エラー: ' + e.message, false); }
  finally { btn.disabled = false; btn.textContent = '要約実行'; }
}

function showMsg(text, ok) {
  const el = document.getElementById('msg');
  el.className = 'msg ' + (ok ? 'msg-ok' : 'msg-err');
  el.textContent = text;
  setTimeout(() => { el.textContent = ''; el.className = ''; }, 5000);
}

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

loadPapers();

// ── 仕入れ機能 ────────────────────────────────────────────────────────────────
let lookedUpWork = null;
let lookedUpArxiv = null;
let candidateWorks = [];

function toggleProcure() {
  const mainEl = document.getElementById('main-section');
  const procureEl = document.getElementById('procure-section');
  const btn = document.getElementById('btn-procure');
  const isActive = procureEl.style.display !== 'none';
  if (isActive) {
    procureEl.style.display = 'none';
    mainEl.style.display = '';
    btn.textContent = '仕入れ';
    btn.classList.remove('btn-active');
  } else {
    mainEl.style.display = 'none';
    procureEl.style.display = '';
    btn.textContent = '← 一覧';
    btn.classList.add('btn-active');
  }
}

function showProcureMsg(text, ok) {
  const el = document.getElementById('procure-msg');
  el.className = 'msg ' + (ok ? 'msg-ok' : 'msg-err');
  el.textContent = text;
  setTimeout(() => { el.textContent = ''; el.className = ''; }, 6000);
}

// 手動投入 ─────────────────────────────────────────────────────────────────────

async function lookupPaper() {
  const query = document.getElementById('manual-input').value.trim();
  if (!query) return;
  const resultEl = document.getElementById('manual-result');
  resultEl.innerHTML = '<div style="color:#888;font-size:14px">検索中...</div>';
  lookedUpWork = null;
  lookedUpArxiv = null;
  try {
    const res = await api('/api/admin/procure/lookup', 'POST', { query });
    if (res.error) {
      resultEl.innerHTML = '<div class="msg msg-err">エラー: ' + escHtml(res.error) + '</div>';
      return;
    }
    if (!res.found) {
      var d = res.debug || {};
      var notFoundMsg = '論文が見つかりませんでした';
      if (d.type === 'arxiv') {
        notFoundMsg = d.openAlexStatus === 'error'
          ? 'arXiv ID "' + escHtml(d.normalized || '') + '" は arXiv にも見つかりませんでした（OpenAlex はレート制限中）。ID が正しいか確認してください。'
          : 'arXiv ID "' + escHtml(d.normalized || '') + '" は OpenAlex にも arXiv にも見つかりませんでした。ID が正しいか確認してください。';
      } else if (d.type === 'doi') {
        notFoundMsg = 'DOI "' + escHtml(d.normalized || '') + '" は OpenAlex に見つかりませんでした。';
      } else if (d.type === 'id') {
        notFoundMsg = 'OpenAlex ID "' + escHtml(d.normalized || '') + '" は見つかりませんでした。';
      } else if (d.type === 'title') {
        notFoundMsg = 'タイトル検索で論文が見つかりませんでした。DOI や arXiv ID での検索もお試しください。';
      }
      resultEl.innerHTML = '<div class="msg msg-err">' + notFoundMsg + '</div>';
      return;
    }
    if (res.alreadyExists) {
      resultEl.innerHTML = '<div class="msg" style="background:#fef9c3;color:#854d0e">既にDB登録済みです (ID: ' + escHtml(res.existingId || '') + ')</div>';
      return;
    }
    if (res.arxivOnly) {
      // arXiv Atom preview — OpenAlex was rate-limited or paper not yet indexed
      lookedUpWork = null;
      lookedUpArxiv = res.arxivEntry;
      var e = res.arxivEntry;
      var atomAuthors = (e.authors || []).slice(0, 3).map(function(n) { return escHtml(n); }).join(', ');
      var oaBgColor = res.openAlexStatus === 'error' ? '#fee2e2' : '#fef3c7';
      var oaTextColor = res.openAlexStatus === 'error' ? '#991b1b' : '#92400e';
      var oaNote = res.openAlexStatus === 'error'
        ? 'OpenAlex レート制限中 → arXiv 直取得'
        : 'arXiv 直取得 / OpenAlex 未登録';
      resultEl.innerHTML =
        '<div class="paper-card" style="cursor:default;margin-bottom:12px">' +
          '<div class="paper-card-title">' + escHtml(e.title) + '</div>' +
          '<div class="paper-card-meta">' +
            '<span>' + (e.published || '').slice(0, 7) + '</span>' +
            '<span style="background:' + oaBgColor + ';color:' + oaTextColor + ';padding:1px 6px;border-radius:4px;font-size:11px">' + oaNote + '</span>' +
          '</div>' +
          (atomAuthors ? '<div style="font-size:12px;color:#666;margin-top:4px">' + atomAuthors + '</div>' : '') +
        '</div>' +
        '<div style="font-size:12px;color:#888;margin-bottom:8px">※ 被引用数・トピックは未取得（arXiv 直取得のため）。追加後に要約は実行できます。</div>' +
        '<button class="btn btn-success" onclick="importLookedUp()">この論文を追加（arXiv / source: manual）</button>';
      return;
    }
    lookedUpWork = res.work;
    lookedUpArxiv = null;
    const w = res.work;
    const authors = (w.authorships || []).slice(0, 3).map(function(a) { return escHtml(a.author.display_name); }).join(', ');
    resultEl.innerHTML =
      '<div class="paper-card" style="cursor:default;margin-bottom:12px">' +
        '<div class="paper-card-title">' + escHtml(w.title) + '</div>' +
        '<div class="paper-card-meta">' +
          '<span>' + (w.publication_date || '').slice(0, 7) + '</span>' +
          '<span>被引用 ' + (w.cited_by_count || 0) + '</span>' +
          (w.doi ? '<span>' + escHtml(w.doi) + '</span>' : '') +
        '</div>' +
        (authors ? '<div style="font-size:12px;color:#666;margin-top:4px">' + authors + '</div>' : '') +
      '</div>' +
      '<button class="btn btn-success" onclick="importLookedUp()">この論文を追加（source: manual）</button>';
  } catch(e) {
    resultEl.innerHTML = '<div class="msg msg-err">' + escHtml(e.message) + '</div>';
  }
}

async function importLookedUp() {
  if (!lookedUpWork && !lookedUpArxiv) return;
  try {
    const body = lookedUpArxiv
      ? { arxivEntry: lookedUpArxiv, source: 'manual' }
      : { work: lookedUpWork, source: 'manual' };
    const res = await api('/api/admin/procure/import', 'POST', body);
    const resultEl = document.getElementById('manual-result');
    if (res.status === 'exists') {
      resultEl.innerHTML += '<div class="msg" style="background:#fef9c3;color:#854d0e;margin-top:8px">既にDB登録済みです</div>';
    } else if (res.status === 'added') {
      resultEl.innerHTML += '<div class="msg msg-ok" style="margin-top:8px">追加しました ✓ 要約実行で review_pending に来ます</div>';
      lookedUpWork = null;
      lookedUpArxiv = null;
    } else {
      resultEl.innerHTML += '<div class="msg msg-err" style="margin-top:8px">追加できませんでした: ' + escHtml(res.reason || '') + '</div>';
    }
  } catch(e) {
    showProcureMsg('エラー: ' + e.message, false);
  }
}

// キーワード仕入れ ──────────────────────────────────────────────────────────────

async function searchKeyword() {
  const keyword = document.getElementById('keyword-input').value.trim();
  if (!keyword) return;
  const candidatesEl = document.getElementById('keyword-candidates');
  const loadingEl = document.getElementById('keyword-loading');
  const addBarEl = document.getElementById('keyword-add-bar');
  candidatesEl.innerHTML = '';
  addBarEl.style.display = 'none';
  loadingEl.style.display = '';
  candidateWorks = [];
  try {
    const res = await api('/api/admin/procure/keyword', 'POST', { keyword });
    loadingEl.style.display = 'none';
    if (res.error) { candidatesEl.innerHTML = '<div class="msg msg-err">' + escHtml(res.error) + '</div>'; return; }
    candidateWorks = res.candidates || [];
    if (!candidateWorks.length) {
      candidatesEl.innerHTML = '<div class="msg" style="background:#fef9c3;color:#854d0e">新規候補が見つかりませんでした（' + (res.total || 0) + '件中 ' + (res.filtered || 0) + '件が既知）</div>';
      return;
    }
    candidatesEl.innerHTML = candidateWorks.map(function(w, i) {
      var authors = (w.authorships || []).slice(0, 2).map(function(a) { return escHtml(a.author.display_name); }).join(', ');
      return '<div class="candidate-item">' +
        '<input type="checkbox" id="cand-' + i + '" onchange="updateSelectedCount()">' +
        '<label class="candidate-label" for="cand-' + i + '">' +
          '<div class="candidate-title">' + escHtml(w.title) + '</div>' +
          '<div class="candidate-meta">' +
            '<span>' + (w.publication_date || '').slice(0, 7) + '</span>' +
            '<span>被引用 ' + (w.cited_by_count || 0) + '</span>' +
          '</div>' +
          (authors ? '<div style="font-size:12px;color:#888">' + authors + '</div>' : '') +
        '</label>' +
      '</div>';
    }).join('');
    addBarEl.style.display = 'flex';
    document.getElementById('selected-count').textContent = '0件選択中（全' + candidateWorks.length + '件）';
  } catch(e) {
    loadingEl.style.display = 'none';
    candidatesEl.innerHTML = '<div class="msg msg-err">' + escHtml(e.message) + '</div>';
  }
}

function updateSelectedCount() {
  var checked = document.querySelectorAll('#keyword-candidates input[type=checkbox]:checked');
  var total = candidateWorks.length;
  document.getElementById('selected-count').textContent = checked.length + '件選択中（全' + total + '件）';
}

async function addSelectedCandidates() {
  var checked = Array.from(document.querySelectorAll('#keyword-candidates input[type=checkbox]:checked'));
  if (!checked.length) return;
  var selected = checked.map(function(el) {
    return candidateWorks[parseInt(el.id.replace('cand-', ''))];
  });
  try {
    var res = await api('/api/admin/procure/batch-import', 'POST', { works: selected, source: 'keyword_curated' });
    showProcureMsg('追加完了: ' + res.added + '件追加 / ' + res.skipped + '件スキップ / ' + res.failed + '件失敗', res.added > 0);
    checked.forEach(function(el) { el.checked = false; });
    updateSelectedCount();
  } catch(e) {
    showProcureMsg('エラー: ' + e.message, false);
  }
}
</script>
</body>
</html>`;
}
