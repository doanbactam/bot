import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { cacheDir, repoRoot } from "./config.mjs";
import { run } from "./process.mjs";

export const linuxElectronVersion = "42.1.0";
export const linuxElectronAbi = "146";
const headersUrl = `https://artifacts.electronjs.org/headers/dist/v${linuxElectronVersion}/node-v${linuxElectronVersion}-headers.tar.gz`;

function runNodeGyp(target, headersDir) {
  const command = path.join(repoRoot, "node_modules", ".bin", "node-gyp");
  const environment = {
    ...process.env,
    npm_config_runtime: "electron",
    npm_config_target: linuxElectronVersion,
    npm_config_disturl: "https://artifacts.electronjs.org/headers/dist",
  };
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["rebuild", "--directory", target, "--release", "--nodedir", headersDir, "--jobs", "max"], {
      cwd: repoRoot,
      env: environment,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`node-gyp exited with ${code} for ${path.basename(target)}`)));
  });
}

async function sha256(target) {
  return createHash("sha256").update(await readFile(target)).digest("hex");
}

export async function ensureElectronHeaders() {
  const headersRoot = path.join(cacheDir, "electron-headers", `v${linuxElectronVersion}`);
  const versionHeader = path.join(headersRoot, "include", "node", "node_version.h");
  if (existsSync(versionHeader)) return headersRoot;

  await rm(headersRoot, { recursive: true, force: true });
  await mkdir(headersRoot, { recursive: true });
  const archiveRoot = await mkdtemp(path.join(cacheDir, "electron-headers-download-"));
  try {
    const archive = path.join(archiveRoot, "headers.tar.gz");
    const response = await fetch(headersUrl, { redirect: "follow" });
    if (!response.ok || response.body == null) throw new Error(`Electron headers download failed: HTTP ${response.status}`);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    await run("/bin/tar", ["-xzf", archive, "-C", headersRoot, "--strip-components=1"]);
  } finally {
    await rm(archiveRoot, { recursive: true, force: true });
  }
  if (!existsSync(versionHeader)) throw new Error(`Electron headers archive did not contain include/node/node_version.h under ${headersRoot}`);
  const headerVersion = await readFile(versionHeader, "utf8");
  if (!new RegExp(`#define NODE_MODULE_VERSION ${linuxElectronAbi}\\b`).test(headerVersion)) {
    throw new Error(`Electron ${linuxElectronVersion} headers do not declare NODE_MODULE_VERSION ${linuxElectronAbi}`);
  }
  return headersRoot;
}

async function copyOver(source, destination) {
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true, dereference: true, preserveTimestamps: true });
}

/**
 * The pinned runtime ships native packages as compiled artifacts plus headers;
 * some binding sources (e.g. tree-sitter's `src/*.cc`) are stripped. Restore
 * any file the published npm package contains but the staged copy lacks, so
 * node-gyp can rebuild against the Electron ABI without overwriting the
 * checksum-pinned staged content.
 */
async function copyMissing(sourceRoot, destinationRoot) {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(sourceRoot, entry.name);
    const destination = path.join(destinationRoot, entry.name);
    if (entry.isDirectory()) {
      await mkdir(destination, { recursive: true });
      await copyMissing(source, destination);
    } else if (!existsSync(destination)) {
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination, { dereference: false, preserveTimestamps: true });
    }
  }
}

async function restoreMissingSourcesFromNpm({ packageName, stagedRoot }) {
  const version = JSON.parse(await readFile(path.join(stagedRoot, "package.json"), "utf8")).version;
  const spec = `${packageName}@${version}`;
  const packRoot = await mkdtemp(path.join(cacheDir, "npm-sources-"));
  try {
    await run("npm", ["pack", spec, "--pack-destination", packRoot], { cwd: repoRoot });
    const tarball = (await readdir(packRoot)).find(name => name.endsWith(".tgz"));
    if (tarball == null) throw new Error(`npm pack produced no tarball for ${spec}`);
    const extractRoot = path.join(packRoot, "extract");
    await mkdir(extractRoot, { recursive: true });
    await run("/bin/tar", ["-xzf", path.join(packRoot, tarball), "-C", extractRoot]);
    await copyMissing(path.join(extractRoot, "package"), stagedRoot);
  } finally {
    await rm(packRoot, { recursive: true, force: true });
  }
}

