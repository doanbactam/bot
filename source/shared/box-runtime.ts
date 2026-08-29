export type SandBoxRuntime = "remote" | "local-docker";

/** Independent reconstruction defaults to the owned local Docker VM. */
export const DEFAULT_SAND_BOX_RUNTIME: SandBoxRuntime = "local-docker";

export function isSandBoxRuntime(value: unknown): value is SandBoxRuntime {
  return value === "remote" || value === "local-docker";
}
