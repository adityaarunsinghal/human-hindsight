import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { build } from "tsdown";
import { z } from "zod";

// Explicit binary, private stores, and a loopback mock provider: no paid requests
// or private transcripts. Run once per supported OpenCode release family.
const binary = process.argv[2];
if (!binary) throw new Error("Usage: node scripts/smoke-opencode.mjs /absolute/path/to/opencode");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-opencode-integration-"));
const requests = [];
let passed = false;
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!req.url?.endsWith("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  const request = JSON.parse(body);
  requests.push(request);
  const completion = '{"answer":"ready"}';
  if (!request.stream) {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        id: "chatcmpl-hindsight",
        object: "chat.completion",
        created: 1,
        model: "test",
        choices: [
          { index: 0, message: { role: "assistant", content: completion }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      }),
    );
    return;
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  for (const [delta, finish_reason] of [
    [{ role: "assistant", content: completion }, null],
    [{}, "stop"],
  ]) {
    res.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-hindsight",
        object: "chat.completion.chunk",
        created: 1,
        model: "test",
        choices: [{ index: 0, delta, finish_reason }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      })}\n\n`,
    );
  }
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");

try {
  const configDir = path.join(root, "config/opencode");
  fs.mkdirSync(configDir, { recursive: true });
  for (const [key, value] of Object.entries({
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_MODELS_PATH: path.join(root, "models.json"),
  }))
    process.env[key] = value;
  fs.writeFileSync(process.env.OPENCODE_MODELS_PATH, "{}\n");
  for (const key of [
    "OPENCODE_DB",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "HUMAN_HINDSIGHT_OPENCODE_DB",
    "HUMAN_HINDSIGHT_OPENCODE_DIR",
  ])
    delete process.env[key];
  const version = execFileSync(path.resolve(binary), ["--version"], { encoding: "utf8" }).trim();
  const nativeV2 = /\bv?2\./.test(version);
  const marker = path.join(root, "unexpected-tool-start");
  const plugin = path.join(root, "unexpected-plugin.mjs");
  fs.writeFileSync(
    plugin,
    `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "plugin"); export default async () => ({});\n`,
  );
  fs.writeFileSync(
    path.join(configDir, "AGENTS.md"),
    "HINDSIGHT_AMBIENT_INSTRUCTIONS_MUST_NOT_APPEAR",
  );
  fs.writeFileSync(
    path.join(configDir, "opencode.jsonc"),
    JSON.stringify(
      {
        model: "hindsightmock/test",
        [nativeV2 ? "providers" : "provider"]: {
          hindsightmock: {
            [nativeV2 ? "package" : "npm"]: "@ai-sdk/openai-compatible",
            name: "Local test provider",
            [nativeV2 ? "settings" : "options"]: {
              baseURL: `http://127.0.0.1:${address.port}/v1`,
              apiKey: "mock-only",
            },
            models: { test: { name: "test", limit: { context: 128000, output: 2048 } } },
          },
        },
        plugin: [pathToFileURL(plugin).href],
        plugins: [pathToFileURL(plugin).href],
        instructions: [path.join(configDir, "AGENTS.md")],
        mcp: {
          shouldNotStart: {
            type: "local",
            command: [
              process.execPath,
              "-e",
              `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "mcp")`,
            ],
          },
        },
      },
      null,
      2,
    ),
  );
  const outDir = path.join(root, "bundle");
  await build({
    config: false,
    entry: ["src/runners/opencode.ts", "src/runners/shared.ts"],
    outDir,
    format: "esm",
    platform: "node",
    target: "node22",
    dts: false,
    logLevel: "warn",
  });
  // The temporary output sits outside the package's type=module scope.
  fs.writeFileSync(path.join(outDir, "package.json"), '{"type":"module"}\n');
  fs.symlinkSync(path.resolve("node_modules"), path.join(outDir, "node_modules"), "dir");
  const { makeOpenCodeRunner } = await import(
    pathToFileURL(path.join(outDir, "opencode.mjs")).href
  );
  const { defaultIo } = await import(pathToFileURL(path.join(outDir, "shared.mjs")).href);
  const io = { which: () => path.resolve(binary), spawn: defaultIo.spawn };
  const runner = makeOpenCodeRunner(io);
  try {
    const result = await runner.run({
      prompt: 'Return {"answer":"ready"}.',
      schema: z.object({ answer: z.string() }),
      timeoutMs: 30000,
    });
    assert.deepEqual(result, { answer: "ready" });
    assert.equal(requests.length, 1, "one stage must make one mock-provider request");
    assert.equal(
      requests[0].tools?.length ?? 0,
      0,
      "the provider must receive no tool definitions",
    );
    assert(!JSON.stringify(requests).includes("HINDSIGHT_AMBIENT_INSTRUCTIONS_MUST_NOT_APPEAR"));
    assert(!fs.existsSync(marker), "ambient MCP or plugin code was executed");
  } finally {
    await runner.finalize();
  }
  const db = new DatabaseSync(path.join(root, "data/opencode/opencode.db"), { readOnly: true });
  try {
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name),
    );
    const table = tables.has("session_v2") ? "session_v2" : "session";
    assert.equal(
      db.prepare(`SELECT count(*) n FROM ${table}`).get().n,
      0,
      "generated sessions must be removed",
    );
  } finally {
    db.close();
  }
  passed = true;
  console.log(
    `OpenCode integration passed: ${path.resolve(binary)} (no tools, no ambient instructions, sessions cleaned up).`,
  );
} catch (error) {
  console.error(`Synthetic test artifacts: ${root}`);
  throw error;
} finally {
  await new Promise((resolve) => server.close(resolve));
  // Keep only failed synthetic fixtures for diagnosis.
  if (passed) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
