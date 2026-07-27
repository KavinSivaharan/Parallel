import { ValidationPipe } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { EventEnvelope, SessionView } from "@parallel/contracts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "./app.module.js";
import { DomainExceptionFilter } from "./domain-exception.filter.js";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgresql://parallel:parallel@localhost:5432/parallel",
});

describe("real workspace runtime vertical slice", () => {
  let app: INestApplication;
  let baseUrl: string;
  let workspaceRoot: string;

  beforeAll(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "parallel-api-workspaces-"));
    process.env.WORKSPACE_ROOT = workspaceRoot;
    await pool.query(
      `TRUNCATE users, organizations, organization_memberships, sessions,
       session_branches, provider_executions, workspaces, checkpoints, artifacts,
       consumer_inbox, provider_observation_inbox, idempotency_keys, outbox,
       events, event_streams CASCADE`,
    );
    await startApplication();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("executes, checkpoints, restores, forks, and replays real workspace state", async () => {
    const auth = await request<{ token: string; user: { userId: string } }>(
      "/v1/auth/development/sign-in",
      null,
      { method: "POST", body: { email: "runtime@test.local", displayName: "Runtime Owner" } },
    );
    const organization = await request<{ id: string }>("/v1/organizations", auth.token, {
      method: "POST",
      body: { name: "Runtime Test", slug: "runtime-test" },
    });
    const session = await request<{ branchId: string }>("/v1/sessions", auth.token, {
      method: "POST",
      body: {
        organizationId: organization.id,
        title: "Real workspace",
        providerId: "local-workspace",
      },
    });

    const workspace = await waitForValue(() =>
      request<{ id: string; repository_path: string }>(
        `/v1/branches/${session.branchId}/workspace`,
        auth.token,
      ).catch(() => null),
    );
    await waitFor(async () =>
      (await getEvents(session.branchId, auth.token)).some(
        (event) => event.type === "provider.execution_started",
      ),
    );
    let state = await getState(session.branchId, auth.token);
    await request(`/v1/branches/${session.branchId}/workspace/commands`, auth.token, {
      method: "POST",
      idempotencyKey: "command-one",
      body: {
        expectedVersion: state.version,
        executable: process.execPath,
        args: [
          "-e",
          "require('fs').writeFileSync('runtime.txt','version-one'); console.log('workspace-output'); console.error('workspace-warning')",
        ],
      },
    });
    await waitFor(async () => {
      const events = await getEvents(session.branchId, auth.token);
      return events.some((event) => event.type === "filesystem.changed") &&
        events.some((event) => event.type === "terminal.stdout") &&
        events.some((event) => event.type === "terminal.stderr");
    });
    expect(await readFile(join(workspace.repository_path, "runtime.txt"), "utf8")).toBe("version-one");

    state = await getState(session.branchId, auth.token);
    await request(`/v1/branches/${session.branchId}/checkpoints`, auth.token, {
      method: "POST",
      idempotencyKey: "checkpoint-one",
      body: { expectedVersion: state.version, summary: "Version one" },
    });
    const checkpoint = await waitForValue(async () => {
      const checkpoints = await request<Array<{ id: string; commit_hash: string }>>(
        `/v1/branches/${session.branchId}/checkpoints`,
        auth.token,
      );
      return checkpoints[0] ?? null;
    });
    expect(checkpoint.commit_hash).toMatch(/^[0-9a-f]{40}$/);

    state = await getState(session.branchId, auth.token);
    await request(`/v1/branches/${session.branchId}/workspace/commands`, auth.token, {
      method: "POST",
      idempotencyKey: "command-two",
      body: {
        expectedVersion: state.version,
        executable: process.execPath,
        args: ["-e", "require('fs').writeFileSync('runtime.txt','version-two')"],
      },
    });
    await waitFor(async () =>
      (await readFile(join(workspace.repository_path, "runtime.txt"), "utf8")) === "version-two",
    );
    state = await getState(session.branchId, auth.token);
    await request(`/v1/branches/${session.branchId}/checkpoints`, auth.token, {
      method: "POST",
      idempotencyKey: "checkpoint-two",
      body: { expectedVersion: state.version, summary: "Version two" },
    });
    const secondCheckpoint = await waitForValue(async () => {
      const checkpoints = await request<Array<{ id: string; commit_hash: string }>>(
        `/v1/branches/${session.branchId}/checkpoints`,
        auth.token,
      );
      return checkpoints[1] ?? null;
    });
    const comparison = await request<{
      files: Array<{ kind: string; path: string }>;
      patch: string;
    }>(
      `/v1/branches/${session.branchId}/checkpoints/compare?from=${checkpoint.id}&to=${secondCheckpoint.id}`,
      auth.token,
    );
    expect(comparison.files).toContainEqual({ kind: "modified", path: "runtime.txt" });
    expect(comparison.patch).toContain("version-two");

    state = await getState(session.branchId, auth.token);
    await request(
      `/v1/branches/${session.branchId}/checkpoints/${checkpoint.id}/restore`,
      auth.token,
      {
        method: "POST",
        idempotencyKey: "restore-one",
        body: { expectedVersion: state.version },
      },
    );
    await waitFor(async () =>
      (await readFile(join(workspace.repository_path, "runtime.txt"), "utf8")) === "version-one",
    );

    const fork = await request<{ branchId: string }>(
      `/v1/branches/${session.branchId}/checkpoints/${checkpoint.id}/forks`,
      auth.token,
      { method: "POST", idempotencyKey: "fork-one", body: {} },
    );
    expect(
      await request<{ branchId: string }>(
        `/v1/branches/${session.branchId}/checkpoints/${checkpoint.id}/forks`,
        auth.token,
        { method: "POST", idempotencyKey: "fork-one", body: {} },
      ),
    ).toMatchObject({ branchId: fork.branchId });
    await waitForValue(() =>
      request(`/v1/branches/${fork.branchId}/workspace`, auth.token).catch(() => null),
    );
    expect(
      await request<Array<{ id: string }>>(
        `/v1/branches/${fork.branchId}/checkpoints`,
        auth.token,
      ),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: checkpoint.id })]));
    const replay = await request<{
      events: Array<EventEnvelope & { replaySequence: number; originBranchId: string }>;
      artifacts: Array<{ id: string; name: string }>;
      reconstructed: {
        workspace: Record<string, unknown>;
        terminal: Array<{ stream: string; chunk: string }>;
      };
    }>(`/v1/branches/${fork.branchId}/replay`, auth.token);
    expect(replay.events.map((event) => event.replaySequence)).toEqual(
      replay.events.map((_event, index) => index + 1),
    );
    expect(replay.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "workspace.created", originBranchId: session.branchId }),
        expect.objectContaining({ type: "checkpoint.created", originBranchId: session.branchId }),
        expect.objectContaining({ type: "session.forked", originBranchId: fork.branchId }),
      ]),
    );
    expect(replay.artifacts.filter((artifact) => artifact.name.endsWith(".log"))).toHaveLength(1);
    expect(replay.reconstructed.workspace.workspaceId).toBe(fork.branchId);
    expect(replay.reconstructed.terminal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stream: "stdout", chunk: "workspace-output\n" }),
        expect.objectContaining({ stream: "stderr", chunk: "workspace-warning\n" }),
      ]),
    );

    await app.close();
    await startApplication();
    state = await getState(session.branchId, auth.token);
    await request(`/v1/branches/${session.branchId}/workspace/commands`, auth.token, {
      method: "POST",
      idempotencyKey: "post-restart-command",
      body: {
        expectedVersion: state.version,
        executable: process.execPath,
        args: [
          "-e",
          "const fs=require('fs'); if(fs.readFileSync('runtime.txt','utf8')!=='version-one') process.exit(2); fs.writeFileSync('recovered.txt','durable')",
        ],
      },
    });
    await waitFor(async () =>
      readFile(join(workspace.repository_path, "recovered.txt"), "utf8")
        .then((value) => value === "durable")
        .catch(() => false),
    );

    state = await getState(session.branchId, auth.token);
    await request(`/v1/branches/${session.branchId}/workspace/commands`, auth.token, {
      method: "POST",
      idempotencyKey: "long-command",
      body: {
        expectedVersion: state.version,
        executable: process.execPath,
        args: ["-e", "setInterval(() => console.log('still-running'), 100)"],
      },
    });
    await waitFor(async () =>
      (await getEvents(session.branchId, auth.token)).some(
        (event) =>
          event.type === "terminal.command_started" &&
          event.sequence > state.version,
      ),
    );
    state = await getState(session.branchId, auth.token);
    const pauseStartedAt = Date.now();
    await request(`/v1/branches/${session.branchId}/commands`, auth.token, {
      method: "POST",
      idempotencyKey: "emergency-pause",
      body: {
        type: "session.pause",
        expectedVersion: state.version,
        payload: { reason: "integration cancellation proof" },
      },
    });
    await waitFor(async () =>
      (await getEvents(session.branchId, auth.token)).some(
        (event) =>
          event.type === "terminal.command_completed" &&
          event.payload.exitCode === null,
      ),
    );
    expect(Date.now() - pauseStartedAt).toBeLessThan(3_000);
  }, 30_000);

  function getState(branchId: string, token: string): Promise<SessionView> {
    return request(`/v1/branches/${branchId}/state`, token);
  }

  function getEvents(branchId: string, token: string): Promise<EventEnvelope[]> {
    return request(`/v1/branches/${branchId}/events?after=0`, token);
  }

  async function startApplication(): Promise<void> {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0);
    baseUrl = await app.getUrl();
  }

  async function request<T>(
    path: string,
    token: string | null,
    options?: { method?: string; body?: unknown; idempotencyKey?: string },
  ): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...(options?.method ? { method: options.method } : {}),
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options?.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
      },
      ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    if (!response.ok) throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  }
});

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for condition");
}

async function waitForValue<T>(
  load: () => T | null | Promise<T | null>,
  timeoutMs = 8_000,
): Promise<T> {
  let value: T | null = null;
  await waitFor(async () => {
    value = await load();
    return value !== null;
  }, timeoutMs);
  return value as T;
}
