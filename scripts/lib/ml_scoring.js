'use strict';

const { normalizeForSearch, reconstructAbstractText } = require('./text_normalize');

const DEFAULT_FILTER_THRESHOLD = 20;

const POINTS_STRONG = { title: 25, abstract: 20, topic: 10, keyword: 8 };
const POINTS_BROAD  = { title: 10, abstract:  5, topic:  5, keyword: 3 };

const PENALTY_ABSTRACT_MISSING = -5;
const PENALTY_ABSTRACT_SHORT   = -3;
const ABSTRACT_SHORT_LEN       = 50;

const POINTS_CONCEPT     = 5;
const POINTS_CONCEPT_CAP = 15;

const POINTS_CITE_HIGH = 5;
const POINTS_CITE_MID  = 2;

const STRONG_ML_KEYWORDS = [
  'machine learning',
  'deep learning',
  'neural network',
  'neural networks',
  'large language model',
  'large language models',
  'llm',
  'llms',
  'transformer',
  'transformers',
  'bert',
  'gpt',
  'cnn',
  'convolutional neural',
  'gnn',
  'graph neural',
  'reinforcement learning',
  'computer vision',
  'natural language processing',
  'nlp',
  'representation learning',
  'generative model',
  'generative adversarial',
  'diffusion model',
  'retrieval augmented generation',
  'attention mechanism',
  'self-supervised',
  'contrastive learning',
  'foundation model',
  'language model',
  'vision-language',
  'multimodal',
  'few-shot',
  'zero-shot',
  'transfer learning',
];

const BROAD_ML_KEYWORDS = [
  'artificial intelligence',
  'deep neural',
  'pre-trained',
  'pretrained',
  'fine-tuning',
  'finetuning',
  'federated learning',
  'image classification',
  'object detection',
  'image segmentation',
  'speech recognition',
  'text generation',
  'image generation',
  'question answering',
  'machine translation',
  'semantic segmentation',
  'knowledge graph',
  'recommendation system',
  'anomaly detection',
  'autonomous driving',
  'text classification',
  'named entity',
  'sentiment analysis',
  'information retrieval',
  'data mining',
  'robotics',
  'image recognition',
  'visual question',
  'video understanding',
  'super resolution',
  'pose estimation',
  'point cloud',
  'optical flow',
];

const ML_CONCEPT_NAMES = [
  'artificial intelligence',
  'machine learning',
  'deep learning',
  'natural language processing',
  'computer vision',
  'pattern recognition',
  'data mining',
];

const JOURNAL_NOISE_PREFIXES = [
  'international journal of',
  'international journal on',
  'journal of',
  'journal on',
  'proceedings of',
  'conference on',
];

function readAbstractText(item) {
  if (typeof item.abstract === 'string') return item.abstract;
  if (typeof item.summary === 'string') return item.summary;
  return reconstructAbstractText(item.abstract_inverted_index);
}

function readTopicText(item) {
  return [
    item.primary_topic?.display_name ?? item.primary_topic ?? '',
    ...(item.topics ?? []).map((t) => t.display_name ?? t.name ?? String(t)),
    ...(item.categories ?? []),
  ].join(' ');
}

function readConceptText(item) {
  return (item.concepts ?? []).map((c) => c.display_name ?? c.name ?? String(c)).join(' ');
}

function readKeywordText(item) {
  return (item.keywords ?? []).map((k) => k.display_name ?? k.keyword ?? k.name ?? String(k)).join(' ');
}

