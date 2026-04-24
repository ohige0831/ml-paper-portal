#!/usr/bin/env node
/**
 * fetch_openalex.js — 3層スリム版 + ML候補フィルタ
 *
 * [Step 1: 2026-04-23〜] 8層50件/3回→3層20件/1回 に縮小
 * [Step 2: 2026-04-25〜] DB投入前 ML関連度スコアリング + 候補フィルタ追加
 *
 * 層配分 (計 20 件/回):
 *   new-hot   (last 90 days,  ≥10 citations):  8
 *   mid-solid (91d〜730d,     20-100 citations): 7
 *   classic   (731d+,         ≥100 citations):  5
 *
 * ML候補フィルタ:
 *   title/abstract/topics/concepts/keywords に ML キーワードが含まれるかを
 *   ルールベースでスコアリングし、FILTER_THRESHOLD 未満をingest前に除外する。
 *   除外された論文はコンソールにスコア・理由を出力して追跡可能にする。
 *   --dry-run または DRY_RUN=1 でスコア分布のみ確認してingestしない。
 *
 * Required env vars:
 *   WORKER_URL       e.g. https://ml-paper-portal-worker.*.workers.dev
 *   INGEST_TOKEN     Bearer token (matches wrangler secret INGEST_TOKEN)
 *   OPENALEX_MAILTO  e.g. kagerou5100@gmail.com
 */

const WORKER_URL    = process.env.WORKER_URL;
const INGEST_TOKEN  = process.env.INGEST_TOKEN;
const MAILTO        = process.env.OPENALEX_MAILTO ?? 'kagerou5100@gmail.com';
const DRY_RUN       = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';

if (!DRY_RUN && (!WORKER_URL || !INGEST_TOKEN)) {
  console.error('ERROR: WORKER_URL and INGEST_TOKEN must be set (or use --dry-run)');
  process.exit(1);
}

const OPENALEX_BASE = 'https://api.openalex.org';
const SUBFIELD_FILTER = 'primary_topic.subfield.id:1702';
const SELECT_FIELDS = [
  'id', 'doi', 'title', 'authorships', 'publication_date',
  'cited_by_count', 'open_access', 'primary_location', 'best_oa_location',
  'primary_topic', 'topics', 'concepts', 'keywords', 'abstract_inverted_index',
].join(',');

// ─────────────────────────────────────────────────────────────────────────────
// ML Relevance Scoring — constants (edit to tune)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * スコアがこの値未満の論文をingestから除外する。
 * 低いほど寛容（誤除外が減る）。高いほど厳格（ノイズが減る）。
 * 初期値 10 = strong keyword が topic に1個あれば通過。
 * （OpenAlex subfield=1702 フィルタが大半を絞っているため、ここは寛容に）
 * 除外が多すぎる場合は下げる、ノイズが多い場合は 15〜20 に上げる。
 */
const FILTER_THRESHOLD = 10;

// 各フィールドでの加点（strong = 明確にML固有の語、broad = ML隣接語）
const POINTS_STRONG = { title: 25, abstract: 15, topic: 10, keyword: 8 };
const POINTS_BROAD  = { title: 10, abstract:  5, topic:  5, keyword: 3 };

// OpenAlex concepts フィールドでの加点（1件 +5、上限 +15）
const POINTS_CONCEPT     = 5;
const POINTS_CONCEPT_CAP = 15;

// 被引用数による加点
const POINTS_CITE_HIGH = 5;  // cited_by_count >= 100
const POINTS_CITE_MID  = 2;  // cited_by_count >= 20

// abstract が短い・欠損している場合は減点しない。
// ログに記録して判定参考にするが、スコアへの影響はなし。
// （OpenAlex で abstract が取れない論文でも ML 論文であることは多い）

/**
 * Strong ML キーワード: このリストにヒットすると title +25 / abstract +15 / topic +10 / keyword +8。
 * タイトルに1つあれば単独で FILTER_THRESHOLD=15 を超えて通過する。
 */
const STRONG_ML_KEYWORDS = [
  'machine learning',
  'deep learning',
  'neural network',
  'neural networks',
  'large language model',
  'large language models',
  'llm',
  'llms',
  'transformer',
  'transformers',
  'bert',
  'gpt',
  'cnn',
  'convolutional neural',
  'gnn',
  'graph neural',
  'reinforcement learning',
  'computer vision',
  'natural language processing',
  'nlp',
  'representation learning',
  'generative model',
  'generative adversarial',
  'diffusion model',
  'retrieval augmented generation',
  'rag',
  'attention mechanism',
  'self-supervised',
  'contrastive learning',
  'foundation model',
  'language model',
  'vision-language',
  'multimodal',
  'few-shot',
  'zero-shot',
  'transfer learning',
];

