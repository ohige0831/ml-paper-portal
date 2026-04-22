-- withdraw_candidates: 24 papers
-- hard_reject 理由: 未来日付 / title破損 / DOI破損
-- 生成: audit_papers.js v2  2026-04-21T18:23:27.786Z
-- 実行前に withdraw_candidates.json を必ず目視確認すること
UPDATE publish_states
SET status           = 'withdrawn',
    withdrawn_at     = datetime('now'),
    withdrawn_reason = 'audit: hard_reject (metadata broken or future date)',
    withdrawn_by     = 'audit_script',
    updated_at       = datetime('now')
WHERE paper_id IN (
  'W4226369673',
  'W4393614663',
  'W7128624139',
  'W7116362194',
  'W7128633535',
  'W7128510716',
  'W7124539528',
  'W7124567928',
  'W7127379152',
  'W7127371715',
  'W7133132222',
  'W7126060132',
  'W7125940856',
  'W7125952599',
  'W7126055328',
  'W7126045467',
  'W7128031672',
  'W7128502054',
  'W7154712957',
  'W7154759180',
  'W7119928501',
  'W4281660156',
  'W4220754760',
  'W2783566296'
)
  AND status IN ('published', 'review_pending', 'summarized', 'fetched');