function scoreMlRelevance(item) {
  let score = 0;
  const reasons = [];

  const title       = normalizeForSearch(item.title);
  const abstract    = normalizeForSearch(readAbstractText(item));
  const topicText   = normalizeForSearch(readTopicText(item));
  const conceptText = normalizeForSearch(readConceptText(item));
  const keywordText = normalizeForSearch(readKeywordText(item));
  const citations   = Number(item.cited_by_count ?? item.citation_count ?? 0);

  const tStrong = STRONG_ML_KEYWORDS.find((kw) => title.includes(kw));
  if (tStrong)   { score += POINTS_STRONG.title;    reasons.push(`+${POINTS_STRONG.title} title:"${tStrong}"`); }
  else {
    const tBroad = BROAD_ML_KEYWORDS.find((kw) => title.includes(kw));
    if (tBroad)  { score += POINTS_BROAD.title;     reasons.push(`+${POINTS_BROAD.title} title:"${tBroad}"`); }
  }

  const aStrong = STRONG_ML_KEYWORDS.find((kw) => abstract.includes(kw));
  if (aStrong)   { score += POINTS_STRONG.abstract; reasons.push(`+${POINTS_STRONG.abstract} abstract:"${aStrong}"`); }
  else {
    const aBroad = BROAD_ML_KEYWORDS.find((kw) => abstract.includes(kw));
    if (aBroad)  { score += POINTS_BROAD.abstract;  reasons.push(`+${POINTS_BROAD.abstract} abstract:"${aBroad}"`); }
  }

  const topicStrong = STRONG_ML_KEYWORDS.find((kw) => topicText.includes(kw));
  if (topicStrong)  { score += POINTS_STRONG.topic; reasons.push(`+${POINTS_STRONG.topic} topic:"${topicStrong}"`); }
  else {
    const topicBroad = BROAD_ML_KEYWORDS.find((kw) => topicText.includes(kw));
    if (topicBroad)  { score += POINTS_BROAD.topic; reasons.push(`+${POINTS_BROAD.topic} topic:"${topicBroad}"`); }
  }

  const kwStrong = STRONG_ML_KEYWORDS.find((kw) => keywordText.includes(kw));
  if (kwStrong)  { score += POINTS_STRONG.keyword;  reasons.push(`+${POINTS_STRONG.keyword} keyword:"${kwStrong}"`); }
  else {
    const kwBroad = BROAD_ML_KEYWORDS.find((kw) => keywordText.includes(kw));
    if (kwBroad) { score += POINTS_BROAD.keyword;   reasons.push(`+${POINTS_BROAD.keyword} keyword:"${kwBroad}"`); }
  }

  let conceptPtsTotal = 0;
  for (const kw of ML_CONCEPT_NAMES) {
    if (conceptPtsTotal >= POINTS_CONCEPT_CAP) break;
    if (conceptText.includes(kw)) {
      const pts = Math.min(POINTS_CONCEPT, POINTS_CONCEPT_CAP - conceptPtsTotal);
      conceptPtsTotal += pts;
      score += pts;
      reasons.push(`+${pts} concept:"${kw}"`);
    }
  }

  if (citations >= 100)      { score += POINTS_CITE_HIGH; reasons.push(`+${POINTS_CITE_HIGH} citations>=${100}`); }
  else if (citations >= 20)  { score += POINTS_CITE_MID;  reasons.push(`+${POINTS_CITE_MID} citations>=${20}`); }

  if (abstract.length === 0) {
    score += PENALTY_ABSTRACT_MISSING;
    reasons.push(`${PENALTY_ABSTRACT_MISSING} abstract missing (0 chars)`);
  } else if (abstract.length < ABSTRACT_SHORT_LEN) {
    score += PENALTY_ABSTRACT_SHORT;
    reasons.push(`${PENALTY_ABSTRACT_SHORT} abstract short (${abstract.length} chars)`);
  }

  return { score, reasons };
}

function isJournalNoise(title) {
  const t = normalizeForSearch(title);
  return JOURNAL_NOISE_PREFIXES.some((p) => t.startsWith(p));
}

function filterCandidates(works, options = {}) {
  const threshold = options.threshold ?? DEFAULT_FILTER_THRESHOLD;
  const dryRun = Boolean(options.dryRun);
  const toIngest = [];
  const filtered = [];
  const scores = new Map();
  let noiseCount = 0;

  for (const work of works) {
    if (isJournalNoise(work.title)) {
      noiseCount++;
      const snippet = (work.title ?? '').slice(0, 70);
      if (dryRun) {
        console.log(`  [noise ] SKIP journal-noise "${snippet}"`);
      } else {
        filtered.push({ id: work.id, title: work.title, score: null, reasons: ['journal-noise title'] });
      }
      continue;
    }

    const { score, reasons } = scoreMlRelevance(work);
    const pass = score >= threshold;
    scores.set(work.id, { score, reasons });

    if (dryRun) {
      const label = pass ? 'PASS ' : 'FAIL ';
      const snippet = (work.title ?? '').slice(0, 70);
      console.log(`  [score] ${label} score=${String(score).padStart(3)} "${snippet}"`);
      if (!pass) {
        for (const r of reasons) console.log(`    ${r}`);
        if (reasons.length === 0) console.log('    (no ML signals found)');
      }
    } else if (pass) {
      toIngest.push(work);
    } else {
      filtered.push({ id: work.id, title: work.title, score, reasons });
    }
  }

  return { toIngest, filtered, scores, noiseCount };
}

module.exports = {
  DEFAULT_FILTER_THRESHOLD,
  filterCandidates,
  isJournalNoise,
  scoreMlRelevance,
};
