import type { PagesFunction } from '@cloudflare/workers-types';
import { getTagBySlug, getPublishedPapersByTag } from '../../src/db/queries';

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

  const papers = await getPublishedPapersByTag(ctx.env.DB, tag.id, 20, 0);
  const countRow = await ctx.env.DB.prepare(
    `SELECT COUNT(*) as total FROM paper_tags pt
     JOIN publish_states ps ON ps.paper_id = pt.paper_id
     WHERE pt.tag_id = ? AND ps.status = 'published'`
  ).bind(tag.id).first<{ total: number }>();
  const total = countRow?.total ?? 0;

  return new Response(renderTagPage(tag, papers, total), {
    headers: { 'Content-Type': 'text/html;charset=UTF-8' },
  });
};

type Tag = Awaited<ReturnType<typeof getTagBySlug>>;
type Papers = Awaited<ReturnType<typeof getPublishedPapersByTag>>;

function esc(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderTagPage(tag: NonNullable<Tag>, papers: Papers, total: number): string {
  const papersHtml = papers.map((item) => {
    const { paper, summary, tags } = item;
    const title = summary?.title_ja || paper.title;
    const slug = paper.id.toLowerCase();
    const tagsHtml = tags
      .filter((t) => t.id !== tag.id)
      .slice(0, 3)
      .map((t) => `<a href="/tags/${esc(t.slug)}" class="tag tag--tier${t.tier}">${esc(t.name)}</a>`)
      .join('');
    return `<article class="paper-card">
      <div class="paper-card__title">
        <a href="/papers/${esc(slug)}">${esc(title)}</a>
      </div>
      ${summary?.one_line ? `<p class="paper-card__summary">${esc(summary.one_line)}</p>` : ''}
      <div class="paper-card__meta">
        <span>${esc(paper.published_date?.slice(0, 7))}</span>
        ${paper.citation_count ? `<span>被引用 ${paper.citation_count}</span>` : ''}
      </div>
      ${tagsHtml ? `<div class="paper-card__tags">${tagsHtml}</div>` : ''}
    </article>`;
  }).join('');

  const tierLabel = tag.tier === 1 ? '分野・タスク' : tag.tier === 2 ? 'モデル・手法' : '技術要素';

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(tag.name)} の機械学習論文 - ML Paper Portal</title>
<meta name="description" content="${esc(tag.name)}に関する機械学習論文一覧。日本語の短い導入文とともに${total}件を掲載。">
<link rel="stylesheet" href="/styles/main.css">
</head>
<body>
<header class="site-header">
  <div class="container site-header__inner">
    <a href="/" class="site-logo">ML Paper Portal</a>
    <nav class="site-nav">
      <a href="/latest/">新着</a>
      <a href="/tags/">タグ</a>
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
      <p class="tag-page-count">${total}件の論文</p>

      ${tag.description ? `
      <details class="tag-toggle">
        <summary>「${esc(tag.name)}」とは？</summary>
        <div class="tag-toggle__content">${esc(tag.description)}</div>
      </details>` : ''}
    </div>

    ${papers.length === 0
      ? '<p class="empty">このタグの論文はまだありません</p>'
      : `<div class="paper-grid">${papersHtml}</div>`
    }
  </div>
</main>

<footer class="site-footer">
  <div class="container">
    <p>ML Paper Portal — 機械学習論文の日本語入口サイト</p>
    <p style="margin-top:8px;">論文情報は <a href="https://openalex.org" target="_blank">OpenAlex</a> より取得。要約は参考情報です。必ず元論文をご確認ください。</p>
  </div>
</footer>
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
