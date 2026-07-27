import {
  BufferedProviderExecution,
  BoundedProviderEventKeys,
  GENERIC_AGENT_PROTOCOL_VERSION,
  IdempotentSteeringReceipts,
  genericAgentManifestSchema,
  genericCreateExecutionResponseSchema,
  genericObservationBatchSchema,
  normalizedText,
  safeUsage,
  type AgentProvider,
  type CreateExecutionRequest,
  type GenericAgentCommand,
  type GenericAgentManifest,
  type GenericObservationEnvelope,
  type ProviderObservationInput,
  type ProviderReadiness,
  type SteeringReceipt,
} from "@parallel/provider-sdk";
import {
  WorkspaceManager,
  type WorkspaceMetadata,
} from "@parallel/workspace-runtime";

export interface GenericAgentProviderOptions {
  baseUrl: string;
  manifest: GenericAgentManifest;
  token?: string;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
}

interface ResolvedOptions {
  baseUrl: string;
  manifest: GenericAgentManifest;
  token: string | null;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  fetch: typeof fetch;
}

export class GenericAgentProvider implements AgentProvider {
  readonly id: string;
  readonly metadata: GenericAgentManifest["metadata"];
  readonly capabilities: GenericAgentManifest["capabilities"];
  private readonly options: ResolvedOptions;

  constructor(
    private readonly workspaces: WorkspaceManager,
    options: GenericAgentProviderOptions,
  ) {
    const manifest = genericAgentManifestSchema.parse(options.manifest);
    this.id = manifest.metadata.id;
    this.metadata = manifest.metadata;
    this.capabilities = manifest.capabilities;
    this.options = {
      baseUrl: options.baseUrl.replace(/\/$/, ""),
      manifest,
      token: options.token ?? null,
      pollIntervalMs: bounded(options.pollIntervalMs, 500, 25, 60_000),
      requestTimeoutMs: bounded(options.requestTimeoutMs, 10_000, 500, 60_000),
      fetch: options.fetch ?? globalThis.fetch,
    };
  }

  async readiness(): Promise<ProviderReadiness> {
    const checkedAt = new Date().toISOString();
    try {
      const discovered = genericAgentManifestSchema.parse(
        await requestJson(this.options, "/.well-known/parallel-agent-provider", {
          method: "GET",
        }),
      );
      if (
        discovered.metadata.id !== this.id ||
        JSON.stringify(discovered.capabilities) !== JSON.stringify(this.capabilities)
      ) {
        throw new Error("Configured and discovered provider manifests differ");
      }
      return {
        ...discovered.readiness,
        checkedAt,
        diagnostics: [
          ...discovered.readiness.diagnostics,
          `Parallel generic protocol v${GENERIC_AGENT_PROTOCOL_VERSION}`,
        ].slice(0, 20),
      };
    } catch (error) {
      return {
        status: "unavailable",
        checkedAt,
        executable: null,
        providerVersion: this.metadata.providerVersion,
        authentication: this.options.token ? "unknown" : "missing",
        diagnostics: [normalizedText(error instanceof Error ? error.message : String(error), 500)],
      };
    }
  }

  async createExecution(request: CreateExecutionRequest) {
    let workspace: WorkspaceMetadata | null = null;
    if (this.capabilities.workspaceOwnership !== "provider") {
      workspace =
        request.parentWorkspaceId && request.parentCheckpoint
          ? await this.workspaces.fork(
              request.parentWorkspaceId,
              request.parentCheckpoint,
              request.branchId,
            )
          : await this.workspaces.create({
              id: request.branchId,
              ...(request.repositoryUrl ? { repositoryUrl: request.repositoryUrl } : {}),
              ...(request.baseRef ? { baseRef: request.baseRef } : {}),
            });
    } else if (!request.repositoryUrl) {
      throw new Error(`${this.metadata.displayName} requires a repository URL`);
    }
    return new GenericExecution(
      this.options,
      this.workspaces,
      request,
      workspace,
    );
  }
}

