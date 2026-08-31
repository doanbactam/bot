#!/usr/bin/env node
/**
 * Live repro: can coordinator Shell drive grok-bot-local-vm?
 * Exit 0 = Shell works. Exit 1 = broken (expected before fix).
 */
import { build } from "esbuild";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const settingsPath = process.env.GROK_BOT_SETTINGS_PATH
  ?? "/home/doanbactam/.cursor/sand-dev/settings.json";
const mark = `repro-${Date.now().toString(36)}`;

async function loadRoutedShell() {
  const dir = await mkdtemp(path.join(repoRoot, ".tmp-live-shell-repro-"));
  const outfile = path.join(dir, "routed-shell.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/node-agent-coordinator/routed-shell.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    packages: "external",
  });
  const mod = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { mod, dispose: () => rm(dir, { recursive: true, force: true }) };
}

const loaded = await loadRoutedShell();
try {
  const transport = await loaded.mod.loadRoutedShellTransport({ settingsPath });
  console.log(JSON.stringify({
    phase: "transport",
    baseUrl: transport.baseUrl,
    authTokenLen: transport.authToken.length,
  }));
  const result = await loaded.mod.executeRoutedShell(
    {
      command: `printf '%s\\n' '${mark}'; test -f /.dockerenv && echo DOCKERENV`,
    },
    transport,
  );
  console.log(JSON.stringify({ phase: "shell", result }));
  const ok = result.exitCode === 0
    && String(result.stdout).includes(mark)
    && String(result.stdout).includes("DOCKERENV")
    && result.isError !== true;
  if (!ok) {
    console.error("REPRO_FAIL: Shell did not control the live Docker box");
    process.exitCode = 1;
  } else {
    console.log("REPRO_PASS: Shell controlled the live Docker box");
  }
} finally {
  await loaded.dispose();
}
