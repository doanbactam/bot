import type { SandAuthStatus } from "./cursor-auth.js";

/**
 * Auth is never demanded to open the reconstruction shell. Cursor credentials
 * only matter when inference is explicitly routed through Cursor; every other
 * provider (OpenRouter default, Baseten, Claude Code, Codex) runs without a
 * Cursor session. When a real session is absent, the reported status is a
 * synthetic local account instead of a blocking "logged-out", so the app boots
 * past the sign-in gate. A real logged-in session always passes through
 * untouched, and optional Cursor login remains available from Settings.
 */
export const LOCAL_ACCOUNT_AUTH_ID = "local";

export function localAccountAuthStatus(): SandAuthStatus {
  return {
    kind: "logged-in",
    authId: LOCAL_ACCOUNT_AUTH_ID,
    displayName: "Local",
    email: "local@grok-bot",
  };
}

export function reportedAuthStatus(status: SandAuthStatus, isCursorAuthRequired: boolean): SandAuthStatus {
  return status.kind === "logged-out" && !isCursorAuthRequired ? localAccountAuthStatus() : status;
}
