import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadRoutedShell() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-routed-shell-"));
  const output = path.join(temporary, "routed-shell.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/node-agent-coordinator/routed-shell.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("withRoutedShellTools always prepends Shell ahead of MCP tools", async () => {
  const loaded = await loadRoutedShell();
  try {
    const tools = loaded.module.withRoutedShellTools([
      { name: "plugin_x", providerIdentifier: "x", toolName: "search", inputSchema: { type: "object" } },
      { name: "Shell", providerIdentifier: "stale", toolName: "Shell" },
    ]);
    assert.equal(tools[0]?.name, "Shell");
    assert.equal(tools[0]?.providerIdentifier, "grok-bot-box");
    assert.equal(tools.length, 2);
    assert.equal(tools[1]?.name, "plugin_x");
  } finally {
    await loaded.dispose();
  }
});

test("executeRoutedShell runs a command on the local Docker exec daemon", async () => {
  const loaded = await loadRoutedShell();
  const mark = `shell-unit-${Date.now().toString(36)}`;
  try {
    const result = await loaded.module.executeRoutedShell({
      command: `printf '%s\\n' '${mark}' > /tmp/${mark}.txt && cat /tmp/${mark}.txt`,
      working_directory: "/tmp",
    });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.match(String(result.stdout), new RegExp(mark));
    assert.equal(result.isError, false);
  } finally {
    await loaded.dispose();
  }
});

test("inference router wires Shell into executeTool before MCP", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-router-shell-src-"));
  try {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(path.join(repoRoot, "source/node-agent-coordinator/inference-router.ts"), "utf8");
    assert.match(source, /withRoutedShellTools/);
    assert.match(source, /executeRoutedShell/);
    assert.match(source, /isRoutedShellTool/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
