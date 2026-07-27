import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { EventEnvelope, SessionView } from "@parallel/contracts";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { io, type Socket } from "socket.io-client";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "./app.module.js";
import { DomainExceptionFilter } from "./domain-exception.filter.js";

const enabled = process.env.PARALLEL_RUN_CODEX_E2E === "1";
const run = describe.skipIf(!enabled);
const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(__dirname, "../../..");
const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://parallel:parallel@localhost:5432/parallel";

run("real Codex two-user demonstration", () => {
  let app: INestApplication;
  let baseUrl: string;
  let fixtureRoot: string;
  let workspaceRoot: string;
  const pool = new Pool({ connectionString: databaseUrl });
  const sockets: Socket[] = [];

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "parallel-ledger-demo-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "parallel-real-workspaces-"));
    process.env.WORKSPACE_ROOT = workspaceRoot;
    await cp(
      join(repositoryRoot, "demo/fixtures/ledger-service"),
      fixtureRoot,
      { recursive: true },
    );
    await execFileAsync("git", ["init", "-b", "main"], { cwd: fixtureRoot });
    await execFileAsync("git", ["config", "user.name", "Parallel Demo"], { cwd: fixtureRoot });
    await execFileAsync("git", ["config", "user.email", "demo@parallel.local"], { cwd: fixtureRoot });
    await execFileAsync("git", ["add", "-A"], { cwd: fixtureRoot });
    await execFileAsync("git", ["commit", "-m", "Initial failing ledger fixture"], { cwd: fixtureRoot });
    await pool.query(
      `TRUNCATE users, organizations, organization_memberships, sessions,
       session_branches, provider_executions, workspaces, checkpoints, artifacts,
       consumer_inbox, provider_observation_inbox, idempotency_keys, outbox,
       events, event_streams CASCADE`,
    );
    app = await createApp();
    baseUrl = await app.getUrl();
  }, 30_000);

  afterAll(async () => {
    sockets.forEach((socket) => socket.disconnect());
    if (app) await app.close();
    await pool.end();
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("proves collaborative real-agent execution, steering, handoff, pause, checkpoint, fork, and replay", async () => {
    const demoStartedAt = Date.now();
    const alice = await signIn("alice.codex@parallel.local", "Alice");
    const bob = await signIn("bob.codex@parallel.local", "Bob");
    const organization = await json<{ id: string; slug: string }>(
      "/v1/organizations",
      alice.token,
      { method: "POST", body: { name: "Parallel Demo", slug: `parallel-demo-${Date.now()}` } },
    );
    await json("/v1/organizations/join", bob.token, {
      method: "POST",
      body: { slug: organization.slug },
    });
    const providerCatalog = await json<
      Array<{
        metadata: { id: string };
        readiness: { status: string; providerVersion: string | null };
      }>
    >("/v1/providers", alice.token);
    expect(
      providerCatalog.find((item) => item.metadata.id === "codex")?.readiness.status,
    ).toBe("ready");

    const objective =
      "Inspect this unfamiliar Python ledger service. Reproduce the failing edge case, fix the allocation bug without losing cents, update relevant tests or documentation, and run the complete unittest suite. Do not use the internet.";
    const created = await json<{ sessionId: string; branchId: string }>(
      "/v1/sessions",
      alice.token,
      {
        method: "POST",
        body: {
          organizationId: organization.id,
          title: "Repair ledger allocation",
          objective,
          providerId: "codex",
          repositoryUrl: fixtureRoot,
          baseRef: "main",
        },
      },
    );

    const aliceLive = new Map<string, number>();
    const bobLive = new Map<string, number>();
    sockets.push(
      await connect(alice.token, created.branchId, aliceLive),
      await connect(bob.token, created.branchId, bobLive),
    );
    await sendCommand(created.branchId, bob.token, "participant.join", {});
    await waitForEvent(created.branchId, alice.token, "provider.turn_started", 1, 120_000);

    const proposalId = crypto.randomUUID();
    await sendCommand(created.branchId, bob.token, "steering.propose", {
      proposalId,
      instruction:
        "Preserve backward compatibility: each account may use the legacy `account` field instead of `account_id`. Add regression coverage and document both accepted shapes.",
    });
    const approval = await sendCommand(created.branchId, alice.token, "steering.approve", {
      proposalId,
    });
    const approvalEvent = approval.find((event) => event.type === "steering.approved");
    expect(approvalEvent).toBeDefined();
    await waitForEvent(created.branchId, alice.token, "steering.delivered", 1, 180_000);
    await waitForEvent(created.branchId, alice.token, "provider.turn_completed", 2, 240_000);

    await sendCommand(created.branchId, alice.token, "driver.transfer", {
      toId: bob.user.userId,
    });
    await sendCommand(created.branchId, bob.token, "steering.send", {
      instruction:
        "As the new driver, run the full unittest suite again and add a concise validation note to README.md with the exact command and result.",
    });
    await waitForEvent(created.branchId, bob.token, "steering.delivered", 2, 180_000);
    await waitForEvent(created.branchId, bob.token, "provider.turn_completed", 3, 240_000);

    await sendCommand(created.branchId, bob.token, "checkpoint.create", {
      summary: "Passing ledger fix with legacy request compatibility",
    });
    const checkpointEvent = await waitForEvent(
      created.branchId,
      bob.token,
      "checkpoint.created",
      1,
      60_000,
    );
    const checkpointId = String(checkpointEvent.payload.checkpointId);
    const checkpointCommit = String(checkpointEvent.payload.commitHash);

    const fork = await json<{ branchId: string }>(
      `/v1/branches/${created.branchId}/checkpoints/${checkpointId}/forks`,
      bob.token,
      {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: {
          objective:
            "Explore an independent alternative: add an ALTERNATIVE.md explaining a round-robin allocation strategy, leave production behavior passing, and run all tests.",
        },
      },
    );
    await waitForEvent(fork.branchId, bob.token, "provider.turn_completed", 1, 240_000);

    await sendCommand(created.branchId, bob.token, "steering.send", {
      instruction:
        "Begin one more validation turn. First run `python3 -c \"import time; time.sleep(30)\"`, then rerun all tests. This deliberate wait is part of an emergency-interruption exercise.",
    });
    await waitForEvent(created.branchId, bob.token, "steering.delivered", 3, 120_000);
    const cancellationRequestedAt = Date.now();
    await sendCommand(created.branchId, bob.token, "session.pause", {
      reason: "Real-agent emergency cancellation demonstration",
    });
    const interrupted = await waitForEvent(
      created.branchId,
      bob.token,
      "provider.interrupted",
      1,
      30_000,
    );
    const cancellationLatencyMs = Date.now() - cancellationRequestedAt;

    const replayStartedAt = performance.now();
    const replay = await json<{
      eventCount: number;
      events: EventEnvelope[];
      artifacts: Array<{ byteSize: number }>;
    }>(`/v1/branches/${created.branchId}/replay`, alice.token);
    const replayReconstructionMs = round(performance.now() - replayStartedAt);
    const forkReplay = await json<{ events: EventEnvelope[] }>(
      `/v1/branches/${fork.branchId}/replay`,
      bob.token,
    );
    const parentWorkspace = await workspacePath(created.branchId);
    const forkWorkspace = await workspacePath(fork.branchId);
    const parentService = await readFile(join(parentWorkspace, "ledger/service.py"), "utf8");
    const parentReadme = await readFile(join(parentWorkspace, "README.md"), "utf8");
    const forkAlternative = await readFile(join(forkWorkspace, "ALTERNATIVE.md"), "utf8");
    expect(parentService).toMatch(/account/);
    expect(parentReadme).toMatch(/unittest/i);
    expect(forkAlternative.length).toBeGreaterThan(20);
    await expect(readFile(join(parentWorkspace, "ALTERNATIVE.md"), "utf8")).rejects.toThrow();

    const events = await eventsFor(created.branchId, alice.token);
    const forkEvents = await eventsFor(fork.branchId, bob.token);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "provider.tool_started",
        "provider.tool_completed",
        "terminal.command_started",
        "terminal.command_completed",
        "filesystem.changed",
        "git.diff_created",
        "artifact.created",
        "steering.queued",
        "steering.delivered",
        "driver.transferred",
        "checkpoint.created",
        "session.paused",
        "provider.interrupted",
      ]),
    );
    expect(aliceLive.size).toBeGreaterThan(0);
    expect(bobLive.size).toBeGreaterThan(0);
    expect([...aliceLive.keys()].some((id) => bobLive.has(id))).toBe(true);
    expect(forkReplay.events.some((event) => event.type === "checkpoint.created")).toBe(true);

    const requested = events.find((event) => event.type === "execution.requested");
    const firstTurn = events.find((event) => event.type === "provider.turn_started");
    const firstOutput = events.find((event) => event.type === "provider.output_received");
    const delivery = events.find((event) => event.type === "steering.delivered");
    const providerCompleted = events.filter(
      (event) => event.type === "provider.turn_completed",
    );
    const persistedRows = await pool.query<{
      last_persistence_latency_ms: number | null;
      process_started_at: Date | null;
      completed_at: Date | null;
    }>(
      `SELECT last_persistence_latency_ms, process_started_at, completed_at
       FROM provider_executions WHERE branch_id = $1`,
      [created.branchId],
    );
    const eventBytes = events.reduce(
      (total, event) => total + Buffer.byteLength(JSON.stringify(event)),
      0,
    );
    const artifactBytes = replay.artifacts.reduce(
      (total, artifact) => total + artifact.byteSize,
      0,
    );
    const liveLatencies = events.flatMap((event) =>
      [aliceLive.get(event.id), bobLive.get(event.id)]
        .filter((receivedAt): receivedAt is number => receivedAt !== undefined)
        .map((receivedAt) =>
          Math.max(0, receivedAt - new Date(event.occurredAt).getTime()),
        ),
    );

    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      environment: {
        provider: "codex",
        providerVersion:
          providerCatalog.find((item) => item.metadata.id === "codex")?.readiness
            .providerVersion ?? "unknown",
        fixture: "demo/fixtures/ledger-service",
        localTrustedExecution: true,
      },
      execution: {
        sessionId: created.sessionId,
        branchId: created.branchId,
        providerExecutionIds: [
          ...new Set(
            events
              .filter((event) => event.actor.kind === "provider")
              .map((event) => event.actor.id),
          ),
        ],
        checkpoint: { id: checkpointId, commit: checkpointCommit },
        forkBranchId: fork.branchId,
        parentEventCount: events.length,
        forkOwnEventCount: forkEvents.length,
        replayEventCount: replay.eventCount,
        artifactCount: replay.artifacts.length,
        artifactBytes,
        eventBytes,
      },
      assertions: {
        twoAuthenticatedUsers: true,
        oneSharedLogicalExecution: true,
        realShellAndFileEdits: true,
        nonDriverProposalApproved: true,
        continuationSteeringDelivered: true,
        driverTransferred: true,
        checkpointIsGitCommit: /^[0-9a-f]{40}$/i.test(checkpointCommit),
        forkIndependent: true,
        emergencyCancellationObserved: interrupted.type === "provider.interrupted",
        replayRecovered: replay.eventCount === events.length,
      },
      metrics: {
        commandAcceptanceToProcessStartMs: duration(requested, firstTurn),
        timeToFirstProviderOutputMs: duration(requested, firstOutput),
        steeringApprovalToDeliveryMs: duration(approvalEvent, delivery),
        providerEventPersistenceLatencyMs:
          persistedRows.rows[0]?.last_persistence_latency_ms ?? null,
        websocketFanoutLatencyMs: summarize(liveLatencies),
        totalDemoDurationMs: Date.now() - demoStartedAt,
        providerTurnDurationsMs: providerCompleted.map((event) =>
          duration(
            [...events]
              .slice(0, events.indexOf(event))
              .reverse()
              .find((candidate) => candidate.type === "provider.turn_started"),
            event,
          ),
        ),
        cancellationLatencyMs,
        replayReconstructionMs,
      },
      limitations: [
        "Local measurements are a single machine run, not universal performance claims.",
        "WebSocket latency is measured from durable event occurrence to client receipt and includes outbox dispatch.",
        "A host crash interrupts the active Codex process; Parallel persists prior events and can later continue the stored Codex conversation, but does not reattach to the vanished process.",
        "The checkpoint and fork clone Git workspace state and inherited Parallel history, not hidden provider state.",
      ],
    };
    const reportPath = resolve(
      process.env.PARALLEL_DEMO_REPORT ??
        join(repositoryRoot, "reports/real-agent-demo.latest.json"),
    );
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    expect(Object.values(report.assertions).every(Boolean)).toBe(true);
  }, 15 * 60_000);

  async function createApp(): Promise<INestApplication> {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const application = module.createNestApplication();
    application.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    application.useGlobalFilters(new DomainExceptionFilter());
    await application.listen(0);
    return application;
  }

  async function signIn(email: string, displayName: string) {
    return json<{ token: string; user: { userId: string } }>(
      "/v1/auth/development/sign-in",
      null,
      { method: "POST", body: { email, displayName } },
    );
  }

  async function sendCommand(
    branchId: string,
    token: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<EventEnvelope[]> {
    const state = await json<SessionView>(`/v1/branches/${branchId}/state`, token);
    return json(`/v1/branches/${branchId}/commands`, token, {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
      body: { type, expectedVersion: state.version, payload },
    });
  }

  async function waitForEvent(
    branchId: string,
    token: string,
    type: EventEnvelope["type"],
    count: number,
    timeoutMs: number,
  ): Promise<EventEnvelope> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const matches = (await eventsFor(branchId, token)).filter(
        (event) => event.type === type,
      );
      if (matches.length >= count) return matches[count - 1]!;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for ${type} #${count}`);
  }

  function eventsFor(branchId: string, token: string): Promise<EventEnvelope[]> {
    return json(`/v1/branches/${branchId}/events?after=0`, token);
  }

  async function workspacePath(branchId: string): Promise<string> {
    const result = await pool.query<{ repository_path: string }>(
      "SELECT repository_path FROM workspaces WHERE branch_id = $1",
      [branchId],
    );
    const path = result.rows[0]?.repository_path;
    if (!path) throw new Error(`Workspace missing for ${branchId}`);
    return path;
  }

  async function connect(
    token: string,
    branchId: string,
    receipts: Map<string, number>,
  ): Promise<Socket> {
    const socket = io(`${baseUrl}/v1/live`, {
      auth: { token },
      transports: ["websocket"],
      forceNew: true,
    });
    socket.on("event.committed", (event: EventEnvelope) => {
      receipts.set(event.id, Date.now());
    });
    await new Promise<void>((resolveConnection, reject) => {
      socket.on("connect", () => {
        socket.emit("branch.subscribe", { branchId });
        resolveConnection();
      });
      socket.on("connect_error", reject);
    });
    return socket;
  }

  async function json<T>(
    path: string,
    token: string | null,
    options?: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...(options?.method ? { method: options.method } : {}),
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...options?.headers,
      },
      ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    if (!response.ok) {
      throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
    }
    return response.json() as Promise<T>;
  }
});

function duration(
  from: EventEnvelope | undefined,
  to: EventEnvelope | undefined,
): number | null {
  if (!from || !to) return null;
  return Math.max(
    0,
    new Date(to.occurredAt).getTime() - new Date(from.occurredAt).getTime(),
  );
}

function summarize(values: number[]) {
  if (values.length === 0) return { samples: 0, median: null, p95: null };
  const ordered = [...values].sort((a, b) => a - b);
  return {
    samples: ordered.length,
    median: ordered[Math.floor((ordered.length - 1) * 0.5)] ?? null,
    p95: ordered[Math.floor((ordered.length - 1) * 0.95)] ?? null,
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
