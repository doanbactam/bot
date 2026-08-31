import { randomInt, randomUUID } from "node:crypto";
import { MethodKind, type ServiceType } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";

import { LOCAL_DOCKER_EXEC_DAEMON_DEFAULT_URL, readLocalDockerExecDaemonToken } from "../shared/local-docker-box-credentials.js";
import { ExecService } from "../packages/proto/generated/agent/v1/exec_service_connect.js";
import { ExecServerMessage, type ExecClientMessage } from "../packages/proto/generated/agent/v1/exec_pb.js";
import { ShellArgs, type ShellResult, type ShellStream } from "../packages/proto/generated/agent/v1/shell_exec_pb.js";

export const ROUTED_SHELL_TOOL_NAME = "Shell";
export const LOCAL_DOCKER_BOX_CONTAINER = "grok-bot-local-vm";

export const ROUTED_SHELL_TOOL = {
  name: ROUTED_SHELL_TOOL_NAME,
  toolName: ROUTED_SHELL_TOOL_NAME,
  providerIdentifier: "grok-bot-box",
  description:
    "Run a bash command on Grok Bot's computer (the local Docker box). Use for files, installs, and checks inside the box. Working directory defaults to /workspace. The box has a real GUI on DISPLAY=:1 — open the browser with box-chrome, never google-chrome --headless, and never claim there is no display.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Bash command to run" },
      working_directory: {
        type: "string",
        description: "Absolute working directory on the box (default /workspace)",
      },
      description: { type: "string", description: "Short description of what this command does" },
    },
    required: ["command"],
    additionalProperties: false,
  },
} as const;

const DEFAULT_CWD = "/workspace";
const MAX_OUTPUT = 80_000;
const DEFAULT_TIMEOUT_MS = 120_000;

const RoutedExecService = {
  typeName: ExecService.typeName,
  methods: { exec: { ...ExecService.methods.exec, kind: MethodKind.ServerStreaming } },
} as const satisfies ServiceType;

export interface RoutedShellTransport {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly timeoutMs?: number;
}

let configuredTransport: RoutedShellTransport | undefined;

export function configureRoutedShell(transport: RoutedShellTransport | undefined): void {
  configuredTransport = transport;
}

