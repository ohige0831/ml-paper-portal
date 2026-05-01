export interface Env {
  DB: D1Database;
  OPENAI_API_KEY: string;
  ADMIN_PASSWORD: string;
  INGEST_TOKEN: string;         // GitHub Actions → Worker ingest auth
  OPENAI_MODEL?: string;        // default: gpt-4o-mini
  SITE_BASE_URL?: string;       // public site URL (for admin links)
  DAILY_REGISTER_LIMIT?: string;
  OPENALEX_API_KEY?: string;    // optional — preferred over mailto when set
}

// D1 row shapes
export interface Paper {
  id: string;
  doi: string | null;
  title: string;
  authors: string;              // JSON: [{name:string}]
  published_date: string;
  citation_count: number;
  oa_url: string | null;
  pdf_url: string | null;
  openalex_url: string;
  primary_topic: string | null;
  topics: string;               // JSON: string[]
  abstract: string | null;
  source: string;               // 'auto' | 'manual' | 'keyword_curated'
  arxiv_id: string | null;      // bare arXiv ID (e.g. "2401.12345"), null for non-arXiv
  is_preprint: number;          // 1 if sourced from arXiv, 0 otherwise
  normalized_title: string | null;
  ml_score: number | null;
  effective_score: number | null;
  review_tier: ReviewTier | null;
  score_reasons: string;        // JSON: string[]
  created_at: string;
}

export type ReviewTier = 'A' | 'B' | 'C';

export interface PaperReviewMetadata {
  normalized_title?: string | null;
  ml_score?: number | null;
  effective_score?: number | null;
  review_tier?: ReviewTier | null;
  score_reasons?: string[];
}

export interface Tag {
  id: number;
  slug: string;
  name: string;
  tier: number;
  description: string | null;
  created_at: string;
}

export interface Summary {
  id: number;
  paper_id: string;
  version: number;
  title_ja: string | null;
  one_line: string | null;
  three_lines: string;          // JSON: string[]
  keywords: string;             // JSON: string[]
  long_summary: string | null;
  audience: string | null;
  difficulty: string | null;
  source_model: string | null;
  generated_at: string;
}

export interface PublishState {
  paper_id: string;
  status: PaperStatus;
  error_message: string | null;
  updated_at: string;
  withdrawn_at: string | null;
  withdrawn_reason: string | null;
  withdrawn_by: string | null;
  rejected_reason: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  llm_recheck_checked_at: string | null;
  recheck_reason: string | null;
  recheck_confidence: string | null;
  recheck_model: string | null;
  recheck_flagged_at: string | null;
}

export type PaperStatus =
  | 'fetched'
  | 'summarized'
  | 'review_pending'
  | 'approved'
  | 'published'
  | 'error'
  | 'quarantined'    // failed ML-relevance or metadata validation at ingest
  | 'withdrawn'      // manually retracted from public view
  | 'rejected'       // admin dismissed from review — NOT re-summarized automatically
  | 'needs_recheck'; // LLM flagged as possibly irrelevant — pending human review

// OpenAlex API response shape (partial)
export interface OpenAlexWork {
  id: string;
  doi: string | null;
  title: string;
  authorships: Array<{
    author: { display_name: string };
  }>;
  publication_date: string;
  cited_by_count: number;
  open_access: {
    is_oa: boolean;
    oa_url: string | null;
  };
  primary_location?: {
    pdf_url: string | null;
    landing_page_url: string | null;
  };
  best_oa_location?: {
    pdf_url: string | null;
    landing_page_url: string | null;
  };
  primary_topic?: {
    display_name: string;
  };
  topics?: Array<{
    display_name: string;
    score: number;
  }>;
  abstract_inverted_index?: Record<string, number[]>;
}

// OpenAI-generated summary fields
export interface SummaryData {
  title_ja: string;
  one_line: string;
  three_lines: string[];
  keywords: string[];
  long_summary: string;
  audience: string;
  difficulty: string;
  suggested_tags: string[];
}

// Combined view for admin and public pages
export interface PaperWithSummary {
  paper: Paper;
  summary: Summary | null;
  tags: Tag[];
  status: PaperStatus;
  error_message?: string | null;
  withdrawn_at?: string | null;
  withdrawn_reason?: string | null;
  withdrawn_by?: string | null;
  rejected_reason?: string | null;
  rejected_by?: string | null;
  rejected_at?: string | null;
  recheck_reason?: string | null;
  recheck_confidence?: string | null;
  recheck_model?: string | null;
  recheck_flagged_at?: string | null;
}
