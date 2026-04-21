import type { PagesFunction, EventContext } from '@cloudflare/workers-types';
import { getPaperById, getRelatedPapers } from '../../src/db/queries';

interface Env { DB: D1Database }

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const slug = (ctx.params as Record<string, string>).slug?.toLowerCase();
  if (!slug) return new Response('Not Found', { status: 404 });

  // slug = lowercase OpenAlex ID (e.g. "w2741809807")
  const paperId = slug.toUpperCase();

  const item = await getPaperById(ctx.env.DB, paperId);
  if (!item || item.status !== 'published') {
    return new Response(notFoundHtml(), {
      status: 404,
      headers: { 'Content-Type': 'text/html;charset=UTF-8' },
    });
  }

  const related = await getRelatedPapers(ctx.env.DB, paperId, 5);

  return new Response(renderPaperPage(item, related), {
    headers: { 'Content-Type': 'text/html;charset=UTF-8' },
  });
};

type Item = Awaited<ReturnType<typeof getPaperById>>;
type Related = Awaited<ReturnType<typeof getRelatedPapers>>;

function esc(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function difficultyClass(d: string | null | undefined): string {
  if (!d) return '';
  if (d === '入門') return 'difficulty-badge--intro';
  if (d === '上級') return 'difficulty-badge--adv';
  return 'difficulty-badge--mid';
}

function renderPaperPage(item: NonNullable<Item>, related: Related): string {
  const { paper, summary, tags } = item;
  const titleJa = summary?.title_ja || paper.title;
  const threeLines = summary ? JSON.parse(summary.three_lines) as string[] : [];
  const keywords = summary ? JSON.parse(summary.keywords) as string[] : [];
  const authors = (JSON.parse(paper.authors) as Array<{ name: string }>).slice(0, 6);
  const tagsHtml = tags
    .map((t) => `<a href="/tags/${esc(t.slug)}" class="tag tag--tier${t.tier}">${esc(t.name)}</a>`)
    .join('');

  const relatedHtml = related.length === 0 ? '' : `
    <div class="paper-section">
      <div class="paper-section__label">関連論文</div>
      <div class="related-list">
        ${related.map((r) => {
          const rtitle = r.summary?.title_ja || r.paper.title;
          const rslug = r.paper.id.toLowerCase();
          const rtags = r.tags.slice(0, 3)
            .map((t) => `<a href="/tags/${esc(t.slug)}" class="tag tag--tier${t.tier}">${esc(t.name)}</a>`)
            .join('');
          return `<div class="related-item">
            <div>
              <div class="related-item__title"><a href="/papers/${esc(rslug)}">${esc(rtitle)}</a></div>
              <div class="related-item__meta">${esc(r.paper.published_date?.slice(0, 7))}</div>
              ${rtags ? `<div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap;">${rtags}</div>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(titleJa)} - ML Paper Portal</title>
<meta name="description" content="${esc(summary?.one_line || '')}">
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
  <article class="container paper-detail">
    <div class="breadcrumb">
      <a href="/">ホーム</a> / <a href="/latest/">新着</a> / 論文
    </div>

    <header class="paper-detail__header">
      <h1 class="paper-detail__title-ja">${esc(titleJa)}</h1>
      ${summary?.title_ja ? `<p class="paper-detail__title-en">${esc(paper.title)}</p>` : ''}
      ${summary?.one_line ? `<p class="paper-detail__one-line">${esc(summary.one_line)}</p>` : ''}
      <div class="paper-detail__meta">
        <span>${esc(paper.published_date)}</span>
        ${paper.citation_count ? `<span>被引用 ${paper.citation_count}</span>` : ''}
        ${summary?.difficulty ? `<span class="difficulty-badge ${difficultyClass(summary.difficulty)}">${esc(summary.difficulty)}</span>` : ''}
      </div>
      ${tagsHtml ? `<div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap;">${tagsHtml}</div>` : ''}
    </header>

    ${threeLines.length > 0 ? `
    <section class="paper-section">
      <div class="paper-section__label">この論文を3行でいうと</div>
      <ul class="three-lines">
        ${threeLines.map((l) => `<li>${esc(l)}</li>`).join('')}
      </ul>
    </section>` : ''}

    ${keywords.length > 0 ? `
    <section class="paper-section">
      <div class="paper-section__label">キーワード</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        ${keywords.map((k) => `<span class="tag tag--plain">${esc(k)}</span>`).join('')}
      </div>
    </section>` : ''}

    ${summary?.long_summary ? `
    <section class="paper-section">
      <div class="paper-section__label">もう少しだけ中身を見る</div>
      <p class="paper-section__content">${esc(summary.long_summary)}</p>
    </section>` : ''}

    ${summary?.audience ? `
    <section class="paper-section">
      <div class="paper-section__label">こんな人に向いていそう</div>
      <p class="paper-section__content">${esc(summary.audience)}</p>
    </section>` : ''}

    <section class="paper-section">
      <div class="paper-section__label">元論文はこちら</div>
      <div class="original-paper-box">
        <div class="original-paper-box__title">${esc(paper.title)}</div>
        <div style="font-size:13px;color:#555;margin-top:6px;">
          ${authors.map((a) => esc(a.name)).join(', ')}${authors.length < (JSON.parse(paper.authors) as []).length ? ' ほか' : ''}
        </div>
        <div class="original-paper-links">
          ${paper.openalex_url ? `<a href="${esc(paper.openalex_url)}" target="_blank" rel="noopener">OpenAlex</a>` : ''}
          ${paper.pdf_url ? `<a href="${esc(paper.pdf_url)}" target="_blank" rel="noopener">PDF</a>` : ''}
          ${paper.doi ? `<a href="https://doi.org/${esc(paper.doi)}" target="_blank" rel="noopener">DOI</a>` : ''}
          ${paper.oa_url && paper.oa_url !== paper.pdf_url ? `<a href="${esc(paper.oa_url)}" target="_blank" rel="noopener">論文ページ</a>` : ''}
        </div>
      </div>
    </section>

    ${relatedHtml}
  </article>
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
<html lang="ja"><head><meta charset="UTF-8"><title>論文が見つかりません - ML Paper Portal</title>
<link rel="stylesheet" href="/styles/main.css"></head>
<body>
<header class="site-header">
  <div class="container site-header__inner">
    <a href="/" class="site-logo">ML Paper Portal</a>
  </div>
</header>
<main><div class="container" style="padding:80px 0;text-align:center;">
  <h1>論文が見つかりません</h1>
  <p style="margin-top:16px;color:#888;"><a href="/latest/">新着一覧に戻る</a></p>
</div></main>
</body></html>`;
}
