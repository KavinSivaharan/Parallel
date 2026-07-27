import {
  BufferedProviderExecution,
  BoundedProviderEventKeys,
  IdempotentSteeringReceipts,
  defineCapabilities,
  normalizedText,
  type AgentProvider,
  type CreateExecutionRequest,
  type ProviderReadiness,
  type SteeringReceipt,
} from "@parallel/provider-sdk";

export interface DevinProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  organizationId?: string;
  defaultRepos?: string[];
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
}

interface ResolvedOptions {
  baseUrl: string;
  apiKey: string | null;
  organizationId: string | null;
  defaultRepos: string[];
  pollIntervalMs: number;
  requestTimeoutMs: number;
  fetch: typeof fetch;
}

export class DevinProvider implements AgentProvider {
  readonly id = "devin";
  readonly metadata = {
    id: this.id,
    displayName: "Devin",
    adapterVersion: "1.0.0",
    providerVersion: "API v3",
  };
  readonly capabilities = defineCapabilities({
    schemaVersion: 1,
    startExecution: true,
    steering: "interactive",
    interactiveInput: true,
    pause: "none",
    resume: "continuation",
    cancel: true,
    persistentConversation: true,
    reconnect: "cursor_replay",
    checkpointAwareness: "none",
    shellExecution: true,
    filesystemEvents: false,
    artifactOutput: false,
    toolCallVisibility: "text_only",
    structuredEventOutput: true,
    usageReporting: false,
    workspaceOwnership: "provider",
    concurrentExecutions: true,
  });
  private readonly options: ResolvedOptions;

  constructor(options: DevinProviderOptions = {}) {
    this.options = {
      baseUrl: (options.baseUrl ?? process.env.DEVIN_BASE_URL ?? "https://api.devin.ai/v3").replace(/\/$/, ""),
      apiKey: options.apiKey ?? process.env.DEVIN_API_KEY ?? null,
      organizationId: options.organizationId ?? process.env.DEVIN_ORG_ID ?? null,
      defaultRepos: options.defaultRepos ?? csv(process.env.DEVIN_DEFAULT_REPOS),
      pollIntervalMs: bounded(options.pollIntervalMs, 2_000, 50, 60_000),
      requestTimeoutMs: bounded(options.requestTimeoutMs, 10_000, 500, 60_000),
      fetch: options.fetch ?? globalThis.fetch,
    };
  }

  async readiness(): Promise<ProviderReadiness> {
    const checkedAt = new Date().toISOString();
    if (!this.options.apiKey || !this.options.organizationId) {
      return {
        status: "misconfigured",
        checkedAt,
        executable: null,
        providerVersion: this.metadata.providerVersion,
        authentication: "missing",
        diagnostics: ["Set DEVIN_API_KEY and DEVIN_ORG_ID for a v3 service user"],
      };
    }
    try {
      await requestJson(this.options, "/self", { method: "GET" });
      return {
        status: "ready",
        checkedAt,
        executable: null,
        providerVersion: this.metadata.providerVersion,
        authentication: "ready",
        diagnostics: ["Devin v3 service-user authentication verified"],
      };
    } catch (error) {
      return {
        status: "misconfigured",
        checkedAt,
        executable: null,
        providerVersion: this.metadata.providerVersion,
        authentication: "missing",
        diagnostics: [normalizedText(error instanceof Error ? error.message : String(error), 500)],
      };
    }
  }

  async createExecution(request: CreateExecutionRequest) {
    const repositories = unique([
      ...(request.repositoryUrl ? [validateRepository(request.repositoryUrl)] : []),
      ...this.options.defaultRepos.map(validateRepository),
    ]);
    if (repositories.length === 0) {
      throw new Error(
        "Devin requires a connected Git repository URL via repositoryUrl or DEVIN_DEFAULT_REPOS",
      );
    }
    if (!this.options.apiKey || !this.options.organizationId) {
      throw new Error("Devin is not configured; set DEVIN_API_KEY and DEVIN_ORG_ID");
    }
    return new DevinExecution(this.options, request, repositories);
  }
}

class DevinExecution extends BufferedProviderExecution {
  private readonly receipts = new IdempotentSteeringReceipts();
  private readonly seenMessages = new BoundedProviderEventKeys();
  private providerSessionId: string | null;
  private messageCursor: string | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private terminal = false;
  private lastStatus = "";

  constructor(
    private readonly options: ResolvedOptions,
    private readonly request: CreateExecutionRequest,
    private readonly repositories: string[],
  ) {
    super(`devin-${request.branchId}`, request.observationSequence ?? 1);
    this.providerSessionId = request.recovery?.providerSessionId ?? null;
    this.messageCursor = request.recovery?.cursor ?? null;
  }

