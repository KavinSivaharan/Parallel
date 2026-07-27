import { WorkspaceManager } from "@parallel/workspace-runtime";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexProvider } from "./provider.js";
import type { ProviderObservation } from "@parallel/provider-sdk";

const temporaryRoots: string[] = [];
const fakeCodex = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("CodexProvider", () => {
  it("reports readiness without exposing credentials", async () => {
    const provider = await createProvider();
    const readiness = await provider.readiness();

    expect(readiness.status).toBe("ready");
    expect(readiness.authentication).toBe("ready");
    expect(readiness.providerVersion).toContain("99.0.0-test");
    expect(JSON.stringify(readiness)).not.toContain("test credentials");
  });

  it("targets the Parallel workspace and delivers steering as a continuation", async () => {
    const provider = await createProvider();
    const execution = await provider.createExecution({
      sessionId: "session-123",
      branchId: "branch-123",
      workspaceRef: "session://session-123/branch-123",
      initialInstruction: "Implement the initial change",
      idempotencyKey: "create-123",
    });
    const observations: ProviderObservation[] = [];
    const pump = (async () => {
      for await (const observation of execution.observations()) observations.push(observation);
    })();

    await execution.start();
    await waitFor(() => statusCount(observations, "completed") === 1);
    const first = await execution.steer("Apply the reviewed direction", "steer-123");
    const duplicate = await execution.steer("Apply the reviewed direction", "steer-123");
    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({ state: "queued", model: "continuation" });
    await waitFor(() => statusCount(observations, "completed") === 2);

    await execution.dispose();
    await pump;
    expect(
      observations.some(
        (item) =>
          item.kind === "steering" &&
          item.commandId === "steer-123" &&
          item.state === "delivered",
      ),
    ).toBe(true);
    expect(
      observations.filter((item) => item.kind === "status" && item.status === "started"),
    ).toHaveLength(2);
    expect(new Set(observations.map((item) => item.sequence)).size).toBe(observations.length);

    const workspace = await new WorkspaceManager(provider.root).metadata("branch-123");
    const content = await readFile(join(workspace.repositoryPath, "fixture.txt"), "utf8");
    expect(content).toBe("Implement the initial change\nApply the reviewed direction\n");
  });

  it("interrupts the active process on emergency cancellation", async () => {
    const provider = await createProvider({ maxExecutionMs: 5_000 });
    const execution = await provider.createExecution({
      sessionId: "session-cancel",
      branchId: "branch-cancel",
      workspaceRef: "session://session-cancel/branch-cancel",
      initialInstruction: "slow operation",
      idempotencyKey: "create-cancel",
    });
    const observations: ProviderObservation[] = [];
    const pump = (async () => {
      for await (const observation of execution.observations()) observations.push(observation);
    })();

    await execution.start();
    await waitFor(() =>
      observations.some((item) => item.kind === "status" && item.status === "turn_started"),
    );
    await execution.cancel("Emergency stop");
    await waitFor(() =>
      observations.some((item) => item.kind === "status" && item.status === "cancelled"),
    );
    await execution.dispose();
    await pump;

    expect(observations.some((item) => item.kind === "status" && item.status === "completed")).toBe(false);
  });

  it("classifies malformed output, redacts stderr, and deduplicates provider callbacks", async () => {
    const provider = await createProvider();
    const observations = await runToEnd(
      provider,
      "branch-defensive",
      "malformed stderr duplicate",
    );
    expect(
      observations.some(
        (item) => item.kind === "warning" && item.code === "codex_malformed_event",
      ),
    ).toBe(true);
    const stderr = observations.find(
      (item) => item.kind === "warning" && item.code === "codex_stderr",
    );
    expect(stderr && stderr.kind === "warning" ? stderr.message : "").not.toContain(
      "fake-secret-token",
    );
    expect(
      observations.filter(
        (item) =>
          item.kind === "tool" &&
          item.phase === "started" &&
          item.callId === "command-initial",
      ),
    ).toHaveLength(1);
  });

  it("distinguishes provider crashes and enforced timeouts", async () => {
    const crashProvider = await createProvider();
    const crashed = await runToEnd(crashProvider, "branch-crash", "crash now", "crashed");
    expect(crashed.some((item) => item.kind === "error" && item.code === "codex_process_failed")).toBe(true);

    const timeoutProvider = await createProvider({ maxExecutionMs: 1_000 });
    const timedOut = await runToEnd(timeoutProvider, "branch-timeout", "slow operation", "timed_out");
    expect(timedOut.some((item) => item.kind === "status" && item.status === "timed_out")).toBe(true);
  });
});

async function createProvider(options: { maxExecutionMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "parallel-codex-test-"));
  temporaryRoots.push(root);
  const provider = new CodexProvider(new WorkspaceManager(root), {
    executable: process.execPath,
    executableArgsPrefix: [fakeCodex],
    ...options,
  });
  return Object.assign(provider, { root });
}

function statusCount(observations: ProviderObservation[], status: string): number {
  return observations.filter(
    (item) => item.kind === "status" && item.status === status,
  ).length;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for provider observation");
}

async function runToEnd(
  provider: Awaited<ReturnType<typeof createProvider>>,
  branchId: string,
  instruction: string,
  terminalStatus = "completed",
): Promise<ProviderObservation[]> {
  const execution = await provider.createExecution({
    sessionId: `session-${branchId}`,
    branchId,
    workspaceRef: `session://session-${branchId}/${branchId}`,
    initialInstruction: instruction,
    idempotencyKey: `create-${branchId}`,
  });
  const observations: ProviderObservation[] = [];
  const pump = (async () => {
    for await (const observation of execution.observations()) observations.push(observation);
  })();
  await execution.start();
  await waitFor(
    () =>
      observations.some(
        (item) => item.kind === "status" && item.status === terminalStatus,
      ),
    6_000,
  );
  await execution.dispose();
  await pump;
  return observations;
}
