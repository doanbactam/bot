import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { archivedDmg, cachedDmg, cachedRuntimeApp, dmgMirrorUrl, dmgSha256, dmgUrl } from "./lib/config.mjs";
import { run } from "./lib/process.mjs";
import { cacheRuntimeFromApp, hydrateSourcePayloadFromRuntime, validateRuntimeApp } from "./lib/runtime.mjs";
import { requireSevenZip, SYSTEM_TOOLS } from "./lib/system-tools.mjs";

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function sha256(target) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
}

async function downloadFrom(url) {
  console.log(`Downloading ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || response.body == null) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  const partial = `${cachedDmg}.partial`;
  await rm(partial, { force: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { mode: 0o600 }));
  const digest = await sha256(partial);
  if (digest !== dmgSha256) {
    await rm(partial, { force: true });
    throw new Error(`DMG checksum mismatch: expected ${dmgSha256}, got ${digest}`);
  }
  await rename(partial, cachedDmg);
}

async function downloadDmg() {
  await mkdir(path.dirname(cachedDmg), { recursive: true });
  if (await exists(cachedDmg)) {
    const digest = await sha256(cachedDmg);
    if (digest === dmgSha256) return;
    await rm(cachedDmg, { force: true });
  }

  if (await exists(archivedDmg)) {
    const archivedDigest = await sha256(archivedDmg);
    if (archivedDigest === dmgSha256) {
      console.log(`Using archived release ${archivedDmg}`);
      await copyFile(archivedDmg, cachedDmg);
      return;
    }
    console.log(`Archived copy at ${archivedDmg} is not the pinned artifact (likely a Git LFS pointer); downloading instead.`);
  }

  const mirror = process.env.GROK_BOT_DMG_MIRROR_URL?.trim();
  const candidates = mirror != null && mirror.length > 0 ? [mirror] : [dmgUrl, dmgMirrorUrl];
  let lastError;
  for (const candidate of candidates) {
    try {
      await downloadFrom(candidate);
      return;
    } catch (error) {
      lastError = error;
      console.warn(`Download candidate failed: ${String(error)}`);
    }
  }
  throw lastError ?? new Error("Unable to download the pinned release.");
}

async function extractRuntime() {
  if (process.platform === "darwin") {
    const mountRoot = await mkdtemp(path.join(tmpdir(), "grok-bot-018-mount-"));
    let attached = false;
    try {
      await run(SYSTEM_TOOLS.hdiutil, ["attach", "-readonly", "-nobrowse", "-mountpoint", mountRoot, cachedDmg]);
      attached = true;
      await cacheRuntimeFromApp(path.join(mountRoot, "Grok Bot.app"));
    } finally {
      if (attached) await run(SYSTEM_TOOLS.hdiutil, ["detach", mountRoot]);
      await rm(mountRoot, { recursive: true, force: true });
    }
    return;
  }
  // Outside macOS the pinned DMG is extracted with 7-Zip (it reads APFS images
  // directly); no kernel mount and no hdiutil are required.
  const sevenZip = requireSevenZip();
  const extractRoot = await mkdtemp(path.join(tmpdir(), "grok-bot-018-dmg-"));
  try {
    await run(sevenZip, ["x", "-y", `-o${extractRoot}`, cachedDmg]);
    await cacheRuntimeFromApp(path.join(extractRoot, "Grok Bot.app"));
  } finally {
    await rm(extractRoot, { recursive: true, force: true });
  }
}

const configuredApp = process.env.GROK_BOT_018_APP?.trim();
let runtimeApp;
if (configuredApp) {
  runtimeApp = await cacheRuntimeFromApp(configuredApp);
} else if (await exists(cachedRuntimeApp)) {
  runtimeApp = await validateRuntimeApp(cachedRuntimeApp);
} else {
  await downloadDmg();
  await extractRuntime();
  runtimeApp = await validateRuntimeApp(cachedRuntimeApp);
}

const hydrated = await hydrateSourcePayloadFromRuntime(runtimeApp);

console.log(`Runtime ready: ${cachedRuntimeApp}`);
console.log(`Checksum-pinned source payload ready: ${hydrated.destination} (${hydrated.sha256})`);
console.log("The checksum-pinned app supplies only the Electron shell, ABI-matched native dependencies, and explicitly documented build fallbacks.");
