import { cp, mkdir, readFile, rm, stat, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { buildFidelityReconstructedAsar } from "./clean-build.mjs";
import { linuxOutputDir, repoRoot, reconstructedName, upstreamVersion } from "./lib/config.mjs";
import { run } from "./lib/process.mjs";

if (process.platform !== "linux") {
  throw new Error("The reconstructed Linux application is packaged with `npm run package` on macOS; package-linux targets linux-x64 hosts.");
}

// Same hybrid assembly as the macOS package: compiled reconstructed runtimes
// plus the checksum-pinned shipped renderer, packed into an ASAR, wrapped in
// an unmodified npm Electron 42.1.0 linux-x64 shell instead of the macOS
// bundle from the pinned DMG.
const { builtAsar, builtAsarUnpacked } = await buildFidelityReconstructedAsar();

const electronDist = path.join(repoRoot, "node_modules", "electron", "dist");
if (!existsSync(path.join(electronDist, "electron"))) {
  console.log("Fetching the pinned Electron 42.1.0 linux-x64 runtime...");
  await run(process.execPath, [path.join(repoRoot, "node_modules", "electron", "install.js")], { cwd: repoRoot });
}
if (!existsSync(path.join(electronDist, "electron"))) {
  // extract-zip can silently yield a partial tree on some filesystems; recover
  // from the @electron/get artifact cache with the system unzip.
  console.log("Recovering the Electron runtime from its artifact cache...");
  const { downloadArtifact } = await import("@electron/get");
  const artifact = await downloadArtifact({
    version: "42.1.0",
    artifactName: "electron",
    platform: "linux",
    arch: process.arch,
  });
  await rm(electronDist, { recursive: true, force: true });
  await mkdir(electronDist, { recursive: true });
  await run("/usr/bin/unzip", ["-oq", artifact, "-d", electronDist]);
  await writeFile(path.join(repoRoot, "node_modules", "electron", "path.txt"), "electron");
}
if (!existsSync(path.join(electronDist, "electron"))) {
  throw new Error("The Electron 42.1.0 linux-x64 runtime did not install correctly");
}
const electronPackage = JSON.parse(await readFile(path.join(repoRoot, "node_modules", "electron", "package.json"), "utf8"));
if (electronPackage.version !== "42.1.0") {
  throw new Error(`Expected Electron 42.1.0 in node_modules, got ${electronPackage.version}`);
}

await rm(linuxOutputDir, { recursive: true, force: true });
await cp(electronDist, linuxOutputDir, { recursive: true, dereference: false, preserveTimestamps: true });

const resources = path.join(linuxOutputDir, "resources");
const packagedAsar = path.join(resources, "app.asar");
const packagedUnpacked = `${packagedAsar}.unpacked`;
await rm(packagedAsar, { force: true });
await rm(packagedUnpacked, { recursive: true, force: true });
await cp(builtAsar, packagedAsar, { preserveTimestamps: true });
await cp(builtAsarUnpacked, packagedUnpacked, {
  recursive: true,
  dereference: false,
  preserveTimestamps: true,
});

// npm Electron ships a default_app.asar fallback; remove it so the packaged
// reconstruction is the only entry point.
await rm(path.join(resources, "default_app.asar"), { force: true });

const launcher = `#!/bin/sh
# ${reconstructedName} (linux-x64) launcher
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/electron" "$@" "$DIR/resources/app.asar"
`;
const launcherPath = path.join(linuxOutputDir, "grok-bot");
await writeFile(launcherPath, launcher, { mode: 0o755 });
await chmod(launcherPath, 0o755);

const desktopEntry = [
  "[Desktop Entry]",
  `Name=${reconstructedName}`,
  "Comment=Source-oriented reconstruction of Grok Bot 0.18",
  "Type=Application",
  "Categories=Development;Utility;",
  `Exec=${linuxOutputDir}/grok-bot`,
  "Terminal=false",
  "",
].join("\n");
await writeFile(path.join(linuxOutputDir, `${reconstructedName}.desktop`), desktopEntry);

// Packaging verification: ASAR identity, native payload presence, launcher.
const asarDigest = createHash("sha256").update(await readFile(packagedAsar)).digest("hex");
const nativePayload = path.join(packagedUnpacked, "dist", "deps", "tree-sitter", "build", "Release", "tree_sitter_runtime_binding.node");
if (!(await stat(nativePayload)).isFile()) throw new Error("Packaged Linux ASAR is missing the linux-x64 tree-sitter runtime binding");
const manifest = JSON.parse(await readFile(path.join(packagedUnpacked, "dist", "deps", "runtime-deps-manifest.json"), "utf8"));
if (manifest.platform !== "linux" || manifest.arch !== process.arch) {
  throw new Error(`Packaged deps manifest is not linux/${process.arch}: ${manifest.platform}/${manifest.arch}`);
}
if (!existsSync(path.join(linuxOutputDir, "electron")) || !existsSync(launcherPath)) {
  throw new Error("Linux application directory assembly is incomplete");
}

const record = {
  schemaVersion: 1,
  kind: "grok-bot-reconstructed-linux-package",
  platform: `linux-${process.arch}`,
  upstreamVersion,
  electron: electronPackage.version,
  asarSha256: asarDigest,
  output: linuxOutputDir,
};
await writeFile(path.join(linuxOutputDir, "package-record.json"), `${JSON.stringify(record, null, 2)}\n`);

console.log(`Packaged Linux application: ${linuxOutputDir}`);
console.log(`ASAR sha256: ${asarDigest}`);
console.log(`Launch: ${linuxOutputDir}/grok-bot`);
