#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT_DIR, 'web');
const OUTPUT_PATH = path.join(WEB_DIR, 'public', 'sitemap.xml');
const SITE_BASE_URL = 'https://ml-paper-portal-web.pages.dev';
const D1_DATABASE_NAME = 'ml-paper-portal';

const SQL = {
  siteLastmod: `
SELECT
  COALESCE(MAX(ps.updated_at), MAX(p.created_at), MAX(p.published_date), date('now')) AS lastmod
FROM papers p
JOIN publish_states ps ON ps.paper_id = p.id
WHERE ps.status = 'published';
`.trim(),

  publishedPapers: `
SELECT
  p.id,
  COALESCE(ps.updated_at, p.created_at, p.published_date) AS lastmod
FROM papers p
JOIN publish_states ps ON ps.paper_id = p.id
WHERE ps.status = 'published'
ORDER BY p.published_date DESC, p.id ASC;
`.trim(),

  publishedTags: `
SELECT
  t.slug,
  MAX(COALESCE(ps.updated_at, p.created_at, p.published_date)) AS lastmod,
  COUNT(*) AS paper_count
FROM tags t
JOIN paper_tags pt ON pt.tag_id = t.id
JOIN papers p ON p.id = pt.paper_id
JOIN publish_states ps ON ps.paper_id = p.id
WHERE ps.status = 'published'
GROUP BY t.id, t.slug
HAVING COUNT(*) > 0
ORDER BY t.slug ASC;
`.trim(),
};

function runD1Query(sql) {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const result = spawnSync(
    npx,
    ['wrangler', 'd1', 'execute', D1_DATABASE_NAME, '--remote', '--json', '--command', sql],
    {
      cwd: WEB_DIR,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `wrangler d1 execute failed (${result.status})\n${result.stderr || result.stdout}`,
    );
  }

  return parseWranglerJson(result.stdout);
}

function parseWranglerJson(stdout) {
  const text = stdout.trim();
  if (!text) return [];

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse wrangler JSON output: ${err.message}`);
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return [];
    if (Array.isArray(parsed[0]?.results)) return parsed[0].results;
    if (Array.isArray(parsed[0]?.result?.[0]?.results)) return parsed[0].result[0].results;
    if (Array.isArray(parsed[0]?.result?.results)) return parsed[0].result.results;
    if (parsed.every((item) => item && typeof item === 'object' && !('results' in item))) {
      return parsed;
    }
  }

  if (Array.isArray(parsed.results)) return parsed.results;
  if (Array.isArray(parsed.result?.[0]?.results)) return parsed.result[0].results;
  if (Array.isArray(parsed.result?.results)) return parsed.result.results;

  throw new Error('Unexpected wrangler JSON shape');
}

function normalizeLastmod(value) {
  if (!value) return new Date().toISOString().slice(0, 10);
  const text = String(value).trim();
  const datePart = text.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (datePart) return datePart;

  const date = new Date(text);
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);

  return new Date().toISOString().slice(0, 10);
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildUrl(pathname) {
  return `${SITE_BASE_URL}${pathname}`;
}

function renderUrl(loc, lastmod) {
  return [
    '  <url>',
    `    <loc>${xmlEscape(loc)}</loc>`,
    `    <lastmod>${xmlEscape(normalizeLastmod(lastmod))}</lastmod>`,
    '  </url>',
  ].join('\n');
}

function renderSitemap(entries) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    '',
    entries.map((entry) => renderUrl(entry.loc, entry.lastmod)).join('\n\n'),
    '',
    '</urlset>',
    '',
  ].join('\n');
}

function main() {
  const siteRows = runD1Query(SQL.siteLastmod);
  const paperRows = runD1Query(SQL.publishedPapers);
  const tagRows = runD1Query(SQL.publishedTags);

  const siteLastmod = siteRows[0]?.lastmod ?? new Date().toISOString().slice(0, 10);

  const entries = [
    { loc: buildUrl('/'), lastmod: siteLastmod },
    { loc: buildUrl('/latest/'), lastmod: siteLastmod },
    ...paperRows.map((paper) => ({
      loc: buildUrl(`/papers/${String(paper.id).toLowerCase()}`),
      lastmod: paper.lastmod,
    })),
    ...tagRows.map((tag) => ({
      loc: buildUrl(`/tags/${tag.slug}/`),
      lastmod: tag.lastmod,
    })),
  ];

  fs.writeFileSync(OUTPUT_PATH, renderSitemap(entries), 'utf8');
  console.log(
    `[sitemap] wrote ${path.relative(ROOT_DIR, OUTPUT_PATH)} ` +
    `(${entries.length} urls: papers=${paperRows.length}, tags=${tagRows.length})`,
  );
}

main();
