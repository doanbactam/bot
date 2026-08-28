import { existsSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./config.mjs";

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate != null && existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveSevenZip() {
  const configured = process.env.GROK_BOT_SEVENZIP?.trim();
  if (configured != null && configured.length > 0) return configured;
  return firstExisting([
    // Prefer the official 7-Zip "7zz" build (newer releases read APFS images,
    // which the pinned DMG uses). Legacy p7zip "7za"/"7z" binaries predate
    // APFS support and fail on the pinned artifact.
    path.join(repoRoot, ".cache", "bin", "7zz"),
    "/usr/local/bin/7zz",
    "/opt/homebrew/bin/7zz",
    "/usr/bin/7zz",
    "/bin/7zz",
    "/usr/bin/7z",
    "/usr/bin/7za",
  ]);
}

const darwin = Object.freeze({
  platform: "darwin",
  cp: "/bin/cp",
  lsof: "/usr/sbin/lsof",
  ps: "/bin/ps",
  codesign: "/usr/bin/codesign",
  ditto: "/usr/bin/ditto",
  hdiutil: "/usr/bin/hdiutil",
  plutil: "/usr/bin/plutil",
  xattr: "/usr/bin/xattr",
});

const linux = Object.freeze({
  platform: "linux",
  cp: "/bin/cp",
  lsof: firstExisting(["/usr/bin/lsof", "/bin/lsof"]),
  ps: "/bin/ps",
  sevenZip: resolveSevenZip(),
});

const win32 = Object.freeze({
  platform: "win32",
  cp: "cp",
  ps: "ps",
  sevenZip: resolveSevenZip(),
});

export const SYSTEM_TOOLS = process.platform === "darwin"
  ? darwin
  : process.platform === "win32"
    ? win32
    : linux;

export function requireSevenZip() {
  const tool = SYSTEM_TOOLS.sevenZip;
  if (tool == null) {
    throw new Error(
      "7-Zip (7zz/7za) is required to extract the pinned DMG outside macOS. "
      + "Install it (e.g. `apt install p7zip-full` or the official 7-Zip Linux build) "
      + "or point GROK_BOT_SEVENZIP at the binary.",
    );
  }
  return tool;
}

export function requireDarwinTool(name) {
  const tool = SYSTEM_TOOLS[name];
  if (tool == null || process.platform !== "darwin") {
    throw new Error(`The ${name} tool is only available in the macOS packaging path.`);
  }
  return tool;
}
