#!/usr/bin/env node
/**
 * fetch_openalex.js — 3層スリム版 + ML候補フィルタ
 *
 * [Step 1: 2026-04-23〜] 8層50件/3回→3層20件/1回 に縮小
 * [Step 2: 2026-04-25〜] DB投入前 ML関連度スコアリング + 候補フィルタ追加
 * [Step 3: 2026-04-29〜] fetchOpenAlexラッパー + リクエスト上限 + 429即終了 + stats出力
 * [Step 4: 2026-05-01〜] OPENALEX_API_KEY サポート・レイヤー間 sleep 延長・5xx リトライ追加
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
 *   WORKER_URL         e.g. https://ml-paper-portal-worker.*.workers.dev
 *   INGEST_TOKEN       Bearer token (matches wrangler secret INGEST_TOKEN)
 * Optional:
 *   OPENALEX_API_KEY   OpenAlex API key — preferred over mailto when set
 *   OPENALEX_MAILTO    fallback polite-pool identifier (default: kagerou5100@gmail.com)
 *   OPENALEX_SLEEP_MS  sleep between layer requests in ms (default: 7000)
 */

const WORKER_URL       = process.env.WORKER_URL;
const INGEST_TOKEN     = process.env.INGEST_TOKEN;
const OPENALEX_API_KEY = process.env.OPENALEX_API_KEY ?? null;
const MAILTO           = process.env.OPENALEX_MAILTO ?? 'kagerou5100@gmail.com';
const OPENALEX_SLEEP_MS = Number(process.env.OPENALEX_SLEEP_MS ?? '7000');
const DRY_RUN          = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
const mlScoring = require('./lib/ml_scoring');

/**
 * API key が設定されていれば { api_key } を、なければ { mailto } を返す。
 * URLSearchParams の spread に使う。
 */
function buildAuthParam() {
  return OPENALEX_API_KEY ? { api_key: OPENALEX_API_KEY } : { mailto: MAILTO };
}

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
 * 環境変数 FILTER_THRESHOLD で上書き可能: FILTER_THRESHOLD=25 node scripts/fetch_openalex.js
 * デフォルト 20 = strong keyword が title にあれば単独で通過、topic のみでは不足。
 * 除外が多すぎる場合は下げる、ノイズが多い場合は 25〜30 に上げる。
 */
const FILTER_THRESHOLD = Number(process.env.FILTER_THRESHOLD ?? '20');

// 各フィールドでの加点（strong = 明確にML固有の語、broad = ML隣接語）
const POINTS_STRONG = { title: 25, abstract: 20, topic: 10, keyword: 8 };
const POINTS_BROAD  = { title: 10, abstract:  5, topic:  5, keyword: 3 };

// abstract が欠損・極端に短い場合のペナルティ（OpenAlex で abstract が取れない ML 論文はあるが、
// concept/topic だけで通過する非 ML 論文を弾く補助として使用する）
const PENALTY_ABSTRACT_MISSING = -5;  // abstract が完全に欠損（0 chars）
const PENALTY_ABSTRACT_SHORT   = -3;  // abstract が極端に短い（< ABSTRACT_SHORT_LEN chars）
const ABSTRACT_SHORT_LEN       = 50;

// OpenAlex concepts フィールドでの加点（1件 +5、上限 +15）
const POINTS_CONCEPT     = 5;
const POINTS_CONCEPT_CAP = 15;

// 被引用数による加点
const POINTS_CITE_HIGH = 5;  // cited_by_count >= 100
const POINTS_CITE_MID  = 2;  // cited_by_count >= 20

/**
 * Strong ML キーワード: このリストにヒットすると title +25 / abstract +15 / topic +10 / keyword +8。
 * タイトルに1つあれば abstract ペナルティ込みでも FILTER_THRESHOLD=20 を超えて通過する。
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
  'artificial intelligence',
  'machine learning',
  'deep learning',
  'natural language processing',
  'computer vision',
  'pattern recognition',
  'data mining',
];

// ─────────────────────────────────────────────────────────────────────────────
// OpenAlex fetch wrapper — request accounting + rate-limit guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 1回の実行あたり OpenAlex API を叩ける最大回数。
 * 上限に達したらそれ以降のレイヤーは取得せず終了する（TARGET追いかけ禁止）。
 */
const MAX_OPENALEX_REQUESTS_PER_RUN = 5;

/** 実行中のリクエスト回数カウンタ */
let requestCount = 0;