async function stageNapiPrebuilt(stagedPackageRoot, prebuiltRelativeSource) {
  const target = path.join(stagedPackageRoot, "prebuilds", "linux-x64");
  await rm(path.join(stagedPackageRoot, "prebuilds"), { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(repoRoot, "node_modules", prebuiltRelativeSource), target, { recursive: true, dereference: true, preserveTimestamps: true });
}

const betterSqlite3ReleasesUrl = "https://api.github.com/repos/WiseLibs/better-sqlite3/releases?per_page=100";

async function stageBetterSqlite3Prebuilt({ stagedRoot }) {
  const stagedPackage = JSON.parse(await readFile(path.join(stagedRoot, "package.json"), "utf8"));
  const stagedVersion = stagedPackage.version;
  const assetName = version => `better-sqlite3-v${version}-electron-v${linuxElectronAbi}-linux-x64.tar.gz`;

  const response = await fetch(betterSqlite3ReleasesUrl, { headers: { "user-agent": "grok-bot-reconstruction" } });
  if (!response.ok) throw new Error(`better-sqlite3 release lookup failed: HTTP ${response.status}`);
  const releases = JSON.parse(await response.text());
  const major = stagedVersion.split(".")[0];
  const candidates = [
    stagedVersion,
    ...releases
      .filter(release => release.tag_name.startsWith(`v${major}.`))
      .map(release => release.tag_name.slice(1)),
  ];

  for (const version of candidates) {
    const release = releases.find(entry => entry.tag_name === `v${version}`);
    const asset = release?.assets?.find(entry => entry.name === assetName(version));
    if (asset == null) continue;

    const extractRoot = await mkdtemp(path.join(cacheDir, "better-sqlite3-prebuild-"));
    try {
      const archive = path.join(extractRoot, asset.name);
      const download = await fetch(asset.browser_download_url, { redirect: "follow" });
      if (!download.ok || download.body == null) throw new Error(`better-sqlite3 prebuild download failed: HTTP ${download.status}`);
      await writeFile(archive, Buffer.from(await download.arrayBuffer()));
      await run("/bin/tar", ["-xzf", archive, "-C", extractRoot]);
      const prebuilt = path.join(extractRoot, "build", "Release", "better_sqlite3.node");
      if (!existsSync(prebuilt)) throw new Error(`better-sqlite3 prebuild ${asset.name} did not contain build/Release/better_sqlite3.node`);
      await rm(path.join(stagedRoot, "build"), { recursive: true, force: true });
      await mkdir(path.dirname(path.join(stagedRoot, "build", "Release", "better_sqlite3.node")), { recursive: true });
      await cp(prebuilt, path.join(stagedRoot, "build", "Release", "better_sqlite3.node"), { preserveTimestamps: true });
    } finally {
      await rm(extractRoot, { recursive: true, force: true });
    }
    if (version !== stagedVersion) {
      stagedPackage.version = version;
      await writeFile(path.join(stagedRoot, "package.json"), `${JSON.stringify(stagedPackage, null, 2)}\n`);
    }
    return { stagedVersion, packagedVersion: version };
  }
  throw new Error(`No better-sqlite3 release publishes an electron-v${linuxElectronAbi} linux-x64 prebuild`);
}

/**
 * Stage the checksum-pinned upstream `dist/deps` tree for native linux-x64:
 * the JavaScript packages are platform-neutral, while the darwin-arch native
 * binaries are replaced with linux-x64 equivalents rebuilt or fetched from the
 * same pinned package versions.
 */
export async function stageLinuxRuntimeDependencies({ runtimeDepsRoot, stageDepsRoot }) {
  await rm(stageDepsRoot, { recursive: true, force: true });
  await mkdir(path.dirname(stageDepsRoot), { recursive: true });
  await cp(runtimeDepsRoot, stageDepsRoot, { recursive: true, dereference: false, preserveTimestamps: true });

  if (process.arch !== "x64") throw new Error(`The Linux reconstruction currently stages linux-x64 native dependencies, not ${process.arch}`);

  const upstreamManifest = JSON.parse(await readFile(path.join(runtimeDepsRoot, "runtime-deps-manifest.json"), "utf8"));
  const headersDir = await ensureElectronHeaders();

  // tree-sitter runtime binding: the staged package ships only compiled
  // artifacts and headers, so restore the missing binding sources from the
  // published npm package and rebuild against the Electron ABI (upstream
  // staged a darwin-arm64 build of the same sources).
  await restoreMissingSourcesFromNpm({ packageName: "tree-sitter", stagedRoot: path.join(stageDepsRoot, "tree-sitter") });
  await runNodeGyp(path.join(stageDepsRoot, "tree-sitter"), headersDir);
  const rebuiltBinding = path.join(stageDepsRoot, "tree-sitter", "build", "Release", "tree_sitter_runtime_binding.node");
  if (!existsSync(rebuiltBinding)) throw new Error("tree-sitter Electron build did not produce tree_sitter_runtime_binding.node");

  // tree-sitter-bash: the upstream payload keeps only a darwin prebuild; stage
  // the matching linux-x64 NAPI prebuild shipped in the same npm package.
  await stageNapiPrebuilt(path.join(stageDepsRoot, "tree-sitter-bash"), path.join("tree-sitter-bash", "prebuilds", "linux-x64"));

  // better-sqlite3: the pinned 12.6.2 sources predate the V8 API shipped in
  // Electron 42 headers (PropertyCallbackInfo::This()/External::Value() were
  // removed), so compiling from the staged amalgamation fails. Stage the
  // official WiseLibs prebuilt binary for the exact Electron runtime instead:
  // prefer the pinned version, else the newest release in the same major line
  // that publishes an electron-v<ABI> linux-x64 prebuild.
  const betterSqlite3 = await stageBetterSqlite3Prebuilt({ stagedRoot: path.join(stageDepsRoot, "better-sqlite3") });
  const rebuiltSqlite = path.join(stageDepsRoot, "better-sqlite3", "build", "Release", "better_sqlite3.node");
  if (!existsSync(rebuiltSqlite)) throw new Error("better-sqlite3 Electron prebuild did not produce better_sqlite3.node");

  // whichlang-node: swap the darwin-arch platform package for its linux-x64
  // glibc twin published by the same upstream release.
  const whichlangVersion = JSON.parse(await readFile(path.join(stageDepsRoot, "whichlang-node-darwin-arm64", "package.json"), "utf8")).version;
  const platformPackage = `whichlang-node-linux-x64-gnu@${whichlangVersion}`;
  const packRoot = await mkdtemp(path.join(cacheDir, "whichlang-pack-"));
  try {
    await run("npm", ["pack", platformPackage, "--pack-destination", packRoot], { cwd: repoRoot });
    const tarball = (await readdir(packRoot)).find(name => name.endsWith(".tgz"));
    if (tarball == null) throw new Error(`npm pack produced no tarball for ${platformPackage}`);
    const extractRoot = path.join(packRoot, "extract");
    await mkdir(extractRoot, { recursive: true });
    await run("/bin/tar", ["-xzf", path.join(packRoot, tarball), "-C", extractRoot]);
    await rm(path.join(stageDepsRoot, "whichlang-node-darwin-arm64"), { recursive: true, force: true });
    await copyOver(path.join(extractRoot, "package"), path.join(stageDepsRoot, "whichlang-node-linux-x64-gnu"));
  } finally {
    await rm(packRoot, { recursive: true, force: true });
  }

  // Anysphere-private darwin-only native binaries without shipped sources.
  // Runtime consumers load these lazily and degrade gracefully; stage the JS
  // shims but drop the incompatible binaries.
  const darwinOnlyBinaries = [
    path.join(stageDepsRoot, "@anysphere", "tree-chunk-napi", "tree-chunk-napi.darwin-arm64.node"),
    path.join(stageDepsRoot, "cursor-proclist", "build", "Release", "cursor_proclist.node"),
  ];
  for (const binary of darwinOnlyBinaries) await rm(binary, { force: true });

  const manifest = {
    platform: "linux",
    arch: process.arch,
    required: ["tree-sitter", "tree-sitter-bash", "whichlang-node"],
    copied: upstreamManifest.copied?.filter(name => name !== "@anysphere/tree-chunk-napi" && name !== "cursor-proclist") ?? [],
    unsupportedDarwinOnly: ["@anysphere/tree-chunk-napi", "cursor-proclist"],
    reconstruction: {
      stagedBy: "scripts/lib/linux-runtime-deps.mjs",
      electron: linuxElectronVersion,
      electronAbi: Number(linuxElectronAbi),
      rebuiltNative: ["tree-sitter"],
      swappedNative: ["tree-sitter-bash", "better-sqlite3", "whichlang-node"],
      betterSqlite3: {
        ...betterSqlite3,
        source: "official WiseLibs electron-v146 linux-x64 prebuild",
        reason: "pinned 12.6.2 sources predate the V8 API of Electron 42 headers",
      },
      upstreamManifestSha256: await sha256(path.join(runtimeDepsRoot, "runtime-deps-manifest.json")),
    },
  };
  await writeFile(path.join(stageDepsRoot, "runtime-deps-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { stageDepsRoot, manifest };
}
