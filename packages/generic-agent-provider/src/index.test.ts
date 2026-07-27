import { WorkspaceManager } from "@parallel/workspace-runtime";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GenericAgentProvider } from "./index.js";

describe("generic agent protocol adapter", () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  let root: string;
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  const manifest = {
    protocolVersion: 1 as const,
    metadata: {
      id: "internal-agent",
      displayName: "Internal Agent",
      adapterVersion: "1.0.0",
      providerVersion: "2026.7",
    },
    capabilities: {
      schemaVersion: 1 as const,
      startExecution: true,
      steering: "interactive" as const,
      interactiveInput: true,
      pause: "boundary_only" as const,
      resume: "continuation" as const,
      cancel: true,
      persistentConversation: true,
      reconnect: "cursor_replay" as const,
      checkpointAwareness: "none" as const,
      shellExecution: true,
      filesystemEvents: true,
      artifactOutput: false,
      toolCallVisibility: "structured" as const,
      structuredEventOutput: true,
      usageReporting: true,
      workspaceOwnership: "shared" as const,
      concurrentExecutions: true,
    },
    readiness: {
      status: "ready" as const,
      checkedAt: new Date().toISOString(),
      executable: null,
      providerVersion: "2026.7",
      authentication: "ready" as const,
      diagnostics: ["Test provider"],
    },
    endpoints: { executions: "/v1/executions" },
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "parallel-generic-provider-"));
    const server = createServer(async (request, response) => {
      const body = await readBody(request);
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        body: body ? JSON.parse(body) : null,
      });
      route(request, response, manifest);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    baseUrl = `http://127.0.0.1:${address.port}`;
    close = () => new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  });

  afterEach(async () => {
    requests.splice(0);
    await close();
    await rm(root, { recursive: true, force: true });
  });

  it("discovers the manifest and drives one shared workspace execution", async () => {
    const provider = new GenericAgentProvider(
      new WorkspaceManager(root),
      { baseUrl, manifest, token: "secret", pollIntervalMs: 25 },
    );
    expect((await provider.readiness()).status).toBe("ready");
    const execution = await provider.createExecution({
      sessionId: "session",
      branchId: "branch",
      workspaceRef: "session://session/branch",
      initialInstruction: "Implement the change",
      idempotencyKey: "create",
    });
    const observations: unknown[] = [];
    const pump = (async () => {
      for await (const item of execution.observations()) observations.push(item);
    })();
    await execution.start();
    const receipt = await execution.steer("Add tests", "steer");
    expect(receipt.state).toBe("accepted");
    await waitFor(() => JSON.stringify(observations).includes("internal agent ready"));
    await execution.cancel("done");
    await execution.dispose();
    await pump;
    expect(requests).toContainEqual(expect.objectContaining({
      method: "POST",
      url: "/v1/executions",
      body: expect.objectContaining({
        protocolVersion: 1,
        instruction: "Implement the change",
        workspace: expect.objectContaining({ ownership: "shared" }),
      }),
    }));
  });
});

function route(
  request: IncomingMessage,
  response: ServerResponse,
  manifest: unknown,
): void {
  response.setHeader("content-type", "application/json");
  if (request.url === "/.well-known/parallel-agent-provider") return json(response, manifest);
  if (request.method === "POST" && request.url === "/v1/executions") {
    return json(response, { executionId: "execution-1", providerSessionId: "conversation-1" });
  }
  if (request.method === "POST" && request.url === "/v1/executions/execution-1/commands") {
    return json(response, { state: "accepted" });
  }
  if (request.method === "GET" && request.url?.startsWith("/v1/executions/execution-1/observations")) {
    return json(response, {
      observations: [{
        eventId: "event-1",
        sequence: 1,
        kind: "output",
        data: { channel: "final", text: "internal agent ready" },
      }],
      cursor: "cursor-1",
    });
  }
  response.statusCode = 404;
  json(response, { error: "not found" });
}

function json(response: ServerResponse, body: unknown): void {
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
