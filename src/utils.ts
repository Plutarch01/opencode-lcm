import { createHash } from 'node:crypto';

/**
 * Shared pure utility functions used across the LCM codebase.
 * These functions have no dependencies on store internals or external types.
 */

// --- Type guards ---

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function firstFiniteNumber(value: unknown): number | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  for (const entry of Object.values(record)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
  }

  return undefined;
}

// --- String utilities ---

export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3))}...`;
}

export function shortNodeID(nodeID: string): string {
  return nodeID.length <= 32 ? nodeID : `${nodeID.slice(0, 20)}...${nodeID.slice(-8)}`;
}

export function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

// --- Number utilities ---

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// --- Hashing ---

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// --- Query tokenization ---

export function tokenizeQuery(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9_]+/g) ?? [])];
}

/** FTS5 reserved words that would be interpreted as operators/syntax inside MATCH. */
export const FTS5_RESERVED = new Set([
  'and',
  'or',
  'not',
  'near',
  'order',
  'by',
  'asc',
  'desc',
  'limit',
  'offset',
  'match',
  'rank',
  'rowid',
  'bm25',
  'highlight',
  'snippet',
  'replace',
  'delete',
  'insert',
  'update',
  'select',
  'from',
  'where',
  'group',
  'having',
]);

/** Drop FTS5-reserved words and too-short tokens to keep MATCH queries safe. */
export function sanitizeFtsTokens(tokens: string[]): string[] {
  return tokens.filter((t) => t.length >= 2 && !FTS5_RESERVED.has(t));
}

// --- Snippet extraction ---

export function buildSnippet(content: string, query?: string, limit = 280): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (!query) return truncate(normalized, limit);

  const lower = normalized.toLowerCase();
  const exact = query.toLowerCase();
  let index = lower.indexOf(exact);
  if (index < 0) {
    for (const token of tokenizeQuery(query)) {
      index = lower.indexOf(token);
      if (index >= 0) break;
    }
  }

  if (index < 0) return truncate(normalized, limit);
  const start = Math.max(0, index - 90);
  const end = Math.min(normalized.length, index + Math.max(exact.length, 32) + 150);
  return truncate(normalized.slice(start, end), limit);
}

// --- Automatic retrieval text sanitization ---

const AUTOMATIC_RETRIEVAL_NOISE_PATTERNS = [
  /<system-reminder>/i,
  /system[-\s[\]]*reminder/i,
  /\[archived by opencode-lcm:/i,
  /recall telemetry:/i,
  /recalled context:/i,
  /your operational mode has changed/i,
  /opencode-lcm automatically recalled/i,
  /treat recalled archive as supporting context/i,
  /use lcm_(describe|grep|resume|expand|artifact)/i,
];

const AUTOMATIC_RETRIEVAL_STOPWORDS = new Set([
  'a',
  'about',
  'again',
  'all',
  'also',
  'an',
  'and',
  'ahead',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'can',
  'continue',
  'did',
  'do',
  'does',
  'exact',
  'for',
  'from',
  'get',
  'give',
  'had',
  'has',
  'have',
  'help',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'make',
  'me',
  'mention',
  'mentioned',
  'more',
  'need',
  'of',
  'on',
  'or',
  'our',
  'only',
  'ok',
  'okay',
  'please',
  'previous',
  'recall',
  'remind',
  'reply',
  'say',
  'said',
  'show',
  'so',
  'sure',
  'still',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'up',
  'use',
  'using',
  'want',
  'was',
  'we',
  'yes',
  'yep',
  'earlier',
  'what',
  'when',
  'where',
  'which',
  'who',
  'with',
  'would',
  'you',
  'your',
  'thank',
  'thanks',
  'confirm',
  'confirmed',
]);

export function sanitizeAutomaticRetrievalSourceText(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<system-reminder>/gi, ' ')
    .replace(/<\/system-reminder>/gi, ' ')
    .replace(/\[Archived by opencode-lcm:[^\]]*\]/gi, ' ')
    .replace(/Recall telemetry:[^\n]*/gi, ' ')
    .replace(/Recalled context:/gi, ' ')
    .replace(/Archived roots:/gi, ' ')
    .replace(/Treat recalled archive as supporting context[^\n]*/gi, ' ')
    .replace(/Use lcm_(describe|grep|resume|expand|artifact)[^\n]*/gi, ' ')
    .replace(/opencode-lcm automatically recalled[^\n]*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isAutomaticRetrievalNoise(text: string): boolean {
  return AUTOMATIC_RETRIEVAL_NOISE_PATTERNS.some((pattern) => pattern.test(text));
}

export function filterIntentTokens(tokens: string[]): string[] {
  return tokens.filter((token) => {
    if (AUTOMATIC_RETRIEVAL_STOPWORDS.has(token)) return false;
    if (token.length >= 3) return true;
    return /\d/.test(token) || token.includes('_');
  });
}

export function shouldSuppressLowSignalAutomaticRetrievalAnchor(
  anchorText: string,
  anchorSignalCount: number,
  minTokens: number,
  anchorFileCount: number,
): boolean {
  if (anchorSignalCount >= minTokens) return false;
  if (anchorFileCount > 0) return false;
  if (anchorText.includes('?')) return false;

  const rawTokenCount = tokenizeQuery(anchorText).length;
  return rawTokenCount <= 4;
}

// --- URL and file utilities ---

export function inferUrlScheme(url?: string): string | undefined {
  if (!url) return undefined;
  const index = url.indexOf(':');
  if (index <= 0) return undefined;
  return url.slice(0, index).toLowerCase();
}

export function inferFileExtension(file?: string): string | undefined {
  if (!file) return undefined;
  const cleaned = file.replace(/\\/g, '/').split('/').pop() ?? file;
  const index = cleaned.lastIndexOf('.');
  if (index <= 0 || index === cleaned.length - 1) return undefined;
  return cleaned.slice(index + 1).toLowerCase();
}

export function classifyFileCategory(mime?: string, extension?: string): string {
  const kind = mime?.toLowerCase() ?? '';
  const ext = extension?.toLowerCase() ?? '';

  if (kind.startsWith('image/')) return 'image';
  if (kind === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (kind.startsWith('audio/')) return 'audio';
  if (kind.startsWith('video/')) return 'video';
  if (
    kind.includes('zip') ||
    kind.includes('tar') ||
    kind.includes('gzip') ||
    ['zip', 'tar', 'gz', 'tgz', 'rar', '7z'].includes(ext)
  )
    return 'archive';
  if (kind.includes('spreadsheet') || ['xls', 'xlsx', 'ods', 'csv', 'tsv'].includes(ext))
    return 'spreadsheet';
  if (kind.includes('presentation') || ['ppt', 'pptx', 'odp', 'key'].includes(ext))
    return 'presentation';
  if (
    kind.includes('word') ||
    kind.includes('document') ||
    ['doc', 'docx', 'odt', 'rtf'].includes(ext)
  )
    return 'document';
  if (kind.startsWith('text/') || ['txt', 'md', 'rst', 'log'].includes(ext)) return 'text';
  if (
    [
      'ts',
      'tsx',
      'js',
      'jsx',
      'py',
      'rb',
      'go',
      'rs',
      'java',
      'kt',
      'c',
      'cpp',
      'h',
      'hpp',
      'cs',
      'php',
      'swift',
      'scala',
      'pl',
      'pm',
      'sh',
      'bash',
      'zsh',
      'fish',
      'ps1',
      'bat',
      'cmd',
    ].includes(ext)
  )
    return 'code';
  if (
    [
      'html',
      'htm',
      'xml',
      'json',
      'yaml',
      'yml',
      'toml',
      'ini',
      'cfg',
      'conf',
      'env',
      'sql',
      'graphql',
      'gql',
    ].includes(ext)
  )
    return 'structured-data';
  return 'binary';
}

// --- Formatting utilities ---

export function formatMetadataValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const items = value.map((item) => formatMetadataValue(item)).filter(Boolean);
    return items.length > 0 ? items.join(', ') : undefined;
  }
  if (value && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return undefined;
}

export function formatRetentionDays(value?: number): string {
  return value === undefined ? 'disabled' : String(value);
}
