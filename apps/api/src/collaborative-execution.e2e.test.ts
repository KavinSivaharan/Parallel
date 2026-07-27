import { ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import type { EventEnvelope, SessionView } from "@parallel/contracts";
import { io, type Socket } from "socket.io-client";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "./app.module.js";
import { DomainExceptionFilter } from "./domain-exception.filter.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://parallel:parallel@localhost:5432/parallel";
const pool = new Pool({ connectionString: databaseUrl });

describe("collaborative execution vertical slice", () => {
  let app: INestApplication;
  let baseUrl: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    await pool.query(
      `TRUNCATE users, organizations, organization_memberships, sessions,
       session_branches, provider_executions, artifacts, consumer_inbox,
       provider_observation_inbox, idempotency_keys, outbox, events, event_streams CASCADE`,
    );
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await app.close();
    await pool.end();
  });

  it("runs one provider execution with two authenticated collaborators", async () => {
    const unauthenticatedProviders = await fetch(`${baseUrl}/v1/providers`);
    expect(unauthenticatedProviders.status).toBe(401);
    const alice = await signIn("alice@test.local", "Alice");
    const bob = await signIn("bob@test.local", "Bob");
    const viewer = await signIn("viewer@test.local", "Viewer");
    const outsider = await signIn("outsider@test.local", "Outsider");

    const organization = await json<{ id: string; slug: string }>(
      "/v1/organizations",
      alice.token,
      { method: "POST", body: { name: "Acme", slug: "acme-e2e" } },
    );
    const providers = await json<
      Array<{
        metadata: { id: string };
        readiness: { status: string };
        capabilities: { schemaVersion: number; steering: string };
        certification: { status: string; failed: number };
      }>
    >("/v1/providers", alice.token);
    expect(providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({ id: "simulator" }),
          readiness: expect.objectContaining({ status: "ready" }),
          capabilities: expect.objectContaining({ schemaVersion: 1 }),
        }),
        expect.objectContaining({
          metadata: expect.objectContaining({ id: "codex" }),
          capabilities: expect.objectContaining({ steering: "continuation" }),
        }),
        ...["claude-code", "openhands", "devin", "generic-agent"].map((id) =>
          expect.objectContaining({
            metadata: expect.objectContaining({ id }),
            certification: expect.objectContaining({
              status: "passed",
              failed: 0,
            }),
          }),
        ),
      ]),
    );
    await json("/v1/organizations/join", bob.token, {
      method: "POST",
      body: { slug: organization.slug },
    });
    await json("/v1/organizations/join", viewer.token, {
      method: "POST",
      body: { slug: organization.slug },
    });
    await pool.query(
      `UPDATE organization_memberships SET role = 'viewer'
       WHERE organization_id = $1 AND user_id = $2`,
      [organization.id, viewer.user.userId],
    );
    const created = await json<{ branchId: string }>(
      "/v1/sessions",
      alice.token,
      {
        method: "POST",
        body: {
          organizationId: organization.id,
          title: "Build token rotation",
          providerId: "simulator",
        },
      },
    );

    const aliceEvents: EventEnvelope[] = [];
    const bobEvents: EventEnvelope[] = [];
    sockets.push(
      await connect(alice.token, created.branchId, aliceEvents),
      await connect(bob.token, created.branchId, bobEvents),
    );

    const outsiderResponse = await fetch(
      `${baseUrl}/v1/branches/${created.branchId}/state`,
      { headers: { authorization: `Bearer ${outsider.token}` } },
    );
    expect(outsiderResponse.status).toBe(403);
    const viewerStateResponse = await fetch(
      `${baseUrl}/v1/branches/${created.branchId}/state`,
      { headers: { authorization: `Bearer ${viewer.token}` } },
    );
    expect(viewerStateResponse.status).toBe(200);

    await waitFor(async () => (await state(created.branchId, alice.token)).version >= 7);
    const beforeJoin = await state(created.branchId, bob.token);
    const joinBody = {
      type: "participant.join",
      expectedVersion: beforeJoin.version,
      payload: {},
    };
    await command(created.branchId, bob.token, "join-bob", joinBody);
    const duplicate = await command(created.branchId, bob.token, "join-bob", joinBody);
    expect(duplicate).toHaveLength(1);

    let current = await state(created.branchId, bob.token);
    const nonDriverSteer = await rawCommand(created.branchId, bob.token, "illegal-direct", {
      type: "steering.send",
      expectedVersion: current.version,
      payload: { instruction: "Bypass the driver" },
    });
    expect(nonDriverSteer.status).toBe(422);
    const viewerPause = await rawCommand(created.branchId, viewer.token, "viewer-pause", {
      type: "session.pause",
      expectedVersion: current.version,
      payload: { reason: "Viewer cannot interrupt" },
    });
    expect(viewerPause.status).toBe(403);

    await command(created.branchId, bob.token, "proposal-1", {
      type: "steering.propose",
      expectedVersion: current.version,
      payload: { proposalId: "proposal-1", instruction: "Use device-scoped tokens" },
    });
    current = await state(created.branchId, alice.token);
    await command(created.branchId, alice.token, "approve-1", {
      type: "steering.approve",
      expectedVersion: current.version,
      payload: { proposalId: "proposal-1" },
    });

    await waitFor(async () => {
      const artifacts = await json<unknown[]>(
        `/v1/branches/${created.branchId}/artifacts`,
        bob.token,
      );
      return artifacts.length >= 1;
    });
    current = await state(created.branchId, alice.token);
    const transfers = await Promise.all([
      rawCommand(created.branchId, alice.token, "transfer-a", {
        type: "driver.transfer",
        expectedVersion: current.version,
        payload: { toId: bob.user.userId },
      }),
      rawCommand(created.branchId, alice.token, "transfer-b", {
        type: "driver.transfer",
        expectedVersion: current.version,
        payload: { toId: bob.user.userId },
      }),
    ]);
    expect(transfers.map((response) => response.status).sort()).toEqual([201, 409]);

    current = await state(created.branchId, bob.token);
    await command(created.branchId, bob.token, "direct-1", {
      type: "steering.send",
      expectedVersion: current.version,
      payload: { instruction: "Add a concurrency regression test" },
    });
    await waitFor(async () => {
      const stream = await json<EventEnvelope[]>(
        `/v1/branches/${created.branchId}/events?after=0`,
        alice.token,
      );
      return stream.filter((event) => event.type === "artifact.created").length >= 2;
    });

    current = await state(created.branchId, alice.token);
    await command(created.branchId, alice.token, "pause-1", {
      type: "session.pause",
      expectedVersion: current.version,
      payload: { reason: "Emergency test" },
    });
    await waitFor(async () => (await state(created.branchId, bob.token)).status === "paused");

    const reloaded = await state(created.branchId, alice.token);
    const durableEvents = await json<EventEnvelope[]>(
      `/v1/branches/${created.branchId}/events?after=0`,
      alice.token,
    );
    expect(reloaded).toMatchObject({
      status: "paused",
      driverId: bob.user.userId,
    });
    expect(reloaded.participants).toHaveLength(2);
    expect(durableEvents.map((event) => event.sequence)).toEqual(
      durableEvents.map((_event, index) => index + 1),
    );
    expect(durableEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "steering.proposed",
        "steering.approved",
        "steering.dispatched",
        "provider.output_received",
        "artifact.created",
        "driver.transferred",
        "session.paused",
      ]),
    );
    await waitFor(() => aliceEvents.length >= durableEvents.length - 2);
    await waitFor(() => bobEvents.some((event) => event.type === "session.paused"));

    const recoveryTarget = await json<{ branchId: string }>(
      "/v1/sessions",
      alice.token,
      {
        method: "POST",
        body: {
          organizationId: organization.id,
          title: "Restart recovery target",
          providerId: "simulator",
        },
      },
    );
    await waitFor(async () => {
      const result = await pool.query<{ state: string }>(
        "SELECT state FROM provider_executions WHERE branch_id = $1",
        [recoveryTarget.branchId],
      );
      return result.rows[0]?.state === "running";
    });

    sockets.forEach((socket) => socket.disconnect());
    await app.close();
    const restartedModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = restartedModule.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0);
    baseUrl = await app.getUrl();

    const replayedAfterRestart = await json<EventEnvelope[]>(
      `/v1/branches/${created.branchId}/events?after=0`,
      alice.token,
    );
    expect(replayedAfterRestart.map((event) => event.id)).toEqual(
      expect.arrayContaining(durableEvents.map((event) => event.id)),
    );
    const recoveryEvents = await json<EventEnvelope[]>(
      `/v1/branches/${recoveryTarget.branchId}/events?after=0`,
      alice.token,
    );
    expect(recoveryEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "provider.crashed",
          payload: expect.objectContaining({ code: "provider_process_abandoned" }),
        }),
      ]),
    );
  }, 20_000);

  async function signIn(email: string, displayName: string) {
    return json<{ token: string; user: { userId: string } }>(
      "/v1/auth/development/sign-in",
      null,
      { method: "POST", body: { email, displayName } },
    );
  }

  async function state(branchId: string, token: string): Promise<SessionView> {
    return json(`/v1/branches/${branchId}/state`, token);
  }

  async function command(
    branchId: string,
    token: string,
    key: string,
    body: Record<string, unknown>,
  ): Promise<EventEnvelope[]> {
    const response = await rawCommand(branchId, token, key, body);
    expect(response.status).toBe(201);
    return response.json() as Promise<EventEnvelope[]>;
  }

  function rawCommand(
    branchId: string,
    token: string,
    key: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return fetch(`${baseUrl}/v1/branches/${branchId}/commands`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify(body),
    });
  }

  async function connect(
    token: string,
    branchId: string,
    observed: EventEnvelope[],
  ): Promise<Socket> {
    const socket = io(`${baseUrl}/v1/live`, {
      auth: { token },
      transports: ["websocket"],
      forceNew: true,
    });
    await new Promise<void>((resolve, reject) => {
      socket.on("connect", () => {
        socket.emit("branch.subscribe", { branchId });
        resolve();
      });
      socket.on("connect_error", reject);
    });
    socket.on("event.committed", (event: EventEnvelope) => observed.push(event));
    return socket;
  }

  async function json<T>(
    path: string,
    token: string | null,
    options?: { method?: string; body?: unknown },
  ): Promise<T> {
    const init: RequestInit = {
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    };
    if (options?.method) init.method = options.method;
    if (options?.body !== undefined) init.body = JSON.stringify(options.body);
    const response = await fetch(`${baseUrl}${path}`, init);
    if (!response.ok) throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  }
});

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for condition");
}
