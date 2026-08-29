const LOCAL_DOCKER_BOX_CONTAINER = "grok-bot-local-vm";

export const ROUTED_SHELL_TOOL_NAME = "Shell";

export const ROUTED_SHELL_TOOL = {
  name: ROUTED_SHELL_TOOL_NAME,
  toolName: ROUTED_SHELL_TOOL_NAME,
  providerIdentifier: "grok-bot-box",
  description:
    "Run a bash command on Grok Bot's computer (the local Docker box). Use for files, installs, and checks inside the box. Working directory defaults to /workspace.",
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

const EXEC_URL = "http://127.0.0.1:1337/agent.v1.ControlService/Exec";
const DEFAULT_CWD = "/workspace";
const MAX_OUTPUT = 80_000;

function connectJsonEnvelope(payload: Uint8Array): Uint8Array {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.byteLength, 1);
  return Buffer.concat([header, payload]);
}

function decodeConnectJsonStream(body: Uint8Array): unknown[] {
  const messages: unknown[] = [];
  let offset = 0;
  while (offset + 5 <= body.byteLength) {
    const flags = body[offset]!;
    const length = (body[offset + 1]! << 24) | (body[offset + 2]! << 16) | (body[offset + 3]! << 8) | body[offset + 4]!;
    offset += 5;
    if (offset + length > body.byteLength) break;
    const chunk = body.subarray(offset, offset + length);
    offset += length;
    if ((flags & 0b10) !== 0) continue; // end-stream / trailers
    if (chunk.byteLength === 0) continue;
    try {
      messages.push(JSON.parse(Buffer.from(chunk).toString("utf8")));
    } catch {
      // ignore malformed frame
    }
  }
  return messages;
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

export async function executeRoutedShell(args: unknown): Promise<Record<string, unknown>> {
  const record = asRecord(args) ?? {};
  const command = typeof record.command === "string" ? record.command : "";
  if (command.trim().length === 0) {
    return { exitCode: 1, stdout: "", stderr: "Shell requires a non-empty command.", isError: true };
  }
  const cwd =
    typeof record.working_directory === "string" && record.working_directory.trim().length > 0
      ? record.working_directory.trim()
      : DEFAULT_CWD;

  const payload = Buffer.from(
    JSON.stringify({
      command: "bash",
      args: ["-lc", command],
      cwd,
    }),
    "utf8",
  );

  let response: Response;
  try {
    response = await fetch(EXEC_URL, {
      method: "POST",
      headers: {
        authorization: "Bearer local",
        "content-type": "application/connect+json",
        "connect-protocol-version": "1",
      },
      body: connectJsonEnvelope(payload),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Couldn't reach Grok Bot's computer exec daemon (${error instanceof Error ? error.message : String(error)}). Is the local Docker VM running (${LOCAL_DOCKER_BOX_CONTAINER})?`,
      isError: true,
    };
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Exec HTTP ${response.status}: ${Buffer.from(bytes).toString("utf8").slice(0, 500)}`,
      isError: true,
    };
  }

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  for (const message of decodeConnectJsonStream(bytes)) {
    const row = asRecord(message);
    if (row == null) continue;
    const stdoutEvent = asRecord(row.stdoutEvent);
    const stderrEvent = asRecord(row.stderrEvent);
    const exitEvent = asRecord(row.exitEvent);
    if (stdoutEvent != null && typeof stdoutEvent.data === "string") stdout += stdoutEvent.data;
    if (stderrEvent != null && typeof stderrEvent.data === "string") stderr += stderrEvent.data;
    if (exitEvent != null) {
      if (typeof exitEvent.exitCode === "number") exitCode = exitEvent.exitCode;
      else if (typeof exitEvent.code === "number") exitCode = exitEvent.code;
    }
  }

  return {
    exitCode,
    stdout: truncate(stdout),
    stderr: truncate(stderr),
    workingDirectory: cwd,
    isError: exitCode !== 0,
  };
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
