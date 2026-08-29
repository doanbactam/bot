import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadInferenceExtension() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-inference-ready-"));
  const output = path.join(temporary, "inference-extension.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/extensions/inference/extension.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("isReady is true for baseten without Cursor token", async () => {
  const loaded = await loadInferenceExtension();
  try {
    assert.equal(
      loaded.module.isInferenceExtensionReady({
        mockResponseSet: false,
        peekAccessToken: null,
        inferenceProvider: "baseten",
      }),
      true,
    );
    assert.equal(
      loaded.module.isInferenceExtensionReady({
        mockResponseSet: false,
        peekAccessToken: null,
        inferenceProvider: "openrouter",
      }),
      true,
    );
    assert.equal(
      loaded.module.isInferenceExtensionReady({
        mockResponseSet: false,
        peekAccessToken: null,
        inferenceProvider: "cursor",
      }),
      false,
    );
    assert.equal(
      loaded.module.isInferenceExtensionReady({
        mockResponseSet: false,
        peekAccessToken: "tok",
        inferenceProvider: "cursor",
      }),
      true,
    );
  } finally {
    await loaded.dispose();
  }
});

test("local-docker falls back to an independent inference credential", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    path.join(repoRoot, "source/electron-main/box/local-docker-host-connector.ts"),
    "utf8",
  );
  assert.match(source, /localDockerIndependentInferenceCredential/);
  assert.match(source, /issued \?\? localDockerIndependentInferenceCredential\(\)/);
  assert.match(source, /local-docker-independent/);
});

test("kickstart is skipped for non-Cursor routed providers", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(path.join(repoRoot, "source/host/sand-host.ts"), "utf8");
  assert.match(source, /Desktop inference-router owns first-turn chat/);
  assert.match(source, /provider !== "cursor"/);
});

test("routine cloud sync ignores the local-docker independent token", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-routine-sync-"));
  const output = path.join(temporary, "cred.mjs");
  try {
    await build({
      entryPoints: [path.join(repoRoot, "source/shared/local-docker-independent-credential.ts")],
      outfile: output,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
    });
    const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
    assert.equal(module.isLocalDockerIndependentAccessToken(null), false);
    assert.equal(module.isLocalDockerIndependentAccessToken("local-docker-independent"), true);
    assert.equal(module.isLocalDockerIndependentAccessToken("real-cursor-token"), false);
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      path.join(repoRoot, "source/host/extensions/automations/extension.ts"),
      "utf8",
    );
    assert.match(source, /hasCloudAutomationCredential/);
    assert.match(source, /isLocalDockerIndependentAccessToken/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
