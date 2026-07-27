import {
  providerCapabilitiesV1Schema,
  providerReadinessSchema,
  type AgentProvider,
  type CreateExecutionRequest,
  type ProviderObservation,
} from "@parallel/provider-sdk";

export type CertificationStatus = "passed" | "failed" | "skipped";

export interface CertificationCheck {
  id: string;
  status: CertificationStatus;
  durationMs: number;
  detail: string;
}

export interface CertificationReport {
  schemaVersion: 1;
  provider: {
    id: string;
    displayName: string;
    adapterVersion: string;
    providerVersion: string | null;
  };
  capabilities: ReturnType<typeof providerCapabilitiesV1Schema.parse>;
  readiness: ReturnType<typeof providerReadinessSchema.parse>;
  startedAt: string;
  completedAt: string;
  checks: CertificationCheck[];
  summary: { passed: number; failed: number; skipped: number };
}

export interface ProviderCertificationProbes {
  workspaceTargeting?: () => Promise<void>;
  stdoutAndStderr?: () => Promise<void>;
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
}): Promise<CertificationReport> {
  const startedAt = new Date().toISOString();
  const checks: CertificationCheck[] = [];
  const timeoutMs = input.timeoutMs ?? 5_000;
  const capabilities = await check(checks, "capability_honesty", async () =>
    providerCapabilitiesV1Schema.parse(input.provider.capabilities),
  );
  const readiness = await check(checks, "provider_readiness", async () =>
    providerReadinessSchema.parse(await input.provider.readiness()),
  );

  const execution = await input.provider.createExecution(input.createRequest);
  const duplicate = await input.provider.createExecution(input.createRequest);
  await record(checks, "stable_execution_identity", async () => {
    if (execution.id !== duplicate.id) {
      throw new Error(`Expected stable identity, got ${execution.id} and ${duplicate.id}`);
    }
  });
  await duplicate.dispose();

  const observations: ProviderObservation[] = [];
  const pump = (async () => {
    for await (const observation of execution.observations()) observations.push(observation);
  })();

  await record(checks, "execution_startup", async () => {
    await execution.start();
    await waitFor(
      () =>
        observations.some(
          (observation) =>
            observation.kind === "status" &&
            ["started", "turn_started", "turn_completed"].includes(observation.status),
        ),
      timeoutMs,
    );
  });

  if (capabilities.steering === "none") {
    skipped(checks, "steering_delivery", "Provider truthfully declares steering unsupported");
    skipped(checks, "duplicate_command_handling", "No steering command surface");
  } else {
    await record(checks, "steering_delivery", async () => {
      const receipt = await execution.steer("Certification steering", "cert-steer-1");
      if (receipt.state === "rejected") throw new Error(receipt.reason ?? "Steering rejected");
    });
    await record(checks, "duplicate_command_handling", async () => {
      const first = await execution.steer("Duplicate", "cert-steer-duplicate");
      const second = await execution.steer("Duplicate", "cert-steer-duplicate");
      if (first.state !== second.state || first.model !== second.model) {
        throw new Error("Duplicate command changed receipt");
      }
    });
  }

  if (capabilities.pause === "none") {
    skipped(checks, "cancellation", "Provider declares pause unsupported");
  } else {
    await record(checks, "cancellation", async () => {
      await execution.pause("Certification pause");
    });
  }

  if (capabilities.resume === "none") {
    skipped(checks, "lifecycle_transitions", "Provider declares resume unsupported");
  } else {
    await record(checks, "lifecycle_transitions", async () => {
      await execution.resume(null);
    });
  }

  for (const [id, probe] of Object.entries(input.probes ?? {})) {
    if (probe) await record(checks, snakeCase(id), probe);
  }
  for (const id of [
    "workspace_targeting",
    "stdout_and_stderr",
    "file_modification",
    "successful_completion",
    "failed_completion",
    "callback_replay",
    "malformed_output",
    "process_crash",
    "timeout",
  ]) {
    if (!checks.some((item) => item.id === id)) {
      skipped(checks, id, "No certification probe supplied");
    }
  }

  await execution.cancel("Certification complete");
  await execution.dispose();
  await pump;
  await record(checks, "event_ordering", async () => {
    const sequences = observations.map((observation) => observation.sequence);
    if (sequences.some((sequence, index) => sequence !== index + 1)) {
      throw new Error(`Non-contiguous provider sequences: ${sequences.join(",")}`);
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
    checks,
    summary: {
      passed: checks.filter((item) => item.status === "passed").length,
      failed: checks.filter((item) => item.status === "failed").length,
      skipped: checks.filter((item) => item.status === "skipped").length,
    },
  };
}

export function renderCertificationMarkdown(report: CertificationReport): string {
  const rows = report.checks
    .map(
      (item) =>
        `| \`${item.id}\` | ${item.status} | ${item.durationMs.toFixed(2)} | ${escapeCell(item.detail)} |`,
    )
    .join("\n");
  return `# ${report.provider.displayName} certification

- Provider: \`${report.provider.id}\`
- Adapter: \`${report.provider.adapterVersion}\`
- Provider version: \`${report.provider.providerVersion ?? "unknown"}\`
- Readiness: **${report.readiness.status}**
- Started: ${report.startedAt}
- Completed: ${report.completedAt}
- Result: **${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped**

## Declared capabilities

\`\`\`json
${JSON.stringify(report.capabilities, null, 2)}
\`\`\`

## Behavioral checks

| Check | Status | Duration (ms) | Detail |
| --- | --- | ---: | --- |
${rows}

Skipped checks are unsupported or were not supplied by the adapter-specific probe set; they are not silently counted as passes.
`;
}

async function check<T>(
  checks: CertificationCheck[],
  id: string,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await operation();
    checks.push({
      id,
      status: "passed",
      durationMs: round(performance.now() - startedAt),
      detail: "Validated",
    });
    return result;
  } catch (error) {
    checks.push({
      id,
      status: "failed",
      durationMs: round(performance.now() - startedAt),
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function record(
  checks: CertificationCheck[],
  id: string,
  operation: () => Promise<void>,
): Promise<void> {
  const startedAt = performance.now();
  try {
    await operation();
    checks.push({
      id,
      status: "passed",
      durationMs: round(performance.now() - startedAt),
      detail: "Validated",
    });
  } catch (error) {
    checks.push({
      id,
      status: "failed",
      durationMs: round(performance.now() - startedAt),
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function skipped(checks: CertificationCheck[], id: string, detail: string): void {
  checks.push({ id, status: "skipped", durationMs: 0, detail });
}

async function waitFor(checkValue: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (checkValue()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for provider observation");
}

function snakeCase(value: string): string {
  return value.replaceAll(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", "<br>");
}
