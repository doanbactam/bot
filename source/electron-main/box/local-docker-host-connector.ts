import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SandSettingsStore } from "../../shared/node/settings/sand-settings-store.js";
import type { RecreateResult } from "./box-recreate-commands.js";
import type { SandRemoteHostConnector } from "./box-host-connector.js";
import type { GatewayConnection } from "./gateway-descriptor-cache.js";
import { LOCAL_DOCKER_INDEPENDENT_ACCESS_TOKEN } from "../../shared/local-docker-independent-credential.js";
import { readOrCreateLocalDockerBoxCredentials } from "../../shared/local-docker-box-credentials.js";

export const LOCAL_DOCKER_BOX_IMAGE = "public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest";
export const LOCAL_DOCKER_BOX_CONTAINER = "grok-bot-local-vm";
export const LOCAL_DOCKER_GATEWAY_URL = "http://127.0.0.1:1340";
export const LOCAL_DOCKER_OWNER_LABEL = "com.grok-bot.local-vm=1";
export const LOCAL_DOCKER_SCHEMA_VERSION = "9";
const READY_TIMEOUT_MS = 180_000;
const OPTIONAL_CREDENTIAL_TIMEOUT_MS = 3_000;

export interface LocalDockerStatus {
  readonly available: boolean;
  readonly running: boolean;
  readonly ready: boolean;
  readonly containerName: string;
  readonly image: string;
  readonly detail: string;
}

interface CommandResult { readonly ok: boolean; readonly output: string }
interface InferenceCredential { readonly accessToken: string; readonly backendUrl: string; readonly expiresAtMs: number }
interface LocalHostBundle { readonly path: string; readonly sha256: string; readonly boxExecDaemonPath: string; readonly boxExecDaemonSha256: string; readonly startExecDaemonPath: string }

function runDocker(args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn("docker", [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (chunk: Buffer): void => { output += chunk.toString(); if (output.length > 200_000) output = output.slice(-200_000); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => resolve({ ok: false, output: `${output}\n${error.message}`.trim() }));
    child.once("close", (code) => resolve({ ok: code === 0, output: output.trim() }));
  });
}

function inferenceCredentialPath(settingsPath: string): string {
  return join(dirname(settingsPath), "local-docker-credential", "inference.json");
}

async function persistInferenceCredential(settingsPath: string, credential: InferenceCredential): Promise<string> {
  const target = inferenceCredentialPath(settingsPath);
  const temporary = `${target}.${process.pid}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(temporary, `${JSON.stringify({ accessToken: credential.accessToken, expiresAtMs: credential.expiresAtMs })}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
  return target;
}

async function readOrCreateToken(settingsPath: string): Promise<string> {
  return (await readOrCreateLocalDockerBoxCredentials(settingsPath)).token;
}