export async function loadRoutedShellTransport(options?: {
  readonly settingsPath?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<RoutedShellTransport> {
  const env = options?.env ?? process.env;
  const baseUrl = env.SAND_BOX_EXEC_DAEMON_URL?.trim() || configuredTransport?.baseUrl || LOCAL_DOCKER_EXEC_DAEMON_DEFAULT_URL;
  const envToken = env.SAND_BOX_EXEC_DAEMON_AUTH_TOKEN?.trim();
  if (envToken != null && envToken.length > 0) return { baseUrl, authToken: envToken };
  if (configuredTransport != null && configuredTransport.authToken.length > 0) {
    return { baseUrl: configuredTransport.baseUrl, authToken: configuredTransport.authToken, ...(configuredTransport.timeoutMs == null ? {} : { timeoutMs: configuredTransport.timeoutMs }) };
  }
  if (options?.settingsPath != null) {
    const stored = await readLocalDockerExecDaemonToken(options.settingsPath);
    if (stored != null) return { baseUrl, authToken: stored };
  }
  return { baseUrl, authToken: "" };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n…[truncated]`;
}

function shellFailure(stderr: string, extras?: { readonly stdout?: string; readonly workingDirectory?: string }): Record<string, unknown> {
  return {
    exitCode: 1,
    stdout: truncate(extras?.stdout ?? ""),
    stderr: truncate(stderr),
    ...(extras?.workingDirectory == null ? {} : { workingDirectory: extras.workingDirectory }),
    isError: true,
  };
}

function fromCompleted(
  exitCode: number,
  stdout: string,
  stderr: string,
  workingDirectory: string,
  isError = exitCode !== 0,
): Record<string, unknown> {
  return {
    exitCode,
    stdout: truncate(stdout),
    stderr: truncate(stderr),
    workingDirectory,
    isError,
  };
}

function describeConnectError(error: unknown): string {
  if (error instanceof ConnectError) {
    if (error.code === Code.Unauthenticated || error.code === Code.PermissionDenied) {
      return "Exec daemon rejected the control token.";
    }
    return `Exec RPC ${error.code}: ${error.rawMessage}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function fromShellResult(result: ShellResult, fallbackCwd: string): Record<string, unknown> | undefined {
  switch (result.result.case) {
    case "success": {
      const value = result.result.value;
      return fromCompleted(value.exitCode, value.stdout, value.stderr, value.workingDirectory || fallbackCwd, value.exitCode !== 0);
    }
    case "failure": {
      const value = result.result.value;
      return fromCompleted(value.exitCode, value.stdout, value.stderr, value.workingDirectory || fallbackCwd, true);
    }
    case "timeout": {
      const value = result.result.value;
      return shellFailure(`Command timed out after ${value.timeoutMs}ms.`, { workingDirectory: value.workingDirectory || fallbackCwd });
    }
    case "spawnError": {
      const value = result.result.value;
      return shellFailure(value.error || "Shell failed to spawn.", { workingDirectory: value.workingDirectory || fallbackCwd });
    }
    case "rejected": {
      const value = result.result.value;
      return shellFailure(value.reason || "Shell command was rejected.", { workingDirectory: value.workingDirectory || fallbackCwd });
    }
    case "permissionDenied": {
      const value = result.result.value;
      return shellFailure(value.error || "Shell permission denied.", { workingDirectory: value.workingDirectory || fallbackCwd });
    }
    default:
      return undefined;
  }
}

function applyShellStreamEvent(
  event: ShellStream["event"],
  state: { stdout: string; stderr: string; exitCode: number | undefined; workingDirectory: string; terminalError: string | undefined },
): void {
  switch (event.case) {
    case "stdout":
      state.stdout += event.value.data;
      break;
    case "stderr":
      state.stderr += event.value.data;
      break;
    case "exit":
      state.exitCode = event.value.code;
      if (event.value.cwd.length > 0) state.workingDirectory = event.value.cwd;
      break;
    case "rejected":
      state.terminalError = event.value.reason || "Shell command was rejected.";
      break;
    case "permissionDenied":
      state.terminalError = event.value.error || "Shell permission denied.";
      break;
    case "sandboxUnsupported":
      state.terminalError = event.value.reason || "Sandbox is not supported for this command.";
      break;
    default:
      break;
  }
}

function createExecClient(transport: RoutedShellTransport) {
  return createClient(RoutedExecService, createConnectTransport({
    baseUrl: transport.baseUrl,
    httpVersion: "1.1",
    interceptors: [
      (next) => async (request) => {
        request.header.set("authorization", `Bearer ${transport.authToken}`);
        return await next(request);
      },
    ],
  }));
}

export async function executeRoutedShell(args: unknown, transport?: RoutedShellTransport): Promise<Record<string, unknown>> {
  const record = asRecord(args) ?? {};
  const command = typeof record.command === "string" ? record.command : "";
  if (command.trim().length === 0) {
    return shellFailure("Shell requires a non-empty command.");
  }
  const cwd =
    typeof record.working_directory === "string" && record.working_directory.trim().length > 0
      ? record.working_directory.trim()
      : DEFAULT_CWD;
  const resolved = transport ?? configuredTransport ?? await loadRoutedShellTransport();
  if (resolved.authToken.trim().length === 0) {
    return shellFailure("No exec daemon control token is configured.");
  }
  const timeoutMs = resolved.timeoutMs != null && resolved.timeoutMs > 0 ? resolved.timeoutMs : DEFAULT_TIMEOUT_MS;
  const request = new ExecServerMessage({
    id: randomInt(1, 0xffff_ffff),
    execId: randomUUID(),
    message: {
      case: "shellArgs",
      value: new ShellArgs({
        command,
        workingDirectory: cwd,
        timeout: timeoutMs,
      }),
    },
  });

  const streamState = { stdout: "", stderr: "", workingDirectory: cwd, exitCode: undefined as number | undefined, terminalError: undefined as string | undefined };
  let shellResult: Record<string, unknown> | undefined;
  try {
    const client = createExecClient(resolved);
    for await (const element of client.exec(request, { timeoutMs })) {
      if (element.element.case === "execClientControlMessage") {
        const control = element.element.value.message;
        if (control.case === "throw") {
          return shellFailure(control.value.error || "Exec daemon threw a control error.", { workingDirectory: cwd });
        }
        continue;
      }
      if (element.element.case !== "execClientMessage") continue;
      const message: ExecClientMessage["message"] = element.element.value.message;
      if (message.case === "shellResult" || message.case === "miniSweAgentBashResult") {
        shellResult = fromShellResult(message.value, cwd);
        continue;
      }
      if (message.case === "shellStream") applyShellStreamEvent(message.value.event, streamState);
    }
  } catch (error) {
    const detail = describeConnectError(error);
    if (error instanceof ConnectError && (error.code === Code.Unauthenticated || error.code === Code.PermissionDenied)) {
      return shellFailure(detail);
    }
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    const unreachable = error instanceof ConnectError
      ? error.code === Code.Unavailable || error.code === Code.DeadlineExceeded || error.code === Code.Aborted || /econnreset|econnrefused|fetch failed|network/.test(message)
      : /fetch failed|econnrefused|enotfound|econnreset|network|abort/.test(message);
    if (unreachable) {
      return shellFailure(
        `Couldn't reach Grok Bot's computer exec daemon (${detail}). Is the local Docker VM running (${LOCAL_DOCKER_BOX_CONTAINER})?`,
      );
    }
    return shellFailure(detail);
  }

  if (shellResult != null) return shellResult;
  if (streamState.terminalError != null) {
    return shellFailure(streamState.terminalError, { stdout: streamState.stdout, workingDirectory: streamState.workingDirectory });
  }
  if (streamState.exitCode != null) {
    return fromCompleted(streamState.exitCode, streamState.stdout, streamState.stderr, streamState.workingDirectory);
  }
  return shellFailure("Exec daemon returned no terminal shell result.", { workingDirectory: cwd });
}

export function isRoutedShellTool(definition: { name?: unknown; toolName?: unknown; providerIdentifier?: unknown }): boolean {
  return (
    definition.providerIdentifier === ROUTED_SHELL_TOOL.providerIdentifier
    || definition.name === ROUTED_SHELL_TOOL_NAME
    || definition.toolName === ROUTED_SHELL_TOOL_NAME
  );
}

export function withRoutedShellTools(tools: readonly Record<string, unknown>[] | undefined): Record<string, unknown>[] {
  const rest = (tools ?? []).filter((tool) => !isRoutedShellTool(tool));
  return [{ ...ROUTED_SHELL_TOOL }, ...rest];
}
