import { randomUUID } from 'node:crypto';

import type { Message, Part } from '@opencode-ai/sdk';
import { runBinaryPreviewProviders } from './preview-providers.js';
import {
  type CompiledPrivacyOptions,
  isExcludedTool,
  matchesExcludedPath,
  PRIVACY_EXCLUDED_FILE_CONTENT,
  PRIVACY_EXCLUDED_FILE_REFERENCE,
  PRIVACY_EXCLUDED_TOOL_OUTPUT,
  PRIVACY_REDACTED_PATH_TEXT,
  redactStructuredValue,
  redactText,
} from './privacy.js';
import type { ArtifactBlobRow, ArtifactRow } from './store-snapshot.js';
import type { SqlDatabaseLike } from './store-types.js';
import type { ConversationMessage, NormalizedSession } from './types.js';
import {
  classifyFileCategory,
  formatMetadataValue,
  hashContent,
  inferFileExtension,
  inferUrlScheme,
  parseJson,
  sanitizeAutomaticRetrievalSourceText,
  truncate,
} from './utils.js';

export type ArtifactData = {
  artifactID: string;
  sessionID: string;
  messageID: string;
  partID: string;
  artifactKind: string;
  fieldName: string;
  previewText: string;
  contentText: string;
  contentHash: string;
  charCount: number;
  createdAt: number;
  metadata: Record<string, unknown>;
};

export type ExternalizedMessage = {
  storedMessage: ConversationMessage;
  artifacts: ArtifactData[];
};

export type ExternalizedSession = {
  storedSession: NormalizedSession;
  artifacts: ArtifactData[];
};

export type StoreArtifactBindings = {
  workspaceDirectory: string;
  options: {
    artifactPreviewChars: number;
    binaryPreviewProviders: string[];
    largeContentThreshold: number;
    previewBytePeek: number;
    privacy: CompiledPrivacyOptions;
  };
  getDb(): SqlDatabaseLike;
  readArtifactBlobSync(contentHash?: string | null): ArtifactBlobRow | undefined;
  upsertSessionRowSync(session: NormalizedSession): void;
  upsertMessageInfoSync(sessionID: string, message: ConversationMessage): void;
  deleteMessageSync(sessionID: string, messageID: string): void;
  replaceMessageSearchRowSync(sessionID: string, message: ConversationMessage): void;
  replaceMessageSearchRowsSync(session: NormalizedSession): void;
};

function artifactPlaceholder(
  artifactID: string,
  label: string,
  preview: string,
  charCount: number,
): string {
  const body = preview ? ` Preview: ${preview}` : '';
  return `[Externalized ${label} as ${artifactID} (${charCount} chars). Use lcm_artifact for full content.]${body}`;
}

function fileCategoryHint(category: string): string {
  switch (category) {
    case 'image':
      return 'Visual asset or screenshot; exact pixels still require the source file.';
    case 'pdf':
      return 'Formatted document; exact layout and embedded pages still require the source file.';
    case 'audio':
      return 'Audio asset; waveform and transcription details still require the source file.';
    case 'video':
      return 'Video asset; frames and timing still require the source file.';
    case 'archive':
      return 'Bundled archive; internal file listing still requires unpacking the source file.';
    case 'spreadsheet':
      return 'Spreadsheet-like document; formulas and cell layout may require the source file.';
    case 'presentation':
      return 'Slide deck; visual layout and speaker notes may require the source file.';
    case 'document':
      return 'Rich document; styled content and embedded assets may require the source file.';
    case 'code':
      return 'Code or source-like file reference; load the file body if exact lines matter.';
    case 'structured-data':
      return 'Structured data file reference; exact records may require the full source body.';
    default:
      return 'Binary or opaque artifact reference; inspect the original file for exact contents.';
  }
}

