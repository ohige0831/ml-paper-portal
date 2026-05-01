#!/usr/bin/env node
'use strict';

const { scoreMlRelevance } = require('./lib/ml_scoring');
const { normalizeTitle, normalizeWhitespace } = require('./lib/text_normalize');

const ARXIV_BASE = 'https://export.arxiv.org/api/query';
const CATEGORIES = ['cs.LG', 'cs.CV', 'cs.AI', 'stat.ML', 'cs.CL'];
const ARXIV_DAILY_LIMIT = Math.max(1, Number(process.env.ARXIV_DAILY_LIMIT ?? '60'));
const DAILY_REGISTER_LIMIT = Math.max(1, Number(process.env.DAILY_REGISTER_LIMIT ?? '30'));
const WORKER_URL = process.env.WORKER_URL;
const INGEST_TOKEN = process.env.INGEST_TOKEN;
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
const SOURCE_BONUS_ARXIV = 5;

if (!DRY_RUN && (!WORKER_URL || !INGEST_TOKEN)) {
  console.error('[fetch_arxiv] WORKER_URL and INGEST_TOKEN are required unless --dry-run or DRY_RUN=1 is set.');
  process.exit(1);
}

function escapeQueryCategory(category) {
  return `cat:${category}`;
}

function buildQueryUrl() {
  const searchQuery = CATEGORIES.map(escapeQueryCategory).join(' OR ');
  const params = new URLSearchParams({
    search_query: searchQuery,
    start: '0',
    max_results: String(ARXIV_DAILY_LIMIT),
    sortBy: 'submittedDate',
    sortOrder: 'descending',
  });
  return `${ARXIV_BASE}?${params.toString()}`;
}

function decodeXml(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function matchText(xml, pattern) {
  const match = xml.match(pattern);
  return match ? normalizeWhitespace(decodeXml(match[1])) : '';
}

function extractArxivId(idUrl) {
  const raw = idUrl.split('/').pop() ?? '';
  return raw.replace(/v\d+$/i, '');
}

function parseAtomEntries(xml) {
  const entries = [];
  const entryMatches = xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g);

  for (const match of entryMatches) {
    const entryXml = match[1];
    const idUrl = matchText(entryXml, /<id>([\s\S]*?)<\/id>/);
    const arxivId = extractArxivId(idUrl);
    const title = matchText(entryXml, /<title>([\s\S]*?)<\/title>/);
    const abstract = matchText(entryXml, /<summary>([\s\S]*?)<\/summary>/);
    const published = matchText(entryXml, /<published>(\d{4}-\d{2}-\d{2})[\s\S]*?<\/published>/);
    const authors = [...entryXml.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>\s*<\/author>/g)]
      .map((m) => normalizeWhitespace(decodeXml(m[1])));
    const categories = [...entryXml.matchAll(/<category\s+term="([^"]+)"/g)]
      .map((m) => decodeXml(m[1]));

    if (!arxivId || !title || !published) continue;

    entries.push({
      arxiv_id: arxivId,
      title,
      abstract,
      authors,
      published_date: published,
      normalized_title: normalizeTitle(title),
      url: `https://arxiv.org/abs/${arxivId}`,
      pdf_url: `https://arxiv.org/pdf/${arxivId}`,
      categories,
    });
  }

  return entries;
}

function freshnessBonus(publishedDate) {
  const published = new Date(`${publishedDate}T00:00:00Z`);
  if (Number.isNaN(published.getTime())) return 0;
  const now = new Date();
  const ageDays = Math.floor((now.getTime() - published.getTime()) / 86400000);
  if (ageDays <= 7) return 5;
  if (ageDays <= 30) return 2;
  return 0;
}

function reviewTier(effectiveScore) {
  if (effectiveScore >= 45) return 'A';
  if (effectiveScore >= 25) return 'B';
  return 'C';
}

function scoreEntry(entry) {
  const ml = scoreMlRelevance({
    title: entry.title,
    abstract: entry.abstract,
    categories: entry.categories,
    cited_by_count: 0,
  });
  const freshness = freshnessBonus(entry.published_date);
  const effectiveScore = ml.score + SOURCE_BONUS_ARXIV + freshness;
  return {
    ...entry,
    ml_score: ml.score,
    score_reasons: ml.reasons,
    source_bonus: SOURCE_BONUS_ARXIV,
    freshness_bonus: freshness,
    effective_score: effectiveScore,
    review_tier: reviewTier(effectiveScore),
  };
}

async function fetchArxiv() {
  const url = buildQueryUrl();
  console.log(`[fetch_arxiv] categories=${CATEGORIES.join(',')} limit=${ARXIV_DAILY_LIMIT}`);
  console.log(DRY_RUN
    ? '[fetch_arxiv] mode=DRY-RUN (no ingest, no DB writes)'
    : `[fetch_arxiv] mode=INGEST limit=${DAILY_REGISTER_LIMIT}`);

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'ml-paper-portal/1.0 (daily arXiv discovery dry-run)',
    },
  });
  if (!res.ok) {
    throw new Error(`arXiv Atom API failed: ${res.status}`);
  }
  const xml = await res.text();
  return parseAtomEntries(xml);
}

async function main() {
  const entries = await fetchArxiv();
  const scored = entries.map(scoreEntry);

  const tierCounts = { A: 0, B: 0, C: 0 };
  for (const item of scored) tierCounts[item.review_tier]++;

  console.log(`[fetch_arxiv] fetched=${entries.length} scored=${scored.length}`);
  console.log(`[fetch_arxiv] tiers A=${tierCounts.A} B=${tierCounts.B} C=${tierCounts.C}`);

  if (!DRY_RUN) {
    const toRegister = scored
      .sort((a, b) => b.effective_score - a.effective_score)
      .slice(0, DAILY_REGISTER_LIMIT);
    const result = await postToWorker(toRegister);
    console.log(
      `[fetch_arxiv] ingest inserted=${result.inserted ?? 0} ` +
      `skipped=${result.skipped ?? 0} rejected=${result.rejected ?? 0} limit=${result.limit ?? DAILY_REGISTER_LIMIT}`,
    );
    return;
  }

  for (const item of scored) {
    const authors = item.authors.slice(0, 3).join(', ');
    console.log(
      `[${item.review_tier}] effective=${String(item.effective_score).padStart(3)} ` +
      `ml=${String(item.ml_score).padStart(3)} ` +
      `fresh=${item.freshness_bonus} ${item.arxiv_id} "${item.title.slice(0, 90)}"`,
    );
    console.log(`    date=${item.published_date} categories=${item.categories.join(',')} url=${item.url}`);
    if (authors) console.log(`    authors=${authors}${item.authors.length > 3 ? ', ...' : ''}`);
    if (item.score_reasons.length > 0) {
      console.log(`    reasons=${item.score_reasons.join('; ')}`);
    }
  }
}

async function postToWorker(papers) {
  const res = await fetch(`${WORKER_URL.replace(/\/$/, '')}/api/ingest/arxiv`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify({ papers, limit: DAILY_REGISTER_LIMIT }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Worker ingest failed: ${res.status} ${text}`);
  }
  return res.json();
}

main().catch((err) => {
  console.error('[fetch_arxiv] Fatal error:', err);
  process.exit(1);
});
