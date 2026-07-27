import {
  providerCapabilitiesV1Schema,
  providerReadinessSchema,
  type AgentProvider,
  type CreateExecutionRequest,
  type ProviderObservation,
} from "./index.js";

export type CertificationStatus = "passed" | "failed" | "skipped";

export interface CertificationCheck {
  id: string;
  status: CertificationStatus;
  durationMs: number;
  detail: string;
}

export interface CertificationReport {
  schemaVersion: 1;
  provider: AgentProvider["metadata"];
  capabilities: ReturnType<typeof providerCapabilitiesV1Schema.parse>;
  readiness: ReturnType<typeof providerReadinessSchema.parse>;
  startedAt: string;
  completedAt: string;
  evidence: {
    mode: "deterministic_fixture" | "credentialed_live" | "unspecified";
    transport: string;
  };
  checks: CertificationCheck[];
  summary: { passed: number; failed: number; skipped: number };
}

export interface ProviderCertificationProbes {
  workspaceTargeting?: () => Promise<void>;
  observableOutput?: () => Promise<void>;
  fileModification?: () => Promise<void>;
  successfulCompletion?: () => Promise<void>;
  failedCompletion?: () => Promise<void>;
  callbackReplay?: () => Promise<void>;
  malformedOutput?: () => Promise<void>;
  processCrash?: () => Promise<void>;
  timeout?: () => Promise<void>;
}

export async function certifyProvider(input: {
  provider: AgentProvider;
  createRequest: CreateExecutionRequest;
  timeoutMs?: number;
  probes?: ProviderCertificationProbes;
  evidence?: CertificationReport["evidence"];
}): Promise<CertificationReport> {
  const startedAt = new Date().toISOString();
  const checks: CertificationCheck[] = [];
  const timeoutMs = input.timeoutMs ?? 5_000;
  const capabilities = await checked(checks, "capability_honesty", async () =>
    providerCapabilitiesV1Schema.parse(input.provider.capabilities),
  );
  const readiness = await checked(checks, "provider_readiness", async () =>
    providerReadinessSchema.parse(await input.provider.readiness()),
  );
  const execution = await input.provider.createExecution(input.createRequest);
  const duplicate = await input.provider.createExecution(input.createRequest);
  await recorded(checks, "stable_execution_identity", async () => {
    if (execution.id !== duplicate.id) {
      throw new Error(`Execution identity changed: ${execution.id} != ${duplicate.id}`);
    }
  });
  await duplicate.dispose();

  const observations: ProviderObservation[] = [];
  const pump = (async () => {
    for await (const observation of execution.observations()) {
      observations.push(observation);
    }
  })();

  await recorded(checks, "execution_startup", async () => {
    await execution.start();
    await waitFor(
      () => observations.some(
        (observation) =>
          observation.kind === "status" &&
          ["started", "turn_started", "turn_completed"].includes(observation.status),
      ),
      timeoutMs,
    );
  });

  if (capabilities.steering === "none") {
    skipped(checks, "steering_delivery", "Provider declares steering unsupported");
    skipped(checks, "duplicate_command_handling", "No steering command surface");
  } else {
    await recorded(checks, "steering_delivery", async () => {
      const receipt = await execution.steer("Certification steering", "cert-steer");
      if (receipt.state === "rejected") throw new Error(receipt.reason ?? "Rejected");
    });
    await recorded(checks, "duplicate_command_handling", async () => {
      const first = await execution.steer("Duplicate", "cert-duplicate");
      const duplicateReceipt = await execution.steer("Duplicate", "cert-duplicate");
      if (
        first.state !== duplicateReceipt.state ||
        first.model !== duplicateReceipt.model ||
        first.providerExecutionId !== duplicateReceipt.providerExecutionId
      ) {
        throw new Error("Duplicate command did not return the original receipt");
      }
    });
  }

  if (capabilities.pause === "none") {
    skipped(checks, "pause_behavior", "Provider declares pause unsupported");
  } else {
    await recorded(checks, "pause_behavior", () =>
      execution.pause("Certification pause").then(() => undefined),
    );
  }
  if (capabilities.resume === "none") {
    skipped(checks, "resume_behavior", "Provider declares resume unsupported");
  } else {
    await recorded(checks, "resume_behavior", () => execution.resume(null));
  }
  if (capabilities.checkpointAwareness === "none") {
    skipped(checks, "checkpoint_behavior", "Provider declares checkpoint awareness unsupported");
  } else {
    await recorded(checks, "checkpoint_behavior", () =>
      execution.checkpoint("Certification checkpoint").then(() => undefined),
    );
  }

  const probeNames: Array<keyof ProviderCertificationProbes> = [
    "workspaceTargeting",
    "observableOutput",
    "fileModification",
    "successfulCompletion",
    "failedCompletion",
    "callbackReplay",
    "malformedOutput",
    "processCrash",
    "timeout",
  ];
  for (const name of probeNames) {
    const probe = input.probes?.[name];
    const id = snakeCase(name);
    if (probe) await recorded(checks, id, probe);
    else skipped(checks, id, "No adapter-specific probe supplied");
  }

  if (capabilities.cancel) {
    await recorded(checks, "cancellation", () =>
      execution.cancel("Certification complete"),
    );
  } else {
    skipped(checks, "cancellation", "Provider declares cancellation unsupported");
  }
  await execution.dispose();
  await pump;
  await recorded(checks, "event_ordering", async () => {
    for (let index = 0; index < observations.length; index += 1) {
      const previous = observations[index - 1];
      const current = observations[index];
      if (!current) throw new Error("Missing observation");
      if (previous && current.sequence !== previous.sequence + 1) {
        throw new Error(`Sequence gap ${previous.sequence} -> ${current.sequence}`);
      }
    }
  });

  const completedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    provider: input.provider.metadata,
    capabilities,
    readiness,
    startedAt,
    completedAt,
    evidence: input.evidence ?? { mode: "unspecified", transport: "unspecified" },
    checks,
    summary: summarize(checks),
  };
}

