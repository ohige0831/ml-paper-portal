# 取得戦略: 層別サンプリング — 2026-04-22〜

## 背景と目的

単純な「最新25件 + 高被引用Top25件」の取得では、
毎回同じ顔ぶれの論文を踏んでしまい、新規候補が増えにくかった。
公開時期 × 被引用数で層を分け、OpenAlex の `sample=N`（seed なし = 毎回ランダム）を使うことで
各実行ごとに異なる候補が来るようにした。

---

## 自動取得（GitHub Actions）の層設計

### 層の定義（計 50 件/回）

| 層ラベル | 公開時期 | 被引用数 | 件数 |
|---|---|---|---|
| new-uncited   | 直近 90 日 | 0 | 8 |
| new-low       | 直近 90 日 | 1〜19 | 10 |
| new-cited     | 直近 90 日 | 20 以上 | 7 |
| mid-low       | 91〜730 日 | 0〜9 | 4 |
| mid-mid       | 91〜730 日 | 10〜49 | 6 |
| mid-high      | 91〜730 日 | 50 以上 | 5 |
| classic-mid   | 731 日以上 | 20〜99 | 4 |
| classic-high  | 731 日以上 | 100 以上 | 6 |
| **合計** | | | **50** |

### 新着層を多めにした理由

- 高被引用 (classic-high) は OpenAlex のプールが広く、ランダムサンプリングでも結果が安定しやすい
- 新着層はプールが毎日変わるため、新規候補が来やすい
- 初動での記事数確保のため新着寄りに傾斜

### 重複回避の仕組み

- OpenAlex の `sample=N`（seed なし）= 毎回ランダムに N 件を返す
- 同一実行内は `Set<id>` でデデュープ
- 既知 ID は ingest 側の `paperExists()` で除外（スキップカウント）
- 結果: 毎回異なる候補が来る確率が高く、同じ顔ぶれを踏みにくい

### フィルター設計

```
base: primary_topic.subfield.id:1702,is_oa:true
  + from_publication_date / to_publication_date（層別）
  + cited_by_count:>N / cited_by_count:<N（境界は整数）
```

日付の境界は厳密に 1 日ずつずらして層の重複を防ぐ:
- 新着: from d90
- 中間: from d730, to d91（d90 を含まない）
- 定番: to d731（d730 を含まない）

---

## 手動取得（管理画面ボタン）のモード

管理画面の「取得実行」ボタンは **手動モード** で動作する。
自動取得（GitHub Actions）が止まっているときや、
すぐに候補を補充したいときのための補助ルート。

### 手動モードの仕様

| 項目 | 値 |
|---|---|
| 被引用数フィルター | **20 以上**（低品質ノイズを減らす） |
| 取得件数 | 最大 50 件（recent 25 + classic 25） |
| ランダム性 | `sample=25`（seed なし）= 毎回異なる |
| 実装ファイル | `worker/src/cron/fetch.ts` |

### 被引用数 20+ を選んだ理由

| 閾値 | 特徴 |
|---|---|
| 10+ | ノイズが多い。論文数が多すぎる |
| **20+** | 定番〜中堅のバランスが良い ← 採用 |
| 50+ | 定番に偏りすぎ、中堅を取りこぼす |
| 100+ | 範囲が狭すぎる |

### 手動モードの注意

- Cloudflare Worker から OpenAlex への直接リクエストは 429 が起きやすい
- 補助ルートとして使い、取得の正規ルートは GitHub Actions を維持する
- 手動モードの結果は管理画面のメッセージに表示される:
  `取得完了 [手動/被引用20+]: N件中 M件が新規 (検疫:X 却下:Y)`

---

## 元に戻す方法

### GitHub Actions スクリプト

```bash
git checkout HEAD~N -- scripts/fetch_openalex.js
```

または `fetch_openalex.js` を手動で旧版（`fetchRecentWorks` + `fetchPopularWorks`）に戻す。

### Worker 手動取得

`worker/src/cron/fetch.ts` を旧版に戻し `npm run deploy`。

---

## ログの見方

### GitHub Actions ログ（自動取得）

```
[fetch_openalex] mode=auto (stratified sampling)
[fetch_openalex] 8 layers, target 50 papers
  [new-uncited] n=8 → 8 works
  [new-low] n=10 → 10 works
  ...
[fetch_openalex] Layer results:
  new-uncited: 8
  new-low: 10
  ...
[fetch_openalex] Total unique: 48
[fetch_openalex] Done: inserted=12 skipped=36 quarantined=2 rejected=0
```

### Cloudflare Worker ログ（手動取得）

```
[fetch:manual] Starting (citation>=20, random 50)
[fetch:manual] recent-cited: 25 works
[fetch:manual] classic-high: 25 works
[fetch:manual] fetched=48 new=10 duplicate=35 quarantined=3 rejected=0
```

### Worker cron ログ（要約）

```
[cron] summarized=15 errors=0 | error=2 fetched=20 published=38 review_pending=5
```

---

## 観察ポイント（試験運用中）

- `skipped` 件数: 既知 ID が多い場合、その層は網羅されてきたサイン
- `quarantined` 件数: ML キーワードフィルターの誤判定率の参考
- 層ごとの `got N works` が 0 になる層: その属性の論文が OpenAlex にほぼない
- `new-uncited` 層: 品質が低い論文も多い → quarantine 率を観察
