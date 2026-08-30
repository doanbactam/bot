import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundleSource(entry, name) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), `grok-${name}-`));
  const output = path.join(temporary, `${name}.mjs`);
  await build({
    entryPoints: [entry],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

async function loadRoutedShell() {
  return bundleSource(path.join(repoRoot, "source/node-agent-coordinator/routed-shell.ts"), "routed-shell");
}

async function loadBoxExecDaemon() {
  return bundleSource(path.join(repoRoot, "source/box-exec-daemon/server.ts"), "box-exec-daemon");
}

function controlToken() {
  return randomBytes(32).toString("hex");
}

async function withDaemon(testFn) {
  const loadedShell = await loadRoutedShell();
  const loadedDaemon = await loadBoxExecDaemon();
  const workspace = await mkdtemp(path.join(os.tmpdir(), "grok-box-workspace-"));
  const token = controlToken();
  const daemon = await loadedDaemon.module.startBoxExecDaemon({
    host: "127.0.0.1",
    port: 0,
    authToken: token,
    workspaceRoot: workspace,
  });
  try {
    return await testFn({
      executeRoutedShell: loadedShell.module.executeRoutedShell,
      configureRoutedShell: loadedShell.module.configureRoutedShell,
      daemon,
      token,
      workspace,
    });
  } finally {
    await daemon.stop();
    await loadedShell.dispose();
    await loadedDaemon.dispose();
    await rm(workspace, { recursive: true, force: true });
  }
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

test("executeRoutedShell runs a successful command on an ephemeral daemon", async () => {
  await withDaemon(async ({ executeRoutedShell, daemon, token }) => {
    const mark = `ok-${Date.now().toString(36)}`;
    const result = await executeRoutedShell(
      { command: `printf '%s\\n' '${mark}'` },
      { baseUrl: `http://127.0.0.1:${daemon.port}`, authToken: token },
    );
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.match(String(result.stdout), new RegExp(mark));
    assert.equal(String(result.stderr), "");
    assert.equal(result.isError, false);
    assert.equal(result.workingDirectory, "/workspace");
    assert.ok(!JSON.stringify(result).includes(token));
  });
});

test("executeRoutedShell captures stderr and a non-zero exit code", async () => {
  await withDaemon(async ({ executeRoutedShell, daemon, token }) => {
    const mark = `err-${Date.now().toString(36)}`;
    const result = await executeRoutedShell(
      { command: `printf '%s\\n' '${mark}' >&2; exit 7` },
      { baseUrl: `http://127.0.0.1:${daemon.port}`, authToken: token },
    );
    assert.equal(result.exitCode, 7, JSON.stringify(result));
    assert.match(String(result.stderr), new RegExp(mark));
    assert.equal(result.isError, true);
  });
});

test("executeRoutedShell honors working_directory", async () => {
  await withDaemon(async ({ executeRoutedShell, daemon, token, workspace }) => {
    const nested = path.join(workspace, "nested-cwd");
    await mkdir(nested);
    const result = await executeRoutedShell(
      { command: "basename \"$(pwd)\"", working_directory: "/workspace/nested-cwd" },
      { baseUrl: `http://127.0.0.1:${daemon.port}`, authToken: token },
    );
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.match(String(result.stdout), /nested-cwd/);
    assert.equal(result.workingDirectory, "/workspace/nested-cwd");
  });
});

test("executeRoutedShell rejects a wrong control token", async () => {
  await withDaemon(async ({ executeRoutedShell, daemon, token }) => {
    const result = await executeRoutedShell(
      { command: "printf ok" },
      { baseUrl: `http://127.0.0.1:${daemon.port}`, authToken: controlToken() },
    );
    assert.equal(result.isError, true);
    assert.notEqual(result.exitCode, 0);
    assert.match(String(result.stderr), /rejected the control token|Unauthenticated|Unauthorized|401/i);
    assert.ok(!JSON.stringify(result).includes(token));
  });
});

test("executeRoutedShell reports an unreachable endpoint", async () => {
  const loaded = await loadRoutedShell();
  try {
    const token = controlToken();
    const result = await loaded.module.executeRoutedShell(
      { command: "printf ok" },
      { baseUrl: "http://127.0.0.1:1", authToken: token },
    );
    assert.equal(result.isError, true);
    assert.notEqual(result.exitCode, 0);
    assert.match(String(result.stderr), /Couldn't reach Grok Bot's computer exec daemon/);
    assert.ok(!JSON.stringify(result).includes(token));
  } finally {
    await loaded.dispose();
  }
});

test("executeRoutedShell errors on an empty or malformed response", async () => {
  const loaded = await loadRoutedShell();
  const token = controlToken();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/connect+json" });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const result = await loaded.module.executeRoutedShell(
      { command: "printf ok" },
      { baseUrl: `http://127.0.0.1:${address.port}`, authToken: token },
    );
    assert.equal(result.isError, true);
    assert.notEqual(result.exitCode, 0);
    assert.ok(String(result.stderr).length > 0);
    assert.ok(!JSON.stringify(result).includes(token));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error == null ? resolve() : reject(error)));
    await loaded.dispose();
  }
});

test("executeRoutedShell does not default a missing token to Bearer local", async () => {
  const loaded = await loadRoutedShell();
  try {
    const result = await loaded.module.executeRoutedShell({ command: "printf ok" }, { baseUrl: "http://127.0.0.1:1", authToken: "" });
    assert.equal(result.isError, true);
    assert.match(String(result.stderr), /No exec daemon control token is configured/);
    assert.doesNotMatch(String(result.stderr), /Bearer local/);
  } finally {
    await loaded.dispose();
  }
});

test("box exec daemon defaults to loopback and refuses LAN binds", async () => {
  const loaded = await loadBoxExecDaemon();
  const workspace = await mkdtemp(path.join(os.tmpdir(), "grok-box-bind-"));
  try {
    assert.equal(loaded.module.BOX_EXEC_DAEMON_HOST, "127.0.0.1");
    assert.equal(loaded.module.BOX_EXEC_DAEMON_CONTAINER_BIND_HOST, "0.0.0.0");
    assert.equal(loaded.module.resolveBoxExecDaemonBindHost(undefined), "127.0.0.1");
    assert.equal(loaded.module.resolveBoxExecDaemonBindHost("0.0.0.0"), "0.0.0.0");
    assert.throws(() => loaded.module.resolveBoxExecDaemonBindHost("192.168.1.9"), /only 127\.0\.0\.1 and 0\.0\.0\.0/);
    await assert.rejects(
      () => loaded.module.startBoxExecDaemon({ host: "0.0.0.0", port: 0, workspaceRoot: workspace }),
      /refuses to bind 0\.0\.0\.0 without an explicit auth token/,
    );
    const daemon = await loaded.module.startBoxExecDaemon({ port: 0, workspaceRoot: workspace, authToken: controlToken() });
    try {
      assert.equal(daemon.host, "127.0.0.1");
      assert.match(daemon.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await daemon.stop();
    }
  } finally {
    await loaded.dispose();
    await rm(workspace, { recursive: true, force: true });
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
    assert.match(source, /loadRoutedShellTransport/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
