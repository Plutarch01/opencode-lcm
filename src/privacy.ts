import type { PrivacyOptions } from './types.js';

export const PRIVACY_REDACTION_TEXT = '[REDACTED]';
export const PRIVACY_REDACTED_PATH_TEXT = '[REDACTED_PATH]';
export const PRIVACY_EXCLUDED_TOOL_OUTPUT =
  '[Excluded tool payload by opencode-lcm privacy policy.]';
export const PRIVACY_EXCLUDED_FILE_CONTENT =
  '[Excluded file content by opencode-lcm privacy policy.]';
export const PRIVACY_EXCLUDED_FILE_REFERENCE =
  '[Excluded file reference by opencode-lcm privacy policy.]';

export type CompiledPrivacyOptions = {
  excludeToolPrefixes: string[];
  excludePathPatterns: RegExp[];
  redactPatterns: RegExp[];
};

const EXEMPT_STRING_KEYS = new Set([
  'agent',
  'artifactID',
  'callID',
  'fieldName',
  'id',
  'messageID',
  'mime',
  'modelID',
  'name',
  'nodeID',
  'parentID',
  'parentSessionID',
  'partID',
  'projectID',
  'providerID',
  'role',
  'rootSessionID',
  'sessionID',
  'status',
  'tool',
  'type',
  'urlScheme',
]);

function compilePattern(source: string): RegExp | undefined {
  try {
    const probe = new RegExp(source, 'u');
    if (probe.test('')) return undefined;
    return new RegExp(source, 'gu');
  } catch {
    return undefined;
  }
}

function applyPatterns(value: string, patterns: RegExp[], replacement: string): string {
  let next = value;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    next = next.replace(pattern, replacement);
  }
  return next;
}

function matchesPattern(value: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

export function compilePrivacyOptions(options: PrivacyOptions): CompiledPrivacyOptions {
  return {
    excludeToolPrefixes: [
      ...new Set(options.excludeToolPrefixes.filter((value) => value.length > 0)),
    ],
    excludePathPatterns: options.excludePathPatterns
      .map((source) => compilePattern(source))
      .filter((pattern): pattern is RegExp => Boolean(pattern)),
    redactPatterns: options.redactPatterns
      .map((source) => compilePattern(source))
      .filter((pattern): pattern is RegExp => Boolean(pattern)),
  };
}

export function redactText(value: string, privacy: CompiledPrivacyOptions): string {
  const redacted = applyPatterns(value, privacy.redactPatterns, PRIVACY_REDACTION_TEXT);
  return applyPatterns(redacted, privacy.excludePathPatterns, PRIVACY_REDACTED_PATH_TEXT);
}

export function redactStructuredValue<T>(
  value: T,
  privacy: CompiledPrivacyOptions,
  currentKey?: string,
): T {
  if (typeof value === 'string') {
    return (
      currentKey && EXEMPT_STRING_KEYS.has(currentKey) ? value : redactText(value, privacy)
    ) as T;
  }
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((entry) => redactStructuredValue(entry, privacy, currentKey)) as T;
  }

  const entries = Object.entries(value).map(([key, entry]) => [
    key,
    redactStructuredValue(entry, privacy, key),
  ]);
  return Object.fromEntries(entries) as T;
}

export function isExcludedTool(toolName: string, privacy: CompiledPrivacyOptions): boolean {
  return privacy.excludeToolPrefixes.some((prefix) => toolName.startsWith(prefix));
}

export function matchesExcludedPath(
  candidates: Array<string | undefined>,
  privacy: CompiledPrivacyOptions,
): boolean {
  return candidates.some(
    (candidate) =>
      typeof candidate === 'string' &&
      candidate.length > 0 &&
      privacy.excludePathPatterns.some((pattern) => matchesPattern(candidate, pattern)),
  );
}
