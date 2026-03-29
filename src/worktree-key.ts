export function normalizeWorktreeKey(directory?: string): string | undefined {
  if (!directory) return undefined;
  const normalized = directory.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return normalized || undefined;
}
