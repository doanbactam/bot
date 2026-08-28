import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportingSourcePath = path.join(repoRoot, "source/electron-main/account/auth-reporting.ts");

async function loadAuthReporting() {
  const source = await readFile(reportingSourcePath, "utf8");
  const stripped = source.replace(/import type[^;]+;/, "type SandAuthStatus = Record<string, unknown>;");
  const { code: output } = await transform(stripped, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("a missing Cursor session is reported as a local account when Cursor auth is unnecessary", async () => {
  const reporting = await loadAuthReporting();
  assert.equal(reporting.LOCAL_ACCOUNT_AUTH_ID, "local");

  assert.deepEqual(reporting.reportedAuthStatus({ kind: "logged-out" }, false), { kind: "logged-in", authId: "local" });
  assert.deepEqual(
    reporting.reportedAuthStatus({ kind: "logged-out", errorMessage: "boom" }, false),
    { kind: "logged-in", authId: "local" },
  );

  // Real sessions, in-flight logins, and required-auth cases pass through.
  const real = { kind: "logged-in", authId: "account-7", email: "user@example.com" };
  assert.deepEqual(reporting.reportedAuthStatus(real, false), real);
  assert.deepEqual(reporting.reportedAuthStatus(real, true), real);
  assert.deepEqual(reporting.reportedAuthStatus({ kind: "logged-out" }, true), { kind: "logged-out" });
  assert.deepEqual(reporting.reportedAuthStatus({ kind: "logging-in" }, false), { kind: "logging-in" });
});
