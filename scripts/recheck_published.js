#!/usr/bin/env node
// scripts/recheck_published.js
// Weekly LLM batch recheck: flags published papers that may be irrelevant to ML/AI.
//
// Usage:
//   node scripts/recheck_published.js                 # check unchecked papers
//   node scripts/recheck_published.js --all           # re-check ALL published papers
//   node scripts/recheck_published.js --dry-run       # print decisions, no submit
//   node scripts/recheck_published.js --limit 20      # override paper count
//
// Required env vars:
//   WORKER_URL, INGEST_TOKEN, OPENAI_API_KEY
// Optional:
//   OPENAI_MODEL       default: gpt-4o-mini
//   RECHECK_LIMIT      default: 50  (overridden by --limit N)
//   RECHECK_SLEEP_MS   default: 3000  inter-paper wait (0 to disable)

// ── Constants ─────────────────────────────────────────────────────────────────

const WORKER_URL     = process.env.WORKER_URL;
const INGEST_TOKEN   = process.env.INGEST_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL  ?? 'gpt-4o-mini';
const SLEEP_MS       = Number(process.env.RECHECK_SLEEP_MS ?? '3000');
const MAX_RETRIES    = 4; // max retries per paper (5 total attempts)

// --limit N takes priority over RECHECK_LIMIT env var
const limitArgIdx = process.argv.indexOf('--limit');
const cliLimit    = (limitArgIdx !== -1 && !isNaN(Number(process.argv[limitArgIdx + 1])))
  ? Number(process.argv[limitArgIdx + 1])
  : null;
const LIMIT = Math.min(cliLimit ?? Number(process.env.RECHECK_LIMIT ?? '50'), 500);

const DRY_RUN  = process.argv.includes('--dry-run');
const ALL_MODE = process.argv.includes('--all');

