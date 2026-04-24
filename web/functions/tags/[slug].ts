import type { PagesFunction } from '@cloudflare/workers-types';
import { getTagBySlug } from '../../src/db/queries';

interface Env { DB: D1Database }

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const slug = (ctx.params as Record<string, string>).slug;
  if (!slug) return new Response('Not Found', { status: 404 });

  const tag = await getTagBySlug(ctx.env.DB, slug);
  if (!tag) {
    return new Response(notFoundHtml(), {
      status: 404,
      headers: { 'Content-Type': 'text/html;charset=UTF-8' },
    });
  }

  return new Response(renderTagPage(tag), {
    headers: { 'Content-Type': 'text/html;charset=UTF-8' },
  });
};

type Tag = NonNullable<Awaited<ReturnType<typeof getTagBySlug>>>;

function esc(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderTagPage(tag: Tag): string {
  const tierLabel = tag.tier === 1 ? '分野・タスク' : tag.tier === 2 ? 'モデル・手法' : '技術要素';
  const tagSlugJson = JSON.stringify(tag.slug);

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(tag.name)} の機械学習論文 - ML Paper Portal</title>
<meta name="description" content="${esc(tag.name)}に関する機械学習論文一覧。日本語の短い導入文とともに掲載。">
<link rel="stylesheet" href="/styles/main.css">
</head>
<body>
<header class="site-header">
  <div class="container site-header__inner">
    <a href="/" class="site-logo">ML Paper Portal</a>
    <nav class="site-nav">
      <a href="/latest/">新着</a>
      <a href="/tags/">タグ</a>
      <a href="/random" class="site-nav__random">ランダム</a>
    </nav>
  </div>
</header>

<main>
  <div class="container">
    <div class="tag-page-header">
      <div class="breadcrumb">
        <a href="/">ホーム</a> / <a href="/tags/">タグ</a> / ${esc(tag.name)}
      </div>
      <h1 class="tag-page-title">
        <span class="tag tag--tier${tag.tier}" style="font-size:16px;vertical-align:middle;margin-right:6px;">${esc(tierLabel)}</span>
        ${esc(tag.name)}
      </h1>
      <p id="tag-count" class="tag-page-count">読み込み中...</p>
      ${tag.description ? `
      <details class="tag-toggle">
        <summary>「${esc(tag.name)}」とは？</summary>
        <div class="tag-toggle__content">${esc(tag.description)}</div>
      </details>` : ''}
    </div>

    <div id="source-filter" class="source-filter"></div>
    <div id="paper-grid" class="paper-grid">
      <p class="loading">読み込み中...</p>
    </div>
    <div id="pagination" class="pagination" style="margin-top:32px;"></div>
  </div>
</main>

<footer class="site-footer">
  <div class="container">
    <p>ML Paper Portal — 機械学習論文の日本語入口サイト</p>
    <p style="margin-top:8px;">論文情報は <a href="https://openalex.org" target="_blank">OpenAlex</a> より取得。要約は参考情報です。必ず元論文をご確認ください。</p>
  </div>
</footer>

<script type="module">
import { fetchJson, renderPaperGrid, escHtml } from '/js/app.js';

const TAG_SLUG = ${tagSlugJson};
const PAGE_SIZE = 20;
const VALID_SOURCES = ['all', 'arxiv', 'non-arxiv'];
let currentPage = 1;
let currentSource = 'all';
let sourceCounts = { all: 0, arxiv: 0, nonArxiv: 0 };

function getSourceFromUrl() {
  const s = new URLSearchParams(window.location.search).get('source') || 'all';
  return VALID_SOURCES.includes(s) ? s : 'all';
}

function setSourceInUrl(source) {
  const url = new URL(window.location.href);
  if (source === 'all') { url.searchParams.delete('source'); }
  else { url.searchParams.set('source', source); }
  window.history.pushState({}, '', url.toString());
}

function renderSourceFilter() {
  const el = document.getElementById('source-filter');
  if (!el) return;
  const buttons = [
    { key: 'all',       label: 'All',       count: sourceCounts.all },
    { key: 'arxiv',     label: 'arXiv',     count: sourceCounts.arxiv },
    { key: 'non-arxiv', label: 'Non-arXiv', count: sourceCounts.nonArxiv },
  ];
  el.innerHTML = buttons.map(function(b) {
    const active = b.key === currentSource ? ' source-filter__btn--active' : '';
    return '<button class="source-filter__btn' + active + '" data-source="' + b.key + '" onclick="setSource(this.dataset.source)">' + escHtml(b.label) + ' (' + b.count + ')</button>';
  }).join('');
}

async function loadPage(page) {
  const offset = (page - 1) * PAGE_SIZE;
  document.getElementById('paper-grid').innerHTML = '<p class="loading">読み込み中...</p>';
  try {
    const data = await fetchJson('/api/papers?tag=' + encodeURIComponent(TAG_SLUG) + '&limit=' + PAGE_SIZE + '&offset=' + offset + '&source=' + currentSource);
    const items = data.items || data;
    const total = data.total || items.length;
    if (data.sourceCounts) sourceCounts = data.sourceCounts;
    document.getElementById('tag-count').textContent = sourceCounts.all + '件の論文';
    renderSourceFilter();
    renderPaperGrid('paper-grid', items);
    renderPagination(page, total);
    currentPage = page;
  } catch(e) {
    document.getElementById('paper-grid').innerHTML = '<p class="empty">読み込みに失敗しました</p>';
  }
}

function renderPagination(page, total) {
  const totalPages = Math.ceil(total / PAGE_SIZE);
  if (totalPages <= 1) { document.getElementById('pagination').innerHTML = ''; return; }
  const el = document.getElementById('pagination');
  let html = '';
  if (page > 1) html += '<a href="#" onclick="goPage(' + (page - 1) + ');return false;">← 前</a>';
  html += '<span class="current">' + page + ' / ' + totalPages + '</span>';
  if (page < totalPages) html += '<a href="#" onclick="goPage(' + (page + 1) + ');return false;">次 →</a>';
  el.innerHTML = html;
}

window.goPage = function(p) { window.scrollTo(0, 0); loadPage(p); };
window.setSource = function(source) {
  if (source === currentSource) return;
  currentSource = source;
  setSourceInUrl(source);
  loadPage(1);
};

window.addEventListener('popstate', function() {
  currentSource = getSourceFromUrl();
  renderSourceFilter();
  loadPage(1);
});

currentSource = getSourceFromUrl();
renderSourceFilter();
loadPage(1);
</script>
</body>
</html>`;
}

function notFoundHtml(): string {
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>タグが見つかりません - ML Paper Portal</title>
<link rel="stylesheet" href="/styles/main.css"></head>
<body>
<header class="site-header">
  <div class="container site-header__inner">
    <a href="/" class="site-logo">ML Paper Portal</a>
  </div>
</header>
<main><div class="container" style="padding:80px 0;text-align:center;">
  <h1>タグが見つかりません</h1>
  <p style="margin-top:16px;color:#888;"><a href="/tags/">タグ一覧に戻る</a></p>
</div></main>
</body></html>`;
}
