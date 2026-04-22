import { Hono } from 'hono';
import type { Env } from './types';
import { adminRouter } from './routes/admin';
import { ingestRouter } from './routes/ingest';
import { runSummarize } from './cron/summarize';

const app = new Hono<{ Bindings: Env }>();

// Redirect root to admin panel
app.get('/', (c) => c.redirect('/admin'));

// Ingest endpoint for GitHub Actions (Bearer token auth)
app.route('/', ingestRouter);

// Admin routes (Basic auth)
app.route('/', adminRouter);

// Surface errors as JSON so debugging is easier
app.onError((err, c) => {
  console.error('[worker error]', err);
  return c.json({ error: err.message ?? String(err) }, 500);
});

export default {
  fetch: app.fetch,

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCronJob(env));
  },
};

// Cron only runs summarize; fetch is handled by GitHub Actions
async function runCronJob(env: Env): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log(`[cron] Starting summarize at ${startedAt}`);
  try {
    const model = env.OPENAI_MODEL ?? 'gpt-4o-mini';
    // [TRIAL B案 2026-04-22〜2026-04-29] batchSize=30（元: 10）
    const sumResult = await runSummarize(env.DB, env.OPENAI_API_KEY, model, 30);

    // Count current pipeline states for visibility
    const counts = await env.DB
      .prepare(
        `SELECT status, COUNT(*) as n FROM papers
         GROUP BY status ORDER BY status`,
      )
      .all<{ status: string; n: number }>();
    const statusLine = (counts.results ?? [])
      .map((r) => `${r.status}=${r.n}`)
      .join(' ');

    console.log(
      `[cron] summarized=${sumResult.processed} errors=${sumResult.errors} | ${statusLine}`,
    );
  } catch (err) {
    console.error('[cron] Summarize error:', err);
  }
}