class GenericExecution extends BufferedProviderExecution {
  private readonly receipts = new IdempotentSteeringReceipts();
  private readonly seenEvents = new BoundedProviderEventKeys();
  private lastProviderSequence: number | null = null;
  private remoteExecutionId: string | null = null;
  private providerSessionId: string | null;
  private cursor: string | null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private terminal = false;
  private started = false;

  constructor(
    private readonly options: ResolvedOptions,
    private readonly workspaces: WorkspaceManager,
    private readonly request: CreateExecutionRequest,
    private readonly workspace: WorkspaceMetadata | null,
  ) {
    super(`${options.manifest.metadata.id}-${request.branchId}`, request.observationSequence ?? 1);
    this.providerSessionId = request.recovery?.providerSessionId ?? null;
    this.cursor = request.recovery?.cursor ?? null;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.emit(
      { kind: "status", status: "starting" },
      `execution:${this.request.branchId}:starting`,
    );
    const created = genericCreateExecutionResponseSchema.parse(
      await requestJson(
        this.options,
        this.options.manifest.endpoints.executions,
        {
          method: "POST",
          body: JSON.stringify({
            protocolVersion: GENERIC_AGENT_PROTOCOL_VERSION,
            idempotencyKey: this.request.idempotencyKey,
            sessionId: this.request.sessionId,
            branchId: this.request.branchId,
            instruction: this.request.initialInstruction,
            workspace: this.workspace
              ? {
                  ownership: this.options.manifest.capabilities.workspaceOwnership,
                  id: this.workspace.id,
                  path: this.workspace.repositoryPath,
                  repositoryUrl: this.workspace.repositoryUrl,
                  baseRef: this.workspace.baseRef,
                }
              : {
                  ownership: "provider",
                  id: this.request.branchId,
                  repositoryUrl: this.request.repositoryUrl,
                  baseRef: this.request.baseRef ?? null,
                },
            recovery: this.request.recovery ?? null,
          }),
        },
      ),
    );
    this.remoteExecutionId = created.executionId;
    this.providerSessionId = created.providerSessionId ?? this.providerSessionId;
    if (this.workspace) {
      this.emit({
        kind: "workspace",
        workspaceId: this.workspace.id,
        repositoryPath: this.workspace.repositoryPath,
        repositoryUrl: this.workspace.repositoryUrl,
        baseRef: this.workspace.baseRef,
        branch: this.workspace.branch,
        parentWorkspaceId: this.workspace.parentWorkspaceId,
        parentCheckpoint: this.workspace.parentCheckpoint,
      }, `workspace:${this.workspace.id}`);
    }
    this.emit({
      kind: "status",
      status: "started",
      ...(this.providerSessionId ? { providerSessionId: this.providerSessionId } : {}),
    }, `execution:${this.remoteExecutionId}:started`);
    this.schedulePoll(0);
  }

  async steer(instruction: string, idempotencyKey: string): Promise<SteeringReceipt> {
    const existing = this.receipts.get(idempotencyKey);
    if (existing) return existing;
    if (this.capability("steering") === "none" || this.terminal || !this.remoteExecutionId) {
      const receipt = this.receipts.remember(idempotencyKey, {
        state: "rejected",
        model: "none",
        providerExecutionId: this.id,
        reason: this.terminal ? "Execution terminated" : "Steering unsupported or not started",
      });
      return receipt;
    }
    const command: GenericAgentCommand = {
      type: "steer",
      instruction: validateInstruction(instruction),
      idempotencyKey,
    };
    const response = await this.command(command);
    const model =
      this.capability("steering") === "interactive"
        ? "interactive"
        : "continuation";
    const state = response.state === "queued" ? "queued" : "accepted";
    const receipt = this.receipts.remember(idempotencyKey, {
      state,
      model,
      providerExecutionId: this.id,
    });
    this.emit({
      kind: "steering",
      commandId: idempotencyKey,
      state: state === "queued" ? "queued" : "delivered",
      model,
    });
    return receipt;
  }

