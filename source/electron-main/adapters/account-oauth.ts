import { createCursorAuthWiring, reportedAuthStatus, LOCAL_ACCOUNT_AUTH_ID, type AuthServicePort } from "../account/cursor-auth-wiring.js";
import type { SandAuthStatus } from "../account/cursor-auth.js";
import type { ElectronProductionAdapterBindings } from "../production-adapters.js";
import type { ProductionAccountService, ProductionServiceContext } from "../main-production-services.js";
import { accountCacheScope } from "../../shared/node/cursor-token.js";
import { requireFunction, requireObject } from "./provider-guards.js";

type CursorAuthWiringDeps = Parameters<typeof createCursorAuthWiring>[0];

/**
 * Reconstruction policy: the shell never blocks on Cursor sign-in.
 * OpenRouter/Baseten/Claude Code/Codex all run without a Cursor session.
 * Cursor tokens are only demanded later, when a turn actually routes through
 * the Cursor provider — not as a gate to open the app.
 *
 * Opt back into the upstream gate with SAND_REQUIRE_CURSOR_AUTH=1.
 */
export function isCursorAuthRequiredFor(context: Pick<ProductionServiceContext, "settings">): boolean {
  if (process.env.SAND_REQUIRE_CURSOR_AUTH === "1") {
    try {
      return context.settings.settingsStore.getInferenceProvider() === "cursor";
    } catch {
      return true;
    }
  }
  return false;
}

/** Apply independent-mode defaults when a synthetic local account is active. */
export function ensureIndependentLocalDefaults(context: Pick<ProductionServiceContext, "settings">): void {
  try {
    const store = context.settings.settingsStore;
    // Secrets upsert requires an account scope. Scope the local synthetic
    // account immediately so Router API key saves do not race coordinator auth.
    store.scopeToAccount(accountCacheScope(LOCAL_ACCOUNT_AUTH_ID));
    if (store.getInferenceProvider() === "cursor") {
      store.setInferenceProvider("openrouter");
    }
    if (store.getBoxRuntime() !== "local-docker") {
      store.setBoxRuntime("local-docker");
    }
    if (store.getHasSeenOnboarding() !== true) {
      store.setHasSeenOnboarding(true);
    }
  } catch {
    // Settings may not be ready during early bootstrap; auth reporting still works.
  }
}

export interface ProductionAccountOAuthPorts {
  readonly resolveWiringDeps?: (context: ProductionServiceContext) => CursorAuthWiringDeps;
}

function accountRuntimeOf(context: ProductionServiceContext): ReturnType<CursorAuthWiringDeps["getAccountRuntime"]> {
  try {
    const runtime = context.requireCoordinator().getAccountRuntime?.();
    if (runtime != null && typeof (runtime as { observe?: unknown }).observe === "function" && typeof (runtime as { whenIdle?: unknown }).whenIdle === "function") {
      return runtime as ReturnType<CursorAuthWiringDeps["getAccountRuntime"]>;
    }
  } catch {
    // Account construction precedes coordinator construction. The auth wiring
    // must deliver directly until the coordinator exposes its settled runtime.
  }
  return null;
}

function defaultWiringDeps(context: ProductionServiceContext): CursorAuthWiringDeps {
  requireFunction(context.native?.shell?.openExternal, "electron.shell.openExternal");
  requireFunction(context.settings?.settingsStore?.getLocalToolPermission, "account settings.getLocalToolPermission");
  requireFunction(context.settings?.settingsStore?.setLocalToolPermissionCeiling, "account settings.setLocalToolPermissionCeiling");
  requireFunction(context.requireMainEdge, "account main-edge");
  requireFunction(context.coordinatorLegs?.legs?.setHostSettings, "account coordinator.setHostSettings");
  return {
    openExternal: async (url) => { await context.native.shell.openExternal(url); },
    getAccountRuntime: () => accountRuntimeOf(context),
    emitAuthStatus: (status) => {
      if (status.kind === "logged-in" && status.authId === LOCAL_ACCOUNT_AUTH_ID) {
        ensureIndependentLocalDefaults(context);
      }
      context.requireMainEdge().emit("cursor-auth-changed", status);
    },
    isCursorAuthRequired: () => isCursorAuthRequiredFor(context),
    sentryEnabled: context.env.SAND_DISABLE_SENTRY !== "1",
    settingsStore: context.settings.settingsStore,
    syncHostSettingsToBox: async (settings) => {
      const setHostSettings = context.coordinatorLegs.legs.setHostSettings;
      if (typeof setHostSettings !== "function") throw new Error("Electron production account requires coordinator host-settings synchronization.");
      await setHostSettings(settings);
    },
  };
}

