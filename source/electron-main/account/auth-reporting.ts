import type { SandAuthStatus } from "./cursor-auth.js";

/**
 * Auth is only demanded when it is actually needed. Cursor credentials gate
 * Cursor-routed inference and account features; every other provider (the
 * OpenRouter default, Claude Code, Codex) runs without any Cursor session.
 * When a real session is absent and Cursor auth is not required, the reported
 * status is a synthetic local account instead of a blocking "logged-out", so
 * the app boots past the sign-in gate. A real logged-in session always passes
 * through untouched, and explicit login flows remain fully functional.
 */
export const LOCAL_ACCOUNT_AUTH_ID = "local";

export function localAccountAuthStatus(): SandAuthStatus {
  return { kind: "logged-in", authId: LOCAL_ACCOUNT_AUTH_ID };
}

export function reportedAuthStatus(status: SandAuthStatus, isCursorAuthRequired: boolean): SandAuthStatus {
  return status.kind === "logged-out" && !isCursorAuthRequired ? localAccountAuthStatus() : status;
}
