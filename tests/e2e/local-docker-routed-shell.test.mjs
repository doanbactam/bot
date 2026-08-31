import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DOCKER_BINARIES = ["docker", "sudo docker"];

function controlToken() {
  return randomBytes(32).toString("hex");
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let output = "";
    const append = (chunk) => {
      output += chunk.toString();
      if (output.length > 200_000) output = output.slice(-200_000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => resolve({ ok: false, output: `${output}\n${error.message}`.trim(), code: 1 }));
    child.once("close", (code) => resolve({ ok: code === 0, output: output.trim(), code: code ?? 1 }));
  });
}

async function resolveDocker() {
  for (const candidate of DOCKER_BINARIES) {
    const [command, ...prefix] = candidate.split(" ");
    const probe = await run(command, [...prefix, "info", "--format", "{{.ServerVersion}}"]);
    if (probe.ok && probe.output.length > 0) return { command, prefix, version: probe.output };
  }
  throw new Error("Docker is required for this E2E test, but no running engine answered `docker info`.");
}

function dockerApi(docker, args, options) {
  return run(docker.command, [...docker.prefix, ...args], options);
}

async function loadRoutedShell() {
  const temporary = await mkdtemp(path.join(repoRoot, ".tmp-grok-e2e-routed-shell-"));
  const output = path.join(temporary, "routed-shell.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/node-agent-coordinator/routed-shell.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    packages: "external",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

async function buildDaemonBundle() {
  const directory = await mkdtemp(path.join(repoRoot, ".tmp-grok-e2e-daemon-bundle-"));
  const outfile = path.join(directory, "main.cjs");
  const built = await run(process.execPath, [path.join(repoRoot, "scripts/build-box-exec-daemon.mjs"), outfile]);
  if (!built.ok) throw new Error(`Failed to build box exec daemon:\n${built.output}`);
  return { directory, outfile, dispose: () => rm(directory, { recursive: true, force: true }) };
}

async function waitForLog(docker, container, pattern, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let logs = "";
  while (Date.now() < deadline) {
    const result = await dockerApi(docker, ["logs", "--tail", "40", container]);
    logs = result.output;
    if (pattern.test(logs)) return logs;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Container ${container} did not become ready.\n${logs}`);
}

async function publishedPort(docker, container, containerPort = 1337) {
  const inspected = await dockerApi(docker, ["inspect", "--format", "{{json .NetworkSettings.Ports}}", container]);
  if (!inspected.ok) throw new Error(`docker inspect failed:\n${inspected.output}`);
  const ports = JSON.parse(inspected.output);
  const bindings = ports[`${containerPort}/tcp`];
  if (!Array.isArray(bindings) || bindings.length === 0) throw new Error(`Container did not publish ${containerPort}/tcp: ${inspected.output}`);
  const binding = bindings[0];
  return { hostIp: String(binding.HostIp ?? ""), hostPort: Number(binding.HostPort), raw: ports };
}

async function startDaemonContainer(docker, args) {
  const name = `grok-bot-e2e-routed-shell-${process.pid}-${randomBytes(4).toString("hex")}`;
  const created = await dockerApi(docker, [
    "run", "--detach", "--name", name,
    "--publish", `127.0.0.1:0:1337`,
    "--env", `SAND_BOX_EXEC_DAEMON_BIND_HOST=${args.bindHost}`,
    "--env", `SAND_BOX_EXEC_DAEMON_AUTH_TOKEN=${args.token}`,
    "--env", "SAND_BOX_EXEC_DAEMON_PORT=1337",
    "--env", "SAND_BOX_WORKSPACE_ROOT=/workspace",
    "--mount", `type=bind,src=${args.daemonDirectory},dst=/home/box/box-exec-daemon,readonly`,
    "--mount", `type=bind,src=${args.workspace},dst=/workspace`,
    "node:22-bookworm-slim",
    "node", "/home/box/box-exec-daemon/main.cjs",
  ]);
  if (!created.ok) throw new Error(`docker run failed:\n${created.output}`);
  return {
    name,
    id: created.output,
    async stop() {
      await dockerApi(docker, ["rm", "--force", name]);
    },
  };
}

test("Docker E2E: routed Shell reaches a container-bound exec daemon on loopback publish", async (t) => {
  const docker = await resolveDocker();
  const loaded = await loadRoutedShell();
  const daemonBundle = await buildDaemonBundle();
  const workspace = await mkdtemp(path.join(os.tmpdir(), "grok-e2e-workspace-"));
  await mkdir(path.join(workspace, "nested-cwd"), { recursive: true });
  await writeFile(path.join(workspace, "nested-cwd", "marker.txt"), "from-workspace\n");
  const token = controlToken();
  const reachable = await startDaemonContainer(docker, {
    bindHost: "0.0.0.0",
    token,
    daemonDirectory: daemonBundle.directory,
    workspace,
  });
  const loopback = await startDaemonContainer(docker, {
    bindHost: "127.0.0.1",
    token,
    daemonDirectory: daemonBundle.directory,
    workspace,
  });
  t.after(async () => {
    await reachable.stop();
    await loopback.stop();
    await loaded.dispose();
    await daemonBundle.dispose();
    await rm(workspace, { recursive: true, force: true });
  });

  const readyLogs = await waitForLog(docker, reachable.name, /box-exec-daemon-ready/);
  assert.match(readyLogs, /127\.0\.0\.1/);
  assert.doesNotMatch(readyLogs, new RegExp(token));

  const published = await publishedPort(docker, reachable.name);
  assert.equal(published.hostIp, "127.0.0.1", JSON.stringify(published.raw));
  assert.ok(Number.isInteger(published.hostPort) && published.hostPort > 0);
  const transport = { baseUrl: `http://127.0.0.1:${published.hostPort}`, authToken: token };
  const mark = `e2e-${Date.now().toString(36)}`;

  const success = await loaded.module.executeRoutedShell({ command: `printf '%s\\n' '${mark}'` }, transport);
  assert.equal(success.exitCode, 0, JSON.stringify(success));
  assert.match(String(success.stdout), new RegExp(mark));
  assert.equal(String(success.stderr), "");
  assert.equal(success.isError, false);
  assert.ok(!JSON.stringify(success).includes(token));

  const failed = await loaded.module.executeRoutedShell({ command: `printf '%s\\n' '${mark}-err' >&2; exit 9` }, transport);
  assert.equal(failed.exitCode, 9, JSON.stringify(failed));
  assert.match(String(failed.stderr), new RegExp(`${mark}-err`));
  assert.equal(failed.isError, true);

  const cwd = await loaded.module.executeRoutedShell(
    { command: "basename \"$(pwd)\"; cat marker.txt", working_directory: "/workspace/nested-cwd" },
    transport,
  );
  assert.equal(cwd.exitCode, 0, JSON.stringify(cwd));
  assert.match(String(cwd.stdout), /nested-cwd/);
  assert.match(String(cwd.stdout), /from-workspace/);
  assert.equal(cwd.workingDirectory, "/workspace/nested-cwd");

  const denied = await loaded.module.executeRoutedShell({ command: "printf ok" }, { ...transport, authToken: controlToken() });
  assert.equal(denied.isError, true);
  assert.match(String(denied.stderr), /rejected the control token|Unauthenticated|Unauthorized|401/i);

  await waitForLog(docker, loopback.name, /box-exec-daemon-ready/);
  const loopbackPublish = await publishedPort(docker, loopback.name);
  assert.equal(loopbackPublish.hostIp, "127.0.0.1", JSON.stringify(loopbackPublish.raw));
  const unreachable = await loaded.module.executeRoutedShell(
    { command: "printf should-not-run" },
    { baseUrl: `http://127.0.0.1:${loopbackPublish.hostPort}`, authToken: token },
  );
  assert.equal(unreachable.isError, true, JSON.stringify(unreachable));
  assert.match(String(unreachable.stderr), /Couldn't reach Grok Bot's computer exec daemon|ECONNRESET|ECONNREFUSED|Unavailable|Aborted/i);
});
