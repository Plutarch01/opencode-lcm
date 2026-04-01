import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distPath = path.join(repoRoot, 'dist', 'index.js');

if (!existsSync(distPath)) {
  console.error(`Missing build output at ${distPath}. Run npm run build first.`);
  process.exit(1);
}

const model = process.argv[2] ?? process.env.OPENCODE_LCM_DOGFOOD_MODEL ?? 'openai/gpt-5.4-mini';
const distUrl = pathToFileURL(distPath).href;
const expectedMarker = 'ZX729ALBATROSS';

function runOpencode(cwd, args) {
  if (process.platform === 'win32') {
    return spawnSync('cmd.exe', ['/c', 'opencode', ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 180000,
    });
  }

  return spawnSync('opencode', args, {
    cwd,
    encoding: 'utf8',
    timeout: 180000,
  });
}

function extractText(output) {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        const entry = JSON.parse(line);
        return entry.type === 'text' ? (entry.part?.text ?? '') : '';
      } catch {
        return '';
      }
    })
    .filter(Boolean)
    .join('');
}

function summarizeFailure(result) {
  const stdoutLine = result.stdout?.split(/\r?\n/).find(Boolean);
  const stderrLine = result.stderr?.split(/\r?\n/).find(Boolean);
  return stdoutLine || stderrLine || result.error?.message || 'no output';
}

