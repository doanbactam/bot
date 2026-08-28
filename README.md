# Grok Bot 0.18 — reconstructed and extended

![Grok Bot Router settings with Codex selected and local usage totals](docs/assets/router-settings.png)

This repository is an unofficial, source-oriented reconstruction of the
publicly shipped Grok Bot 0.18.0 macOS app.

The project began as an attempt to understand how the desktop app was put
together. It now contains readable TypeScript implementations of its Electron,
host, coordinator, local-execution, protocol, and renderer boundaries, plus a
deterministic toolchain for turning those sources back into a working macOS
application (and, experimentally, a linux-x64 application directory).

It also adds a few practical experiments:

- an inference router for Cursor, Claude Code, Codex, and OpenRouter;
- Grok Bot plugin/MCP tools across the routed providers;
- local usage tracking for routed inference;
- an optional local Docker sandbox in place of the remote box; and
- a reconstructed settings surface integrated into the polished shipped UI.

This is a hacking and research project, not Anysphere's original monorepo and
not an official Grok Bot release. Names and module boundaries inferred from a
compiled application may differ from the original source.

## What is in the repository?

The checked-in tree contains the reviewed reconstruction, tests, manifests,
build scripts, and Git LFS preservation copies of the original macOS arm64 and
Windows x64 installers. It deliberately does **not** commit the extracted
upstream application, build output, local credentials, or the large forensic
recovery workspace.

The public Grok Bot 0.18.0 application is instead treated as a pinned build
input. During bootstrap, the toolchain downloads it, verifies its SHA-256
identity, and extracts the pieces required to assemble the reconstruction.

The resulting app is a hybrid by design:

- application runtimes are compiled from the readable sources under `source/`;
- the polished shipped renderer remains the UI baseline;
- a narrow deterministic transform adds the reconstructed Router settings UI;
- original and patched renderer chunk hashes are recorded and verified; and
- the finished app uses a separate bundle identifier and an ad-hoc signature.

The upstream app installed on the machine is never overwritten.

### Why retain the shipped renderer?

The distributed application did not include the original frontend source or
source maps. It contained optimized, minified production JavaScript and CSS
chunks: enough to inspect behavior and recover contracts, but not the authored
React components, names, comments, file structure, or design-system source.

Recreating the complete frontend with the same polish and behavior would have
been a separate, much larger reverse-engineering project. It was not a realistic
goal for a weekend build. The practical choice was therefore to reconstruct the
runtime and control-plane code, retain the checksum-pinned shipped renderer,
and make the smallest auditable UI patch needed for the new Router settings.

`frontend/` is a readable partial reconstruction and design workspace. It is
useful for understanding UI contracts and experimenting with clean components,
but it should not be mistaken for Anysphere's missing original frontend source
or a pixel-perfect replacement for the packaged renderer.

## Preserved original installers

Research copies of the exact 0.18.0 installers live under
`research-archives/original/0.18.0/` and are stored with Git LFS:

| Platform | File | SHA-256 |
| --- | --- | --- |
| macOS arm64 | `macos-arm64/Grok_Bot_0.18.0.dmg` | `a253ccd8aab01e083f9812a0264354c5034d8ba7f0610bbb557e82ae77d203eb` |
| Windows x64 | `windows-x64/Grok_Bot_0.18.0_Setup.exe` | `464079a15ef5fa8b61ccea8fffcc78f63cfcf6df65fb0ad5e725d8b95f7e437e` |

See [research-archives/README.md](research-archives/README.md) for source URLs,
sizes, verification commands, and the machine-readable artifact manifest.

## Current features

### Inference Router

Open **Settings → Router** to choose the backend used for new turns:

| Provider | Authentication | Tool support |
| --- | --- | --- |
| Cursor | Existing Grok Bot/Cursor session | Native Grok Bot tools and plugins |
| Claude Code | Existing Claude Code login | Routed Grok Bot MCP tools |
| Codex | Existing local ChatGPT/Codex login | Direct Responses transport with Grok Bot tools |
| OpenRouter | API key saved through the desktop secrets bridge | Grok Bot tool-execution loop |

OpenRouter is the default, so the app runs independently of any Cursor login:
saving an OpenRouter API key (or exporting `OPENROUTER_API_KEY`) is the only
credential required, and no sign-in is demanded — without a Cursor session the
app reports a local account instead of blocking on the sign-in screen. Cursor,
Claude Code, and Codex remain available as explicit opt-in providers; Cursor
credentials are only requested when inference actually routes through Cursor,
and do not require separate API keys when their local clients are already
authenticated. The application preserves
streaming responses, thinking state, reactions, rich plugin mentions, and MCP
tool execution across routed conversations.

**Usage & Billing** shows the locally recorded request and token totals for
providers that return usage data. These figures are activity records, not an
authoritative provider invoice.

### Local Docker sandbox

The Router page also has a **Use local Docker VM** toggle. When enabled, Grok
Bot runs its box host and execution daemon in an owned local container instead
of connecting to the remote sandbox.

The container:

- uses the pinned `public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest`
  image (linux/amd64), pulled explicitly before creation;
- is bound only to loopback ports (`1337`, `1339`, `1340` gateway, `6080`/`6081`
  noVNC desktop, `8790`);
- mounts content-addressed host and daemon artifacts read-only;
- mounts the user's `~/.codex` and `~/.claude` CLI credentials read-only when
  present, so those router choices work in the box;
- receives the OpenRouter key through the box secrets channel, so in-box
  inference works without a remote credential;
- gets `--shm-size 1g` so the in-box Chrome desktop stays stable;
- reuses named volumes (`grok-bot-local-vm-workspace`, `grok-bot-local-vm-data`)
  across recreations, so files survive app and container upgrades;
