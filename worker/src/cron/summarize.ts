import type { D1Database } from '@cloudflare/workers-types';
import type { SummaryData } from '../types';
import {
  getPendingForSummarize,
  insertSummary,
  setPublishState,
  getAllTags,
  getTagsBySlug,
  linkTags,
} from '../db/queries';

const SYSTEM_PROMPT = `あなたは機械学習論文の短い日本語導入文を生成するアシスタントです。

論文情報を受け取り、日本語の読者が「読む価値があるか」を短時間で判断できる入口情報を生成してください。

## 方針
- 全文翻訳や詳細解説ではなく「入口」として機能する短い文章を生成する
- 興味を引くことを優先し、難しすぎる説明は避ける
- 論文を断定的に評価するのではなく、「こんな論文がある」という紹介に留める
- 日本語は自然で読みやすく`;

function buildUserPrompt(title: string, abstract: string | null, tagList: string): string {
  return `## 論文情報
タイトル: ${title}
アブストラクト: ${abstract ?? '（アブストラクト未取得）'}

## 利用可能なタグスラッグ一覧
${tagList}

## 出力形式
以下のJSONのみを返してください（マークダウンや説明文は一切不要）:
{
  "title_ja": "日本語タイトル（自然な訳、30〜50文字程度）",
  "one_line": "一言まとめ（この論文が何をするか、30文字以内）",
  "three_lines": ["背景を1文で", "提案内容を1文で", "面白い点または新しい点を1文で"],
  "keywords": ["キーワード1", "キーワード2", "キーワード3"],
  "long_summary": "3〜4文の導入（背景→何をした→面白い点→どんな人向けか）",
  "audience": "こんな人に向いていそう（1〜2文）",
  "difficulty": "入門 または 中級 または 上級 のどれか1語",
  "suggested_tags": ["該当するタグスラッグ（上記一覧から選ぶ）"]
}`;
}

async function callOpenAI(
  apiKey: string,
  model: string,
  title: string,
  abstract: string | null,
  tagList: string,
): Promise<SummaryData> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(title, abstract, tagList) },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${text}`);
  }

  const data = await response.json<{
    choices: Array<{ message: { content: string } }>;
  }>();

  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned empty content');

  const parsed = JSON.parse(content) as Partial<SummaryData>;

  return {
    title_ja: parsed.title_ja ?? title,
    one_line: parsed.one_line ?? '',
    three_lines: Array.isArray(parsed.three_lines) ? parsed.three_lines : [],
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
    long_summary: parsed.long_summary ?? '',
    audience: parsed.audience ?? '',
    difficulty: parsed.difficulty ?? '中級',
    suggested_tags: Array.isArray(parsed.suggested_tags) ? parsed.suggested_tags : [],
  };
}

export async function runSummarize(
  db: D1Database,
  apiKey: string,
  model = 'gpt-4o-mini',
  // [TRIAL B案 2026-04-22〜2026-04-29] 30件/回（元: 10件/回）
  batchSize = 30,
): Promise<{ processed: number; errors: number }> {
  const papers = await getPendingForSummarize(db, batchSize);
  const allTags = await getAllTags(db);
  const tagList = allTags.map((t) => `${t.slug} (${t.name})`).join('\n');

  let processed = 0;
  let errors = 0;

  for (const paper of papers) {
    try {
      const summaryData = await callOpenAI(apiKey, model, paper.title, paper.abstract, tagList);

      await insertSummary(db, paper.id, {
        title_ja: summaryData.title_ja,
        one_line: summaryData.one_line,
        three_lines: summaryData.three_lines,
        keywords: summaryData.keywords,
        long_summary: summaryData.long_summary,
        audience: summaryData.audience,
        difficulty: summaryData.difficulty,
        source_model: model,
      });

      // Link tags
      if (summaryData.suggested_tags.length > 0) {
        const tags = await getTagsBySlug(db, summaryData.suggested_tags);
        if (tags.length > 0) {
          await linkTags(db, paper.id, tags.map((t) => t.id));
        }
      }

      await setPublishState(db, paper.id, 'review_pending');
      processed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await setPublishState(db, paper.id, 'error', message).catch(() => {});
      errors++;
      console.error(`Summarize failed for ${paper.id}: ${message}`);
    }
  }

  return { processed, errors };
}