function readTraceEntries(tracePath) {
  if (!existsSync(tracePath)) return [];
  return readFileSync(tracePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function cleanupProjectDir(projectDir, keep) {
  if (!keep) rmSync(projectDir, { recursive: true, force: true });
}

function validateResults(results) {
  const errors = [];

  for (const result of results) {
    const mode = result.enabled ? 'automatic retrieval ON' : 'automatic retrieval OFF';
    if (!result.ok) {
      errors.push(`${mode}: ${result.reason}`);
      continue;
    }
    if (!result.pluginLoaded) errors.push(`${mode}: plugin did not emit an init trace`);
    if (!result.toolKeys.includes('lcm_status'))
      errors.push(`${mode}: plugin tools did not include lcm_status`);
    if (result.transformCount === 0) errors.push(`${mode}: message transform hook never ran`);
  }

  const enabledResult = results.find((result) => result.enabled && result.ok);
  const disabledResult = results.find((result) => !result.enabled && result.ok);
  if (enabledResult) {
    if (!enabledResult.markers.includes('retrieved-context')) {
      errors.push('automatic retrieval ON: missing retrieved-context marker');
    }
    if (!enabledResult.retrievedContext?.includes(expectedMarker)) {
      errors.push('automatic retrieval ON: retrieved context did not contain the expected marker');
    }
  }
  if (disabledResult?.markers.includes('retrieved-context')) {
    errors.push('automatic retrieval OFF: unexpectedly injected retrieved-context');
  }

  return errors;
}

function runScenario(enabled) {
  const projectDir = mkdtempSync(
    path.join(tmpdir(), enabled ? 'lcm-dogfood-on-' : 'lcm-dogfood-off-'),
  );
  const pluginDir = path.join(projectDir, '.opencode', 'plugins');
  const tracePath = path.join(projectDir, 'trace.jsonl').replace(/\\/g, '/');
  mkdirSync(pluginDir, { recursive: true });

  const pluginSource = [
    `import { appendFileSync } from "node:fs";`,
    `import OpencodeLcmPlugin from ${JSON.stringify(distUrl)};`,
    `const record = (entry) => appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify(entry) + "\\n");`,
    `export const DogfoodPlugin = async (ctx) => {`,
    `  const hooks = await OpencodeLcmPlugin(ctx, {`,
    `    freshTailMessages: 1,`,
    `    minMessagesForTransform: 3,`,
    `    summaryCharBudget: 180,`,
    `    automaticRetrieval: {`,
    `      enabled: ${enabled ? 'true' : 'false'},`,
    `      maxChars: 700,`,
    `      minTokens: 2,`,
    `      maxMessageHits: 2,`,
    `      maxSummaryHits: 0,`,
    `      maxArtifactHits: 0,`,
    `    },`,
    `  });`,
    `  record({ type: "plugin-init", toolKeys: Object.keys(hooks.tool ?? {}).sort() });`,
    `  const original = hooks["experimental.chat.messages.transform"];`,
    `  return {`,
    `    ...hooks,`,
    `    "experimental.chat.messages.transform": async (input, output) => {`,
    `      if (original) await original(input, output);`,
    `      const synthetic = output.messages.flatMap((message) =>`,
    `        message.parts`,
    `          .filter((part) => part.type === "text" && part.metadata && part.metadata.opencodeLcm)`,
    `          .map((part) => ({ marker: part.metadata.opencodeLcm, text: part.text })),`,
    `      );`,
    `      record({ type: "message-transform", count: output.messages.length, synthetic });`,
    `    },`,
    `  };`,
    `};`,
  ].join('\n');

  writeFileSync(path.join(pluginDir, 'dogfood.js'), pluginSource);

  const firstPrompt =
    'Remember this incident note for later: ' +
    'alpha '.repeat(18) +
    `the exact root cause marker ${expectedMarker} and the billing shard billing_42. Reply only stored.`;
  const secondPrompt =
    'What exact root cause marker did I mention earlier? Reply only with the marker.';

  const first = runOpencode(projectDir, [
    'run',
    firstPrompt,
    '--format',
    'json',
    '--dir',
    projectDir,
    '--model',
    model,
  ]);
  if (first.status !== 0) {
    return {
      enabled,
      ok: false,
      projectDir,
      reason: `first run failed: ${summarizeFailure(first)}`,
    };
  }

  const second = runOpencode(projectDir, [
    'run',
    secondPrompt,
    '--continue',
    '--format',
    'json',
    '--dir',
    projectDir,
    '--model',
    model,
  ]);
  if (second.status !== 0) {
    return {
      enabled,
      ok: false,
      projectDir,
      reason: `second run failed: ${summarizeFailure(second)}`,
    };
  }

  const traceEntries = readTraceEntries(tracePath);
  const pluginInit = traceEntries.find((entry) => entry.type === 'plugin-init');
  const transforms = traceEntries.filter((entry) => entry.type === 'message-transform');
  const lastTrace = transforms.at(-1) ?? { synthetic: [] };

  return {
    enabled,
    ok: true,
    projectDir,
    answer: extractText(second.stdout ?? ''),
    pluginLoaded: Boolean(pluginInit),
    toolKeys: pluginInit?.toolKeys ?? [],
    transformCount: transforms.length,
    markers: lastTrace.synthetic.map((entry) => entry.marker),
    retrievedContext: lastTrace.synthetic.find((entry) => entry.marker === 'retrieved-context')
      ?.text,
  };
}

const results = [runScenario(false), runScenario(true)];
const keepProjects = process.env.OPENCODE_LCM_DOGFOOD_KEEP === '1';
const validationErrors = validateResults(results);

console.log(`Model: ${model}`);
for (const result of results) {
  const mode = result.enabled ? 'automatic retrieval ON' : 'automatic retrieval OFF';
  if (!result.ok) {
    console.log(`${mode}: FAILED`);
    console.log(`- reason: ${result.reason}`);
    console.log(`- temp project: ${result.projectDir}`);
    continue;
  }

  console.log(`${mode}:`);
  console.log(`- answer: ${result.answer || '(empty)'}`);
  console.log(`- plugin loaded: ${result.pluginLoaded}`);
  console.log(`- transform count: ${result.transformCount}`);
  console.log(`- tool keys include lcm_status: ${result.toolKeys.includes('lcm_status')}`);
  console.log(`- markers: ${result.markers.join(', ') || 'none'}`);
  if (result.retrievedContext) {
    const preview =
      result.retrievedContext.split('\n').find((line) => line.startsWith('- message ')) ??
      result.retrievedContext.split('\n')[0];
    console.log(`- retrieved context: ${preview}`);
  }
}

const enabledResult = results.find((result) => result.enabled && result.ok);
const disabledResult = results.find((result) => !result.enabled && result.ok);
if (enabledResult && disabledResult) {
  const enabledHit = enabledResult.markers.includes('retrieved-context');
  const disabledHit = disabledResult.markers.includes('retrieved-context');
  console.log(`Verdict: enabled_hit=${enabledHit} disabled_hit=${disabledHit}`);
}

if (validationErrors.length > 0) {
  console.log('Smoke test FAILED:');
  for (const error of validationErrors) console.log(`- ${error}`);
  process.exit(1);
}

console.log('Smoke test passed.');
for (const result of results) {
  if (!result.ok || keepProjects) continue;
  cleanupProjectDir(result.projectDir, keepProjects);
}
