import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const connectorSourcePath = path.join(repoRoot, "source/electron-main/box/local-docker-host-connector.ts");

async function loadConnectorModule() {
  const source = await readFile(connectorSourcePath, "utf8");
  const { code: output } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

function fixtureHostBundle() {
  return {
    path: "/settings/local-docker-runtime/aa11/host-main.cjs",
    sha256: "aa11",
    boxExecDaemonPath: "/settings/local-docker-runtime/aa11/box-exec-daemon/main.cjs",
    boxExecDaemonSha256: "bb22",
  };
}

test("local Docker run arguments pin the owned container contract", async () => {
  const connector = await loadConnectorModule();
  assert.equal(connector.LOCAL_DOCKER_SCHEMA_VERSION, "7");
  assert.equal(connector.LOCAL_DOCKER_BOX_CONTAINER, "grok-bot-local-vm");
  assert.equal(connector.LOCAL_DOCKER_GATEWAY_URL, "http://127.0.0.1:1340");

  const args = connector.buildDockerRunArguments({
    token: "gateway-token",
    hostBundle: fixtureHostBundle(),
    authMounts: ["--mount", "type=bind,src=/home/user/.codex,dst=/root/.codex,readonly"],
  });

  assert.equal(args.at(-1), connector.LOCAL_DOCKER_BOX_IMAGE);
  assert.deepEqual(args.slice(0, 4), ["run", "--detach", "--name", connector.LOCAL_DOCKER_BOX_CONTAINER]);
  assert.ok(args.includes("--platform") && args.includes("linux/amd64"));
  assert.ok(args.includes("--restart") && args.includes("unless-stopped"));
  assert.ok(args.includes("--shm-size") && args.includes("1g"));
  assert.ok(args.includes(`com.grok-bot.local-vm.schema-version=${connector.LOCAL_DOCKER_SCHEMA_VERSION}`));
  assert.ok(args.includes("SAND_HOST_PORT=1340"));
  assert.ok(args.includes("SAND_GATEWAY_BIND_HOST=0.0.0.0"));
  assert.ok(args.includes("SAND_GATEWAY_TOKEN=gateway-token"));
  for (const port of [1337, 1339, 1340, 6080, 6081, 8790]) {
    assert.ok(args.includes(`127.0.0.1:${port}:${port}`), `loopback publish for ${port}`);
  }
  assert.ok(args.includes("grok-bot-local-vm-workspace:/workspace"));
  assert.ok(args.includes("grok-bot-local-vm-data:/home/box/sand-data"));
  assert.ok(args.includes("type=bind,src=/settings/local-docker-runtime/aa11/host-main.cjs,dst=/home/box/sand-host/host-main.cjs,readonly"));
  assert.ok(args.includes("type=bind,src=/settings/local-docker-runtime/aa11/box-exec-daemon,dst=/home/box/box-exec-daemon,readonly"));
  assert.ok(args.includes("type=bind,src=/home/user/.codex,dst=/root/.codex,readonly"));
  assert.ok(!args.some((value) => value.includes("SAND_DEV_INFERENCE_TOKEN_FILE")), "no inference env without a credential");
  assert.ok(!args.some((value) => value.includes("/run/grok-bot")), "no credential mount without a credential");
});

test("local Docker run arguments attach inference credentials when issued", async () => {
  const connector = await loadConnectorModule();
  const credential = { accessToken: "credential-token", backendUrl: "https://api2.cursor.sh/", expiresAtMs: 123 };
  const args = connector.buildDockerRunArguments({
    token: "gateway-token",
    hostBundle: fixtureHostBundle(),
    inferenceCredential: credential,
    inferenceFile: "/settings/local-docker-credential/inference.json",
    authMounts: [],
  });
  assert.ok(args.includes("SAND_DEV_INFERENCE_TOKEN_FILE=/run/grok-bot/inference.json"));
  assert.ok(args.includes("SAND_BACKEND_URL=https://api2.cursor.sh/"));
  assert.ok(args.includes("type=bind,src=/settings/local-docker-credential,dst=/run/grok-bot,readonly"));
  assert.ok(args.includes("com.grok-bot.local-vm.inference-credential=1"));
});
