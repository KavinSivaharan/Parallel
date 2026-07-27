import { ClaudeCodeProvider } from "@parallel/claude-code-provider";
import { CodexProvider } from "@parallel/codex-provider";
import { DevinProvider } from "@parallel/devin-provider";
import { GenericAgentProvider } from "@parallel/generic-agent-provider";
import { OpenHandsProvider } from "@parallel/openhands-provider";
import {
  genericAgentManifestSchema,
  type AgentProvider,
  type CreateExecutionRequest,
  type GenericAgentManifest,
} from "@parallel/provider-sdk";
import { WorkspaceManager } from "@parallel/workspace-runtime";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  certifyProvider,
  renderCertificationMarkdown,
} from "./index.js";

const fakeCli = fileURLToPath(
  new URL("./fixtures/fake-agent-cli.mjs", import.meta.url),
);
const fakeCodex = fileURLToPath(
  new URL("../../codex-provider/src/fixtures/fake-codex.mjs", import.meta.url),
);
const temporaryRoots: string[] = [];
const generatedReports: Array<Awaited<ReturnType<typeof certifyProvider>>> = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

afterAll(async () => {
  await writeMatrix(generatedReports);
});

describe("production provider certification", () => {
  it.each([
    ["codex", createCodex],
    ["claude-code", createClaude],
    ["openhands", createOpenHands],
    ["devin", createDevin],
    ["generic-agent", createGeneric],
  ] as const)(
    "certifies %s through the common SDK harness",
    async (providerId, factory) => {
      const fixture = await factory();
      const report = await certifyProvider({
        provider: fixture.provider,
        createRequest: fixture.createRequest,
        timeoutMs: 3_000,
        evidence: fixture.evidence,
      });

      expect(report.provider.id).toBe(providerId);
      expect(report.summary.failed).toBe(0);
      expect(report.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "capability_honesty",
            status: "passed",
          }),
          expect.objectContaining({
            id: "execution_startup",
            status: "passed",
          }),
          expect.objectContaining({ id: "cancellation", status: "passed" }),
          expect.objectContaining({ id: "event_ordering", status: "passed" }),
        ]),
      );
      await writeReport(report);
    },
    15_000,
  );
});

interface CertificationFixture {
  provider: AgentProvider;
  createRequest: CreateExecutionRequest;
  evidence: {
    mode: "deterministic_fixture";
    transport: string;
  };
}

async function createClaude(): Promise<CertificationFixture> {
  const workspaces = await workspaceManager("claude");
  return {
    provider: new ClaudeCodeProvider(workspaces, {
      executable: process.execPath,
      executableArgsPrefix: [fakeCli, "claude-code"],
    }),
    createRequest: request("claude-code"),
    evidence: { mode: "deterministic_fixture", transport: "Claude Code JSONL CLI" },
  };
}

async function createCodex(): Promise<CertificationFixture> {
  const workspaces = await workspaceManager("codex");
  return {
    provider: new CodexProvider(workspaces, {
      executable: process.execPath,
      executableArgsPrefix: [fakeCodex],
    }),
    createRequest: request("codex"),
    evidence: { mode: "deterministic_fixture", transport: "Codex JSONL CLI" },
  };
}

async function createOpenHands(): Promise<CertificationFixture> {
  const workspaces = await workspaceManager("openhands");
  return {
    provider: new OpenHandsProvider(workspaces, {
      executable: process.execPath,
      executableArgsPrefix: [fakeCli, "openhands"],
    }),
    createRequest: request("openhands"),
    evidence: { mode: "deterministic_fixture", transport: "OpenHands JSONL CLI" },
  };
}

async function createDevin(): Promise<CertificationFixture> {
  return {
    provider: new DevinProvider({
      baseUrl: "https://devin.certification.invalid",
      apiKey: "cog_certification",
      organizationId: "org-certification",
      pollIntervalMs: 50,
      fetch: devinFetch,
    }),
    createRequest: {
      ...request("devin"),
      repositoryUrl: "https://github.com/parallel-fixtures/repository.git",
    },
    evidence: { mode: "deterministic_fixture", transport: "Devin API v3 HTTP" },
  };
}

async function createGeneric(): Promise<CertificationFixture> {
  const workspaces = await workspaceManager("generic");
  return {
    provider: new GenericAgentProvider(workspaces, {
      baseUrl: "https://generic.certification.invalid",
      manifest: genericManifest,
      token: "certification-token",
      pollIntervalMs: 25,
      fetch: genericFetch,
    }),
    createRequest: request("generic-agent"),
    evidence: { mode: "deterministic_fixture", transport: "Generic protocol v1 HTTP" },
  };
}

function request(providerId: string): CreateExecutionRequest {
  return {
    sessionId: `cert-${providerId}`,
    branchId: `cert-${providerId}`,
    workspaceRef: `session://cert-${providerId}/cert-${providerId}`,
    initialInstruction: `Certify ${providerId}`,
    idempotencyKey: `create-${providerId}`,
  };
}