export function renderCertificationMarkdown(report: CertificationReport): string {
  const rows = report.checks.map(
    (check) =>
      `| \`${check.id}\` | ${check.status} | ${check.durationMs.toFixed(2)} | ${escapeCell(check.detail)} |`,
  ).join("\n");
  return `# ${report.provider.displayName} certification

- Provider: \`${report.provider.id}\`
- Adapter: \`${report.provider.adapterVersion}\`
- Provider version: \`${report.provider.providerVersion ?? "unknown"}\`
- Readiness: **${report.readiness.status}**
- Evidence: **${report.evidence.mode}** (${report.evidence.transport})
- Result: **${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped**

## Declared capabilities

\`\`\`json
${JSON.stringify(report.capabilities, null, 2)}
\`\`\`

## Behavioral checks

| Check | Status | Duration (ms) | Detail |
| --- | --- | ---: | --- |
${rows}

Skipped checks are unsupported or lack an adapter-specific probe. They are never counted as passes.
`;
}

function summarize(checks: CertificationCheck[]) {
  return {
    passed: checks.filter((check) => check.status === "passed").length,
    failed: checks.filter((check) => check.status === "failed").length,
    skipped: checks.filter((check) => check.status === "skipped").length,
  };
}

async function checked<T>(
  checks: CertificationCheck[],
  id: string,
  operation: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    const result = await operation();
    checks.push({ id, status: "passed", durationMs: round(performance.now() - started), detail: "Validated" });
    return result;
  } catch (error) {
    checks.push({ id, status: "failed", durationMs: round(performance.now() - started), detail: message(error) });
    throw error;
  }
}

async function recorded(
  checks: CertificationCheck[],
  id: string,
  operation: () => Promise<void>,
): Promise<void> {
  await checked(checks, id, async () => {
    await operation();
  });
}

function skipped(checks: CertificationCheck[], id: string, detail: string): void {
  checks.push({ id, status: "skipped", durationMs: 0, detail });
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function snakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
