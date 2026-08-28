export const SAND_INFERENCE_PROVIDERS = ["cursor", "claude-code", "codex", "openrouter"] as const;
export type SandInferenceProvider = (typeof SAND_INFERENCE_PROVIDERS)[number];

/**
 * The reconstruction runs independently of any Cursor session by default:
 * OpenRouter only needs an API key saved through the desktop secrets bridge
 * (or the OPENROUTER_API_KEY environment variable). Cursor remains available
 * as an explicit opt-in provider.
 */
export const DEFAULT_SAND_INFERENCE_PROVIDER: SandInferenceProvider = "openrouter";

export interface SandInferenceRouterUsageProvider {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly lastUsedAt: string | null;
}

export interface SandInferenceRouterUsage {
  readonly schemaVersion: 1;
  readonly providers: Record<SandInferenceProvider, SandInferenceRouterUsageProvider>;
}

export function isSandInferenceProvider(value: unknown): value is SandInferenceProvider {
  return typeof value === "string" && (SAND_INFERENCE_PROVIDERS as readonly string[]).includes(value);
}

export function emptySandInferenceRouterUsage(): SandInferenceRouterUsage {
  const empty = (): SandInferenceRouterUsageProvider => ({ requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, lastUsedAt: null });
  return { schemaVersion: 1, providers: { cursor: empty(), "claude-code": empty(), codex: empty(), openrouter: empty() } };
}