/**
 * Broad ML キーワード: このリストにヒットすると title +10 / abstract +5 / topic +5 / keyword +3。
 * 複数シグナルの組み合わせで FILTER_THRESHOLD を超える補助的な語。
 */
const BROAD_ML_KEYWORDS = [
  'artificial intelligence',
  'deep neural',
  'pre-trained',
  'pretrained',
  'fine-tuning',
  'finetuning',
  'federated learning',
  'image classification',
  'object detection',
  'image segmentation',
  'speech recognition',
  'text generation',
  'image generation',
  'question answering',
  'machine translation',
  'semantic segmentation',
  'knowledge graph',
  'recommendation system',
  'anomaly detection',
  'autonomous driving',
  'text classification',
  'named entity',
  'sentiment analysis',
  'information retrieval',
  'data mining',
  'robotics',
  'image recognition',
  'visual question',
  'video understanding',
  'super resolution',
  'pose estimation',
  'point cloud',
  'optical flow',
];

/**
 * OpenAlex concepts フィールドで加点の対象となるコンセプト名。
 * concepts はTopics移行で非推奨化されているが古い論文では有効。
 */
const ML_CONCEPT_NAMES = [
  'computer science',
  'artificial intelligence',
  'machine learning',
  'deep learning',
  'natural language processing',
  'computer vision',
  'pattern recognition',
  'data mining',
];

// ─────────────────────────────────────────────────────────────────────────────
// Date helpers
// ─────────────────────────────────────────────────────────────────────────────

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer definitions
// ─────────────────────────────────────────────────────────────────────────────

function buildLayers() {
  const d90  = daysAgo(90);
  const d91  = daysAgo(91);
  const d730 = daysAgo(730);
  const d731 = daysAgo(731);

  return [
    { label: 'new-hot',   from: d90,  to: null, citMin: 10,  citMax: null, n: 8 },
    { label: 'mid-solid', from: d730, to: d91,  citMin: 20,  citMax: 100,  n: 7 },
    { label: 'classic',   from: null, to: d731, citMin: 100, citMax: null, n: 5 },
  ];
}

function buildFilter(layer) {
  const parts = [SUBFIELD_FILTER, 'is_oa:true'];
  if (layer.from) parts.push(`from_publication_date:${layer.from}`);
  if (layer.to)   parts.push(`to_publication_date:${layer.to}`);
  if (layer.citMin != null) parts.push(`cited_by_count:>${layer.citMin - 1}`);
  if (layer.citMax != null) parts.push(`cited_by_count:<${layer.citMax + 1}`);
  return parts.join(',');
}

// ─────────────────────────────────────────────────────────────────────────────
// ML Relevance Scoring
// ─────────────────────────────────────────────────────────────────────────────

function reconstructAbstractText(invIdx) {
  if (!invIdx || typeof invIdx !== 'object') return '';
  const words = {};
  for (const [word, positions] of Object.entries(invIdx)) {
    for (const pos of positions) words[pos] = word;
  }
  const keys = Object.keys(words).map(Number);
  if (keys.length === 0) return '';
  const maxPos = Math.max(...keys);
  return Array.from({ length: maxPos + 1 }, (_, i) => words[i] ?? '').join(' ').trim();
}

/**
 * OpenAlexWork に対して ML 関連度スコアを算出する。
 * @returns {{ score: number, reasons: string[] }}
 */