async function gatewayReady(token: string): Promise<boolean> {
  try {
    const response = await fetch(`${LOCAL_DOCKER_GATEWAY_URL}/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch { return false; }
}

async function inspectContainer(): Promise<{ exists: boolean; running: boolean; owned: boolean; image: string; hostSha256: string; boxExecDaemonSha256: string; hasInferenceCredential: boolean; schemaVersion: string }> {
  const result = await runDocker(["inspect", "--format", "{{json .}}", LOCAL_DOCKER_BOX_CONTAINER]);
  if (!result.ok) return { exists: false, running: false, owned: false, image: "", hostSha256: "", boxExecDaemonSha256: "", hasInferenceCredential: false, schemaVersion: "" };
  try {
    const value = JSON.parse(result.output) as { State?: { Running?: unknown }; Config?: { Image?: unknown; Labels?: Record<string, unknown> } };
    return {
      exists: true,
      running: value.State?.Running === true,
      owned: value.Config?.Labels?.["com.grok-bot.local-vm"] === "1",
      image: typeof value.Config?.Image === "string" ? value.Config.Image : "",
      hostSha256: typeof value.Config?.Labels?.["com.grok-bot.local-vm.host-sha256"] === "string" ? value.Config.Labels["com.grok-bot.local-vm.host-sha256"] as string : "",
      boxExecDaemonSha256: typeof value.Config?.Labels?.["com.grok-bot.local-vm.box-exec-daemon-sha256"] === "string" ? value.Config.Labels["com.grok-bot.local-vm.box-exec-daemon-sha256"] as string : "",
      hasInferenceCredential: value.Config?.Labels?.["com.grok-bot.local-vm.inference-credential"] === "1",
      schemaVersion: typeof value.Config?.Labels?.["com.grok-bot.local-vm.schema-version"] === "string" ? value.Config.Labels["com.grok-bot.local-vm.schema-version"] as string : "",
    };
  } catch { throw new Error("Docker returned malformed container inspection data."); }
}

export async function getLocalDockerStatus(settingsPath: string): Promise<LocalDockerStatus> {
  const daemon = await runDocker(["info", "--format", "{{.ServerVersion}}"]).catch(() => ({ ok: false, output: "Docker is not installed." }));
  if (!daemon.ok) return { available: false, running: false, ready: false, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: LOCAL_DOCKER_BOX_IMAGE, detail: daemon.output || "Docker is not running." };
  const inspected = await inspectContainer();
  if (!inspected.exists) return { available: true, running: false, ready: false, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: LOCAL_DOCKER_BOX_IMAGE, detail: "Ready to create the local VM." };
  if (!inspected.owned) return { available: true, running: inspected.running, ready: false, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: inspected.image, detail: `Container ${LOCAL_DOCKER_BOX_CONTAINER} exists but is not owned by Grok Bot.` };
  const ready = inspected.running && await gatewayReady(await readOrCreateToken(settingsPath));
  return { available: true, running: inspected.running, ready, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: inspected.image, detail: ready ? "Local Docker VM is ready." : inspected.running ? "Container is starting." : "Local Docker VM is stopped." };
}

let ensureInFlight: Promise<GatewayConnection> | undefined;

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function stageCurrentHostBundle(settingsPath: string): Promise<LocalHostBundle> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const readRuntime = async (relative: string): Promise<Buffer> => {
    const candidates = [resolve(moduleDirectory, `../${relative}`), resolve(moduleDirectory, `../../${relative}`)];
    for (const candidate of candidates) {
      try { return await readFile(candidate); } catch {}
    }
    throw new Error(`The reconstructed runtime is unavailable at ${candidates.join(" or ")}; refusing to start a stock local VM.`);
  };
  const hostBytes = await readRuntime("host/host-main.cjs");
  const boxExecDaemonBytes = await readRuntime("box-exec-daemon/main.cjs");
  const startExecDaemonBytes = Buffer.from(`#!/usr/bin/env bash
set -euo pipefail
unset SAND_GATEWAY_TOKEN SAND_INFERENCE_RENEWAL_CREDENTIAL SAND_EGRESS_TUNNEL_BEARER || true
export SAND_BOX_WORKSPACE_ROOT="\${SAND_BOX_WORKSPACE_ROOT:-/workspace}"
export SAND_BOX_EXEC_DAEMON_PORT="\${SAND_BOX_EXEC_DAEMON_PORT:-1337}"
cd /workspace
exec /exec-daemon/node /home/box/box-exec-daemon/main.cjs
`);
  const sha256 = createHash("sha256").update(hostBytes).digest("hex");
  const boxExecDaemonSha256 = createHash("sha256").update(boxExecDaemonBytes).digest("hex");
  const directory = join(dirname(settingsPath), "local-docker-runtime", `${sha256}-${boxExecDaemonSha256}`);
  const persistRuntime = async (name: string, bytes: Buffer, mode = 0o600): Promise<string> => {
    const target = join(directory, name);
    await mkdir(dirname(target), { recursive: true });
    try {
      const existing = await readFile(target);
      if (!existing.equals(bytes)) throw new Error(`Content-addressed local runtime ${target} has unexpected bytes.`);
    } catch (error) {
      if (error instanceof Error && !Reflect.has(error, "code")) throw error;
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, bytes, { mode });
      await rename(temporary, target);
    }
    await chmod(target, mode);
    return target;
  };
  await mkdir(directory, { recursive: true });
  const startExecDaemonPath = join(directory, "start-exec-daemon");
  const startTemporary = `${startExecDaemonPath}.${process.pid}.tmp`;
  await writeFile(startTemporary, startExecDaemonBytes, { mode: 0o755 });
  await rename(startTemporary, startExecDaemonPath);
  await chmod(startExecDaemonPath, 0o755);
  return {
    path: await persistRuntime("host-main.cjs", hostBytes),
    sha256,
    boxExecDaemonPath: await persistRuntime("box-exec-daemon/main.cjs", boxExecDaemonBytes),
    boxExecDaemonSha256,
    startExecDaemonPath,
  };
}

async function localAuthMountArguments(): Promise<string[]> {
  const mounts: string[] = [];
  for (const [source, destination] of [[join(homedir(), ".codex"), "/root/.codex"], [join(homedir(), ".claude"), "/root/.claude"]] as const) {
    if (await isDirectory(source)) mounts.push("--mount", `type=bind,src=${source},dst=${destination},readonly`);
  }
  return mounts;
}

async function pullBoxImage(image: string): Promise<void> {
  const present = await runDocker(["image", "inspect", "--format", "{{.Id}}", image]);
  if (present.ok) return;
  const pulled = await runDocker(["pull", "--platform", "linux/amd64", image]);
  if (!pulled.ok) throw new Error(`Could not download the local VM image (${image}). Check the network connection and Docker registry access.\n${pulled.output}`);
}

export function buildDockerRunArguments(args: { readonly token: string; readonly execDaemonToken: string; readonly hostBundle: LocalHostBundle; readonly inferenceCredential?: InferenceCredential | undefined; readonly inferenceFile?: string | undefined; readonly authMounts: readonly string[] }): string[] {
  return [
    "run", "--detach", "--name", LOCAL_DOCKER_BOX_CONTAINER,
    "--label", LOCAL_DOCKER_OWNER_LABEL, "--label", `com.grok-bot.local-vm.host-sha256=${args.hostBundle.sha256}`,
    "--label", `com.grok-bot.local-vm.box-exec-daemon-sha256=${args.hostBundle.boxExecDaemonSha256}`,
    "--label", `com.grok-bot.local-vm.inference-credential=${args.inferenceCredential == null ? "0" : "1"}`,
    "--label", `com.grok-bot.local-vm.schema-version=${LOCAL_DOCKER_SCHEMA_VERSION}`,
    "--platform", "linux/amd64", "--restart", "unless-stopped", "--shm-size", "1g",
    "--env", "SAND_SUPERVISOR_ENABLED=1", "--env", "SAND_BOX_AUTO_UPDATE=0", "--env", "SAND_USE_EXISTING_BOX_EXEC_DAEMON=1", "--env", "SAND_BOX_WORKSPACE_ROOT=/workspace", "--env", "SAND_BOX_EXEC_DAEMON_PORT=1337", "--env", "SAND_TREE_SITTER_NODE_DEPS=/home/box/deps", "--env", "NODE_PATH=/home/box/deps", "--env", "SAND_GATEWAY_BIND_HOST=0.0.0.0", "--env", "SAND_BOX_EXEC_DAEMON_BIND_HOST=0.0.0.0", "--env", "SAND_HOST_PORT=1340", "--env", `SAND_GATEWAY_TOKEN=${args.token}`, "--env", `SAND_BOX_EXEC_DAEMON_AUTH_TOKEN=${args.execDaemonToken}`,
    ...(args.inferenceCredential == null ? [] : ["--env", "SAND_DEV_INFERENCE_TOKEN_FILE=/run/grok-bot/inference.json", "--env", `SAND_BACKEND_URL=${args.inferenceCredential.backendUrl}`]),
    "--publish", "127.0.0.1:1337:1337", "--publish", "127.0.0.1:1339:1339", "--publish", "127.0.0.1:1340:1340",
    "--publish", "127.0.0.1:6080:6080", "--publish", "127.0.0.1:6081:6081", "--publish", "127.0.0.1:8790:8790",
    "--volume", "grok-bot-local-vm-workspace:/workspace", "--volume", "grok-bot-local-vm-data:/home/box/sand-data",
    "--mount", `type=bind,src=${args.hostBundle.path},dst=/home/box/sand-host/host-main.cjs,readonly`,
    "--mount", `type=bind,src=${dirname(args.hostBundle.boxExecDaemonPath)},dst=/home/box/box-exec-daemon,readonly`,
    "--mount", `type=bind,src=${args.hostBundle.startExecDaemonPath},dst=/usr/local/bin/start-exec-daemon,readonly`,
    ...(args.inferenceFile == null ? [] : ["--mount", `type=bind,src=${dirname(args.inferenceFile)},dst=/run/grok-bot,readonly`]),
    ...args.authMounts,
    LOCAL_DOCKER_BOX_IMAGE,
  ];
}

async function ensureLocalDockerBox(settingsPath: string, inferenceCredential?: InferenceCredential): Promise<GatewayConnection> {
  const credentials = await readOrCreateLocalDockerBoxCredentials(settingsPath);
  const token = credentials.token;
  const hostBundle = await stageCurrentHostBundle(settingsPath);
  const inferenceFile = inferenceCredential == null ? undefined : await persistInferenceCredential(settingsPath, inferenceCredential);
  const daemon = await runDocker(["info", "--format", "{{.ServerVersion}}"]).catch(() => ({ ok: false, output: "Docker is not installed." }));
  if (!daemon.ok) throw new Error(`Local Docker VM is selected, but Docker is unavailable: ${daemon.output || "start Docker and try again"}`);
  const inspected = await inspectContainer();
  if (inspected.exists && !inspected.owned) throw new Error(`Local Docker VM cannot use ${LOCAL_DOCKER_BOX_CONTAINER}: an unowned container already has that name.`);
  if (inspected.exists && inspected.image !== LOCAL_DOCKER_BOX_IMAGE) throw new Error(`Local Docker VM container uses unexpected image ${inspected.image}. Remove it explicitly before changing images.`);
  const replaceReasons = inspected.exists
    ? [
      ...(inspected.schemaVersion !== LOCAL_DOCKER_SCHEMA_VERSION ? ["outdated schema"] : []),
      ...(inspected.hostSha256 !== hostBundle.sha256 ? ["updated app runtime"] : []),
      ...(inspected.boxExecDaemonSha256 !== hostBundle.boxExecDaemonSha256 ? ["updated box exec daemon"] : []),
      ...(inferenceCredential != null && !inspected.hasInferenceCredential ? ["new inference credentials"] : []),
    ]
    : [];
  let current = inspected;
  if (replaceReasons.length > 0) {
    const removed = await runDocker(["rm", "--force", LOCAL_DOCKER_BOX_CONTAINER]);
    if (!removed.ok) throw new Error(`Could not replace the local VM with the current app runtime: ${removed.output}`);
    current = await inspectContainer();
  }
  if (current.exists && !current.running) {
    const started = await runDocker(["start", LOCAL_DOCKER_BOX_CONTAINER]);
    if (!started.ok) throw new Error(`Could not start the local Docker VM: ${started.output}`);
  } else if (!current.exists) {
    await pullBoxImage(LOCAL_DOCKER_BOX_IMAGE);
    const authMounts = await localAuthMountArguments();
    const created = await runDocker(buildDockerRunArguments({
      token,
      execDaemonToken: credentials.execDaemonToken,
      hostBundle,
      inferenceCredential,
      inferenceFile,
      authMounts,
    }));
    if (!created.ok) throw new Error(`Could not create the local Docker VM: ${created.output}`);
  }
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await gatewayReady(token)) return { baseUrl: LOCAL_DOCKER_GATEWAY_URL, token };
    const state = await inspectContainer();
    if (!state.running) {
      const logs = await runDocker(["logs", "--tail", "80", LOCAL_DOCKER_BOX_CONTAINER]);
      throw new Error(`Local Docker VM stopped before its gateway became ready.\n${logs.output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Local Docker VM did not expose its gateway within three minutes.");
}

export async function startLocalDockerBox(settingsPath: string): Promise<GatewayConnection> {
  return await ensureLocalDockerBox(settingsPath);
}

export async function stopLocalDockerBox(): Promise<void> {
  const inspected = await inspectContainer();
  if (!inspected.exists || !inspected.running) return;
  if (!inspected.owned) throw new Error(`Refusing to stop unowned container ${LOCAL_DOCKER_BOX_CONTAINER}.`);
  const stopped = await runDocker(["stop", LOCAL_DOCKER_BOX_CONTAINER]);
  if (!stopped.ok) throw new Error(`Could not stop the local Docker VM: ${stopped.output}`);
}

/** Independent local-docker has no Cursor short-lived creds; seed a long-lived file so the in-box renewer stops waiting forever. */
export function localDockerIndependentInferenceCredential(): InferenceCredential {
  return {
    accessToken: LOCAL_DOCKER_INDEPENDENT_ACCESS_TOKEN,
    backendUrl: "http://127.0.0.1:9",
    expiresAtMs: Date.now() + 365 * 24 * 60 * 60 * 1_000,
  };
}

export function createSettingsRoutedHostConnector(
  remote: SandRemoteHostConnector,
  settings: SandSettingsStore,
): SandRemoteHostConnector {
  const localConnect = (): Promise<GatewayConnection> => {
    if (ensureInFlight == null) ensureInFlight = (async () => {
      const issued = remote.issueInferenceCredential == null ? undefined : await Promise.race([
        remote.issueInferenceCredential(),
        new Promise<undefined>((resolve) => setTimeout(resolve, OPTIONAL_CREDENTIAL_TIMEOUT_MS)),
      ]);
      return await ensureLocalDockerBox(
        settings.settingsPath,
        issued ?? localDockerIndependentInferenceCredential(),
      );
    })().finally(() => { ensureInFlight = undefined; });
    return ensureInFlight;
  };
  return {
    connect: async () => settings.getBoxRuntime() === "local-docker" ? await localConnect() : await remote.connect(),
    ...(remote.issueLocalExecDaemonCredential == null ? {} : { issueLocalExecDaemonCredential: remote.issueLocalExecDaemonCredential.bind(remote) }),
    ...(remote.issueInferenceCredential == null ? {} : { issueInferenceCredential: remote.issueInferenceCredential.bind(remote) }),
    recreate: async (args): Promise<RecreateResult> => {
      if (settings.getBoxRuntime() !== "local-docker") {
        if (remote.recreate == null) throw new Error("Remote computer recreation is unavailable.");
        return await remote.recreate(args);
      }
      const removed = await runDocker(["rm", "--force", LOCAL_DOCKER_BOX_CONTAINER]);
      if (!removed.ok && !/no such container/i.test(removed.output)) return { status: "rejected", reason: removed.output };
      await localConnect();
      return { status: "started-untrackable" };
    },
    forceRecreate: async (): Promise<RecreateResult> => {
      if (settings.getBoxRuntime() !== "local-docker") {
        if (remote.forceRecreate == null) return { status: "rejected", reason: "Remote computer reset is unavailable." };
        return await remote.forceRecreate();
      }
      const removed = await runDocker(["rm", "--force", LOCAL_DOCKER_BOX_CONTAINER]);
      if (!removed.ok && !/no such container/i.test(removed.output)) return { status: "rejected", reason: removed.output };
      await localConnect();
      return { status: "started-untrackable" };
    },
  };
}
