import type { SearchResult } from './types.js';

export type SearchCandidate = {
  id: string;
  type: string;
  sessionID?: string;
  timestamp: number;
  snippet: string;
  content: string;
  sourceKind: 'message' | 'summary' | 'artifact';
  sourceOrder: number;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenizeQuery(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9_]+/g) ?? [])];
}

function buildRecencyRange(candidates: SearchCandidate[]): { oldest: number; newest: number } {
  let oldest = Number.POSITIVE_INFINITY;
  let newest = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    oldest = Math.min(oldest, candidate.timestamp);
    newest = Math.max(newest, candidate.timestamp);
  }

  if (!Number.isFinite(oldest) || !Number.isFinite(newest)) {
    return { oldest: 0, newest: 0 };
  }

  return { oldest, newest };
}

const MESSAGE_BASE_SCORE = 135;
const ARTIFACT_BASE_SCORE = 96;
const SUMMARY_BASE_SCORE = 78;
const USER_ROLE_BONUS = 22;
const ASSISTANT_ROLE_BONUS = 12;
const EXACT_PHRASE_BONUS = 90;
const COVERAGE_MULTIPLIER = 70;
const TOKEN_MATCH_MULTIPLIER = 12;
const TOTAL_HIT_MULTIPLIER = 2;
const BOUNDARY_HIT_MULTIPLIER = 4;
const SNIPPET_EXACT_BONUS = 24;
const SOURCE_ORDER_DECAY_BASE = 18;
const RECENCY_MULTIPLIER = 28;

function scoreSearchCandidate(
  candidate: SearchCandidate,
  query: string,
  tokens: string[],
  recencyRange: { oldest: number; newest: number },
): number {
  const content = candidate.content.toLowerCase();
  const snippet = candidate.snippet.toLowerCase();
  const exactPhrase = content.includes(query);
  const base =
    candidate.sourceKind === 'message'
      ? MESSAGE_BASE_SCORE
      : candidate.sourceKind === 'artifact'
        ? ARTIFACT_BASE_SCORE
        : SUMMARY_BASE_SCORE;

  let matchedTokens = 0;
  let totalHits = 0;
  let boundaryHits = 0;

  for (const token of tokens) {
    const hasToken = content.includes(token);
    if (hasToken) matchedTokens += 1;

    const boundaryPattern = new RegExp(`\\b${escapeRegExp(token)}\\b`, 'g');
    const matches = content.match(boundaryPattern)?.length ?? 0;
    boundaryHits += matches;
    totalHits += matches > 0 ? matches : hasToken ? 1 : 0;
  }

  const coverage = tokens.length > 0 ? matchedTokens / tokens.length : 0;
  let score = base;
  if (candidate.sourceKind === 'message') {
    score +=
      candidate.type === 'user'
        ? USER_ROLE_BONUS
        : candidate.type === 'assistant'
          ? ASSISTANT_ROLE_BONUS
          : 0;
  }
  score += exactPhrase ? EXACT_PHRASE_BONUS : 0;
  score += coverage * COVERAGE_MULTIPLIER;
  score += matchedTokens * TOKEN_MATCH_MULTIPLIER;
  score += Math.min(totalHits, matchedTokens + 2) * TOTAL_HIT_MULTIPLIER;
  score += Math.min(boundaryHits, matchedTokens) * BOUNDARY_HIT_MULTIPLIER;
  score += snippet.includes(query) ? SNIPPET_EXACT_BONUS : 0;
  score += Math.max(0, SOURCE_ORDER_DECAY_BASE - candidate.sourceOrder);
  if (recencyRange.newest > recencyRange.oldest) {
    const recencyRatio =
      (candidate.timestamp - recencyRange.oldest) / (recencyRange.newest - recencyRange.oldest);
    score += recencyRatio * RECENCY_MULTIPLIER;
  }
  return score;
}

export function rankSearchCandidates(
  candidates: SearchCandidate[],
  query: string,
  limit: number,
): SearchResult[] {
  const exactQuery = query.toLowerCase();
  const tokens = tokenizeQuery(query);
  const deduped = new Map<string, SearchCandidate & { score: number }>();
  const recencyRange = buildRecencyRange(candidates);

  for (const candidate of candidates) {
    const score = scoreSearchCandidate(candidate, exactQuery, tokens, recencyRange);
    const key = `${candidate.type}:${candidate.id}`;
    const existing = deduped.get(key);
    if (
      !existing ||
      score > existing.score ||
      (score === existing.score && candidate.timestamp > existing.timestamp)
    ) {
      deduped.set(key, {
        ...candidate,
        score,
      });
    }
  }

  return [...deduped.values()]
    .sort((a, b) => b.score - a.score || b.timestamp - a.timestamp)
    .slice(0, limit)
    .map(
      ({
        content: _content,
        sourceKind: _sourceKind,
        sourceOrder: _sourceOrder,
        score: _score,
        ...result
      }) => result,
    );
}
