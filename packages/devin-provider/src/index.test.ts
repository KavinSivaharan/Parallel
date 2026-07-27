import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DevinProvider } from "./index.js";

describe("Devin provider", () => {
  let close: () => Promise<void>;
  let baseUrl: string;
  const requests: Array<{ method: string; url: string; body: unknown }> = [];

  beforeEach(async () => {
    const server = createServer(async (request, response) => {
      const body = await readBody(request);
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        body: body ? JSON.parse(body) : null,
      });
      route(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
    close = () => new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  });

  afterEach(async () => {
    requests.splice(0);
    await close();
  });

  it("targets repos, streams messages, steers interactively, and terminates", async () => {
    const provider = new DevinProvider({
      baseUrl,
      apiKey: "cog_test",
      organizationId: "org-test",
      pollIntervalMs: 50,
    });
    expect((await provider.readiness()).status).toBe("ready");
    const execution = await provider.createExecution({
      sessionId: "session",
      branchId: "branch",
      workspaceRef: "session://session/branch",
      repositoryUrl: "https://github.com/acme/repo.git",
      initialInstruction: "Fix the bug",
      idempotencyKey: "create",
    });
    const observations: unknown[] = [];
    const pump = (async () => {
      for await (const observation of execution.observations()) observations.push(observation);
    })();
    await execution.start();
    const receipt = await execution.steer("Also add tests", "steer-1");
    expect(receipt.state).toBe("accepted");
    expect(await execution.steer("Also add tests", "steer-1")).toEqual(receipt);
    await waitFor(() => JSON.stringify(observations).includes("Working on it"));
    await execution.cancel("Emergency");
    await execution.dispose();
    await pump;

    expect(requests).toContainEqual(expect.objectContaining({
      method: "POST",
      url: "/organizations/org-test/sessions",
      body: expect.objectContaining({
        prompt: "Fix the bug",
        repos: ["https://github.com/acme/repo.git"],
      }),
    }));
    expect(requests).toContainEqual(expect.objectContaining({
      method: "DELETE",
      url: "/organizations/org-test/sessions/devin-1",
    }));
  });

  it("reports missing credentials and rejects local paths", async () => {
    const provider = new DevinProvider({ baseUrl });
    expect((await provider.readiness()).status).toBe("misconfigured");
    await expect(provider.createExecution({
      sessionId: "session",
      branchId: "branch",
      workspaceRef: "session://session/branch",
      repositoryUrl: "/tmp/repository",
      initialInstruction: "Fix",
      idempotencyKey: "create",
    })).rejects.toThrow("remote Git URLs");
  });
});

function route(request: IncomingMessage, response: ServerResponse): void {
  response.setHeader("content-type", "application/json");
  if (request.url === "/self") return json(response, { service_user_name: "Parallel" });
  if (request.method === "POST" && request.url === "/organizations/org-test/sessions") {
    return json(response, { session_id: "devin-1", url: "https://app.devin.ai/sessions/devin-1" });
  }
  if (request.method === "POST" && request.url === "/organizations/org-test/sessions/devin-1/messages") {
    return json(response, { success: true });
  }
  if (request.method === "GET" && request.url?.startsWith("/organizations/org-test/sessions/devin-1/messages")) {
    return json(response, {
      items: [{ event_id: "message-1", source: "devin", message: "Working on it" }],
      end_cursor: "cursor-1",
      has_next_page: false,
    });
  }
  if (request.method === "GET" && request.url === "/organizations/org-test/sessions/devin-1") {
    return json(response, { session_id: "devin-1", status: "running", status_detail: "working" });
  }
  if (request.method === "DELETE" && request.url === "/organizations/org-test/sessions/devin-1") {
    return json(response, { session_id: "devin-1", status: "exit" });
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
