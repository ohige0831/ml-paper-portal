-- quarantine_candidates: 8 papers
-- ML キーワード非ヒット。誤判定の可能性があるため目視確認後に実行すること
-- 管理画面の「検疫中」タブから個別救済が可能
-- 生成: audit_papers.js v2  2026-04-21T18:23:27.787Z
UPDATE publish_states
SET status        = 'quarantined',
    error_message = 'audit: not ML-related',
    updated_at    = datetime('now')
WHERE paper_id IN (
  'W1531368347',
  'W4404046121',
  'W4396831394',
  'W4404534210',
  'W4405670661',
  'W2626610348',
  'W4404511389',
  'W4401917994'
)
  AND status IN ('published', 'review_pending', 'summarized', 'fetched');
