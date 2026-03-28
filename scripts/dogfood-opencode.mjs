import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distPath = path.join(repoRoot, "dist", "index.js");

if (!existsSync(distPath)) {
  console.error(`Missing build output at ${distPath}. Run npm run build first.`);
  process.exit(1);
}

const model = process.argv[2] ?? process.env.OPENCODE_LCM_DOGFOOD_MODEL ?? "openai/gpt-5.4-mini";
const distUrl = pathToFileURL(distPath).href;

function runOpencode(cwd, args) {
  if (process.platform === "win32") {
    return spawnSync("cmd.exe", ["/c", "opencode", ...args], {
      cwd,
      encoding: "utf8",
      timeout: 180000,
    });
  }

  return spawnSync("opencode", args, {
    cwd,
    encoding: "utf8",
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
        return entry.type === "text" ? entry.part?.text ?? "" : "";
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .join("");
}

function summarizeFailure(result) {
  const stdoutLine = result.stdout?.split(/\r?\n/).find(Boolean);
  const stderrLine = result.stderr?.split(/\r?\n/).find(Boolean);
  return stdoutLine || stderrLine || result.error?.message || "no output";
}

function runScenario(enabled) {
  const projectDir = mkdtempSync(path.join(tmpdir(), enabled ? "lcm-dogfood-on-" : "lcm-dogfood-off-"));
  const pluginDir = path.join(projectDir, ".opencode", "plugins");
  const tracePath = path.join(projectDir, "trace.jsonl").replace(/\\/g, "/");
  mkdirSync(pluginDir, { recursive: true });

  const pluginSource = [
    `import { appendFileSync } from "node:fs";`,
    `import OpencodeLcmPlugin from ${JSON.stringify(distUrl)};`,
    `export const DogfoodPlugin = async (ctx) => {`,
    `  const hooks = await OpencodeLcmPlugin(ctx, {`,
    `    freshTailMessages: 1,`,
    `    minMessagesForTransform: 3,`,
    `    summaryCharBudget: 180,`,
    `    automaticRetrieval: {`,
    `      enabled: ${enabled ? "true" : "false"},`,
    `      maxChars: 700,`,
    `      minTokens: 2,`,
    `      maxMessageHits: 2,`,
    `      maxSummaryHits: 0,`,
    `      maxArtifactHits: 0,`,
    `    },`,
    `  });`,
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
    `      appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify({ count: output.messages.length, synthetic }) + "\\n");`,
    `    },`,
    `  };`,
    `};`,
  ].join("\n");

  writeFileSync(path.join(pluginDir, "dogfood.js"), pluginSource);

  const firstPrompt =
    'Remember this incident note for later: ' +
    'alpha '.repeat(18) +
    'the exact root cause marker was ZX-729-ALBATROSS and the billing shard was billing_42. Reply only stored.';
  const secondPrompt = 'What exact root cause marker did I mention earlier? Reply only with the marker.';

  const first = runOpencode(projectDir, [
    "run",
    firstPrompt,
    "--format",
    "json",
    "--dir",
    projectDir,
    "--model",
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
    "run",
    secondPrompt,
    "--continue",
    "--format",
    "json",
    "--dir",
    projectDir,
    "--model",
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

  const traceLines = existsSync(tracePath) ? readFileSync(tracePath, "utf8").split(/\r?\n/).filter(Boolean) : [];
  const lastTrace = traceLines.length > 0 ? JSON.parse(traceLines.at(-1)) : { synthetic: [] };

  return {
    enabled,
    ok: true,
    projectDir,
    answer: extractText(second.stdout ?? ""),
    markers: lastTrace.synthetic.map((entry) => entry.marker),
    retrievedContext: lastTrace.synthetic.find((entry) => entry.marker === "retrieved-context")?.text,
  };
}

const results = [runScenario(false), runScenario(true)];

console.log(`Model: ${model}`);
for (const result of results) {
  const mode = result.enabled ? "automatic retrieval ON" : "automatic retrieval OFF";
  if (!result.ok) {
    console.log(`${mode}: FAILED`);
    console.log(`- reason: ${result.reason}`);
    console.log(`- temp project: ${result.projectDir}`);
    continue;
  }

  console.log(`${mode}:`);
  console.log(`- answer: ${result.answer || "(empty)"}`);
  console.log(`- markers: ${result.markers.join(", ") || "none"}`);
  if (result.retrievedContext) {
    console.log(`- retrieved context: ${result.retrievedContext.split("\n")[0]}`);
  }
}

const enabledResult = results.find((result) => result.enabled && result.ok);
const disabledResult = results.find((result) => !result.enabled && result.ok);
if (enabledResult && disabledResult) {
  const enabledHit = enabledResult.markers.includes("retrieved-context");
  const disabledHit = disabledResult.markers.includes("retrieved-context");
  console.log(`Verdict: enabled_hit=${enabledHit} disabled_hit=${disabledHit}`);
}
