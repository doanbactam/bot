// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=3304565 (agent.v1.ShellToolCall)
// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=3336849 (agent.v1.EditResult)
// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=3837426 (agent.v1.WriteArgs)
// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=2920347 (agent.v1.ShellResult)

export type ToolResultCardKind = "file-edit" | "file-write" | "shell";
export type ToolResultCardStatus = "running" | "success" | "error" | "denied" | "rejected" | "cancelled" | "background";

export interface ToolResultCardSnapshot {
  kind: ToolResultCardKind;
  toolCallId: string | null;
  status: ToolResultCardStatus;
  path: string | null;
  command: string | null;
  workingDirectory: string | null;
  summary: string;
  output: string;
  diff: string;
  isStreaming: boolean;
  isBackground: boolean;
}
