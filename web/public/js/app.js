// Shared utilities for the public site

export async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function escHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function tagHtml(tag) {
  const tierClass = `tag--tier${tag.tier}`;
  return `<a href="/tags/${escHtml(tag.slug)}" class="tag ${tierClass}">${escHtml(tag.name)}</a>`;
}

export function paperCardHtml(item) {
  const { paper, summary, tags } = item;
  const titleJa = summary?.title_ja;
  const title = titleJa || paper.title;
  const slug = paper.id.toLowerCase();
  const tagsHtml = (tags || []).slice(0, 4).map(tagHtml).join('');
  return `
    <article class="paper-card">
      <div class="paper-card__title">
        <a href="/papers/${escHtml(slug)}">${escHtml(title)}</a>
      </div>
      ${titleJa ? `<div class="paper-card__title-en">${escHtml(paper.title)}</div>` : ''}
      ${summary?.one_line ? `<p class="paper-card__summary">${escHtml(summary.one_line)}</p>` : ''}
      <div class="paper-card__meta">
        <span>${paper.published_date?.slice(0, 7) || ''}</span>
        ${paper.citation_count ? `<span>被引用 ${paper.citation_count}</span>` : ''}
      </div>
      ${tagsHtml ? `<div class="paper-card__tags">${tagsHtml}</div>` : ''}
    </article>
  `;
}

export function renderPaperGrid(containerId, items) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!items || items.length === 0) {
    el.innerHTML = '<p class="empty">論文がまだありません</p>';
    return;
  }
  el.innerHTML = items.map(paperCardHtml).join('');
}
