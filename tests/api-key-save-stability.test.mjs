import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadMirrorModule() {
  const source = await readFile(path.join(repoRoot, "source/electron-main/secrets/box-secrets-disk-mirror.ts"), "utf8");
  const stripped = source
    .replace(/import \{ getSandRootDir \} from \"\.\.\/\.\.\/host\/host-paths\.js\";\n/, "")
    .replace(
      /import \{ validateBoxSecrets \} from \"\.\.\/\.\.\/shared\/box-secrets\.js\";\n/,
      "function getSandRootDir() { return \"/tmp\"; }\nfunction validateBoxSecrets() { return null; }\n",
    );
  const { code } = await transform(stripped, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

test("router API key save mirrors secrets to the inference disk store", async () => {
  const mirror = await loadMirrorModule();
  const dir = await mkdtemp(path.join(tmpdir(), "box-secrets-mirror-"));
  const storePath = path.join(dir, "box-secrets.json");
  try {
    await mirror.mirrorBoxSecretsToDisk({ BASETEN_API_KEY: "prefix.secret-value" }, storePath);
    const persisted = JSON.parse(await readFile(storePath, "utf8"));
    assert.equal(persisted.version, 1);
    assert.equal(persisted.secrets.BASETEN_API_KEY, "prefix.secret-value");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("secrets upsert IPC mirrors before reporting box sync", async () => {
  const source = await readFile(path.join(repoRoot, "source/electron-main/secrets/secrets-ipc.ts"), "utf8");
  assert.match(source, /mirrorBoxSecretsToDisk/);
  assert.match(source, /await mirrorPersistedSecrets\(\);\s*\n\s*return \{ synced: await pushBoxSecrets\(\) \}/);
});

test("router patch surfaces API key save failures and labels the selected provider", async () => {
  const source = await readFile(path.join(repoRoot, "scripts/lib/router-renderer-patch.mjs"), "utf8");
  assert.match(source, /setErr\(String\(u\?\.message/);
  assert.match(source, /u\.synced===false/);
  assert.match(source, /title:r\.kind==="key"\?r\.label:"Account"/);
  assert.doesNotMatch(source, /title:r\.kind==="key"\?"OpenRouter account"/);
});
