import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { getSandRootDir } from "../../host/host-paths.js";
import { validateBoxSecrets } from "../../shared/box-secrets.js";

export const BOX_SECRETS_FILENAME = "box-secrets.json";

export function resolveBoxSecretsStorePath(homeRoot = getSandRootDir()): string {
  return join(homeRoot, BOX_SECRETS_FILENAME);
}

/**
 * Persist decrypted box secrets to the same on-disk store the inference router
 * reads (`box-secrets.json`). Router API keys must land here even when the
 * live box push fails, otherwise Settings → Save looks successful while chat
 * still reports a missing key.
 */
export async function mirrorBoxSecretsToDisk(
  secrets: Readonly<Record<string, string>>,
  storePath: string = resolveBoxSecretsStorePath(),
): Promise<void> {
  const validationError = validateBoxSecrets(secrets);
  if (validationError != null) throw new Error(validationError);
  await fs.mkdir(dirname(storePath), { recursive: true });
  const temporary = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({ version: 1, secrets }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temporary, storePath);
  await fs.chmod(storePath, 0o600).catch(() => undefined);
}
