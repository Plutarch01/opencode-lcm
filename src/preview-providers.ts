import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';

import type { Part } from '@opencode-ai/sdk';

import { getLogger } from './logging.js';
import { resolveWorkspacePath } from './workspace-path.js';

type FilePart = Extract<Part, { type: 'file' }>;

type PreviewContext = {
  workspaceDirectory: string;
  file: FilePart;
  category: string;
  extension?: string;
  mime?: string;
  enabledProviders: string[];
  bytePeek: number;
};

type PreviewOutput = {
  metadata: Record<string, unknown>;
  lines: string[];
  summaryBits: string[];
};

type ProviderName =
  | 'fingerprint'
  | 'byte-peek'
  | 'image-dimensions'
  | 'pdf-metadata'
  | 'zip-metadata';

type Provider = {
  name: ProviderName;
  apply(context: PreviewContext, helpers: ProviderHelpers): PreviewOutput;
};

type ProviderHelpers = {
  resolvePath(): string | undefined;
  readBytes(): Buffer | undefined;
};

function inferLocalPath(workspaceDirectory: string, file: FilePart): string | undefined {
  const sourcePath = file.source && 'path' in file.source ? file.source.path : undefined;
  if (!sourcePath) return undefined;

  try {
    return resolveWorkspacePath(workspaceDirectory, sourcePath);
  } catch (error) {
    getLogger().debug('Failed to resolve workspace path', { sourcePath, error });
    return undefined;
  }
}

function toHexPreview(buffer: Buffer, bytes: number): string | undefined {
  if (buffer.length === 0) return undefined;
  return [...buffer.subarray(0, Math.max(1, bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(' ');
}

function parsePngDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 24) return undefined;
  if (!buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return undefined;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function parseGifDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 10) return undefined;
  const header = buffer.subarray(0, 6).toString('ascii');
  if (header !== 'GIF87a' && header !== 'GIF89a') return undefined;
  return {
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8),
  };
}

function parseJpegDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const size = buffer.readUInt16BE(offset + 2);
    if (size < 2 || offset + 2 + size > buffer.length) break;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + size;
  }
  return undefined;
}

function estimatePdfPages(buffer: Buffer): number | undefined {
  const text = buffer.toString('latin1');
  const matches = text.match(/\/Type\s*\/Page([^s]|$)/g);
  return matches && matches.length > 0 ? matches.length : undefined;
}

function estimateZipEntries(buffer: Buffer): number | undefined {
  if (buffer.length < 4) return undefined;

  const localFileHeaderSignature = 0x04034b50;
  const endOfCentralDirectorySignature = 0x06054b50;
  const firstSignature = buffer.readUInt32LE(0);
  if (
    firstSignature !== localFileHeaderSignature &&
    firstSignature !== endOfCentralDirectorySignature
  ) {
    return undefined;
  }

  const searchStart = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== endOfCentralDirectorySignature) continue;
    return buffer.readUInt16LE(offset + 10);
  }

  let entries = 0;
  for (let offset = 0; offset <= buffer.length - 4; offset += 1) {
    if (buffer.readUInt32LE(offset) === localFileHeaderSignature) entries += 1;
  }
  return entries > 0 ? entries : undefined;
}

const fingerprintProvider: Provider = {
  name: 'fingerprint',
  apply(_context, helpers) {
    const filePath = helpers.resolvePath();
    const bytes = helpers.readBytes();
    if (!filePath || !bytes) return { metadata: {}, lines: [], summaryBits: [] };

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const sizeBytes = statSync(filePath).size;
    return {
      metadata: {
        previewLocalPath: filePath,
        previewSha256: sha256,
        previewSizeBytes: sizeBytes,
      },
      lines: [`Fingerprint: sha256 ${sha256} (${sizeBytes} bytes)`],
      summaryBits: [`sha256 ${sha256.slice(0, 12)}`, `${sizeBytes} bytes`],
    };
  },
};

const bytePeekProvider: Provider = {
  name: 'byte-peek',
  apply(context, helpers) {
    const bytes = helpers.readBytes();
    const preview = bytes ? toHexPreview(bytes, context.bytePeek) : undefined;
    if (!preview) return { metadata: {}, lines: [], summaryBits: [] };

    return {
      metadata: {
        previewBytePeekHex: preview,
      },
      lines: [`Byte peek: ${preview}`],
      summaryBits: [`peek ${preview}`],
    };
  },
};