  async start(): Promise<void> {
    if (!this.providerSessionId) {
      this.emit({ kind: "status", status: "starting" });
      const created = await requestJson(this.options, this.sessionsPath(), {
        method: "POST",
        body: JSON.stringify({
          prompt: this.request.initialInstruction,
          repos: this.repositories,
          tags: ["parallel", `parallel-branch:${this.request.branchId}`],
          title: `Parallel ${this.request.branchId}`,
        }),
      });
      this.providerSessionId = requiredString(created.session_id, "session_id");
    }
    this.emit({
      kind: "workspace",
      workspaceId: this.request.branchId,
      repositoryPath: `provider://devin/${this.providerSessionId}`,
      repositoryUrl: this.repositories[0] ?? null,
      baseRef: this.request.baseRef ?? null,
      branch: this.request.branchId,
      parentWorkspaceId: this.request.parentWorkspaceId ?? null,
      parentCheckpoint: this.request.parentCheckpoint ?? null,
    }, `workspace:${this.providerSessionId}`);
    this.emit({
      kind: "status",
      status: "started",
      providerSessionId: this.providerSessionId,
    }, `execution:${this.providerSessionId}:started`);
    this.schedulePoll(0);
  }

  async steer(instruction: string, idempotencyKey: string): Promise<SteeringReceipt> {
    const existing = this.receipts.get(idempotencyKey);
    if (existing) return existing;
    if (this.terminal || !this.providerSessionId) {
      const receipt = this.receipts.remember(idempotencyKey, {
        state: "rejected",
        model: "interactive",
        providerExecutionId: this.id,
        reason: this.terminal ? "Devin session terminated" : "Devin session not started",
      });
      this.emit({
        kind: "steering",
        commandId: idempotencyKey,
        state: "rejected",
        model: "interactive",
        ...(receipt.reason ? { reason: receipt.reason } : {}),
      });
      return receipt;
    }
    await requestJson(this.options, `${this.sessionPath()}/messages`, {
      method: "POST",
      body: JSON.stringify({ message: validateInstruction(instruction) }),
    });
    const receipt = this.receipts.remember(idempotencyKey, {
      state: "accepted",
      model: "interactive",
      providerExecutionId: this.id,
    });
    this.emit({ kind: "steering", commandId: idempotencyKey, state: "delivered", model: "interactive" });
    this.schedulePoll(0);
    return receipt;
  }

  async executeCommand(): Promise<void> {
    throw new Error("Devin owns its remote tool execution");
  }

  async pause(_reason: string): Promise<{ cursor: string | null }> {
    throw new Error("Devin v3 does not expose a reversible pause operation");
  }

  async resume(_cursor: string | null): Promise<void> {
    if (this.terminal) throw new Error("Terminated Devin session cannot resume");
    if (!this.providerSessionId) throw new Error("Devin session not started");
    await requestJson(this.options, `${this.sessionPath()}/messages`, {
      method: "POST",
      body: JSON.stringify({ message: "Continue the current task." }),
    });
    this.emit({ kind: "status", status: "resumed", providerSessionId: this.providerSessionId });
    this.schedulePoll(0);
  }

  async cancel(_reason: string): Promise<void> {
    if (this.terminal) return;
    if (this.providerSessionId) {
      await requestJson(this.options, this.sessionPath(), { method: "DELETE" });
    }
    this.terminal = true;
    this.clearPoll();
    this.emit({ kind: "status", status: "cancelled", ...(this.providerSessionId ? { providerSessionId: this.providerSessionId } : {}) });
  }

  async checkpoint(_summary?: string): Promise<{ providerState: string }> {
    return {
      providerState: JSON.stringify({
        providerSessionId: this.providerSessionId,
        workspaceOwnership: "provider",
      }),
    };
  }

  async restore(_checkpointId: string, _idempotencyKey: string): Promise<void> {
    throw new Error("Devin does not expose checkpoint restore through API v3");
  }

  override async dispose(): Promise<void> {
    this.clearPoll();
    this.closeObservations();
  }

