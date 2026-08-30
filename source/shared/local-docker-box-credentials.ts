import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const LOCAL_DOCKER_BOX_CREDENTIAL_FILE = "local-docker-vm.json";
export const LOCAL_DOCKER_EXEC_DAEMON_DEFAULT_URL = "http://127.0.0.1:1337";

export interface LocalDockerBoxCredentials {
  readonly token: string;
  readonly execDaemonToken: string;
}

export function localDockerBoxCredentialPath(settingsPath: string): string {
  return join(dirname(settingsPath), LOCAL_DOCKER_BOX_CREDENTIAL_FILE);
}

export function createLocalDockerControlToken(): string {
  return randomBytes(32).toString("hex");
}

function isUsableToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 32;
}

async function persistLocalDockerBoxCredentials(target: string, credentials: LocalDockerBoxCredentials): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, token: credentials.token, execDaemonToken: credentials.execDaemonToken }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

export async function readOrCreateLocalDockerBoxCredentials(settingsPath: string): Promise<LocalDockerBoxCredentials> {
  const target = localDockerBoxCredentialPath(settingsPath);
  try {
    const parsed = JSON.parse(await readFile(target, "utf8")) as { token?: unknown; execDaemonToken?: unknown };
    const token = isUsableToken(parsed.token) ? parsed.token : undefined;
    const execDaemonToken = isUsableToken(parsed.execDaemonToken) ? parsed.execDaemonToken : undefined;
    if (token != null && execDaemonToken != null) return { token, execDaemonToken };
    const credentials = {
      token: token ?? createLocalDockerControlToken(),
      execDaemonToken: execDaemonToken ?? createLocalDockerControlToken(),
    };
    await persistLocalDockerBoxCredentials(target, credentials);
    return credentials;
  } catch {
    const credentials = {
      token: createLocalDockerControlToken(),
      execDaemonToken: createLocalDockerControlToken(),
    };
    await persistLocalDockerBoxCredentials(target, credentials);
    return credentials;
  }
}

export async function readLocalDockerExecDaemonToken(settingsPath: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(localDockerBoxCredentialPath(settingsPath), "utf8")) as { execDaemonToken?: unknown };
    return isUsableToken(parsed.execDaemonToken) ? parsed.execDaemonToken : undefined;
  } catch {
    return undefined;
  }
}
