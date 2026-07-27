import {
  defineCapabilities,
  type AgentProvider,
  type CreateExecutionRequest,
  type ProviderCapabilities,
  type ProviderExecution,
  type ProviderObservation,
  type ProviderReadiness,
  type SteeringReceipt,
} from "@parallel/provider-sdk";
import {
  GitClient,
  WorkspaceManager,
  type WorkspaceMetadata,
} from "@parallel/workspace-runtime";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Readable } from "node:stream";
import { parseCodexEvent, type CodexJsonEvent } from "./codex-events.js";
import {
  providerEnvironment,
  redactProviderText,
  truncateUtf8,
} from "./security.js";

type ObservationInput<T> = T extends unknown ? Omit<T, "id" | "sequence"> : never;
type ProviderObservationInput = ObservationInput<ProviderObservation>;

export interface CodexProviderOptions {
  executable?: string;
  executableArgsPrefix?: string[];
  maxExecutionMs?: number;
  maxEventBytes?: number;
  maxOutputBytes?: number;
  maxArtifactBytes?: number;
  maxQueuedSteering?: number;
}

interface ResolvedOptions {
  executable: string;
  executableArgsPrefix: string[];
  maxExecutionMs: number;
  maxEventBytes: number;
  maxOutputBytes: number;
  maxArtifactBytes: number;
  maxQueuedSteering: number;
}

interface QueuedSteering {
  commandId: string;
  instruction: string;
}

type RunningChild = ChildProcessByStdio<null, Readable, Readable>;

const capabilities: ProviderCapabilities = defineCapabilities({
  schemaVersion: 1,
  startExecution: true,
  steering: "continuation",
  interactiveInput: false,
  pause: "interrupt_current",
  resume: "continuation",
  cancel: true,
  persistentConversation: true,
  reconnect: "workspace_only",
  checkpointAwareness: "workspace",
  shellExecution: true,
  filesystemEvents: true,
  artifactOutput: true,
  toolCallVisibility: "structured",
  structuredEventOutput: true,
  usageReporting: true,
  workspaceOwnership: "parallel",
  concurrentExecutions: true,
});

export class CodexProvider implements AgentProvider {
  readonly id = "codex";
  readonly metadata = {
    id: this.id,
    displayName: "OpenAI Codex CLI",
    adapterVersion: "1.0.0",
    providerVersion: null,
  };
  readonly capabilities = capabilities;
  private readonly options: ResolvedOptions;

  constructor(
    private readonly workspaces: WorkspaceManager,
    options: CodexProviderOptions = {},
  ) {
    this.options = {
      executable: options.executable ?? process.env.CODEX_EXECUTABLE ?? "codex",
      executableArgsPrefix: options.executableArgsPrefix ?? [],
      maxExecutionMs: bounded(options.maxExecutionMs, 15 * 60_000, 1_000, 60 * 60_000),
      maxEventBytes: bounded(options.maxEventBytes, 256 * 1024, 1_024, 2 * 1024 * 1024),
      maxOutputBytes: bounded(options.maxOutputBytes, 2 * 1024 * 1024, 16 * 1024, 16 * 1024 * 1024),
      maxArtifactBytes: bounded(options.maxArtifactBytes, 5 * 1024 * 1024, 16 * 1024, 32 * 1024 * 1024),
      maxQueuedSteering: bounded(options.maxQueuedSteering, 100, 1, 1_000),
    };
  }

  async readiness(): Promise<ProviderReadiness> {
    const checkedAt = new Date().toISOString();
    try {
      const version = await probe(
        this.options,
        ["--version"],
        5_000,
      );
      const login = await probe(
        this.options,
        ["login", "status"],
        5_000,
      );
      const authenticated = login.exitCode === 0 && /logged in/i.test(login.output);
      return {
        status: version.exitCode === 0 && authenticated ? "ready" : "misconfigured",
        checkedAt,
        executable: basename(this.options.executable),
        providerVersion: version.output.trim().slice(0, 200) || null,
        authentication: authenticated ? "ready" : "missing",
        diagnostics: [
          version.exitCode === 0 ? "Codex CLI discovered" : "Codex CLI version probe failed",
          authenticated ? "Codex authentication is available" : "Run `codex login` on the API host",
          "Trusted local execution boundary; Codex runs with workspace-write access",
        ],
      };
    } catch (error) {
      return {
        status: "unavailable",
        checkedAt,
        executable: basename(this.options.executable),
        providerVersion: null,
        authentication: "unknown",
        diagnostics: [
          redactProviderText(error instanceof Error ? error.message : String(error), 500),
        ],
      };
    }
  }