const imageDimensionsProvider: Provider = {
  name: 'image-dimensions',
  apply(context, helpers) {
    if (context.category !== 'image') return { metadata: {}, lines: [], summaryBits: [] };
    const bytes = helpers.readBytes();
    if (!bytes) return { metadata: {}, lines: [], summaryBits: [] };

    const dimensions =
      parsePngDimensions(bytes) ?? parseGifDimensions(bytes) ?? parseJpegDimensions(bytes);
    if (!dimensions) return { metadata: {}, lines: [], summaryBits: [] };

    return {
      metadata: {
        previewImageWidth: dimensions.width,
        previewImageHeight: dimensions.height,
      },
      lines: [`Image dimensions: ${dimensions.width}x${dimensions.height}`],
      summaryBits: [`${dimensions.width}x${dimensions.height}`],
    };
  },
};

const pdfMetadataProvider: Provider = {
  name: 'pdf-metadata',
  apply(context, helpers) {
    if (context.category !== 'pdf') return { metadata: {}, lines: [], summaryBits: [] };
    const bytes = helpers.readBytes();
    if (!bytes) return { metadata: {}, lines: [], summaryBits: [] };
    const pageEstimate = estimatePdfPages(bytes);
    if (!pageEstimate) return { metadata: {}, lines: [], summaryBits: [] };

    return {
      metadata: {
        previewPdfPageEstimate: pageEstimate,
      },
      lines: [`PDF page estimate: ${pageEstimate}`],
      summaryBits: [`${pageEstimate} page${pageEstimate === 1 ? '' : 's'}`],
    };
  },
};

const zipMetadataProvider: Provider = {
  name: 'zip-metadata',
  apply(_context, helpers) {
    const bytes = helpers.readBytes();
    if (!bytes) return { metadata: {}, lines: [], summaryBits: [] };
    const entryCount = estimateZipEntries(bytes);
    if (entryCount === undefined) return { metadata: {}, lines: [], summaryBits: [] };

    return {
      metadata: {
        previewZipEntryCount: entryCount,
      },
      lines: [`ZIP entries: ${entryCount}`],
      summaryBits: [`${entryCount} entr${entryCount === 1 ? 'y' : 'ies'}`],
    };
  },
};

const PROVIDERS: Provider[] = [
  fingerprintProvider,
  bytePeekProvider,
  imageDimensionsProvider,
  pdfMetadataProvider,
  zipMetadataProvider,
];

export function runBinaryPreviewProviders(context: PreviewContext): PreviewOutput {
  let resolvedPath: string | undefined;
  let resolvedBytes: Buffer | undefined;

  const helpers: ProviderHelpers = {
    resolvePath() {
      if (resolvedPath !== undefined) return resolvedPath;
      const localPath = inferLocalPath(context.workspaceDirectory, context.file);
      resolvedPath = localPath && existsSync(localPath) ? localPath : undefined;
      return resolvedPath;
    },
    readBytes() {
      if (resolvedBytes !== undefined) return resolvedBytes;
      const filePath = helpers.resolvePath();
      if (!filePath) return undefined;
      try {
        resolvedBytes = readFileSync(filePath);
      } catch (error) {
        getLogger().debug('Failed to read file bytes for preview', { filePath, error });
        resolvedBytes = undefined;
      }
      return resolvedBytes;
    },
  };

  const enabled = new Set(context.enabledProviders);
  const outputs = PROVIDERS.filter((provider) => enabled.has(provider.name)).map((provider) => ({
    name: provider.name,
    output: provider.apply(context, helpers),
  }));

  const metadata: Record<string, unknown> = {
    previewProviders: outputs
      .filter(
        (entry) => Object.keys(entry.output.metadata).length > 0 || entry.output.lines.length > 0,
      )
      .map((entry) => entry.name),
  };
  const lines: string[] = [];
  const summaryBits: string[] = [];

  for (const entry of outputs) {
    Object.assign(metadata, entry.output.metadata);
    lines.push(...entry.output.lines);
    summaryBits.push(...entry.output.summaryBits);
  }

  return {
    metadata,
    lines,
    summaryBits,
  };
}
