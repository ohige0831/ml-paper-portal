#!/usr/bin/env node
/**
 * audit_papers.js  v2
 *
 * 判定レベル:
 *   hard_reject   → withdraw_candidates.json + bulk_withdraw.sql
 *   quarantine    → quarantine_candidates.json + bulk_quarantine.sql
 *   manual_review → warnings_only.json  （SQL なし、目視用）
 *   safe          → 何も出力しない
 *
 * hard_reject の条件（明確なデータ破損 or 明確な分野外）:
 *   - publication_date が未来
 *   - publication_date が欠損
 *   - title が欠損 or 5文字未満
 *   - doi が存在するが形式が破綻（10.xxxx / https://doi.org/10. でない）
 *
 * quarantine の条件（トピック情報はあるが ML 非関連）:
 *   - primary_topic / topics が存在するが ML キーワードに一切ヒットしない
 *   ※ primary_topic も topics も空の場合は情報不足として manual_review 扱い
 *
 * manual_review の条件（警告のみ、即座のアクション不要）:
 *   - authors が空配列 / JSON 破損
 *   - primary_topic が null
 *   - topics が空配列
 *   - primary_topic も topics も存在しない（情報不足）
 *
 * Usage:
 *   node scripts/audit_papers.js < dump.json
 *
 * dump.json の取り方:
 *   wrangler d1 execute ml-paper-portal-db --remote \
 *     --command "SELECT p.id, p.title, p.published_date, p.primary_topic, \
 *                       p.topics, p.doi, p.authors, ps.status \
 *                FROM papers p JOIN publish_states ps ON ps.paper_id = p.id \
 *                WHERE ps.status IN ('published','review_pending','summarized','fetched')" \
 *     --json > dump.json
 */

'use strict';

const fs = require('fs');

// ML 関連性キーワード（validate.ts と同一リストを維持する）
const ML_KEYWORDS = [
  'machine learning', 'deep learning', 'neural network', 'artificial intelligence',
  'natural language processing', 'computer vision', 'reinforcement learning',
  'generative model', 'generative adversarial', 'diffusion model', 'transformer',
  'language model', 'large language', 'llm', 'nlp', 'image recognition',
  'image classification', 'image segmentation', 'object detection', 'speech recognition',
  'text classification', 'named entity', 'sentiment analysis', 'knowledge graph',
  'graph neural', 'attention mechanism', 'few-shot', 'zero-shot', 'transfer learning',
  'federated learning', 'representation learning', 'self-supervised', 'contrastive learning',
  'multimodal', 'foundation model', 'pre-trained', 'fine-tuning', 'question answering',
  'machine translation', 'text generation', 'image generation', 'autonomous driving',
  'robotics', 'data mining', 'recommendation system', 'information retrieval',
  'anomaly detection', 'semantic segmentation', 'point cloud', 'visual question',
  'video understanding', 'optical flow', 'super resolution', 'pose estimation',
];

// ---- ヘルパー ---------------------------------------------------------------

/**
 * authors 列（JSON 文字列）を安全にパースする。
 * 返り値: { ok: true, authors: [...] } | { ok: false, reason: string }
 */
function parseAuthors(authorsStr) {
  if (authorsStr === null || authorsStr === undefined) {
    return { ok: false, reason: 'authors is null' };
  }
  let parsed;
  try {
    parsed = JSON.parse(authorsStr);
  } catch (e) {
    return { ok: false, reason: `authors JSON broken: ${e.message}` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'authors is not an array' };
  }
  if (parsed.length === 0) {
    return { ok: false, reason: 'authors is empty array' };
  }
  return { ok: true, authors: parsed };
}

/**
 * topics 列（JSON 文字列）を安全にパースして文字列配列を返す。
 * 失敗時は空配列を返す（topics 破損は hard_reject 要因にしない）。
 */
