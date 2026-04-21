-- Test paper: Attention Is All You Need (Vaswani et al., 2017)
-- OpenAlex W2626778328 — inserted as 'fetched' to exercise the summarize pipeline

INSERT OR IGNORE INTO papers (
  id, doi, title, authors, published_date, citation_count,
  oa_url, pdf_url, openalex_url, primary_topic, topics, abstract
) VALUES (
  'W2626778328',
  '10.65215/2q58a426',
  'Attention Is All You Need',
  '[{"name":"Ashish Vaswani"},{"name":"Noam Shazeer"},{"name":"Niki Parmar"},{"name":"Jakob Uszkoreit"},{"name":"Llion Jones"},{"name":"Aidan N. Gomez"},{"name":"Łukasz Kaiser"},{"name":"Illia Polosukhin"}]',
  '2025-08-23',
  6526,
  'https://doi.org/10.65215/r5bs2d54',
  'https://langtaosha.org.cn/index.php/lts/preprint/download/10/108',
  'https://openalex.org/W2626778328',
  'Natural Language Processing Techniques',
  '["Natural Language Processing Techniques","Topic Modeling","Multimodal Machine Learning Applications"]',
  'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks in an encoder-decoder configuration. The best performing models also connect the encoder and decoder through an attention mechanism. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely. Experiments on two machine translation tasks show these models to be superior in quality while being more parallelizable and requiring significantly less time to train. Our model achieves 28.4 BLEU on the WMT 2014 English-to-German translation task, improving over the existing best results, including ensembles by 2 BLEU. On the WMT 2014 English-to-French translation task, our model establishes a new single-model state-of-the-art BLEU score of 41.8 after training for 3.5 days on eight GPUs, a small fraction of the training costs of the best models from the literature. We show that the Transformer generalizes well to other tasks by applying it successfully to English constituency parsing both with large and limited training data.'
);

-- Status = fetched so the summarize cron will pick it up
INSERT OR IGNORE INTO publish_states (paper_id, status)
VALUES ('W2626778328', 'fetched');