- is validated with a gateway health check (up to three minutes) before the
  coordinator connects; and
- is stopped or replaced through the same settings lifecycle.

The container is recreated automatically when the app runtime changes (host
bundle sha or schema version); workspace and data volumes are preserved.

Docker Desktop, or another compatible local Docker daemon, must be running.
Remote mode remains the default.

## Requirements

macOS packaging (the original reconstruction target):

- macOS on Apple Silicon
- Node.js 26.5.x
- Xcode Command Line Tools
- Git LFS
- Docker Desktop (optional, only for the local sandbox)
- local Claude Code or Codex authentication for those router choices

Linux packaging (`npm run package:linux`, linux-x64):

- Linux x86-64 (glibc)
- Node.js 26.5.x
- build tools: `gcc`/`g++`, `make`, `python3` (for node-gyp native rebuilds)
- official 7-Zip (`7zz`, to extract the pinned APFS DMG outside macOS; legacy
  p7zip `7za`/`7z` builds predate APFS support and will not work)
- Git LFS
- Docker (optional, only for the local sandbox)
- an OpenRouter API key for inference (Cursor, Claude Code, and Codex remain
  selectable when their local clients are authenticated)

## Quick start

macOS:

```sh
git clone <your-repository-url>
cd grok-bot-0.18-reconstructed
git lfs install
git lfs pull
npm ci
npm run bootstrap
npm run check
npm run package
open "dist/Grok Bot 0.18 Reconstructed.app"
```

Linux (x64):

```sh
git clone <your-repository-url>
cd grok-bot-0.18-reconstructed
git lfs install
git lfs pull
npm ci
npm run bootstrap
npm run check
npm run package:linux
"dist/Grok Bot 0.18 Reconstructed-linux-x64/grok-bot"
```

`npm run bootstrap` first uses the Git LFS preservation copy of the pinned
0.18.0 DMG. If that archive is absent, it falls back to the original public URL;
`GROK_BOT_018_APP` can also point to an existing application copy. Bootstrap
verifies both the DMG and `app.asar`, caches the matching Electron runtime, and
hydrates the ignored `src/app/dist` build input.

`npm run package` compiles the reconstructed runtimes, applies the narrow
renderer/settings transform, creates the app bundle, assigns the reconstructed
bundle identity, ad-hoc signs it, and verifies the result. Output is written to:

```text
dist/Grok Bot 0.18 Reconstructed.app
```

`npm run package:linux` assembles the same hybrid reconstruction for linux-x64:
the JS dependency tree from the pinned runtime is reused while the darwin-arch
native modules are replaced with linux-x64 equivalents (tree-sitter is rebuilt
against the Electron 42 ABI, better-sqlite3 uses the official WiseLibs
electron-v146 prebuild, and tree-sitter-bash/whichlang-node are swapped for
their published linux-x64 builds). The bundle is wrapped in an unmodified npm
Electron 42.1.0 linux-x64 shell:

```text
dist/Grok Bot 0.18 Reconstructed-linux-x64/
```

On Linux, features that depend on macOS-only components degrade gracefully: the
1Password/webauthn integration and the macOS process-list observation are
unavailable (their binaries are not shipped for linux-x64 and are loaded
lazily), and the "move to Applications folder" startup check is macOS-only.

Reconstructed packages disable the upstream updater at the packaging boundary
and default upstream Sentry and telemetry emission off. Explicitly supplied
environment configuration is still respected.

## Architecture

```text
polished shipped renderer
          │
          │ desktop preload / RPC
          ▼
     Electron main
          │
          ├── settings, secrets, auth and plugin lifecycle
          ├── remote box connector
          └── owned local Docker connector
                       │
                       ▼
              coordinator + host
                       │
              inference router
           ┌───────────┼───────────┐
        Cursor      Claude       Codex / OpenRouter
                       │
                 Grok Bot MCP tools
```

The main source areas are:

- `source/electron-main/` — desktop lifecycle, settings, auth, box connectors,
  coordinator ownership, and RPC handlers;
- `source/electron-preload/` — the narrow trusted bridge exposed to the UI;
- `source/host/` — inference, tools, MCP, settings, and turn execution;
- `source/node-agent-coordinator/` — transcript routing, streaming activity,
  reactions, and the routed MCP bridge;
- `source/shared/` — shared contracts, settings, protocol, and provider helpers;
- `frontend/` — readable React/TypeScript renderer reconstruction and design
  workspace;
- `scripts/` — bootstrap, compilation, renderer patching, packaging, signing,
  and verification; and
- `tests/` — publication and router regressions.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for more detail.

## Development commands

```sh
npm test                  # focused regression tests
npm run typecheck         # renderer TypeScript
npm run source:typecheck  # runtime TypeScript
npm run frontend:build    # build the readable renderer reconstruction
npm run package           # build, sign, and verify the macOS app
npm run package:linux     # assemble the linux-x64 application directory
npm run verify            # verify an existing packaged app
npm run smoke             # bounded native smoke check
npm run publication:check # prove a fresh-history export is lossless
```

Generated directories including `.cache`, `.build`, `dist`, `src/app/dist`,
`recovered`, `recovery`, and local probe roots are ignored.

## Project status

The app launches and the core reconstructed flows are usable, including routed
inference, connected plugins, and the local Docker sandbox. This is still an
experimental reconstruction: it targets one pinned macOS/arm64 release, depends
on external provider sessions, and does not promise compatibility with future
Grok Bot versions.

For changes, read [CONTRIBUTING.md](CONTRIBUTING.md). For the clean-history
export procedure, see [docs/PUBLISHING.md](docs/PUBLISHING.md). Technical
provenance and retained upstream boundaries are described in
[PROVENANCE.md](PROVENANCE.md) and [NOTICE.md](NOTICE.md).
