-- Large tags (tier 1: 分野/タスク/用途)
INSERT OR IGNORE INTO tags (slug, name, tier, description) VALUES
  ('llm', 'LLM', 1, '大規模言語モデル（Large Language Model）に関する研究。テキスト生成・理解・推論などを扱う。GPTやLlamaなどが代表例。'),
  ('vision', '画像認識', 1, '画像・映像を対象とした機械学習。物体検出、セグメンテーション、画像分類などを含む。'),
  ('super-resolution', '超解像', 1, '低解像度の画像から高解像度画像を復元・生成する技術。'),
  ('anomaly-detection', '異常検知', 1, '正常パターンから外れたデータを検出する技術。製造業の品質検査や医療診断などで活用される。'),
  ('reinforcement-learning', '強化学習', 1, 'エージェントが環境との相互作用を通じて学習するパラダイム。ゲームAIやロボット制御などに活用。'),
  ('multimodal', 'マルチモーダル', 1, 'テキスト・画像・音声など複数のモダリティを組み合わせて扱う研究。'),
  ('image-generation', '画像生成', 1, 'テキストや条件から新たな画像を生成する技術。');

-- Medium tags (tier 2: モデル系列/手法群)
INSERT OR IGNORE INTO tags (slug, name, tier, description) VALUES
  ('transformer', 'Transformer', 2, 'Attention機構をベースとしたアーキテクチャ。BERTやGPT系モデルの基盤となっている。'),
  ('vit', 'ViT', 2, 'Vision Transformer。画像をパッチに分割してTransformerで処理するアーキテクチャ。'),
  ('diffusion', 'Diffusion', 2, '拡散モデル。ノイズを段階的に除去することで画像などを生成する手法。Stable Diffusionが代表例。'),
  ('cnn', 'CNN', 2, '畳み込みニューラルネットワーク。画像認識の基本となるアーキテクチャ。'),
  ('gnn', 'GNN', 2, 'グラフニューラルネットワーク。グラフ構造データを扱うための手法群。'),
  ('agent', 'Agent', 2, 'LLMを中核とした自律エージェント。ツール使用や複数ステップの推論・実行を行う。'),
  ('moe', 'MoE', 2, 'Mixture of Experts。複数の専門モジュールを動的に切り替えるアーキテクチャ。');

-- Small tags (tier 3: 技術要素/特徴)
INSERT OR IGNORE INTO tags (slug, name, tier, description) VALUES
  ('lightweight', '軽量化', 3, 'モデルのパラメータ数や計算量を削減する手法群。エッジデバイスへの展開などで重要。'),
  ('distillation', '蒸留', 3, '大きなモデル（教師）の知識を小さなモデル（生徒）に転移させる技術。'),
  ('quantization', '量子化', 3, 'モデルの重みを低ビット精度で表現し、メモリと計算効率を高める手法。'),
  ('few-shot', 'Few-shot学習', 3, '少量のサンプルだけで新タスクに適応する能力。'),
  ('inference-speedup', '推論高速化', 3, 'モデルの推論速度を高速化する技術。投機的デコードやキャッシュ最適化などを含む。'),
  ('fine-tuning', 'ファインチューニング', 3, '事前学習済みモデルを特定タスク向けに追加学習する手法。LoRAなどのPEFT手法も含む。'),
  ('rag', 'RAG', 3, 'Retrieval-Augmented Generation。外部知識を検索してLLMの回答精度を高める手法。'),
  ('benchmark', 'ベンチマーク', 3, '評価指標や評価データセットの提案。手法の比較・検証基盤となる研究。');