  async createExecution(request: CreateExecutionRequest): Promise<ProviderExecution> {
    const workspace =
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
    return new CodexExecution({
      id: `codex-${request.branchId}`,
      workspace,
      initialInstruction: request.initialInstruction,
      initialSequence: request.observationSequence ?? 1,
      workspaces: this.workspaces,
      options: this.options,
      recovery: request.recovery,
    });
  }
}

class CodexExecution implements ProviderExecution {
  readonly id: string;
  private readonly queue: ProviderObservation[] = [];
  private readonly waiters: Array<() => void> = [];
  private readonly receipts = new Map<string, SteeringReceipt>();
  private readonly steeringQueue: QueuedSteering[] = [];
  private readonly workspace: WorkspaceMetadata;
  private readonly initialInstruction: string;
  private readonly workspaces: WorkspaceManager;
  private readonly options: ResolvedOptions;
  private sequence: number;
  private disposed = false;
  private started = false;
  private terminal = false;
  private paused = false;
  private running = false;
  private activeChild: RunningChild | null = null;
  private activeTermination: "pause" | "cancel" | "dispose" | "timeout" | null = null;
  private providerSessionId: string | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private readonly recovery: CreateExecutionRequest["recovery"];

  constructor(input: {
    id: string;
    workspace: WorkspaceMetadata;
    initialInstruction: string;
    initialSequence: number;
    workspaces: WorkspaceManager;
    options: ResolvedOptions;
    recovery?: CreateExecutionRequest["recovery"];
  }) {
    this.id = input.id;
    this.workspace = input.workspace;
    this.initialInstruction = validateInstruction(input.initialInstruction);
    this.sequence = input.initialSequence;
    this.workspaces = input.workspaces;
    this.options = input.options;
    this.recovery = input.recovery;
    this.providerSessionId = input.recovery?.providerSessionId ?? null;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.push({
      kind: "workspace",
      workspaceId: this.workspace.id,
      repositoryPath: this.workspace.repositoryPath,
      repositoryUrl: this.workspace.repositoryUrl,
      baseRef: this.workspace.baseRef,
      branch: this.workspace.branch,
      parentWorkspaceId: this.workspace.parentWorkspaceId,
      parentCheckpoint: this.workspace.parentCheckpoint,
    });
    if (this.recovery) {
      this.push({
        kind: "status",
        status: "started",
        ...this.sessionFields(),
      });
      this.paused = this.recovery.state === "paused";
      this.push({
        kind: "status",
        status: this.paused ? "paused" : "completed",
        ...this.sessionFields(),
      });
      return;
    }
    this.push({ kind: "status", status: "starting" });
    this.enqueueTurn(this.initialInstruction, null);
  }

  async steer(instruction: string, idempotencyKey: string): Promise<SteeringReceipt> {
    const existing = this.receipts.get(idempotencyKey);
    if (existing) return existing;
    if (this.terminal || this.disposed) {
      const receipt: SteeringReceipt = {
        state: "rejected",
        model: "continuation",
        providerExecutionId: this.id,
        reason: "Execution is cancelled",
      };
      this.receipts.set(idempotencyKey, receipt);
      this.push({
        kind: "steering",
        commandId: idempotencyKey,
        state: "rejected",
        model: "continuation",
        reason: "Execution is cancelled",
      });
      return receipt;
    }
    if (this.steeringQueue.length >= this.options.maxQueuedSteering) {
      const receipt: SteeringReceipt = {
        state: "rejected",
        model: "continuation",
        providerExecutionId: this.id,
        reason: "Steering queue limit reached",
      };
      this.receipts.set(idempotencyKey, receipt);
      this.push({
        kind: "steering",
        commandId: idempotencyKey,
        state: "rejected",
        model: "continuation",
        reason: "Steering queue limit reached",
      });
      return receipt;
    }
    const receipt: SteeringReceipt = {
      state: "queued",
      model: "continuation",
      providerExecutionId: this.id,
    };
    this.receipts.set(idempotencyKey, receipt);
    this.steeringQueue.push({
      commandId: idempotencyKey,
      instruction: validateInstruction(instruction),
    });
    this.push({
      kind: "steering",
      commandId: idempotencyKey,
      state: "queued",
      model: "continuation",
    });
    this.scheduleNextSteering();
    return receipt;
  }

