import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runBinaryPreviewProviders } from "../dist/preview-providers.js";

type PreviewContext = Parameters<typeof runBinaryPreviewProviders>[0];
type FilePart = PreviewContext["file"];
type FileSource = Extract<NonNullable<FilePart["source"]>, { type: "file" }>;

function makeWorkspace(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), `${prefix}-`));
}

function cleanupWorkspace(workspace: string): void {
  rmSync(workspace, { recursive: true, force: true });
}

function writeFixtureFile(workspace: string, relativePath: string, content: string | Buffer): string {
  const filePath = path.join(workspace, relativePath);
  writeFileSync(filePath, content);
  return filePath;
}

function makeFilePart(filePath: string): FilePart {
  return {
    id: "file-1",
    sessionID: "session-1",
    messageID: "message-1",
    type: "file",
    mime: "application/octet-stream",
    filename: path.basename(filePath),
    url: pathToFileURL(filePath).href,
    source: {
      type: "file",
      path: filePath,
      text: {
        value: "fixture",
        start: 0,
        end: 7,
      },
    },
  };
}

test("runs fingerprint and byte peek preview providers", () => {
  const workspace = makeWorkspace("preview-providers-text");

  try {
    const filePath = writeFixtureFile(workspace, "note.txt", "hello world");
    const output = runBinaryPreviewProviders({
      workspaceDirectory: workspace,
      file: makeFilePart(filePath),
      category: "document",
      extension: "txt",
      mime: "text/plain",
      enabledProviders: ["fingerprint", "byte-peek"],
      bytePeek: 4,
    });

    assert.deepEqual(output.metadata.previewProviders, ["fingerprint", "byte-peek"]);
    assert.match(output.lines[0], /Fingerprint: sha256/);
    assert.equal(output.lines[1], "Byte peek: 68 65 6c 6c");
    assert.equal(output.metadata.previewLocalPath, filePath);
    assert.equal(output.metadata.previewSizeBytes, 11);
    assert.equal(output.metadata.previewBytePeekHex, "68 65 6c 6c");
    assert.equal(output.summaryBits.length, 3);
    assert.match(output.summaryBits[0], /^sha256 /);
    assert.equal(output.summaryBits[1], "11 bytes");
    assert.equal(output.summaryBits[2], "peek 68 65 6c 6c");
  } finally {
    cleanupWorkspace(workspace);
  }
});

test("detects PNG image dimensions", () => {
  const workspace = makeWorkspace("preview-providers-png");

  try {
    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x05,
      0x08, 0x06, 0x00, 0x00, 0x00,
    ]);
    const filePath = writeFixtureFile(workspace, "image.png", bytes);
    const output = runBinaryPreviewProviders({
      workspaceDirectory: workspace,
      file: makeFilePart(filePath),
      category: "image",
      extension: "png",
      mime: "image/png",
      enabledProviders: ["image-dimensions"],
      bytePeek: 4,
    });

    assert.deepEqual(output.metadata.previewProviders, ["image-dimensions"]);
    assert.equal(output.metadata.previewImageWidth, 3);
    assert.equal(output.metadata.previewImageHeight, 5);
    assert.deepEqual(output.lines, ["Image dimensions: 3x5"]);
    assert.deepEqual(output.summaryBits, ["3x5"]);
  } finally {
    cleanupWorkspace(workspace);
  }
});

test("detects JPEG image dimensions", () => {
  const workspace = makeWorkspace("preview-providers-jpeg");

  try {
    const bytes = Buffer.from([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x04, 0x00, 0x06, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    ]);
    const filePath = writeFixtureFile(workspace, "image.jpg", bytes);
    const output = runBinaryPreviewProviders({
      workspaceDirectory: workspace,
      file: makeFilePart(filePath),
      category: "image",
      extension: "jpg",
      mime: "image/jpeg",
      enabledProviders: ["image-dimensions"],
      bytePeek: 4,
    });

    assert.deepEqual(output.metadata.previewProviders, ["image-dimensions"]);
    assert.equal(output.metadata.previewImageWidth, 6);
    assert.equal(output.metadata.previewImageHeight, 4);
    assert.deepEqual(output.lines, ["Image dimensions: 6x4"]);
    assert.deepEqual(output.summaryBits, ["6x4"]);
  } finally {
    cleanupWorkspace(workspace);
  }
});

test("detects PDF page estimates", () => {
  const workspace = makeWorkspace("preview-providers-pdf");

  try {
    const filePath = writeFixtureFile(
      workspace,
      "doc.pdf",
      Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n2 0 obj\n<< /Type /Page >>\nendobj\n", "ascii"),
    );
    const output = runBinaryPreviewProviders({
      workspaceDirectory: workspace,
      file: makeFilePart(filePath),
      category: "pdf",
      extension: "pdf",
      mime: "application/pdf",
      enabledProviders: ["pdf-metadata"],
      bytePeek: 4,
    });

    assert.deepEqual(output.metadata.previewProviders, ["pdf-metadata"]);
    assert.equal(output.metadata.previewPdfPageEstimate, 2);
    assert.deepEqual(output.lines, ["PDF page estimate: 2"]);
    assert.deepEqual(output.summaryBits, ["2 pages"]);
  } finally {
    cleanupWorkspace(workspace);
  }
});

test("ignores file paths outside the workspace", () => {
  const workspace = makeWorkspace("preview-providers-safe");
  const outside = makeWorkspace("preview-providers-outside");

  try {
    const outsideFile = writeFixtureFile(outside, "secret.txt", "top secret bytes");
    const relativeOutsidePath = path.relative(workspace, outsideFile);
    const filePart = makeFilePart(outsideFile);
    const output = runBinaryPreviewProviders({
      workspaceDirectory: workspace,
      file: {
        ...filePart,
        source: {
          ...(filePart.source as FileSource),
          path: relativeOutsidePath,
        },
      },
      category: "document",
      extension: "txt",
      mime: "text/plain",
      enabledProviders: ["fingerprint", "byte-peek"],
      bytePeek: 8,
    });

    assert.deepEqual(output.metadata.previewProviders, []);
    assert.deepEqual(output.lines, []);
    assert.deepEqual(output.summaryBits, []);
  } finally {
    cleanupWorkspace(workspace);
    cleanupWorkspace(outside);
  }
});