  async executeCommand(): Promise<void> {
    throw new Error(`${this.options.manifest.metadata.displayName} owns tool execution`);
  }

  async pause(reason: string): Promise<{ cursor: string | null }> {
    if (this.capability("pause") === "none") throw new Error("Provider declares pause unsupported");
    const response = await this.command({ type: "pause", reason: normalizedText(reason, 2_000) });
    this.emit({ kind: "status", status: "paused", ...this.sessionFields() });
    return { cursor: typeof response.cursor === "string" ? response.cursor : this.cursor };
  }

  async resume(cursor: string | null): Promise<void> {
    if (this.capability("resume") === "none") throw new Error("Provider declares resume unsupported");
    await this.command({ type: "resume", cursor });
    this.emit({ kind: "status", status: "resumed", ...this.sessionFields() });
    this.schedulePoll(0);
  }

  async cancel(reason: string): Promise<void> {
    if (this.terminal) return;
    await this.command({ type: "cancel", reason: normalizedText(reason, 2_000) });
    this.terminal = true;
    this.clearPoll();
    this.emit({ kind: "status", status: "cancelled", ...this.sessionFields() });
  }

  async checkpoint(summary?: string): Promise<{ providerState: string }> {
    if (this.capability("checkpointAwareness") === "none") {
      return { providerState: JSON.stringify({ providerSessionId: this.providerSessionId }) };
    }
    const response = await this.command({
      type: "checkpoint",
      ...(summary ? { summary: normalizedText(summary, 2_000) } : {}),
    });
    return { providerState: JSON.stringify(response) };
  }

  async restore(checkpointId: string, idempotencyKey: string): Promise<void> {
    if (this.capability("checkpointAwareness") === "none") {
      throw new Error("Provider declares checkpoint restore unsupported");
    }
    await this.command({ type: "restore", checkpointId, idempotencyKey });
  }

  override async dispose(): Promise<void> {
    this.clearPoll();
    this.closeObservations();
  }

  private async command(command: GenericAgentCommand): Promise<Record<string, unknown>> {
    if (!this.remoteExecutionId) throw new Error("Generic execution not started");
    const response = await requestJson(
      this.options,
      `${this.executionPath()}/commands`,
      { method: "POST", body: JSON.stringify(command) },
    );
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new Error("Generic provider returned an invalid command response");
    }
    return response as Record<string, unknown>;
  }

  private schedulePoll(delay: number): void {
    if (this.terminal || this.pollTimer || !this.remoteExecutionId) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, delay);
    this.pollTimer.unref();
  }

  private async poll(): Promise<void> {
    if (this.terminal || !this.remoteExecutionId) return;
    try {
      const batch = genericObservationBatchSchema.parse(
        await requestJson(
          this.options,
          `${this.executionPath()}/observations${this.cursor ? `?cursor=${encodeURIComponent(this.cursor)}` : ""}`,
          { method: "GET" },
        ),
      );
      for (const envelope of batch.observations) {
        if (
          this.lastProviderSequence !== null &&
          envelope.sequence <= this.lastProviderSequence
        ) {
          if (this.seenEvents.has(envelope.eventId)) continue;
          throw new Error(
            `Provider event sequence regressed to ${envelope.sequence}`,
          );
        }
        if (
          this.lastProviderSequence !== null &&
          envelope.sequence !== this.lastProviderSequence + 1
        ) {
          throw new Error(
            `Provider event sequence gap ${this.lastProviderSequence} -> ${envelope.sequence}`,
          );
        }
        const normalized = normalizeEnvelope(envelope);
        if (!this.seenEvents.accept(envelope.eventId)) continue;
        this.emit(normalized, `event:${envelope.eventId}`);
        this.lastProviderSequence = envelope.sequence;
        if (
          normalized.kind === "status" &&
          ["completed", "cancelled", "timed_out", "crashed"].includes(normalized.status)
        ) {
          this.terminal = true;
        }
      }
      if (batch.cursor && batch.cursor !== this.cursor) {
        this.cursor = batch.cursor;
        this.emit(
          { kind: "cursor", cursor: batch.cursor },
          `cursor:${batch.cursor}`,
        );
      }
    } catch (error) {
      this.emit({
        kind: "warning",
        code: "generic_provider_poll_failed",
        message: normalizedText(error instanceof Error ? error.message : String(error), 1_000),
      });
    } finally {
      if (!this.terminal) this.schedulePoll(this.options.pollIntervalMs);
    }
  }

  private executionPath(): string {
    return `${this.options.manifest.endpoints.executions}/${encodeURIComponent(this.remoteExecutionId!)}`;
  }

  private clearPoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private capability<K extends "steering" | "pause" | "resume" | "checkpointAwareness">(
    key: K,
  ): GenericAgentManifest["capabilities"][K] {
    return this.options.manifest.capabilities[key];
  }

  private sessionFields(): { providerSessionId?: string } {
    return this.providerSessionId ? { providerSessionId: this.providerSessionId } : {};
  }
}