  async executeCommand(): Promise<void> {
    throw new Error(
      "Codex owns tool execution; use natural-language steering or the local-workspace provider",
    );
  }

  async pause(reason: string): Promise<{ cursor: string | null }> {
    if (this.terminal) return { cursor: this.providerSessionId };
    this.paused = true;
    this.activeTermination = "pause";
    terminate(this.activeChild);
    this.push({
      kind: "warning",
      code: "provider_pause_requested",
      message: redactProviderText(reason, 500),
    });
    if (!this.running) this.push({ kind: "status", status: "paused" });
    return { cursor: this.providerSessionId };
  }

  async resume(cursor: string | null): Promise<void> {
    if (this.terminal) throw new Error("Cancelled Codex execution cannot be resumed");
    if (!this.providerSessionId && cursor) this.providerSessionId = cursor;
    this.paused = false;
    this.activeTermination = null;
    this.push({ kind: "status", status: "resumed", ...this.sessionFields() });
    if (!this.running) {
      const next = this.steeringQueue.shift();
      this.enqueueTurn(
        next?.instruction ?? "Continue from where the previous turn was interrupted.",
        next?.commandId ?? null,
      );
    }
  }

  async cancel(reason: string): Promise<void> {
    if (this.terminal) return;
    this.terminal = true;
    this.activeTermination = "cancel";
    terminate(this.activeChild);
    this.push({
      kind: "warning",
      code: "provider_cancel_requested",
      message: redactProviderText(reason, 500),
    });
    if (!this.running) this.push({ kind: "status", status: "cancelled" });
  }

  async checkpoint(summary?: string): Promise<{ providerState: string }> {
    const checkpoint = await this.workspaces.checkpoint(
      this.workspace.id,
      summary ?? `Codex checkpoint ${new Date().toISOString()}`,
    );
    this.push({
      kind: "checkpoint",
      action: "created",
      checkpointId: checkpoint.id,
      commitHash: checkpoint.commitHash,
      parentCommitHash: checkpoint.parentCommitHash,
      parentCheckpointId: checkpoint.parentCheckpointId,
      summary: checkpoint.summary,
      createdAt: checkpoint.createdAt,
      branch: checkpoint.branch,
      clean: checkpoint.clean,
    });
    return {
      providerState: JSON.stringify({
        providerSessionId: this.providerSessionId,
        checkpointId: checkpoint.id,
      }),
    };
  }

