import type { OpenAlexWork } from '../types';

export function reconstructAbstract(invertedIndex: Record<string, number[]>): string {
  const words: string[] = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) {
      words[pos] = word;
    }
  }
  return words.filter(Boolean).join(' ');
}

export function extractPdfUrl(work: OpenAlexWork): string | null {
  return work.best_oa_location?.pdf_url ?? work.primary_location?.pdf_url ?? null;
}

export function extractOaUrl(work: OpenAlexWork): string | null {
  return (
    work.open_access.oa_url ??
    work.best_oa_location?.landing_page_url ??
    work.primary_location?.landing_page_url ??
    null
  );
}

export function normalizeId(openAlexId: string): string {
  return openAlexId.replace('https://openalex.org/', '');
}
