# [試験運用] B案スケジュール — 2026-04-22〜2026-04-29

## 目的

現状は「要約 → 取得」の順になっており、取得した論文が当日中に review_pending にならない問題を解消する。
B案として **取得 → 要約 を1日3回** に変更し、1週間の試験運用を行う。

## 変更前（A案）

| 処理 | cron (UTC) | 時刻 (JST) |
|---|---|---|
| 要約 (Worker) | `0 3 * * *` | 12:00 |
| 取得 (GitHub Actions) | `10 3 * * *` | 12:10 |

問題: 要約が先に走るため、12:10 に取得した論文は翌日の要約まで待つことになる。

## 変更後（B案・試験運用）

| 処理 | cron (UTC) | 時刻 (JST) |
|---|---|---|
| 取得 (GitHub Actions) | `0 0 * * *` | 09:00 |
| 要約 (Worker) | `10 0 * * *` | 09:10 |
| 取得 (GitHub Actions) | `0 6 * * *` | 15:00 |
| 要約 (Worker) | `10 6 * * *` | 15:10 |
| 取得 (GitHub Actions) | `0 12 * * *` | 21:00 |
| 要約 (Worker) | `10 12 * * *` | 21:10 |

- 1回の要約バッチ: **最大30件**（2026-04-22 引き上げ。元: 10件/回）
- 1日3回で**最大90件/日**（元: 30件/日）
- 試験運用であり、コスト・レビュー負荷を観察しながら判断する

## 変更ファイル

- `worker/wrangler.toml` — crons を3本に変更
- `.github/workflows/daily_fetch.yml` — schedule を3本に変更
- `worker/src/index.ts` — cron ログに件数サマリー追加、batchSize=30
- `worker/src/cron/summarize.ts` — batchSize デフォルト値を 30 に変更

## 1週間後に元へ戻す手順

### `worker/wrangler.toml`

```toml
# 以下に戻す
[triggers]
crons = ["0 3 * * *"]
```

### `.github/workflows/daily_fetch.yml`

```yaml
# 以下に戻す
on:
  schedule:
    - cron: '10 3 * * *'
```

### `worker/src/cron/summarize.ts` と `worker/src/index.ts`

```ts
// summarize.ts: デフォルト値を 10 に戻す
batchSize = 10,

// index.ts: 明示値を 10 に戻す
const sumResult = await runSummarize(env.DB, env.OPENAI_API_KEY, model, 10);
```

その後 Worker を再デプロイする:

```bash
cd /f/ml_paper_portal/worker && npm run deploy
```

GitHub Actions の変更は push 時に自動反映される。

## 試験運用の観察ポイント

- 取得後に review_pending が当日中に降ってくるか
- 1日3回のうちどの時間帯の取得が多いか
- summarize error 率に変化がないか
- Cloudflare Worker ログの `summarized=N errors=N | fetched=N review_pending=N ...` を確認

## 終了予定

2026-04-29（1週間後）。終了後はA案に戻し、観察結果をもとに正式スケジュールを決定する。