async function workspaceManager(name: string): Promise<WorkspaceManager> {
  const root = await mkdtemp(join(tmpdir(), `parallel-cert-${name}-`));
  temporaryRoots.push(root);
  return new WorkspaceManager(root);
}

const genericManifest: GenericAgentManifest = genericAgentManifestSchema.parse({
  protocolVersion: 1,
  metadata: {
    id: "generic-agent",
    displayName: "Generic Agent SDK",
    adapterVersion: "1.0.0",
    providerVersion: "protocol-v1",
  },
  capabilities: {
    schemaVersion: 1,
    startExecution: true,
    steering: "interactive",
    interactiveInput: true,
    pause: "interrupt_current",
    resume: "same_process",
    cancel: true,
    persistentConversation: true,
    reconnect: "cursor_replay",
    checkpointAwareness: "native",
    shellExecution: true,
    filesystemEvents: true,
    artifactOutput: true,
    toolCallVisibility: "structured",
    structuredEventOutput: true,
    usageReporting: true,
    workspaceOwnership: "shared",
    concurrentExecutions: true,
  },
  readiness: {
    status: "ready",
    checkedAt: "2026-07-27T15:45:00.000Z",
    executable: null,
    providerVersion: "protocol-v1",
    authentication: "ready",
    diagnostics: ["Deterministic protocol fixture"],
  },
  endpoints: { executions: "/v1/executions" },
});

const genericFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.pathname === "/.well-known/parallel-agent-provider") {
    return json(genericManifest);
  }
  if (init?.method === "POST" && url.pathname === "/v1/executions") {
    return json({
      executionId: "generic-certification-execution",
      providerSessionId: "generic-certification-session",
    });
  }
  if (init?.method === "POST" && url.pathname.endsWith("/commands")) {
    const command = JSON.parse(String(init.body)) as { type?: string };
    return json({
      state: command.type === "steer" ? "accepted" : "completed",
      cursor: "generic-certification-cursor",
      checkpointId: "generic-certification-checkpoint",
    });
  }
  if (init?.method === "GET" && url.pathname.endsWith("/observations")) {
    return json({ observations: [], cursor: "generic-certification-cursor" });
  }
  return json({ error: "not found" }, 404);
};

const devinFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.pathname === "/self") return json({ service_user_name: "Parallel" });
  if (
    init?.method === "POST" &&
    url.pathname === "/organizations/org-certification/sessions"
  ) {
    return json({ session_id: "devin-certification-session" });
  }
  if (init?.method === "POST" && url.pathname.endsWith("/messages")) {
    return json({ success: true });
  }
  if (init?.method === "GET" && url.pathname.endsWith("/messages")) {
    return json({ items: [], end_cursor: "cursor-1", has_next_page: false });
  }
  if (
    init?.method === "GET" &&
    url.pathname.endsWith("/devin-certification-session")
  ) {
    return json({
      session_id: "devin-certification-session",
      status: "running",
      status_detail: "working",
    });
  }
  if (
    init?.method === "DELETE" &&
    url.pathname.endsWith("/devin-certification-session")
  ) {
    return json({ session_id: "devin-certification-session", status: "exit" });
  }
  return json({ error: "not found" }, 404);
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function writeReport(
  report: Awaited<ReturnType<typeof certifyProvider>>,
): Promise<void> {
  generatedReports.push(report);
  if (process.env.PARALLEL_WRITE_CERTIFICATION !== "1") return;
  const output = resolve(
    process.cwd(),
    process.env.PARALLEL_CERTIFICATION_DIR ?? "../../docs/certification",
  );
  await mkdir(output, { recursive: true });
  await Promise.all([
    writeFile(
      join(output, `${reportName(report.provider.id)}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      join(output, `${reportName(report.provider.id)}.md`),
      renderCertificationMarkdown(report),
      "utf8",
    ),
  ]);
}

async function writeMatrix(
  reports: Array<Awaited<ReturnType<typeof certifyProvider>>>,
): Promise<void> {
  if (process.env.PARALLEL_WRITE_CERTIFICATION !== "1" || reports.length === 0) {
    return;
  }
  const output = resolve(
    process.cwd(),
    process.env.PARALLEL_CERTIFICATION_DIR ?? "../../docs/certification",
  );
  const matrix = {
    schemaVersion: 1,
    generatedAt: reports
      .map((report) => report.completedAt)
      .sort()
      .at(-1),
    providers: reports
      .map((report) => ({
        metadata: report.provider,
        capabilities: report.capabilities,
        readiness: report.readiness,
        evidence: report.evidence,
        certification: {
          status: report.summary.failed === 0 ? "passed" : "failed",
          ...report.summary,
          report: `${reportName(report.provider.id)}.json`,
        },
      }))
      .sort((left, right) =>
        left.metadata.id.localeCompare(right.metadata.id),
      ),
  };
  await writeFile(
    join(output, "providers.json"),
    `${JSON.stringify(matrix, null, 2)}\n`,
    "utf8",
  );
}

function reportName(providerId: string): string {
  return providerId === "codex" ? "codex-sdk" : providerId;
}
