-- Sample paper: Deep Residual Learning for Image Recognition (He et al., 2015)
-- Source: https://arxiv.org/abs/1512.03385 / OpenAlex W2949650786
-- Used as a concrete display example. Not labelled "元祖論文" —
-- described as "代表的な論文" in the admin/tag page context.

INSERT OR IGNORE INTO papers (
  id, doi, title, authors, published_date, citation_count,
  oa_url, pdf_url, openalex_url, primary_topic, topics, abstract
) VALUES (
  'W2949650786',
  '10.48550/arxiv.1512.03385',
  'Deep Residual Learning for Image Recognition',
  '[{"name":"Kaiming He"},{"name":"Xiangyu Zhang"},{"name":"Shaoqing Ren"},{"name":"Jian Sun"}]',
  '2015-12-10',
  4667,
  'https://arxiv.org/abs/1512.03385',
  'https://arxiv.org/pdf/1512.03385',
  'https://openalex.org/W2949650786',
  'Advanced Neural Network Applications',
  '["Advanced Neural Network Applications","Domain Adaptation and Few-Shot Learning","Advanced Image and Video Retrieval Techniques"]',
  'Deeper neural networks are more difficult to train. We present a residual learning framework to ease the training of networks that are substantially deeper than those used previously. We explicitly reformulate the layers as learning residual functions with reference to the layer inputs, instead of unreferenced functions. We provide comprehensive empirical evidence showing that these residual networks are easier to optimize, and can gain accuracy from considerably increased depth. On the ImageNet dataset we evaluate residual nets with depth of up to 152 layers---8x deeper than VGG nets but still having lower complexity. An ensemble of these residual nets achieves 3.57% error on the ImageNet test set. This result won the 1st place on the ILSVRC 2015 classification task.'
);

-- Japanese summary (pre-generated, no OpenAI call needed for sample display)
INSERT OR IGNORE INTO summaries (
  paper_id, version, title_ja, one_line, three_lines, keywords,
  long_summary, audience, difficulty, source_model
) VALUES (
  'W2949650786',
  1,
  '深層残差学習による画像認識',
  '残差接続で超深層ネットワークの学習を可能にした手法',
  '["深いネットワークは勾配消失などで学習が困難になる問題があった","層の出力ではなく入力との差分（残差）を学習するResidual Networkを提案した","152層のネットワークでImageNet Top-5 errorを3.57%に達成しILSVRC 2015で優勝"]',
  '["ResNet","残差接続","Skip Connection","画像認識","CNN","深層学習"]',
  '深いニューラルネットワークは勾配消失問題などにより学習が難しくなる。この論文ではShortcut Connection（スキップ接続）を導入したResidual Network（ResNet）を提案し、学習目標を「正解への変換」から「入力との差分（残差）」へと変えることで、152層という超深層ネットワークの安定学習を実現した。ImageNetではTop-5 error 3.57%を達成してILSVRC 2015を制覇し、物体検出・領域分割でも大幅な改善を記録した。現在も多くの画像認識モデルの基盤として広く参照されている論文。',
  'CNNや画像認識の基礎を学んでいる人、残差接続がどのような問題意識から生まれたかを理解したい人に向いている。深層学習の実装経験が少しある方でも読みやすい。',
  '中級',
  'sample-pregenerated'
);

-- Set status to published so it appears on the public site
INSERT OR IGNORE INTO publish_states (paper_id, status)
VALUES ('W2949650786', 'published');

-- Tag links: vision (画像認識), cnn (CNN), benchmark (ベンチマーク)
INSERT OR IGNORE INTO paper_tags (paper_id, tag_id)
SELECT 'W2949650786', id FROM tags WHERE slug IN ('vision', 'cnn', 'benchmark');