class RateLimitError extends Error {
  constructor() {
    super('OpenAlex returned 429 Rate Limited');
    this.name = 'RateLimitError';
  }
}
class RequestLimitError extends Error {
  constructor() {
    super(`MAX_OPENALEX_REQUESTS_PER_RUN (${MAX_OPENALEX_REQUESTS_PER_RUN}) reached`);
    this.name = 'RequestLimitError';
  }
}

/**
 * OpenAlex API へのすべての fetch はこのラッパーを通す。
 * - リクエスト回数を記録・制限する（リトライは回数に含まない）
 * - 429 を受けたら即 RateLimitError を throw する（リトライしない）
 * - 5xx は指数バックオフで最大2リトライ（計3試行）してから返す
 * - 上限到達なら即 RequestLimitError を throw する
 */
async function fetchOpenAlex(url) {
  if (requestCount >= MAX_OPENALEX_REQUESTS_PER_RUN) {
    throw new RequestLimitError();
  }
  requestCount++;
  console.log(`  [OpenAlex] request #${requestCount}/${MAX_OPENALEX_REQUESTS_PER_RUN}`);

  const MAX_5XX_RETRIES = 2; // 原則1回 + 最大2リトライ = 計3試行
  let lastRes = null;

  for (let attempt = 0; attempt <= MAX_5XX_RETRIES; attempt++) {
    if (attempt > 0) {
      const waitMs = 1000 * (2 ** (attempt - 1)); // 1s → 2s
      console.warn(`  [OpenAlex] ${lastRes.status} retry#${attempt}/${MAX_5XX_RETRIES}  wait=${waitMs / 1000}s`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    lastRes = await fetch(url);
    if (lastRes.status === 429) throw new RateLimitError(); // 429は即停止
    if (lastRes.status < 500) return lastRes;               // 2xx/3xx/4xx → そのまま返す
    // 5xx → 次のリトライへ
  }

  // 全リトライ消耗 — 呼び出し元がステータスを見てスキップする
  console.warn(`  [OpenAlex] ${lastRes.status} after ${MAX_5XX_RETRIES} retries — skipping layer`);
  return lastRes;
}

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

  // abstract 欠損・短すぎる場合はペナルティ
  // （concept/topic だけで通過する非 ML 論文を弾く補助。真に ML の論文は title/topic で十分な点を得る）
  if (abstract.length === 0) {
    score += PENALTY_ABSTRACT_MISSING;
    reasons.push(`${PENALTY_ABSTRACT_MISSING} abstract missing (0 chars)`);
  } else if (abstract.length < ABSTRACT_SHORT_LEN) {
    score += PENALTY_ABSTRACT_SHORT;
    reasons.push(`${PENALTY_ABSTRACT_SHORT} abstract short (${abstract.length} chars)`);
  }

  return { score, reasons };
}

/**
 * タイトルが雑誌名・会議名そのものの論文を検出するプレフィックスリスト。
 * scoring 前に除外する（ML スコアを計算しても意味がないため）。
 */
const JOURNAL_NOISE_PREFIXES = [
  'international journal of',
  'international journal on',
  'journal of',
  'journal on',
  'proceedings of',
  'conference on',
];

function isJournalNoise(title) {
  const t = (title ?? '').toLowerCase().trim();
  return JOURNAL_NOISE_PREFIXES.some((p) => t.startsWith(p));
}

/**
 * 候補 works をスコアリングし、通過・除外に分類する。
 * dry-run 時は全件ログを出力してフィルタしない（全件通過扱い）。
 * @returns {{ toIngest: any[], filtered: any[], scores: Map<string, {score, reasons}>, noiseCount: number }}
 */
function filterCandidates(works) {
  const toIngest   = [];
  const filtered   = [];
  const scores     = new Map();
  let   noiseCount = 0;

  for (const work of works) {
    // ── 雑誌名・会議名そのものの title を scoring 前に除外
    if (isJournalNoise(work.title)) {
      noiseCount++;
      const snippet = (work.title ?? '').slice(0, 70);
      if (DRY_RUN) {
        console.log(`  [noise ] SKIP journal-noise "${snippet}"`);
      } else {
        filtered.push({ id: work.id, title: work.title, score: null, reasons: ['journal-noise title'] });
      }
      continue;
    }

    const { score, reasons } = scoreMlRelevance(work);
    const pass = score >= FILTER_THRESHOLD;
    scores.set(work.id, { score, reasons });

    if (DRY_RUN) {
      const label = pass ? 'PASS ' : 'FAIL ';
      const snippet = (work.title ?? '').slice(0, 70);
      console.log(`  [score] ${label} score=${String(score).padStart(3)} "${snippet}"`);
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

  return { toIngest, filtered, scores, noiseCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer fetch (fetchOpenAlex ラッパー経由)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 1レイヤー分の works を取得して返す。
 * 429 / 上限到達は呼び出し元 (main) に伝播させる — ここではリトライしない。
 */
async function fetchLayer(layer) {
  const params = new URLSearchParams({
    filter: buildFilter(layer),
    sample: String(layer.n),
    select: SELECT_FIELDS,
    ...buildAuthParam(),
  });
  const url = `${OPENALEX_BASE}/works?${params.toString()}`;
  console.log(`  [${layer.label}] n=${layer.n}`);

  const res = await fetchOpenAlex(url); // RateLimitError / RequestLimitError は上位へ
  if (res.ok) {
    const data = await res.json();
    const results = data.results ?? [];
    console.log(`  [${layer.label}] → ${results.length} works`);
    return results;
  }
  console.warn(`  [${layer.label}] fetch failed: ${res.status} — skipping`);
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
  const mode     = DRY_RUN ? 'DRY-RUN (scoring only, no ingest)' : 'auto (stratified sampling + ML filter)';
  const authMode = OPENALEX_API_KEY ? 'api_key' : 'mailto';
  console.log(`[fetch_openalex] mode=${mode}`);
  console.log(
    `[fetch_openalex]` +
    `  auth=${authMode}` +
    `  sleep=${OPENALEX_SLEEP_MS}ms` +
    `  FILTER_THRESHOLD=${FILTER_THRESHOLD}` +
    `  MAX_REQUESTS=${MAX_OPENALEX_REQUESTS_PER_RUN}`,
  );

  const layers = buildLayers();
  console.log(`[fetch_openalex] ${layers.length} layers`);

  // ── Fetch all layers ──────────────────────────────────────────────────────

  const layerCounts  = {};
  const allWorks     = [];
  const seen         = new Set();
  let   fetchStopped = null; // 'rate_limit' | 'request_limit' | null

  for (const layer of layers) {
    if (allWorks.length > 0) {
      console.log(`  [sleep] ${OPENALEX_SLEEP_MS}ms before next layer`);
      await new Promise((r) => setTimeout(r, OPENALEX_SLEEP_MS));
    }
    let works;
    try {
      works = await fetchLayer(layer);
    } catch (err) {
      if (err instanceof RateLimitError) {
        console.error(`[fetch_openalex] 429 Rate Limited — stopping fetch immediately`);
        fetchStopped = 'rate_limit';
        break;
      }
      if (err instanceof RequestLimitError) {
        console.log(`[fetch_openalex] Request limit reached (${requestCount}/${MAX_OPENALEX_REQUESTS_PER_RUN}) — stopping fetch`);
        fetchStopped = 'request_limit';
        break;
      }
      throw err;
    }
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

  // ── Layer summary ─────────────────────────────────────────────────────────

  console.log('[fetch_openalex] Layer results:');
  let rawFetched = 0;
  for (const [label, count] of Object.entries(layerCounts)) {
    console.log(`  ${label}: ${count}`);
    rawFetched += count;
  }
  console.log(`[fetch_openalex] raw_fetched=${rawFetched}  requests=${requestCount}/${MAX_OPENALEX_REQUESTS_PER_RUN}`);

  if (fetchStopped === 'rate_limit') {
    logStats({ rawFetched, mlRejected: 0, inserted: 0, skippedExisting: 0, workerRejected: 0 });
    process.exit(2);
  }

  if (allWorks.length === 0) {
    console.log('[fetch_openalex] No works to process.');
    logStats({ rawFetched, mlRejected: 0, inserted: 0, skippedExisting: 0, workerRejected: 0 });
    return;
  }

  // ── ML Relevance Filter ───────────────────────────────────────────────────

  console.log('[fetch_openalex] Scoring ML relevance...');
  const { toIngest, filtered, noiseCount } = mlScoring.filterCandidates(allWorks, {
    dryRun: DRY_RUN,
    threshold: FILTER_THRESHOLD,
  });
  const mlRejected = filtered.length;

  if (DRY_RUN) {
    // noise 論文を除いたもののみスコア計算（noise はすでに [noise] ログ済み）
    const scoredWorks = allWorks.filter((w) => !mlScoring.isJournalNoise(w.title));
    const allScores   = scoredWorks.map((w) => mlScoring.scoreMlRelevance(w).score);
    const passCount   = allScores.filter((s) => s >= FILTER_THRESHOLD).length;
    const failCount   = allScores.length - passCount;
    const avg = allScores.length > 0
      ? (allScores.reduce((a, b) => a + b, 0) / allScores.length).toFixed(1)
      : 'n/a';
    const minScore = allScores.length ? Math.min(...allScores) : 'n/a';
    const maxScore = allScores.length ? Math.max(...allScores) : 'n/a';
    // スコア分布バケツ（閾値を変えて比較するときに便利）
    const buckets = [
      { label: ' <0',   lo: -Infinity, hi: 0  },
      { label: '0-9',   lo: 0,         hi: 10 },
      { label: '10-19', lo: 10,        hi: 20 },
      { label: '20-29', lo: 20,        hi: 30 },
      { label: '30-39', lo: 30,        hi: 40 },
      { label: '40+',   lo: 40,        hi: Infinity },
    ];
    const distStr = buckets
      .map((b) => `${b.label}:${allScores.filter((s) => s >= b.lo && s < b.hi).length}`)
      .join('  ');
    console.log(`[fetch_openalex] DRY-RUN score summary (threshold=${FILTER_THRESHOLD}):`);
    console.log(`  noise=${noiseCount}  scored=${allScores.length}  pass=${passCount}  fail=${failCount}`);
    console.log(`  avg=${avg}  min=${minScore}  max=${maxScore}`);
    console.log(`  dist: ${distStr}`);
    logStats({ rawFetched, mlRejected: failCount, inserted: 0, skippedExisting: 0, workerRejected: 0, dryRun: true });
    return;
  }

  if (filtered.length > 0) {
    console.log(`[fetch_openalex] ML filter: ${filtered.length}/${allWorks.length} rejected (noise=${noiseCount} score<${FILTER_THRESHOLD}=${filtered.length - noiseCount}):`);
    for (const f of filtered) {
      const snippet  = (f.title ?? '').slice(0, 70);
      const scoreStr = f.score == null ? 'noise' : `score=${f.score}`;
      console.log(`  SKIP ${scoreStr} "${snippet}"`);
      for (const r of f.reasons) console.log(`    ${r}`);
      if (f.reasons.length === 0) console.log('    (no ML signals found)');
    }
  } else {
    console.log(`[fetch_openalex] All ${allWorks.length} works passed ML filter.`);
  }

  if (toIngest.length === 0) {
    console.log('[fetch_openalex] Nothing to ingest after filtering.');
    logStats({ rawFetched, mlRejected, inserted: 0, skippedExisting: 0, workerRejected: 0 });
    return;
  }

  // ── Ingest ────────────────────────────────────────────────────────────────

  console.log(`[fetch_openalex] Sending ${toIngest.length} works to Worker...`);
  const result = await ingest(toIngest);

  logStats({
    rawFetched,
    mlRejected,
    inserted:        result.inserted       ?? 0,
    skippedExisting: result.skipped        ?? 0,
    workerRejected:  result.rejected       ?? 0,
    quarantined:     result.quarantined    ?? 0,
  });
}

/**
 * 最終 stats を構造化してログ出力する。
 * dry-run 時は inserted / skipped_existing / rejected は計測不能なので "(dry-run)" と表示。
 */
function logStats({ rawFetched, mlRejected, inserted, skippedExisting, workerRejected, quarantined = 0, dryRun = false }) {
  const ins   = dryRun ? '(dry-run)' : String(inserted);
  const skip  = dryRun ? '(dry-run)' : String(skippedExisting);
  const wrej  = dryRun ? '(dry-run)' : String(workerRejected);
  const quar  = dryRun ? '' : `  quarantined=${quarantined}`;
  console.log(
    `[fetch_openalex] ── stats ──────────────────────────────────────────\n` +
    `  raw_fetched=${rawFetched}  ml_rejected=${mlRejected}\n` +
    `  inserted=${ins}  skipped_existing=${skip}  rejected=${wrej}${quar}\n` +
    `  requests=${requestCount}/${MAX_OPENALEX_REQUESTS_PER_RUN}` +
    `  threshold=${FILTER_THRESHOLD}`,
  );
}

main().catch((err) => {
  console.error('[fetch_openalex] Fatal error:', err);
  process.exit(1);
});
