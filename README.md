# ML Paper Portal

機械学習論文の日本語入口サイト。

「読む価値があるか・興味があるか」を短時間で判断できるように、OpenAlexから取得した論文にOpenAIで短い日本語導入文を付けて公開する。

---

## デプロイ済みURL

| サービス | URL |
|----------|-----|
| 公開サイト (Pages) | https://ml-paper-portal-web.pages.dev |
| 管理画面 (Worker) | https://ml-paper-portal-worker.kagerou5100.workers.dev/admin |

### 現在の制約

- **OpenAlex 429 問題**: Cloudflare の大阪 (KIX) データセンター IP から OpenAlex へのリクエストが継続的に 429 でブロックされる。日次 Cron による自動取得が機能しない。管理画面の「取得実行」ボタンも同様。回避策は検討中 → 詳細は `work_log/` 参照。
- **論文取得の代替手順**: 現状はローカル PC から OpenAlex データを取得 → D1 に直接挿入 → 管理画面で要約実行 → 承認 という手順で運用。

---

## 構成

```
ml_paper_portal/
├── migrations/          D1スキーマ + 初期タグ
├── worker/              Cloudflare Worker (Cron取得+要約 / 管理API)
└── web/                 Cloudflare Pages (公開サイト / Pages Functions)
```

**データフロー:**
```
OpenAlex API → Worker(Cron) → D1 → Worker(Cron) → OpenAI API
                                ↓
                         管理画面で承認
                                ↓
                         D1(published) → Pages Functions → HTML
```

---

## セットアップ

### 1. Cloudflare D1 データベースを作成

```bash
cd worker
npx wrangler d1 create ml-paper-portal
```

表示される `database_id` を `worker/wrangler.toml` と `web/wrangler.toml` の `YOUR_D1_DATABASE_ID` に設定する。

### 2. マイグレーションを実行

```bash
cd worker
npm run db:migrate
```

### 3. Secrets を設定

```bash
cd worker
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ADMIN_PASSWORD
```

### 4. Worker をデプロイ

```bash
cd worker
npm install
npm run deploy
```

管理画面URL: `https://ml-paper-portal-worker.YOUR_ACCOUNT.workers.dev/admin`

### 5. Pages サイトをデプロイ

```bash
cd web
npm install
npm run deploy
```

公開サイトURL: Cloudflare Pages のダッシュボードに表示される

---

## 運用フロー

**日次自動 (Cron: 毎日3:00 UTC):**
1. OpenAlexから新着25本 + 人気25本を取得
2. 未処理論文をOpenAIで要約生成 (1回10本)
3. 要約済みは `review_pending` 状態になる

**手動承認:**
1. 管理画面 `/admin` を開く
2. 「レビュー待ち」の論文を確認
3. 承認 → 即座に公開サイトに表示

**手動トリガー:**
- 管理画面の「取得実行」「要約実行」ボタンで即時実行可能

---

## 論文ページのURL

- 論文個別: `/papers/W2741809807` (OpenAlex IDを小文字で)
- タグページ: `/tags/llm`
- 新着一覧: `/latest/`
- トップ: `/`

---

## 状態遷移

```
fetched → (OpenAI) → review_pending → (承認) → published
       ↘ error                      ↘ (差し戻し) → fetched
```

---

## ローカル開発

### Worker

```bash
cd worker
npm install
npx wrangler dev
```

管理画面: http://localhost:8787/admin

### Web (Pages)

```bash
cd web
npm install
npx wrangler pages dev public --d1=DB
```

公開サイト: http://localhost:8788

---

## 後回しにした機能

- arXiv補助連携
- タグ組み合わせ検索UI
- 自動公開 (現在は承認必須)
- 被引用数ソートページネーション
- 高度なレコメンドアルゴリズム
