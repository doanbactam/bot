import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadInferenceRouter() {
  const temporary = await mkdtemp(path.join(repoRoot, ".tmp-grok-activity-rename-"));
  const output = path.join(temporary, "inference-router.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/node-agent-coordinator/inference-router.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    packages: "external",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("activity pulses re-fetch the roster so mid-turn renames stick", async () => {
  const loaded = await loadInferenceRouter();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-settings-"));
  await writeFile(path.join(dataDir, "settings.json"), `${JSON.stringify({ version: 1, inferenceProvider: "baseten" }, null, 2)}\n`);
  try {
    let listCalls = 0;
    const agentsByCall = [
      [{ id: "a1", name: "Old", description: "", updatedAt: 1 }],
      [{ id: "a1", name: "Renamed", description: "", updatedAt: 2 }],
      [{ id: "a1", name: "Renamed", description: "", updatedAt: 3 }],
    ];
    const events = [];
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      postEvent: (family, payload) => {
        events.push({ family, payload });
      },
      dispatchRemote: async (method) => {
        if (method === "listAgents") {
          const index = Math.min(listCalls, agentsByCall.length - 1);
          listCalls += 1;
          return agentsByCall[index];
        }
        if (method === "getAgentTranscriptTail") return { entries: [] };
        if (method === "listRoutedMcpTools") return [];
        throw new Error(`unexpected ${method}`);
      },
      now: () => 1_000,
    });

    // Drive beginActivity through sendPrompt. The provider fails after the activity
    // hold once credentials are absent, which is enough to observe pulsed roster events.
    const previousKey = process.env.BASETEN_API_KEY;
    delete process.env.BASETEN_API_KEY;
    try {
      const dispatch = router.dispatch("sendPrompt", {
        agentId: "a1",
        prompt: "hi",
        clientNonce: "n1",
      });
      // Wait for the initial publish plus at least one refreshed pulse.
      await new Promise((resolve) => setTimeout(resolve, 700));
      const agentEvents = events.filter((event) => event.family === "agents");
      assert.ok(agentEvents.length >= 2, `expected pulsed agents events, got ${agentEvents.length}`);
      assert.ok(listCalls >= 2, `expected listAgents re-fetch, got ${listCalls}`);
      const renamedPulse = agentEvents.find((event) =>
        Array.isArray(event.payload?.agents)
        && event.payload.agents.some((agent) => agent?.id === "a1" && agent?.name === "Renamed" && agent?.isRunning === true),
      );
      assert.ok(renamedPulse != null, "mid-turn rename should appear on a later activity pulse");
      assert.equal(renamedPulse.payload.agents.find((agent) => agent.id === "a1").currentActivity?.kind, "thinking");
      await dispatch;
    } finally {
      if (previousKey === undefined) delete process.env.BASETEN_API_KEY;
      else process.env.BASETEN_API_KEY = previousKey;
    }
  } finally {
    await loaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("updateAgent coerces a missing description instead of throwing", async () => {
  const source = await readFile(path.join(repoRoot, "source/host/extensions/transcript/agent-lifecycle.ts"), "utf8");
  assert.match(source, /getAgentProfileText\(agentId\)/);
  assert.match(source, /typeof profile\?\.description === "string"/);
  assert.match(source, /Agent name cannot be empty/);
});

test("activity publisher refreshes listAgents on each pulse", async () => {
  const source = await readFile(path.join(repoRoot, "source/node-agent-coordinator/inference-router.ts"), "utf8");
  assert.match(source, /Re-fetch on every pulse/);
  assert.match(source, /currentActivity: null/);
  assert.match(source, /currentActivity: \{ kind: "thinking" \}/);
});