function parseTopics(topicsStr) {
  try {
    const parsed = JSON.parse(topicsStr || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * ML 関連性を返す。
 * null  → トピック情報が存在しないため判定不能（情報不足）
 * true  → ML キーワードがヒット
 * false → トピック情報はあるが ML キーワードなし
 */
function mlRelevance(primary_topic, topics) {
  const hasPrimary = typeof primary_topic === 'string' && primary_topic.trim().length > 0;
  const hasTopics  = topics.length > 0;

  if (!hasPrimary && !hasTopics) return null; // 情報不足

  const text = [primary_topic || '', ...topics].join(' ').toLowerCase();
  return ML_KEYWORDS.some(kw => text.includes(kw));
}

/**
 * DOI が存在する場合の形式チェック。
 * null / undefined / 空文字は「なし」として false を返す（エラーなし）。
 */
function isMalformedDoi(doi) {
  if (!doi || doi.trim().length === 0) return false;
  const d = doi.trim();
  // 許容: "https://doi.org/10.xxxx" または "10.xxxx/..."
  if (d.startsWith('https://doi.org/10.')) return false;
  if (/^10\.\d{4,}\//.test(d)) return false;
  return true;
}

// ---- 本体 ------------------------------------------------------------------

function audit(rows) {
  const today = new Date().toISOString().split('T')[0];

  const withdraw_candidates  = [];
  const quarantine_candidates = [];
  const warnings_only        = [];
  let   safe_count           = 0;

  for (const row of rows) {
    const hardReasons   = [];
    const warnReasons   = [];

    // ── hard_reject チェック ─────────────────────────────────────
    if (!row.title || row.title.trim().length < 5) {
      hardReasons.push('title missing or too short');
    }
    if (!row.published_date) {
      hardReasons.push('publication_date missing');
    } else if (row.published_date > today) {
      hardReasons.push(`future publication_date: ${row.published_date}`);
    }
    if (isMalformedDoi(row.doi)) {
      hardReasons.push(`malformed DOI: ${row.doi}`);
    }

    // ── authors チェック（警告のみ）──────────────────────────────
    const authorsResult = parseAuthors(row.authors);
    if (!authorsResult.ok) {
      warnReasons.push(authorsResult.reason);
    }

    // ── ML 関連性チェック ────────────────────────────────────────
    const topics    = parseTopics(row.topics);
    const mlResult  = mlRelevance(row.primary_topic, topics);

    let isQuarantine = false;
    if (mlResult === null) {
      // トピック情報なし → 情報不足として警告
      warnReasons.push('no topic data (primary_topic and topics both empty)');
    } else if (mlResult === false) {
      // トピックはあるが ML キーワード非ヒット → quarantine 候補
      const topicDisplay = [
        row.primary_topic || '',
        ...topics.slice(0, 3),
      ].filter(Boolean).join(' / ') || '(none)';
      isQuarantine = true;
      // quarantine 判定は hard_reject がなければ適用する
    }

    // primary_topic や topics が個別に欠損している場合も警告
    if (!row.primary_topic) {
      warnReasons.push('primary_topic missing');
    }
    if (topics.length === 0 && row.topics && row.topics !== '[]') {
      warnReasons.push('topics JSON broken or empty');
    } else if (topics.length === 0) {
      // topics が '[]' なのは正常ケースもあるので warning 扱いにしない
    }

    // ── 分類 ─────────────────────────────────────────────────────
    const entry = {
      id:             row.id,
      title:          row.title,
      published_date: row.published_date,
      primary_topic:  row.primary_topic,
      topics:         topics.slice(0, 5),
      doi:            row.doi || null,
      status:         row.status,
    };

    if (hardReasons.length > 0) {
      withdraw_candidates.push({ ...entry, hard_reasons: hardReasons, warn_reasons: warnReasons });
    } else if (isQuarantine) {
      const topicDisplay = [
        row.primary_topic || '',
        ...topics.slice(0, 3),
      ].filter(Boolean).join(' / ') || '(none)';
      quarantine_candidates.push({
        ...entry,
        reasons: [`not ML-related (topics: ${topicDisplay})`],
        warn_reasons: warnReasons,
      });
    } else if (warnReasons.length > 0) {
      warnings_only.push({ ...entry, warn_reasons: warnReasons });
    } else {
      safe_count++;
    }
  }

  return { withdraw_candidates, quarantine_candidates, warnings_only, safe_count };
}

function buildWithdrawSql(candidates) {
  const ids = candidates.map(p => `'${p.id}'`).join(',\n  ');
  return `-- withdraw_candidates: ${candidates.length} papers
-- hard_reject 理由: 未来日付 / title破損 / DOI破損
-- 生成: audit_papers.js v2  ${new Date().toISOString()}
-- 実行前に withdraw_candidates.json を必ず目視確認すること
UPDATE publish_states
SET status           = 'withdrawn',
    withdrawn_at     = datetime('now'),
    withdrawn_reason = 'audit: hard_reject (metadata broken or future date)',
    withdrawn_by     = 'audit_script',
    updated_at       = datetime('now')
WHERE paper_id IN (
  ${ids}
)
  AND status IN ('published', 'review_pending', 'summarized', 'fetched');
`;
}

function buildQuarantineSql(candidates) {
  const ids = candidates.map(p => `'${p.id}'`).join(',\n  ');
  return `-- quarantine_candidates: ${candidates.length} papers
-- ML キーワード非ヒット。誤判定の可能性があるため目視確認後に実行すること
-- 管理画面の「検疫中」タブから個別救済が可能
-- 生成: audit_papers.js v2  ${new Date().toISOString()}
UPDATE publish_states
SET status        = 'quarantined',
    error_message = 'audit: not ML-related',
    updated_at    = datetime('now')
WHERE paper_id IN (
  ${ids}
)
  AND status IN ('published', 'review_pending', 'summarized', 'fetched');
`;
}

function main() {
  let input = '';
  process.stdin.on('data', chunk => (input += chunk));
  process.stdin.on('end', () => {

    let parsed;
    try {
      parsed = JSON.parse(input);
    } catch (e) {
      console.error('ERROR: invalid JSON input:', e.message);
      process.exit(1);
    }

    // wrangler d1 execute --json は [{results:[...]}] 形式で返す
    const rows = Array.isArray(parsed)
      ? (parsed[0]?.results ?? parsed)
      : (parsed.results ?? []);

    if (!rows.length) {
      console.log('No rows in input. Check dump.json.');
      return;
    }

    const { withdraw_candidates, quarantine_candidates, warnings_only, safe_count } = audit(rows);

    const total = rows.length;
    console.log(`\n=== audit_papers.js v2 ===`);
    console.log(`Total rows   : ${total}`);
    console.log(`safe         : ${safe_count}`);
    console.log(`warnings only: ${warnings_only.length}`);
    console.log(`quarantine   : ${quarantine_candidates.length}`);
    console.log(`withdraw     : ${withdraw_candidates.length}`);
    console.log('');

    // ── 出力ファイル ────────────────────────────────────────────────

    if (withdraw_candidates.length > 0) {
      fs.writeFileSync('withdraw_candidates.json', JSON.stringify(withdraw_candidates, null, 2));
      fs.writeFileSync('bulk_withdraw.sql', buildWithdrawSql(withdraw_candidates));
      console.log(`[!] withdraw_candidates.json (${withdraw_candidates.length}) → bulk_withdraw.sql`);
    } else {
      console.log('[ ] withdraw_candidates: なし');
    }

    if (quarantine_candidates.length > 0) {
      fs.writeFileSync('quarantine_candidates.json', JSON.stringify(quarantine_candidates, null, 2));
      fs.writeFileSync('bulk_quarantine.sql', buildQuarantineSql(quarantine_candidates));
      console.log(`[?] quarantine_candidates.json (${quarantine_candidates.length}) → bulk_quarantine.sql`);
    } else {
      console.log('[ ] quarantine_candidates: なし');
    }

    if (warnings_only.length > 0) {
      fs.writeFileSync('warnings_only.json', JSON.stringify(warnings_only, null, 2));
      console.log(`[w] warnings_only.json (${warnings_only.length})  ← SQL なし、目視のみ`);
    } else {
      console.log('[ ] warnings_only: なし');
    }

    console.log('');
    console.log('次のステップ:');
    if (withdraw_candidates.length > 0) {
      console.log('  1. withdraw_candidates.json を確認');
      console.log('     誤判定を除いてから: wrangler d1 execute ... --file bulk_withdraw.sql');
    }
    if (quarantine_candidates.length > 0) {
      console.log('  2. quarantine_candidates.json を確認');
      console.log('     ML 論文が混入していたら除外してから: wrangler d1 execute ... --file bulk_quarantine.sql');
      console.log('     管理画面「検疫中」タブから個別救済も可能');
    }
    if (warnings_only.length > 0) {
      console.log('  3. warnings_only.json は目視確認のみ（即アクション不要）');
    }
  });
}

main();
