import {
  ClaudeCodeProvider,
  type ClaudeCodeProviderOptions,
} from "@parallel/claude-code-provider";
import {
  CodexProvider,
  type CodexProviderOptions,
} from "@parallel/codex-provider";
import { DevinProvider } from "@parallel/devin-provider";
import {
  GenericAgentProvider,
  type GenericAgentProviderOptions,
} from "@parallel/generic-agent-provider";
import { OpenHandsProvider } from "@parallel/openhands-provider";
import {
  SimulatedProvider,
  genericAgentManifestSchema,
  type AgentProvider,
  type GenericAgentManifest,
  type ProviderCertificationSummary,
} from "@parallel/provider-sdk";
import { LocalWorkspaceProvider } from "@parallel/workspace-provider";
import type { WorkspaceManager } from "@parallel/workspace-runtime";

export interface RegisteredProvider {
  provider: AgentProvider;
  certification: ProviderCertificationSummary;
}

export class ProviderRegistry {
  private readonly registrations = new Map<string, RegisteredProvider>();

  constructor(workspaces: WorkspaceManager) {
    this.register(new SimulatedProvider());
    this.register(new LocalWorkspaceProvider(workspaces));
    this.register(new CodexProvider(workspaces, codexOptions()));
    this.register(new ClaudeCodeProvider(workspaces, claudeOptions()));
    this.register(new OpenHandsProvider(workspaces, cliOptions("OPENHANDS")));
    this.register(new DevinProvider());
    for (const configuration of genericConfigurations()) {
      this.register(new GenericAgentProvider(workspaces, configuration));
    }
  }

  get(providerId: string): AgentProvider | undefined {
    return this.registrations.get(providerId)?.provider;
  }

  values(): RegisteredProvider[] {
    return [...this.registrations.values()];
  }

  private register(provider: AgentProvider): void {
    if (this.registrations.has(provider.id)) {
      throw new Error(`Duplicate provider id ${provider.id}`);
    }
    this.registrations.set(provider.id, {
      provider,
      certification: certificationFor(provider.id),
    });
  }
}

const certifiedAt = "2026-07-27T15:59:02.991Z";

const certificationResults: Record<
  string,
  Omit<ProviderCertificationSummary, "schemaVersion" | "status" | "certifiedAt">
> = {
  simulator: { passed: 10, failed: 0, skipped: 10, report: "/docs/certification/simulator.json" },
  "local-workspace": { passed: 9, failed: 0, skipped: 11, report: "/docs/certification/local-workspace.json" },
  codex: { passed: 19, failed: 0, skipped: 0, report: "/docs/certification/codex.json" },
  "claude-code": { passed: 11, failed: 0, skipped: 9, report: "/docs/certification/claude-code.json" },
  openhands: { passed: 11, failed: 0, skipped: 9, report: "/docs/certification/openhands.json" },
  devin: { passed: 9, failed: 0, skipped: 11, report: "/docs/certification/devin.json" },
  "generic-agent": { passed: 11, failed: 0, skipped: 9, report: "/docs/certification/generic-agent.json" },
};

function certificationFor(providerId: string): ProviderCertificationSummary {
  const result = certificationResults[providerId];
  if (!result) {
    return {
      schemaVersion: 1,
      status: "not_run",
      passed: 0,
      failed: 0,
      skipped: 0,
      report: null,
      certifiedAt: null,
    };
  }
  return {
    schemaVersion: 1,
    status: result.failed === 0 ? "passed" : "failed",
    ...result,
    certifiedAt,
  };
}

function codexOptions(): CodexProviderOptions {
  return {
    ...(process.env.CODEX_EXECUTABLE ? { executable: process.env.CODEX_EXECUTABLE } : {}),
    ...cliOptions("CODEX"),
  };
}

function claudeOptions(): ClaudeCodeProviderOptions {
  return {
    ...(process.env.CLAUDE_EXECUTABLE ? { executable: process.env.CLAUDE_EXECUTABLE } : {}),
    ...cliOptions("CLAUDE"),
  };
}

function cliOptions(prefix: "CODEX" | "CLAUDE" | "OPENHANDS") {
  const maxExecutionMs = numericEnvironment(`${prefix}_MAX_EXECUTION_MS`);
  const maxEventBytes = numericEnvironment(`${prefix}_MAX_EVENT_BYTES`);
  const maxOutputBytes = numericEnvironment(`${prefix}_MAX_OUTPUT_BYTES`);
  const maxArtifactBytes = numericEnvironment(`${prefix}_MAX_ARTIFACT_BYTES`);
  const maxQueuedSteering = numericEnvironment(`${prefix}_MAX_QUEUED_STEERING`);
  return {
    ...(maxExecutionMs !== undefined ? { maxExecutionMs } : {}),
    ...(maxEventBytes !== undefined ? { maxEventBytes } : {}),
    ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
    ...(maxArtifactBytes !== undefined ? { maxArtifactBytes } : {}),
    ...(maxQueuedSteering !== undefined ? { maxQueuedSteering } : {}),
  };
}

function genericConfigurations(): GenericAgentProviderOptions[] {
  const raw = process.env.PARALLEL_GENERIC_PROVIDERS;
  if (!raw) {
    return [{
      baseUrl: process.env.GENERIC_AGENT_URL ?? "http://127.0.0.1:8787",
      ...(process.env.GENERIC_AGENT_TOKEN
        ? { token: process.env.GENERIC_AGENT_TOKEN }
        : {}),
      manifest: referenceGenericManifest(),
    }];
  }
  let values: unknown;
  try {
    values = JSON.parse(raw);
  } catch {
    throw new Error("PARALLEL_GENERIC_PROVIDERS must be valid JSON");
  }
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("PARALLEL_GENERIC_PROVIDERS must be a non-empty array");
  }
  return values.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Generic provider configuration ${index} must be an object`);
    }
    const input = value as Record<string, unknown>;
    if (typeof input.baseUrl !== "string" || !input.baseUrl) {
      throw new Error(`Generic provider configuration ${index} requires baseUrl`);
    }
    const manifest = genericAgentManifestSchema.parse(input.manifest);
    const token =
      typeof input.tokenEnv === "string" ? process.env[input.tokenEnv] : undefined;
    return {
      baseUrl: input.baseUrl,
      manifest,
      ...(token ? { token } : {}),
    };
  });
}

function referenceGenericManifest(): GenericAgentManifest {
  return {
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
      status: "unavailable",
      checkedAt: certifiedAt,
      executable: null,
      providerVersion: "protocol-v1",
      authentication: "unknown",
      diagnostics: ["Generic provider endpoint has not been probed"],
    },
    endpoints: { executions: "/v1/executions" },
  };
}

function numericEnvironment(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be numeric`);
  return value;
}