function validateAuthService(service: AuthServicePort): AuthServicePort {
  requireObject(service, "accountOAuth.service");
  for (const method of ["subscribe", "getStatus", "getValidAccessToken", "revokeForAccountRefusal", "login", "cancelLogin", "logout", "updateDisplayName"] as const) {
    requireFunction(service[method], `accountOAuth.service.${method}`);
  }
  return service;
}

/** Artifact anchor: main.cjs:505993, `var cursorAuthWiring = createCursorAuthWiring({`. */
export function createProductionAccountOAuthAdapter(
  ports: ProductionAccountOAuthPorts,
): ElectronProductionAdapterBindings["accountOAuth"] {
  return {
    async create(context): Promise<ProductionAccountService> {
      const wiring = createCursorAuthWiring((ports?.resolveWiringDeps ?? defaultWiringDeps)(context));
      const service = validateAuthService(await wiring.ensureCursorAuthService());
      const isCursorAuthRequired = () => isCursorAuthRequiredFor(context);
      const reportedGetStatus = async (): Promise<SandAuthStatus> => {
        const reported = reportedAuthStatus(await service.getStatus(), isCursorAuthRequired());
        if (reported.kind === "logged-in" && reported.authId === LOCAL_ACCOUNT_AUTH_ID) {
          ensureIndependentLocalDefaults(context);
        }
        return reported;
      };
      const subscriptions = new Set<() => void>();
      let disposed = false;
      return {
        getStatus: reportedGetStatus,
        currentAuthStatusFreshness: wiring.currentAuthStatusFreshness,
        deliverCursorAuthStatus(status) {
          if (disposed) throw new Error("Electron production account adapter is disposed.");
          wiring.deliverCursorAuthStatus(service, status);
        },
        async getAuthService() {
          if (disposed) throw new Error("Electron production account adapter is disposed.");
          return service;
        },
        async revokeForAccountRefusal() {
          if (disposed) throw new Error("Electron production account adapter is disposed.");
          return await service.revokeForAccountRefusal();
        },
        subscribe(listener) {
          if (disposed) throw new Error("Electron production account adapter is disposed.");
          const unsubscribe = service.subscribe(() => listener());
          subscriptions.add(unsubscribe);
          return () => { if (subscriptions.delete(unsubscribe)) unsubscribe(); };
        },
        async dispose() {
          if (disposed) return;
          disposed = true;
          const failures: unknown[] = [];
          for (const unsubscribe of [...subscriptions].reverse()) {
            subscriptions.delete(unsubscribe);
            try { unsubscribe(); } catch (error) { failures.push(error); }
          }
          try { wiring.dispose(); } catch (error) { failures.push(error); }
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1) throw new AggregateError(failures, "Electron production account cleanup failed.");
        },
      };
    },
  };
}

/**
 * Exact desktop account composition: native browser callback, secure-store
 * defaults, generated profile clients, main-edge status, coordinator account
 * runtime, and host-settings synchronization remain real owner seams.
 */
export function createElectronProductionAccountOAuthBinding(): ElectronProductionAdapterBindings["accountOAuth"] {
  return createProductionAccountOAuthAdapter({});
}