  private schedulePoll(delay: number): void {
    if (this.terminal || this.pollTimer || this.polling) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, delay);
    this.pollTimer.unref();
  }

  private async poll(): Promise<void> {
    if (this.terminal || !this.providerSessionId || this.polling) return;
    this.polling = true;
    try {
      const [session, messages] = await Promise.all([
        requestJson(this.options, this.sessionPath(), { method: "GET" }),
        requestJson(
          this.options,
          `${this.sessionPath()}/messages?first=100${this.messageCursor ? `&after=${encodeURIComponent(this.messageCursor)}` : ""}`,
          { method: "GET" },
        ),
      ]);
      this.consumeMessages(messages);
      this.consumeStatus(session);
    } catch (error) {
      this.emit({
        kind: "warning",
        code: "devin_poll_failed",
        message: normalizedText(error instanceof Error ? error.message : String(error), 1_000),
      });
    } finally {
      this.polling = false;
      if (!this.terminal) this.schedulePoll(this.options.pollIntervalMs);
    }
  }

  private consumeMessages(response: Record<string, unknown>): void {
    const items = Array.isArray(response.items) ? response.items : [];
    for (const raw of items) {
      const item = asRecord(raw);
      if (!item) continue;
      const eventId = requiredString(item.event_id, "message.event_id");
      if (!this.seenMessages.accept(eventId)) continue;
      if (item.source === "devin" && typeof item.message === "string") {
        this.emit(
          { kind: "output", channel: "final", text: normalizedText(item.message) },
          `message:${eventId}`,
        );
      }
    }
    if (
      typeof response.end_cursor === "string" &&
      response.end_cursor !== this.messageCursor
    ) {
      this.messageCursor = response.end_cursor;
      this.emit(
        { kind: "cursor", cursor: response.end_cursor },
        `cursor:${response.end_cursor}`,
      );
    }
  }

  private consumeStatus(session: Record<string, unknown>): void {
    const status = requiredString(session.status, "status");
    const detail = typeof session.status_detail === "string" ? session.status_detail : "";
    const key = `${status}:${detail}`;
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    if (status === "running" && detail !== "finished") {
      this.emit(
        { kind: "status", status: "turn_started", providerSessionId: this.providerSessionId! },
        `status:${this.providerSessionId}:${key}`,
      );
    } else if (status === "exit" || detail === "finished") {
      this.emit(
        { kind: "status", status: "turn_completed", providerSessionId: this.providerSessionId! },
        `status:${this.providerSessionId}:${key}:turn`,
      );
      this.emit(
        { kind: "status", status: "completed", providerSessionId: this.providerSessionId! },
        `status:${this.providerSessionId}:${key}:execution`,
      );
      this.terminal = true;
      this.clearPoll();
    } else if (status === "error") {
      this.emit(
        { kind: "error", code: "devin_session_error", message: detail || "Devin session failed" },
        `status:${this.providerSessionId}:${key}:error`,
      );
      this.emit(
        { kind: "status", status: "crashed", providerSessionId: this.providerSessionId! },
        `status:${this.providerSessionId}:${key}:crashed`,
      );
      this.terminal = true;
      this.clearPoll();
    } else if (status === "suspended") {
      this.emit(
        { kind: "status", status: "paused", providerSessionId: this.providerSessionId! },
        `status:${this.providerSessionId}:${key}`,
      );
    }
  }

  private sessionsPath(): string {
    return `/organizations/${encodeURIComponent(this.options.organizationId!)}/sessions`;
  }

  private sessionPath(): string {
    return `${this.sessionsPath()}/${encodeURIComponent(this.providerSessionId!)}`;
  }

  private clearPoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }
}

async function requestJson(
  options: ResolvedOptions,
  path: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs);
  timeout.unref();
  try {
    const response = await options.fetch(`${options.baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${options.apiKey ?? ""}`,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Devin API ${response.status}: ${normalizedText(body, 500)}`);
    }
    if (!body) return {};
    const parsed = JSON.parse(body) as unknown;
    const record = asRecord(parsed);
    if (!record) throw new Error("Devin API returned a non-object response");
    return record;
  } finally {
    clearTimeout(timeout);
  }
}

function validateRepository(value: string): string {
  const repository = value.trim();
  if (
    !repository.startsWith("https://") &&
    !repository.startsWith("http://") &&
    !repository.startsWith("git@")
  ) {
    throw new Error("Devin repositories must be remote Git URLs");
  }
  return repository;
}

function validateInstruction(value: string): string {
  const instruction = value.trim();
  if (!instruction) throw new Error("Instruction cannot be empty");
  if (new TextEncoder().encode(instruction).byteLength > 32 * 1024) {
    throw new Error("Instruction exceeds 32 KiB");
  }
  return instruction;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Missing Devin ${field}`);
  return value;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function csv(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < minimum || result > maximum) {
    throw new Error(`Value must be between ${minimum} and ${maximum}`);
  }
  return Math.floor(result);
}
