'use strict';

function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeForSearch(value) {
  return normalizeWhitespace(value).toLowerCase();
}

function normalizeTitle(value) {
  return normalizeForSearch(value)
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function reconstructAbstractText(invIdx) {
  if (!invIdx || typeof invIdx !== 'object') return '';
  const words = {};
  for (const [word, positions] of Object.entries(invIdx)) {
    for (const pos of positions) words[pos] = word;
  }
  const keys = Object.keys(words).map(Number);
  if (keys.length === 0) return '';
  const maxPos = Math.max(...keys);
  return Array.from({ length: maxPos + 1 }, (_, i) => words[i] ?? '').join(' ').trim();
}

module.exports = {
  normalizeWhitespace,
  normalizeForSearch,
  normalizeTitle,
  reconstructAbstractText,
};
