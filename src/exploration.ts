const EXPLORATION_CHAR_LIMIT = 65_536;
const MAX_ITEMS = 12;

function formatItems(label: string, items: string[], total = items.length): string {
  const shown = items.slice(0, MAX_ITEMS).join(', ');
  const overflow = total > MAX_ITEMS ? `, …+${total - MAX_ITEMS}` : '';
  return `${label}: ${shown}${overflow}`;
}

function buildJsonSummary(content: string): string | undefined {
  try {
    const value: unknown = JSON.parse(content);
    if (Array.isArray(value)) {
      const first = value[0];
      const keys =
        first && typeof first === 'object' && !Array.isArray(first)
          ? Object.keys(first as Record<string, unknown>)
          : [];
      return [
        `JSON array length=${value.length}`,
        keys.length > 0 ? formatItems('first-element keys', keys) : '',
      ]
        .filter(Boolean)
        .join('; ');
    }
    if (value && typeof value === 'object') {
      const keys = Object.keys(value as Record<string, unknown>);
      return `JSON object; ${formatItems('keys', keys)}`;
    }
    return `JSON ${value === null ? 'null' : typeof value}`;
  } catch {
    return undefined;
  }
}

function buildDelimitedSummary(content: string, delimiter: string): string | undefined {
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0 || !lines[0].trim()) return undefined;
  const columns = lines[0]
    .split(delimiter)
    .map((column) => column.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  if (columns.length === 0) return undefined;
  return `${delimiter === '\t' ? 'TSV' : 'CSV'} rows=${Math.max(0, lines.length - 1)}; ${formatItems('columns', columns)}`;
}

function buildCodeSummary(content: string): string | undefined {
  const signature =
    /^(export\s+)?(async\s+)?(function|class|interface|type|const|def|fn|func|public|private)\b.*$/;
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => signature.test(line))
    .slice(0, 8)
    .map((line) => line.slice(0, 80));
  return lines.length > 0 ? `Code signatures: ${lines.join(' | ')}` : undefined;
}

function buildSqlSummary(content: string): string | undefined {
  const tables = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^CREATE\s+TABLE\b/i.test(line))
    .slice(0, 6)
    .map((line) => line.slice(0, 120));
  return tables.length > 0 ? `SQL tables: ${tables.join(' | ')}` : undefined;
}

export function buildExplorationSummary(
  category: string,
  extension: string,
  contentText: string,
): string | undefined {
  const content = contentText.slice(0, EXPLORATION_CHAR_LIMIT);
  const ext = extension.toLowerCase().replace(/^\./, '');

  if (category === 'structured-data' && ext === 'json') return buildJsonSummary(content);
  if (category === 'spreadsheet' && (ext === 'csv' || ext === 'tsv')) {
    return buildDelimitedSummary(content, ext === 'tsv' ? '\t' : ',');
  }
  if (ext === 'sql') return buildSqlSummary(content);
  if (category === 'code') return buildCodeSummary(content);
  return undefined;
}