export function normalizeEnvelope(
  envelope: GenericObservationEnvelope,
): ProviderObservationInput {
  const data = envelope.data;
  switch (envelope.kind) {
    case "status":
      return {
        kind: "status",
        status: enumValue(data.status, [
          "starting", "started", "turn_started", "turn_completed", "paused",
          "resumed", "completed", "cancelled", "timed_out", "crashed",
        ]),
        ...(typeof data.providerSessionId === "string"
          ? { providerSessionId: data.providerSessionId }
          : {}),
        ...(typeof data.processId === "number" || data.processId === null
          ? { processId: data.processId }
          : {}),
      };
    case "output":
      return {
        kind: "output",
        channel: enumValue(data.channel, ["analysis", "commentary", "final"]),
        text: normalizedText(data.text),
      };
    case "tool":
      return {
        kind: "tool",
        phase: enumValue(data.phase, ["started", "completed"]),
        name: requiredString(data.name, "tool.name"),
        callId: requiredString(data.callId, "tool.callId"),
        ...(data.input !== undefined ? { input: normalizedText(data.input) } : {}),
        ...(data.output !== undefined ? { output: normalizedText(data.output) } : {}),
        ...(typeof data.exitCode === "number" || data.exitCode === null
          ? { exitCode: data.exitCode }
          : {}),
      };
    case "workspace":
      return {
        kind: "workspace",
        workspaceId: requiredString(data.workspaceId, "workspace.workspaceId"),
        repositoryPath: requiredString(
          data.repositoryPath,
          "workspace.repositoryPath",
        ),
        repositoryUrl:
          typeof data.repositoryUrl === "string" ? data.repositoryUrl : null,
        baseRef: typeof data.baseRef === "string" ? data.baseRef : null,
        branch: requiredString(data.branch, "workspace.branch"),
        parentWorkspaceId:
          typeof data.parentWorkspaceId === "string"
            ? data.parentWorkspaceId
            : null,
        parentCheckpoint:
          typeof data.parentCheckpoint === "string"
            ? data.parentCheckpoint
            : null,
      };
    case "usage":
      return {
        kind: "usage",
        inputTokens: safeUsage(data.inputTokens),
        cachedInputTokens: safeUsage(data.cachedInputTokens),
        outputTokens: safeUsage(data.outputTokens),
        reasoningOutputTokens: safeUsage(data.reasoningOutputTokens),
      };
    case "cursor":
      return {
        kind: "cursor",
        cursor: requiredString(data.cursor, "cursor.cursor"),
      };
    case "warning":
    case "error":
      return {
        kind: envelope.kind,
        code: requiredString(data.code, `${envelope.kind}.code`),
        message: normalizedText(data.message, 4_096),
      };
    case "steering":
      return {
        kind: "steering",
        commandId: requiredString(data.commandId, "steering.commandId"),
        state: enumValue(data.state, ["queued", "delivered", "rejected"]),
        model: enumValue(data.model, ["interactive", "continuation"]),
        ...(typeof data.reason === "string" ? { reason: data.reason } : {}),
      };
    case "terminal":
      return {
        kind: "terminal",
        phase: enumValue(data.phase, ["started", "stdout", "stderr", "completed"]),
        commandId: requiredString(data.commandId, "terminal.commandId"),
        ...(typeof data.executable === "string" ? { executable: data.executable } : {}),
        ...(Array.isArray(data.args) && data.args.every((item) => typeof item === "string")
          ? { args: data.args as string[] }
          : {}),
        ...(typeof data.chunk === "string" ? { chunk: normalizedText(data.chunk) } : {}),
        ...(typeof data.exitCode === "number" || data.exitCode === null ? { exitCode: data.exitCode } : {}),
        ...(typeof data.durationMs === "number" ? { durationMs: data.durationMs } : {}),
      };
    case "filesystem":
      return {
        kind: "filesystem",
        commandId: requiredString(data.commandId, "filesystem.commandId"),
        changes: fileChanges(data.changes),
      };
    case "git_diff":
      return {
        kind: "git_diff",
        commandId: requiredString(data.commandId, "git_diff.commandId"),
        patch: normalizedText(data.patch),
        files: fileChanges(data.files),
      };
    case "artifact":
      return {
        kind: "artifact",
        mediaType: requiredString(data.mediaType, "artifact.mediaType"),
        name: requiredString(data.name, "artifact.name"),
        bytes: Uint8Array.from(Buffer.from(requiredString(data.base64, "artifact.base64"), "base64")),
      };
    case "checkpoint":
      return {
        kind: "checkpoint",
        action: enumValue(data.action, ["created", "restored"]),
        checkpointId: requiredString(data.checkpointId, "checkpoint.id"),
        commitHash: requiredString(data.commitHash, "checkpoint.commitHash"),
        parentCommitHash: typeof data.parentCommitHash === "string" ? data.parentCommitHash : null,
        parentCheckpointId: typeof data.parentCheckpointId === "string" ? data.parentCheckpointId : null,
        summary: requiredString(data.summary, "checkpoint.summary"),
        createdAt: requiredString(data.createdAt, "checkpoint.createdAt"),
        branch: requiredString(data.branch, "checkpoint.branch"),
        clean: data.clean === true,
      };
  }
}