  async restore(checkpointId: string, idempotencyKey: string): Promise<void> {
    if (this.receipts.has(`restore:${idempotencyKey}`)) return;
    this.receipts.set(`restore:${idempotencyKey}`, {
      state: "accepted",
      model: "continuation",
      providerExecutionId: this.id,
    });
    const checkpoint = await this.workspaces.restore(this.workspace.id, checkpointId);
    this.push({
      kind: "checkpoint",
      action: "restored",
      checkpointId: checkpoint.id,
      commitHash: checkpoint.commitHash,
      parentCommitHash: checkpoint.parentCommitHash,
      parentCheckpointId: checkpoint.parentCheckpointId,
      summary: checkpoint.summary,
      createdAt: checkpoint.createdAt,
      branch: checkpoint.branch,
      clean: checkpoint.clean,
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.activeTermination = "dispose";
    terminate(this.activeChild);
    await this.operationTail;
    this.disposed = true;
    this.wake();
  }

  async *observations(): AsyncIterable<ProviderObservation> {
    while (!this.disposed || this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) yield next;
      else await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private enqueueTurn(instruction: string, steeringCommandId: string | null): void {
    this.operationTail = this.operationTail
      .then(async () => {
        if (this.terminal || this.paused || this.disposed) return;
        await this.runTurn(instruction, steeringCommandId);
      })
      .catch((error: unknown) => {
        this.push({
          kind: "error",
          code: "codex_adapter_failure",
          message: redactProviderText(error instanceof Error ? error.message : String(error)),
        });
        this.push({ kind: "status", status: "crashed", ...this.sessionFields() });
      });
  }

  private scheduleNextSteering(): void {
    if (this.running || this.paused || this.terminal || !this.started || !this.providerSessionId) return;
    const next = this.steeringQueue.shift();
    if (next) this.enqueueTurn(next.instruction, next.commandId);
  }

  private async runTurn(instruction: string, steeringCommandId: string | null): Promise<void> {
    this.running = true;
    this.activeTermination = null;
    let sawTurnCompletion = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let observedOutputBytes = 0;
    let outputLimitWarned = false;
    const finalMessages: string[] = [];
    const seenProviderEvents = new Set<string>();
    const args = this.codexArguments(instruction);
    const child = spawn(this.options.executable, [...this.options.executableArgsPrefix, ...args], {
      cwd: this.workspace.repositoryPath,
      env: providerEnvironment(process.env),
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.activeChild = child;
    this.push({
      kind: "status",
      status: "turn_started",
      ...this.sessionFields(),
      processId: child.pid ?? null,
    });
    if (steeringCommandId) {
      this.push({
        kind: "steering",
        commandId: steeringCommandId,
        state: "delivered",
        model: "continuation",
      });
    }

    const consumeLine = (line: string): void => {
      if (!line.trim()) return;
      if (Buffer.byteLength(line) > this.options.maxEventBytes) {
        this.push({
          kind: "warning",
          code: "codex_event_too_large",
          message: `Dropped Codex event larger than ${this.options.maxEventBytes} bytes`,
        });
        return;
      }
      try {
        const event = parseCodexEvent(line);
        const eventIdentity = providerEventIdentity(event);
        if (eventIdentity && seenProviderEvents.has(eventIdentity)) return;
        if (eventIdentity) seenProviderEvents.add(eventIdentity);
        if (event.type === "turn.completed") sawTurnCompletion = true;
        const remainingBytes = Math.max(
          0,
          this.options.maxOutputBytes - observedOutputBytes,
        );
        const output = this.consumeCodexEvent(event, finalMessages, remainingBytes);
        observedOutputBytes += output;
        if (observedOutputBytes > this.options.maxOutputBytes && !outputLimitWarned) {
          outputLimitWarned = true;
          this.push({
            kind: "warning",
            code: "codex_output_limit_reached",
            message: `Provider output exceeded ${this.options.maxOutputBytes} bytes; later text was truncated`,
          });
        }
      } catch (error) {
        this.push({
          kind: "warning",
          code: "codex_malformed_event",
          message: redactProviderText(error instanceof Error ? error.message : String(error), 500),
        });
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
    });
    child.stderr.on("data", (chunk: string) => {
      stderrBuffer += chunk;
      if (Buffer.byteLength(stderrBuffer) > this.options.maxOutputBytes) {
        stderrBuffer = truncateUtf8(stderrBuffer, this.options.maxOutputBytes);
      }
    });

    const processState: { spawnError: string | null } = { spawnError: null };
    child.once("error", (error) => { processState.spawnError = error.message; });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      this.activeTermination = "timeout";
      terminate(child);
    }, this.options.maxExecutionMs);
    timeout.unref();
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => child.once("close", (code, signal) => resolve({ code, signal })),
    );
    clearTimeout(timeout);
    if (stdoutBuffer.trim()) consumeLine(stdoutBuffer);
    if (stderrBuffer.trim()) {
      this.push({
        kind: "warning",
        code: "codex_stderr",
        message: redactProviderText(stderrBuffer),
      });
    }
    this.activeChild = null;
    this.running = false;

    if (this.activeTermination === "pause") {
      this.push({ kind: "status", status: "paused", ...this.sessionFields() });
      return;
    }
    if (this.activeTermination === "cancel" || this.activeTermination === "dispose") {
      if (this.activeTermination === "cancel") {
        this.push({ kind: "status", status: "cancelled", ...this.sessionFields() });
      }
      return;
    }
    if (timedOut || this.activeTermination === "timeout") {
      this.push({ kind: "status", status: "timed_out", ...this.sessionFields() });
      return;
    }
    if (processState.spawnError || result.code !== 0 || !sawTurnCompletion) {
      this.push({
        kind: "error",
        code: processState.spawnError ? "codex_spawn_failed" : "codex_process_failed",
        message: redactProviderText(
          processState.spawnError ??
            `Codex exited with code ${String(result.code)} signal ${String(result.signal)}`,
        ),
      });
      this.push({ kind: "status", status: "crashed", ...this.sessionFields() });
      return;
    }

    await this.emitTurnArtifacts(finalMessages);
    this.push({ kind: "status", status: "turn_completed", ...this.sessionFields() });
    const next = this.steeringQueue.shift();
    if (next && !this.paused && !this.terminal) {
      await this.runTurn(next.instruction, next.commandId);
    } else {
      this.push({ kind: "status", status: "completed", ...this.sessionFields() });
    }
  }

  private codexArguments(instruction: string): string[] {
    const global = ["-a", "never", "-s", "workspace-write", "-C", this.workspace.repositoryPath];
    if (this.providerSessionId) {
      return [
        ...global,
        "exec",
        "resume",
        this.providerSessionId,
        "--json",
        "--ignore-user-config",
        "--ignore-rules",
        instruction,
      ];
    }
    return [
      ...global,
      "exec",
      "--json",
      "--ignore-user-config",
      "--ignore-rules",
      instruction,
    ];
  }

  private consumeCodexEvent(
    event: CodexJsonEvent,
    finalMessages: string[],
    remainingBytes: number,
  ): number {
    if (event.type === "thread.started") {
      const threadId = (event as { thread_id?: unknown }).thread_id;
      if (typeof threadId !== "string" || !threadId) {
        throw new Error("thread.started event did not include thread_id");
      }
      if (this.providerSessionId && this.providerSessionId !== threadId) {
        throw new Error("Codex changed thread identity during continuation");
      }
      this.providerSessionId = threadId;
      this.push({
        kind: "status",
        status: "started",
        providerSessionId: threadId,
        processId: this.activeChild?.pid ?? null,
      });
      return 0;
    }
    if (event.type === "turn.started") return 0;
    if (event.type === "turn.completed") {
      const usage = (event as {
        usage?: {
          input_tokens?: number;
          cached_input_tokens?: number;
          output_tokens?: number;
          reasoning_output_tokens?: number;
        };
      }).usage;
      if (usage) {
        this.push({
          kind: "usage",
          inputTokens: safeCount(usage.input_tokens),
          cachedInputTokens: safeCount(usage.cached_input_tokens),
          outputTokens: safeCount(usage.output_tokens),
          reasoningOutputTokens: safeCount(usage.reasoning_output_tokens),
        });
      }
      return 0;
    }
    if (event.type === "turn.failed" || event.type === "error") {
      const message =
        (event as { error?: { message?: unknown }; message?: unknown }).error?.message ??
        (event as { message?: unknown }).message ??
        "Codex reported an error";
      this.push({
        kind: "error",
        code: "codex_reported_error",
        message: redactProviderText(String(message)),
      });
      return Buffer.byteLength(String(message));
    }
    if (!["item.started", "item.updated", "item.completed"].includes(event.type)) return 0;
    const item = (event as {
      item?: {
        id?: unknown;
        type?: unknown;
        text?: unknown;
        command?: unknown;
        aggregated_output?: unknown;
        exit_code?: unknown;
        changes?: unknown;
      };
    }).item;
    if (!item || typeof item.type !== "string") return 0;
    const phase = event.type === "item.completed" ? "completed" : "started";
    const callId = typeof item.id === "string" ? item.id : `codex-item-${this.sequence}`;
    if (item.type === "command_execution") {
      const command = typeof item.command === "string" ? item.command : "";
      const output = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
      const safeCommand = redactProviderText(
        command,
        Math.min(this.options.maxEventBytes, remainingBytes),
      );
      const outputBudget = Math.max(0, remainingBytes - Buffer.byteLength(safeCommand));
      const safeOutput = redactProviderText(
        output,
        Math.min(this.options.maxEventBytes, outputBudget),
      );
      this.push({
        kind: "tool",
        phase,
        name: "shell",
        callId,
        ...(safeCommand ? { input: safeCommand } : {}),
        ...(phase === "completed" && safeOutput
          ? { output: safeOutput }
          : {}),
        ...(typeof item.exit_code === "number" ? { exitCode: item.exit_code } : {}),
      });
      return Buffer.byteLength(command) + Buffer.byteLength(output);
    }
    if (item.type === "file_change") {
      const changes = item.changes === undefined ? "" : JSON.stringify(item.changes);
      this.push({
        kind: "tool",
        phase,
        name: "file_change",
        callId,
        ...(changes ? { input: truncateUtf8(changes, this.options.maxEventBytes) } : {}),
      });
      return Buffer.byteLength(changes);
    }
    if (typeof item.text === "string" && item.text) {
      const text = redactProviderText(
        item.text,
        Math.min(this.options.maxEventBytes, remainingBytes),
      );
      if (item.type === "agent_message") {
        if (phase === "completed") {
          finalMessages.push(text);
          this.push({ kind: "output", channel: "final", text });
        }
      } else if (item.type === "reasoning" && phase === "completed") {
        this.push({ kind: "output", channel: "analysis", text });
      }
      return Buffer.byteLength(item.text);
    }
    return 0;
  }

  private async emitTurnArtifacts(finalMessages: string[]): Promise<void> {
    const git = new GitClient(this.workspace.repositoryPath);
    const [changes, patch] = await Promise.all([git.status(), git.diff()]);
    const commandId = `codex-turn-${this.sequence}`;
    if (changes.length > 0) {
      this.push({ kind: "filesystem", commandId, changes });
      const safeArtifactPatch = truncateUtf8(
        redactProviderText(patch),
        this.options.maxArtifactBytes,
      );
      this.push({
        kind: "git_diff",
        commandId,
        patch: truncateUtf8(safeArtifactPatch, this.options.maxEventBytes),
        files: changes,
      });
      await this.storeAndEmitArtifact(
        `codex-turn-${this.sequence}.patch`,
        "text/x-diff",
        safeArtifactPatch,
      );
    }
    if (finalMessages.length > 0) {
      await this.storeAndEmitArtifact(
        `codex-turn-${this.sequence}-report.md`,
        "text/markdown",
        truncateUtf8(finalMessages.join("\n\n"), this.options.maxArtifactBytes),
      );
    }
  }

  private async storeAndEmitArtifact(name: string, mediaType: string, text: string): Promise<void> {
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > this.options.maxArtifactBytes) {
      this.push({
        kind: "warning",
        code: "artifact_too_large",
        message: `Artifact ${name} exceeded ${this.options.maxArtifactBytes} bytes`,
      });
      return;
    }
    const stored = await this.workspaces.storeArtifact(
      this.workspace.id,
      name,
      mediaType,
      bytes,
    );
    const persisted = await readFile(stored.path);
    this.push({
      kind: "artifact",
      name: stored.name,
      mediaType: stored.mediaType,
      bytes: new Uint8Array(persisted),
    });
  }

  private push(input: ProviderObservationInput): void {
    const sequence = this.sequence++;
    this.queue.push({
      ...input,
      id: `${this.id}:${sequence}`,
      sequence,
      observedAt: new Date().toISOString(),
    } as ProviderObservation);
    this.wake();
  }

  private wake(): void {
    this.waiters.splice(0).forEach((resolve) => resolve());
  }

  private sessionFields(): { providerSessionId?: string } {
    return this.providerSessionId ? { providerSessionId: this.providerSessionId } : {};
  }
}

async function probe(
  options: ResolvedOptions,
  args: string[],
  timeoutMs: number,
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      options.executable,
      [...options.executableArgsPrefix, ...args],
      {
        env: providerEnvironment(process.env),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output = truncateUtf8(output + chunk, 4_096);
    });
    child.stderr.on("data", (chunk: string) => {
      output = truncateUtf8(output + chunk, 4_096);
    });
    child.once("error", reject);
    const timer = setTimeout(() => terminate(child), timeoutMs);
    timer.unref();
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, output: redactProviderText(output, 4_096) });
    });
  });
}

function terminate(child: RunningChild | null): void {
  const pid = child?.pid;
  if (!pid) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
  } catch {
    return;
  }
  const timer = setTimeout(() => {
    try {
      process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
    } catch {
      // The process already exited.
    }
  }, 2_000);
  timer.unref();
}

function bounded(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error(`Provider limit must be between ${minimum} and ${maximum}`);
  }
  return Math.floor(candidate);
}

function validateInstruction(instruction: string): string {
  if (!instruction.trim()) throw new Error("Provider instruction cannot be empty");
  if (Buffer.byteLength(instruction) > 32 * 1024) {
    throw new Error("Provider instruction exceeds 32 KiB");
  }
  if (instruction.includes("\0")) throw new Error("Provider instruction contains a null byte");
  return instruction;
}

function safeCount(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? -1) >= 0 ? Math.floor(value!) : 0;
}

function providerEventIdentity(event: CodexJsonEvent): string | null {
  if (!["item.started", "item.updated", "item.completed"].includes(event.type)) {
    return null;
  }
  const itemId = (event as { item?: { id?: unknown } }).item?.id;
  return typeof itemId === "string" ? `${event.type}:${itemId}` : null;
}
