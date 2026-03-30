import path from 'node:path';

export function resolveWorkspacePath(workspaceDirectory: string, inputPath: string): string {
  if (path.isAbsolute(inputPath)) {
    return path.normalize(inputPath);
  }

  const workspaceRoot = path.resolve(workspaceDirectory);
  const resolvedPath = path.resolve(workspaceRoot, inputPath);
  const relativePath = path.relative(workspaceRoot, resolvedPath);

  if (relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))) {
    return resolvedPath;
  }

  throw new Error(`Path must stay within the workspace: ${inputPath}`);
}
