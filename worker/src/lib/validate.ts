import type { OpenAlexWork } from '../types';

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string; quarantine: boolean };

// Keywords that must appear in primary_topic or topics to be considered ML-related.
// Match is case-insensitive substring. If NONE match → quarantine (not outright reject,
// so admins can still rescue legitimate papers caught by over-filtering).
const ML_KEYWORDS = [
  'machine learning',
  'deep learning',
  'neural network',
  'artificial intelligence',
  'natural language processing',
  'computer vision',
  'reinforcement learning',
  'generative model',
  'generative adversarial',
  'diffusion model',
  'transformer',
  'language model',
  'large language',
  'llm',
  'nlp',
  'image recognition',
  'image classification',
  'image segmentation',
  'object detection',
  'speech recognition',
  'text classification',
  'named entity',
  'sentiment analysis',
  'knowledge graph',
  'graph neural',
  'attention mechanism',
  'few-shot',
  'zero-shot',
  'transfer learning',
  'federated learning',
  'representation learning',
  'self-supervised',
  'contrastive learning',
  'multimodal',
  'foundation model',
  'pre-trained',
  'fine-tuning',
  'question answering',
  'machine translation',
  'text generation',
  'image generation',
  'autonomous driving',
  'robotics',
  'data mining',
  'recommendation system',
  'information retrieval',
  'anomaly detection',
  'semantic segmentation',
  'point cloud',
  'visual question',
  'video understanding',
  'optical flow',
  'super resolution',
  'pose estimation',
] as const;

function collectTopicText(work: OpenAlexWork): string {
  const parts: string[] = [];
  if (work.primary_topic?.display_name) parts.push(work.primary_topic.display_name);
  for (const t of work.topics ?? []) parts.push(t.display_name);
  return parts.join(' ').toLowerCase();
}

function isMLRelated(work: OpenAlexWork): boolean {
  const topicText = collectTopicText(work);
  if (!topicText) return false;
  return ML_KEYWORDS.some((kw) => topicText.includes(kw));
}

export function validateWork(work: OpenAlexWork, today: string): ValidationResult {
  // --- Hard rejects (data is broken, can't rescue) ---

  if (!work.title || work.title.trim().length < 5) {
    return { ok: false, reason: 'title missing or too short', quarantine: false };
  }

  if (!work.publication_date) {
    return { ok: false, reason: 'publication_date missing', quarantine: false };
  }

  // Reject if publication date is in the future
  if (work.publication_date > today) {
    return {
      ok: false,
      reason: `publication_date ${work.publication_date} is in the future (today=${today})`,
      quarantine: false,
    };
  }

  // DOI format sanity (if present)
  if (work.doi !== null && work.doi !== undefined) {
    const doi = work.doi.trim();
    if (doi.length > 0 && !doi.startsWith('https://doi.org/') && !doi.match(/^10\.\d{4,}/)) {
      return { ok: false, reason: `malformed DOI: ${doi}`, quarantine: false };
    }
  }

  // --- Soft rejects (quarantine — admin can rescue) ---

  if (!isMLRelated(work)) {
    const topicText = collectTopicText(work);
    return {
      ok: false,
      reason: `not ML-related (topics: ${topicText.slice(0, 120) || 'none'})`,
      quarantine: true,
    };
  }

  return { ok: true };
}
