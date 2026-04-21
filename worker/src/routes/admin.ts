import { Hono } from 'hono';
import type { Env, PaperWithSummary } from '../types';
import {
  getPapersByStatus,
  getPaperById,
  setPublishState,
  getTagsWithCount,
} from '../db/queries';
import { runFetch } from '../cron/fetch';
import { runSummarize } from '../cron/summarize';

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
    const [, pass] = decoded.split(':');
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

// POST /api/admin/papers/:id/reject
adminRouter.post('/api/admin/papers/:id/reject', async (c) => {
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
  .status-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
  .status-fetched { background: #e0f2fe; color: #0369a1; }
  .status-summarized { background: #fef9c3; color: #854d0e; }
  .status-review_pending { background: #fef3c7; color: #92400e; }
  .status-approved { background: #dcfce7; color: #166534; }
  .status-published { background: #d1fae5; color: #065f46; }
  .status-error { background: #fee2e2; color: #991b1b; }
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
</style>
</head>
<body>
<header>
  <h1>ML Paper Portal 管理画面</h1>
  <nav>
    ${siteUrl ? `<button onclick="window.open('${siteUrl}','_blank')">公開サイトを見る</button>` : ''}
    <button id="btn-fetch" onclick="triggerFetch()">取得実行</button>
    <button id="btn-summarize" onclick="triggerSummarize()">要約実行</button>
  </nav>
</header>
<div class="container">
  <div class="toolbar">
    <label>ステータス:</label>
    <select id="status-select" onchange="loadPapers()">
      <option value="review_pending">レビュー待ち</option>
      <option value="fetched">取得済み</option>
      <option value="summarized">要約済み</option>
      <option value="published">公開済み</option>
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
        <button class="btn btn-danger" onclick="reject('\${paper.id}')">差し戻し</button>
      \` : ''}
      \${status === 'published' ? '<span style="color:#16a34a;font-size:14px;">✓ 公開済み</span>' : ''}
      \${status === 'error' ? \`<div class="msg msg-err">\${escHtml(p.error_message || 'エラー')}</div>\` : ''}
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

async function reject(id) {
  try {
    await api('/api/admin/papers/' + id + '/reject', 'POST');
    showMsg('差し戻しました', true);
    await loadPapers();
  } catch(e) { showMsg('エラー: ' + e.message, false); }
}

async function triggerFetch() {
  const btn = document.getElementById('btn-fetch');
  btn.disabled = true; btn.textContent = '取得中...';
  try {
    const res = await api('/api/trigger/fetch', 'POST');
    showMsg(\`取得完了: \${res.fetched}件中 \${res.newCount}件が新規\`, true);
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
</script>
</body>
</html>`;
}