async function requestJson(
  options: ResolvedOptions,
  path: string,
  init: RequestInit,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs);
  timeout.unref();
  try {
    const response = await options.fetch(`${options.baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...init.headers,
      },
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Generic provider ${response.status}: ${normalizedText(body, 500)}`);
    }
    return body ? JSON.parse(body) : {};
  } finally {
    clearTimeout(timeout);
  }
}

function fileChanges(value: unknown) {
  if (!Array.isArray(value)) throw new Error("Expected file change array");
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Invalid file change");
    }
    const item = raw as Record<string, unknown>;
    return {
      kind: enumValue(item.kind, ["created", "modified", "deleted", "renamed"]),
      path: requiredString(item.path, "file.path"),
      ...(typeof item.previousPath === "string" ? { previousPath: item.previousPath } : {}),
    };
  });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Missing ${field}`);
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`Expected one of ${allowed.join(", ")}`);
  }
  return value;
}

function validateInstruction(value: string): string {
  const instruction = value.trim();
  if (!instruction) throw new Error("Instruction cannot be empty");
  if (new TextEncoder().encode(instruction).byteLength > 32 * 1024) {
    throw new Error("Instruction exceeds 32 KiB");
  }
  return instruction;
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < minimum || result > maximum) {
    throw new Error(`Value must be between ${minimum} and ${maximum}`);
  }
  return Math.floor(result);
}