if (!WORKER_URL || !INGEST_TOKEN || !OPENAI_API_KEY) {
  console.error('[recheck] ERROR: WORKER_URL, INGEST_TOKEN, OPENAI_API_KEY are required');
  process.exit(1);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Typed errors for retry classification ─────────────────────────────────────

class OpenAiRateLimitError extends Error {
  /** @param {number|null} retryAfterMs — from Retry-After header, or null */
  constructor(retryAfterMs) {
    super('OpenAI 429 rate_limit_exceeded');
    this.name          = 'OpenAiRateLimitError';
    this.retryAfterMs  = retryAfterMs;
  }
}

class OpenAiServerError extends Error {
  /** @param {number} status — 5xx HTTP status */
  constructor(status) {
    super(`OpenAI ${status} server error`);
    this.name   = 'OpenAiServerError';
    this.status = status;
  }
}

// ── Worker API ────────────────────────────────────────────────────────────────

async function workerApi(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${INGEST_TOKEN}`,
    },
  };
  if (body !== null) opts.body = JSON.stringify(body);
  const res = await fetch(`${WORKER_URL}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Worker ${res.status}: ${text}`);
  }
  return res.json();
}

// ── LLM call — single attempt, throws typed errors on 429 / 5xx ──────────────

async function llmRecheck(paper) {
  const title    = paper.title ?? '';
  const abstract = (paper.abstract ?? '').slice(0, 500);

  const prompt = `あなたは機械学習・AI論文の関連性を判定する専門家です。
以下の論文が「機械学習・AI・データサイエンス」の専門ポータルサイトに掲載するのに適切かどうかを判定してください。

論文タイトル: ${title}
アブストラクト（先頭500文字）: ${abstract}

以下のJSON形式のみで回答してください（他の文字を含めないこと）:
{"flag": true または false, "reason": "理由（日本語・50文字以内）", "confidence": "high" または "medium" または "low"}

判定基準:
- flag=true: ML/AI/DL/NLP/CVと無関係、または関連性が極めて薄い
- flag=false: ML/AI関連として掲載適切
- 判断が難しい場合は flag=false（人間が判断するのは flag=true のみ）`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 150,
      temperature: 0,
    }),
  });

  // 429 → throw retryable error with Retry-After if present
  if (res.status === 429) {
    const retryAfterSec = Number(res.headers.get('Retry-After') ?? '0');
    throw new OpenAiRateLimitError(retryAfterSec > 0 ? retryAfterSec * 1000 : null);
  }

  // 5xx → throw retryable server error
  if (res.status >= 500) {
    throw new OpenAiServerError(res.status);
  }

  // other non-ok (400, 401, 403 …) → not retryable
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content ?? '{}';

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`LLM returned invalid JSON: ${content.slice(0, 100)}`);
  }

  return {
    flag:       Boolean(parsed.flag),
    reason:     String(parsed.reason ?? '').slice(0, 200),
    confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium',
  };
}

// ── Retry wrapper — exponential backoff, honours Retry-After ─────────────────

async function llmRecheckWithRetry(paper) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await llmRecheck(paper);
    } catch (err) {
      const isRetryable = err instanceof OpenAiRateLimitError || err instanceof OpenAiServerError;
      if (!isRetryable || attempt === MAX_RETRIES) throw err;

      let waitMs;
      let label;

      if (err instanceof OpenAiRateLimitError && err.retryAfterMs != null) {
        // Use Retry-After header + small buffer
        waitMs = err.retryAfterMs + 500;
        label  = `429 Retry-After=${Math.round(err.retryAfterMs / 1000)}s`;
      } else if (err instanceof OpenAiRateLimitError) {
        // 429 without Retry-After → exponential backoff
        waitMs = 1000 * (2 ** attempt); // 1s → 2s → 4s → 8s
        label  = '429 no-header';
      } else {
        // 5xx → exponential backoff
        waitMs = 1000 * (2 ** attempt);
        label  = `${err.status}`;
      }

      console.log(`  [retry#${attempt + 1}/${MAX_RETRIES}] ${label}  wait=${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(
    `[recheck] start` +
    `  model=${OPENAI_MODEL}` +
    `  limit=${LIMIT}` +
    `  sleep=${SLEEP_MS}ms` +
    `  max_retries=${MAX_RETRIES}` +
    `  dry_run=${DRY_RUN}` +
    `  all=${ALL_MODE}`,
  );

  const pendingUrl = `/api/recheck/pending?limit=${LIMIT}${ALL_MODE ? '&all=1' : ''}`;
  const { papers, count } = await workerApi(pendingUrl);
  console.log(`[recheck] pending=${count}`);

  if (count === 0) {
    console.log('[recheck] nothing to do');
    return;
  }

  const results     = [];
  let flaggedCount  = 0;
  let passedCount   = 0;
  let errorCount    = 0;

  for (let i = 0; i < papers.length; i++) {
    const paper = papers[i];

    // Inter-paper sleep (skip before the very first call)
    if (i > 0 && SLEEP_MS > 0) {
      await sleep(SLEEP_MS);
    }

    try {
      const result = await llmRecheckWithRetry(paper);
      const label  = result.flag ? 'FLAG' : 'pass';
      console.log(`  [${label}] (${result.confidence}) ${(paper.title ?? '').slice(0, 70)}`);
      if (result.flag) console.log(`         reason: ${result.reason}`);

      if (result.flag) flaggedCount++;
      else             passedCount++;

      if (!DRY_RUN) {
        results.push({
          paper_id:   paper.id,
          flag:       result.flag,
          reason:     result.reason,
          confidence: result.confidence,
          model:      OPENAI_MODEL,
        });
      }
    } catch (err) {
      // Distinguish 429/5xx exhausted vs other errors in the log
      const errLabel = err instanceof OpenAiRateLimitError ? '429-exhausted'
        : err instanceof OpenAiServerError ? `${err.status}-exhausted`
        : 'error';
      console.error(`  [${errLabel}] ${paper.id}: ${err.message}`);
      errorCount++;
    }
  }

  if (!DRY_RUN && results.length > 0) {
    const submitResult = await workerApi('/api/recheck/submit', 'POST', { results });
    console.log(
      `[recheck] submit → flagged=${submitResult.flagged}` +
      `  passed=${submitResult.passed}` +
      `  errors=${submitResult.errors}`,
    );
  }

  const dryTag = DRY_RUN ? ' (DRY_RUN — no submit)' : '';
  console.log(
    `[recheck] done` +
    `  total=${papers.length}` +
    `  flagged=${flaggedCount}` +
    `  passed=${passedCount}` +
    `  errors=${errorCount}` +
    dryTag,
  );
}

main().catch((err) => {
  console.error('[recheck] FATAL:', err.message);
  process.exit(1);
});