function scoreMlRelevance(work) {
  let score = 0;
  const reasons = [];

  const title       = (work.title ?? '').toLowerCase();
  const abstract    = reconstructAbstractText(work.abstract_inverted_index).toLowerCase();
  const topicText   = [
    work.primary_topic?.display_name ?? '',
    ...(work.topics ?? []).map((t) => t.display_name ?? ''),
  ].join(' ').toLowerCase();
  const conceptText = (work.concepts ?? []).map((c) => c.display_name ?? '').join(' ').toLowerCase();
  const keywordText = (work.keywords ?? []).map((k) => k.display_name ?? k.keyword ?? '').join(' ').toLowerCase();

  // title / abstract / topic / keyword — strong keywords (first hit per field)
  const tStrong = STRONG_ML_KEYWORDS.find((kw) => title.includes(kw));
  if (tStrong)   { score += POINTS_STRONG.title;    reasons.push(`+${POINTS_STRONG.title} title:"${tStrong}"`); }
  else {
    const tBroad = BROAD_ML_KEYWORDS.find((kw) => title.includes(kw));
    if (tBroad)  { score += POINTS_BROAD.title;     reasons.push(`+${POINTS_BROAD.title} title:"${tBroad}"`); }
  }

  const aStrong = STRONG_ML_KEYWORDS.find((kw) => abstract.includes(kw));
  if (aStrong)   { score += POINTS_STRONG.abstract; reasons.push(`+${POINTS_STRONG.abstract} abstract:"${aStrong}"`); }
  else {
    const aBroad = BROAD_ML_KEYWORDS.find((kw) => abstract.includes(kw));
    if (aBroad)  { score += POINTS_BROAD.abstract;  reasons.push(`+${POINTS_BROAD.abstract} abstract:"${aBroad}"`); }
  }

  const topicStrong = STRONG_ML_KEYWORDS.find((kw) => topicText.includes(kw));
  if (topicStrong)  { score += POINTS_STRONG.topic; reasons.push(`+${POINTS_STRONG.topic} topic:"${topicStrong}"`); }
  else {
    const topicBroad = BROAD_ML_KEYWORDS.find((kw) => topicText.includes(kw));
    if (topicBroad)  { score += POINTS_BROAD.topic; reasons.push(`+${POINTS_BROAD.topic} topic:"${topicBroad}"`); }
  }

  const kwStrong = STRONG_ML_KEYWORDS.find((kw) => keywordText.includes(kw));
  if (kwStrong)  { score += POINTS_STRONG.keyword;  reasons.push(`+${POINTS_STRONG.keyword} keyword:"${kwStrong}"`); }
  else {
    const kwBroad = BROAD_ML_KEYWORDS.find((kw) => keywordText.includes(kw));
    if (kwBroad) { score += POINTS_BROAD.keyword;   reasons.push(`+${POINTS_BROAD.keyword} keyword:"${kwBroad}"`); }
  }

  // concepts フィールド（上限 POINTS_CONCEPT_CAP）
  let conceptPtsTotal = 0;
  for (const kw of ML_CONCEPT_NAMES) {
    if (conceptPtsTotal >= POINTS_CONCEPT_CAP) break;
    if (conceptText.includes(kw)) {
      const pts = Math.min(POINTS_CONCEPT, POINTS_CONCEPT_CAP - conceptPtsTotal);
      conceptPtsTotal += pts;
      score += pts;
      reasons.push(`+${pts} concept:"${kw}"`);
    }
  }

  // 被引用数ボーナス
  if (work.cited_by_count >= 100)      { score += POINTS_CITE_HIGH; reasons.push(`+${POINTS_CITE_HIGH} citations>=${100}`); }
  else if (work.cited_by_count >= 20)  { score += POINTS_CITE_MID;  reasons.push(`+${POINTS_CITE_MID} citations>=${20}`); }

  // abstract が短い / 欠損している場合はスコアへの影響なし（ログに記録のみ）
  if (abstract.length < 50) {
    reasons.push(`(note: abstract short/missing — ${abstract.length} chars, no penalty)`);
  }

  return { score, reasons };
}

/**
 * 候補 works をスコアリングし、通過・除外に分類する。
 * dry-run 時は全件ログを出力してフィルタしない（全件通過扱い）。
 * @returns {{ toIngest: any[], filtered: any[], scores: Map<string, {score, reasons}> }}
 */
function filterCandidates(works) {
  const toIngest = [];
  const filtered = [];
  const scores   = new Map();

  for (const work of works) {
    const { score, reasons } = scoreMlRelevance(work);
    const pass = score >= FILTER_THRESHOLD;
    scores.set(work.id, { score, reasons });

    if (DRY_RUN) {
      // dry-run: 全件ログ表示、ingest には回さない（後で別途判断）
      const label = pass ? 'PASS' : 'FAIL';
      const snippet = (work.title ?? '').slice(0, 70);
      console.log(`  [score] ${label} score=${score} "${snippet}"`);
      if (!pass) {
        for (const r of reasons) console.log(`    ${r}`);
        if (reasons.length === 0) console.log('    (no ML signals found)');
      }
    } else if (pass) {
      toIngest.push(work);
    } else {
      filtered.push({ id: work.id, title: work.title, score, reasons });
    }
  }

  return { toIngest, filtered, scores };
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAlex fetch
// ─────────────────────────────────────────────────────────────────────────────

async function fetchLayer(layer) {
  const params = new URLSearchParams({
    filter: buildFilter(layer),
    sample: String(layer.n),
    select: SELECT_FIELDS,
    mailto: MAILTO,
  });
  const url = `${OPENALEX_BASE}/works?${params.toString()}`;
  console.log(`  [${layer.label}] n=${layer.n}`);

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const wait = 3000 * attempt;
      console.log(`  [${layer.label}] 429, retry in ${wait}ms...`);
      await new Promise((r) => setTimeout(r, wait));
    }
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const results = data.results ?? [];
      console.log(`  [${layer.label}] → ${results.length} works`);
      return results;
    }
    if (res.status === 429 && attempt < 2) continue;
    console.warn(`  [${layer.label}] fetch failed: ${res.status} — skipping`);
    return [];
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingest
// ─────────────────────────────────────────────────────────────────────────────