function createArtifactData(
  bindings: StoreArtifactBindings,
  input: {
    sessionID: string;
    messageID: string;
    partID: string;
    artifactKind: string;
    fieldName: string;
    contentText: string;
    createdAt: number;
    metadata?: Record<string, unknown>;
    previewText?: string;
  },
): ArtifactData {
  const contentText = redactText(input.contentText, bindings.options.privacy);
  const metadata = redactStructuredValue(input.metadata ?? {}, bindings.options.privacy);
  const previewText = redactText(
    input.previewText ??
      truncate(contentText.replace(/\s+/g, ' ').trim(), bindings.options.artifactPreviewChars),
    bindings.options.privacy,
  );
  const contentHash = hashContent(contentText);
  return {
    artifactID: `art_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    sessionID: input.sessionID,
    messageID: input.messageID,
    partID: input.partID,
    artifactKind: input.artifactKind,
    fieldName: input.fieldName,
    previewText,
    contentText,
    contentHash,
    charCount: contentText.length,
    createdAt: input.createdAt,
    metadata,
  };
}

function filePrivacyCandidates(file: Extract<Part, { type: 'file' }>): Array<string | undefined> {
  const sourcePath = file.source && 'path' in file.source ? file.source.path : undefined;
  return [file.filename, file.url, sourcePath];
}

function excludeStoredFilePart(file: Extract<Part, { type: 'file' }>): void {
  file.filename = PRIVACY_EXCLUDED_FILE_REFERENCE;
  file.url = 'lcm://privacy-excluded';
  if (file.source && 'path' in file.source) file.source.path = PRIVACY_REDACTED_PATH_TEXT;
  if (file.source?.text?.value) {
    file.source.text.value = PRIVACY_EXCLUDED_FILE_CONTENT;
    file.source.text.start = 0;
    file.source.text.end = file.source.text.value.length;
  }
}

export function formatArtifactMetadataLines(metadata: Record<string, unknown>): string[] {
  const lines = Object.entries(metadata)
    .map(([key, value]) => {
      const formatted = formatMetadataValue(value);
      return formatted ? `${key}: ${formatted}` : undefined;
    })
    .filter((line): line is string => Boolean(line));

  return lines.length > 0 ? ['Metadata:', ...lines] : [];
}

export function buildArtifactSearchContent(artifact: ArtifactData): string {
  const metadata = Object.entries(artifact.metadata)
    .map(([key, value]) => {
      const formatted = formatMetadataValue(value);
      return formatted ? `${key}: ${formatted}` : undefined;
    })
    .filter((line): line is string => Boolean(line))
    .join('\n');

  return [artifact.previewText, metadata, artifact.contentText].filter(Boolean).join('\n');
}

function buildFileArtifactMetadata(
  file: Extract<Part, { type: 'file' }>,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  const sourcePath = file.source && 'path' in file.source ? file.source.path : undefined;
  const extension = inferFileExtension(file.filename ?? sourcePath ?? file.url);
  const category = classifyFileCategory(file.mime, extension);
  return {
    category,
    extension,
    mime: file.mime,
    filename: file.filename,
    url: file.url,
    urlScheme: inferUrlScheme(file.url),
    sourceType: file.source?.type,
    sourcePath,
    hint: fileCategoryHint(category),
    ...extras,
  };
}

async function buildBinaryPreviewArtifact(
  bindings: StoreArtifactBindings,
  file: Extract<Part, { type: 'file' }>,
  fieldName: string,
  label: string,
  createdAt: number,
  extras: Record<string, unknown> = {},
): Promise<ArtifactData> {
  const baseMetadata = buildFileArtifactMetadata(file, extras);
  const category = typeof baseMetadata.category === 'string' ? baseMetadata.category : 'binary';
  const extension = typeof baseMetadata.extension === 'string' ? baseMetadata.extension : undefined;
  const name =
    file.filename ??
    (typeof baseMetadata.sourcePath === 'string' ? baseMetadata.sourcePath : undefined) ??
    file.url ??
    'unknown file';
  const previewDetails = await runBinaryPreviewProviders({
    workspaceDirectory: bindings.workspaceDirectory,
    file,
    category,
    extension,
    mime: file.mime,
    enabledProviders: bindings.options.binaryPreviewProviders,
    bytePeek: bindings.options.previewBytePeek,
  });
  const summary = previewDetails.summaryBits.slice(0, 3).join(', ');
  const contentText = [
    `${label}`,
    `Category: ${category}`,
    `Name: ${name}`,
    ...(typeof baseMetadata.sourcePath === 'string' ? [`Path: ${baseMetadata.sourcePath}`] : []),
    ...(file.mime ? [`MIME: ${file.mime}`] : []),
    ...(extension ? [`Extension: ${extension}`] : []),
    ...(typeof baseMetadata.urlScheme === 'string'
      ? [`URL scheme: ${baseMetadata.urlScheme}`]
      : []),
    ...(file.url ? [`URL: ${file.url}`] : []),
    ...(typeof baseMetadata.hint === 'string' ? [`Hint: ${baseMetadata.hint}`] : []),
    ...previewDetails.lines,
  ].join('\n');
  const previewText = truncate(
    `${label}: ${name} (${category}${summary ? `, ${summary}` : ''})`,
    bindings.options.artifactPreviewChars,
  );

  return createArtifactData(bindings, {
    sessionID: file.sessionID,
    messageID: file.messageID,
    partID: file.id,
    artifactKind: 'file',
    fieldName,
    contentText,
    createdAt,
    metadata: { ...baseMetadata, ...previewDetails.metadata },
    previewText,
  });
}

async function externalizePart(
  bindings: StoreArtifactBindings,
  part: Part,
  createdAt: number,
): Promise<{
  storedPart: Part;
  artifacts: ArtifactData[];
}> {
  const storedPart = parseJson<Part>(JSON.stringify(part));
  const artifacts: ArtifactData[] = [];
  const privacy = bindings.options.privacy;

  const externalize = (
    artifactKind: string,
    fieldName: string,
    value: string,
    metadata: Record<string, unknown> = {},
    previewText?: string,
    sanitize = false,
  ): string => {
    const contentText = sanitize ? sanitizeAutomaticRetrievalSourceText(value) : value;
    if (contentText.length < bindings.options.largeContentThreshold) return contentText;

    const artifact = createArtifactData(bindings, {
      sessionID: storedPart.sessionID,
      messageID: storedPart.messageID,
      partID: storedPart.id,
      artifactKind,
      fieldName,
      contentText,
      createdAt,
      metadata,
      previewText,
    });
    artifacts.push(artifact);
    return artifactPlaceholder(
      artifact.artifactID,
      `${artifactKind}/${fieldName}`,
      artifact.previewText,
      artifact.charCount,
    );
  };

  switch (storedPart.type) {
    case 'text':
      storedPart.text = externalize('message', 'text', storedPart.text, {}, undefined, true);
      if (artifacts.length > 0) {
        storedPart.metadata = {
          ...(storedPart.metadata ?? {}),
          opencodeLcmArtifact: artifacts.map((artifact) => artifact.artifactID),
        };
      }
      break;
    case 'reasoning':
      storedPart.text = externalize('reasoning', 'text', storedPart.text, {}, undefined, true);
      if (artifacts.length > 0) {
        storedPart.metadata = {
          ...(storedPart.metadata ?? {}),
          opencodeLcmArtifact: artifacts.map((artifact) => artifact.artifactID),
        };
      }
      break;
    case 'tool':
      if (isExcludedTool(storedPart.tool, privacy)) {
        storedPart.state.input = { excluded: true };
        if ('metadata' in storedPart.state) storedPart.state.metadata = { excluded: true };
        if (storedPart.state.status === 'completed') {
          storedPart.state.output = PRIVACY_EXCLUDED_TOOL_OUTPUT;
          storedPart.state.attachments = [];
        }
        if (storedPart.state.status === 'error') {
          storedPart.state.error = PRIVACY_EXCLUDED_TOOL_OUTPUT;
        }
        break;
      }
      if (storedPart.state.status === 'completed') {
        storedPart.state.output = externalize(
          'tool',
          'output',
          storedPart.state.output,
          {},
          undefined,
          true,
        );
        if (storedPart.state.attachments) {
          const storedAttachments: Extract<Part, { type: 'file' }>[] = [];
          for (const [index, attachment] of storedPart.state.attachments.entries()) {
            if (matchesExcludedPath(filePrivacyCandidates(attachment), privacy)) {
              excludeStoredFilePart(attachment);
              storedAttachments.push(attachment);
              continue;
            }
            const previewMetadata = {
              attachmentIndex: index,
              tool: storedPart.tool,
              title: storedPart.state.status === 'completed' ? storedPart.state.title : undefined,
            };
            artifacts.push(
              await buildBinaryPreviewArtifact(
                bindings,
                attachment,
                `attachment:${index}`,
                `Tool attachment for ${storedPart.tool}`,
                createdAt,
                previewMetadata,
              ),
            );

            if (attachment.source?.text?.value) {
              attachment.source.text.value = externalize(
                'file',
                `attachment_text:${index}`,
                attachment.source.text.value,
                buildFileArtifactMetadata(attachment, previewMetadata),
              );
              attachment.source.text.start = 0;
              attachment.source.text.end = attachment.source.text.value.length;
            }
            storedAttachments.push(attachment);
          }
          storedPart.state.attachments = storedAttachments;
        }
      }
      if (storedPart.state.status === 'error') {
        storedPart.state.error = externalize(
          'tool',
          'error',
          storedPart.state.error,
          {},
          undefined,
          true,
        );
      }
      break;
    case 'file':
      if (matchesExcludedPath(filePrivacyCandidates(storedPart), privacy)) {
        excludeStoredFilePart(storedPart);
        break;
      }
      artifacts.push(
        await buildBinaryPreviewArtifact(
          bindings,
          storedPart,
          'reference',
          'File reference',
          createdAt,
        ),
      );
      if (storedPart.source?.text?.value) {
        storedPart.source.text.value = externalize(
          'file',
          'source',
          storedPart.source.text.value,
          buildFileArtifactMetadata(storedPart),
        );
        storedPart.source.text.start = 0;
        storedPart.source.text.end = storedPart.source.text.value.length;
      }
      break;
    case 'snapshot':
      storedPart.snapshot = externalize(
        'snapshot',
        'snapshot',
        storedPart.snapshot,
        {},
        undefined,
        true,
      );
      break;
    case 'agent':
      if (storedPart.source?.value) {
        storedPart.source.value = externalize(
          'agent',
          'source',
          storedPart.source.value,
          {},
          undefined,
          true,
        );
        storedPart.source.start = 0;
        storedPart.source.end = storedPart.source.value.length;
      }
      break;
    case 'subtask':
      storedPart.prompt = externalize('subtask', 'prompt', storedPart.prompt, {}, undefined, true);
      storedPart.description = externalize(
        'subtask',
        'description',
        storedPart.description,
        {},
        undefined,
        true,
      );
      break;
    default:
      break;
  }

  return {
    storedPart: redactStructuredValue(storedPart, privacy),
    artifacts,
  };
}

export async function externalizeMessage(
  bindings: StoreArtifactBindings,
  message: ConversationMessage,
): Promise<ExternalizedMessage> {
  const artifacts: ArtifactData[] = [];
  const storedInfo = parseJson<Message>(JSON.stringify(message.info));
  const storedParts: Part[] = [];

  for (const part of message.parts) {
    const { storedPart, artifacts: nextArtifacts } = await externalizePart(
      bindings,
      part,
      message.info.time.created,
    );
    artifacts.push(...nextArtifacts);
    storedParts.push(storedPart);
  }

  return {
    storedMessage: {
      info: redactStructuredValue(storedInfo, bindings.options.privacy),
      parts: storedParts,
    },
    artifacts,
  };
}

export async function externalizeSession(
  bindings: StoreArtifactBindings,
  session: NormalizedSession,
): Promise<ExternalizedSession> {
  const artifacts: ArtifactData[] = [];
  const storedMessages: ConversationMessage[] = [];

  for (const message of session.messages) {
    const storedInfo = parseJson<Message>(JSON.stringify(message.info));
    const storedParts: Part[] = [];

    for (const part of message.parts) {
      const { storedPart, artifacts: nextArtifacts } = await externalizePart(
        bindings,
        part,
        message.info.time.created,
      );
      artifacts.push(...nextArtifacts);
      storedParts.push(storedPart);
    }

    storedMessages.push({
      info: redactStructuredValue(storedInfo, bindings.options.privacy),
      parts: storedParts,
    });
  }

  return {
    storedSession: redactStructuredValue(
      {
        ...session,
        messages: storedMessages,
      },
      bindings.options.privacy,
    ),
    artifacts,
  };
}

function insertArtifactsSync(bindings: StoreArtifactBindings, artifacts: ArtifactData[]): void {
  if (artifacts.length === 0) return;

  const db = bindings.getDb();
  const insertBlob = db.prepare(
    `INSERT OR IGNORE INTO artifact_blobs (content_hash, content_text, char_count, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  const insertArtifact = db.prepare(
    `INSERT INTO artifacts
     (artifact_id, session_id, message_id, part_id, artifact_kind, field_name, preview_text, content_text, content_hash, metadata_json, char_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFts = db.prepare(
    'INSERT INTO artifact_fts (session_id, artifact_id, message_id, part_id, artifact_kind, created_at, content) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );

  for (const artifact of artifacts) {
    insertBlob.run(
      artifact.contentHash,
      artifact.contentText,
      artifact.charCount,
      artifact.createdAt,
    );
    insertArtifact.run(
      artifact.artifactID,
      artifact.sessionID,
      artifact.messageID,
      artifact.partID,
      artifact.artifactKind,
      artifact.fieldName,
      artifact.previewText,
      '',
      artifact.contentHash,
      JSON.stringify(artifact.metadata),
      artifact.charCount,
      artifact.createdAt,
    );
    insertFts.run(
      artifact.sessionID,
      artifact.artifactID,
      artifact.messageID,
      artifact.partID,
      artifact.artifactKind,
      String(artifact.createdAt),
      buildArtifactSearchContent(artifact),
    );
  }
}

export function persistStoredSessionSync(
  bindings: StoreArtifactBindings,
  storedSession: NormalizedSession,
  artifacts: ArtifactData[],
): void {
  const db = bindings.getDb();
  bindings.upsertSessionRowSync(storedSession);

  db.prepare('DELETE FROM artifact_fts WHERE session_id = ?').run(storedSession.sessionID);
  db.prepare('DELETE FROM artifacts WHERE session_id = ?').run(storedSession.sessionID);
  db.prepare('DELETE FROM parts WHERE session_id = ?').run(storedSession.sessionID);
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(storedSession.sessionID);

  const insertMessage = db.prepare(
    'INSERT INTO messages (message_id, session_id, created_at, info_json) VALUES (?, ?, ?, ?)',
  );
  const insertPart = db.prepare(
    'INSERT INTO parts (part_id, session_id, message_id, sort_key, part_json) VALUES (?, ?, ?, ?, ?)',
  );

  for (const message of storedSession.messages) {
    insertMessage.run(
      message.info.id,
      storedSession.sessionID,
      message.info.time.created,
      JSON.stringify(message.info),
    );

    message.parts.forEach((part, index) => {
      insertPart.run(part.id, storedSession.sessionID, part.messageID, index, JSON.stringify(part));
    });
  }

  insertArtifactsSync(bindings, artifacts);
  bindings.replaceMessageSearchRowsSync(storedSession);
}

export function replaceStoredMessageSync(
  bindings: StoreArtifactBindings,
  sessionID: string,
  storedMessage: ConversationMessage,
  artifacts: ArtifactData[],
): void {
  const db = bindings.getDb();

  bindings.deleteMessageSync(sessionID, storedMessage.info.id);
  bindings.upsertMessageInfoSync(sessionID, storedMessage);

  const insertPart = db.prepare(
    'INSERT INTO parts (part_id, session_id, message_id, sort_key, part_json) VALUES (?, ?, ?, ?, ?)',
  );

  storedMessage.parts.forEach((part, index) => {
    insertPart.run(part.id, sessionID, part.messageID, index, JSON.stringify(part));
  });

  insertArtifactsSync(bindings, artifacts);
  bindings.replaceMessageSearchRowSync(sessionID, storedMessage);
}

export function materializeArtifactRow(
  bindings: StoreArtifactBindings,
  row: ArtifactRow,
): ArtifactData {
  const blob = bindings.readArtifactBlobSync(row.content_hash);
  const contentText = blob?.content_text ?? row.content_text;
  return {
    artifactID: row.artifact_id,
    sessionID: row.session_id,
    messageID: row.message_id,
    partID: row.part_id,
    artifactKind: row.artifact_kind,
    fieldName: row.field_name,
    previewText: row.preview_text,
    contentText,
    contentHash: row.content_hash ?? hashContent(contentText),
    charCount: blob?.char_count ?? row.char_count,
    createdAt: row.created_at,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json || '{}'),
  };
}