async function ingest(works) {
  const res = await fetch(`${WORKER_URL}/api/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify({ works }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ingest failed: ${res.status} ${body}`);
  }
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  if (DRY_RUN) {
    console.log('[fetch_openalex] mode=DRY-RUN (scoring only, no ingest)');
    console.log(`[fetch_openalex] FILTER_THRESHOLD=${FILTER_THRESHOLD}`);
  } else {
    console.log('[fetch_openalex] mode=auto (stratified sampling + ML filter)');
    console.log(`[fetch_openalex] FILTER_THRESHOLD=${FILTER_THRESHOLD}`);
  }

  const layers = buildLayers();
  console.log(`[fetch_openalex] ${layers.length} layers, target 20 papers`);

  // ── Fetch all layers ──────────────────────────────────────────────────────

  const layerCounts = {};
  const allWorks    = [];
  const seen        = new Set();

  for (const layer of layers) {
    if (allWorks.length > 0) {
      await new Promise((r) => setTimeout(r, 300));
    }
    const works = await fetchLayer(layer);
    let added = 0;
    for (const work of works) {
      if (!seen.has(work.id)) {
        seen.add(work.id);
        allWorks.push(work);
        added++;
      }
    }
    layerCounts[layer.label] = added;
  }

  console.log('[fetch_openalex] Layer results:');
  let total = 0;
  for (const [label, count] of Object.entries(layerCounts)) {
    console.log(`  ${label}: ${count}`);
    total += count;
  }
  console.log(`[fetch_openalex] Total unique: ${total}`);

  if (allWorks.length === 0) {
    console.log('[fetch_openalex] No works to process.');
    return;
  }

  // ── ML Relevance Filter ───────────────────────────────────────────────────

  console.log('[fetch_openalex] Scoring ML relevance...');
  const { toIngest, filtered } = filterCandidates(allWorks);

  if (DRY_RUN) {
    // Score summary for dry-run
    const allScores = allWorks.map((w) => scoreMlRelevance(w).score);
    const passCount = allScores.filter((s) => s >= FILTER_THRESHOLD).length;
    const failCount = allScores.length - passCount;
    const avg = allScores.length > 0
      ? (allScores.reduce((a, b) => a + b, 0) / allScores.length).toFixed(1)
      : 0;
    console.log(`[fetch_openalex] DRY-RUN score summary:`);
    console.log(`  total=${allScores.length}  pass=${passCount}  fail=${failCount}`);
    console.log(`  avg=${avg}  min=${Math.min(...allScores)}  max=${Math.max(...allScores)}`);
    console.log(`  threshold=${FILTER_THRESHOLD} (no ingest performed)`);
    return;
  }

  if (filtered.length > 0) {
    console.log(`[fetch_openalex] Filtered ${filtered.length}/${allWorks.length} works (score < ${FILTER_THRESHOLD}):`);
    for (const f of filtered) {
      const snippet = (f.title ?? '').slice(0, 70);
      console.log(`  SKIP score=${f.score} "${snippet}"`);
      for (const r of f.reasons) console.log(`    ${r}`);
      if (f.reasons.length === 0) console.log('    (no ML signals found)');
    }
  } else {
    console.log(`[fetch_openalex] All ${allWorks.length} works passed ML filter.`);
  }

  console.log(`[fetch_openalex] Sending ${toIngest.length} works to Worker...`);

  if (toIngest.length === 0) {
    console.log('[fetch_openalex] Nothing to ingest after filtering.');
    return;
  }

  const result = await ingest(toIngest);
  console.log(
    `[fetch_openalex] Done: ` +
    `inserted=${result.inserted} skipped=${result.skipped} ` +
    `quarantined=${result.quarantined ?? 0} rejected=${result.rejected ?? 0}`,
  );
}

main().catch((err) => {
  console.error('[fetch_openalex] Fatal error:', err);
  process.exit(1);
});
