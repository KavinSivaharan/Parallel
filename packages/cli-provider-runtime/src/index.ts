import {
  BufferedProviderExecution,
  BoundedProviderEventKeys,
  IdempotentSteeringReceipts,
  normalizedError,
  normalizedText,
  type AgentProvider,
  type CreateExecutionRequest,
  type ProviderCapabilities,
  type ProviderMetadata,
  type ProviderObservationInput,
  type ProviderReadiness,
  type SteeringReceipt,
} from "@parallel/provider-sdk";
import {
  GitClient,
  WorkspaceManager,
  type WorkspaceMetadata,
} from "@parallel/workspace-runtime";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { basename } from "node:path";
import type { Readable } from "node:stream";

type RunningChild = ChildProcessByStdio<null, Readable, Readable>;

export interface CliParsedEvent {
  eventId?: string;
  providerSessionId?: string;
  observations: ProviderObservationInput[];
}

export interface CliProviderDriver {
  id: string;
  metadata: ProviderMetadata;
  capabilities: ProviderCapabilities;
  executable: string;
  executableArgsPrefix?: string[];
  versionArguments: string[];
  authenticationArguments?: string[];
  parseAuthentication?: (result: CliProbeResult) => {
    authentication: ProviderReadiness["authentication"];
    diagnostic: string;
  };
  buildArguments(input: {
    instruction: string;
    providerSessionId: string | null;
    workspace: WorkspaceMetadata;
  }): string[];
  parseEvent(line: string): CliParsedEvent;
  environment?: (source: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
}

export interface CliProviderOptions {
  maxExecutionMs?: number;
  maxEventBytes?: number;
  maxOutputBytes?: number;
  maxArtifactBytes?: number;
  maxQueuedSteering?: number;
}

interface ResolvedOptions {
  maxExecutionMs: number;
  maxEventBytes: number;
  maxOutputBytes: number;
  maxArtifactBytes: number;
  maxQueuedSteering: number;
}

interface QueuedInstruction {
  instruction: string;
  commandId: string;
}

export interface CliProbeResult {
  exitCode: number | null;
  output: string;
}

export class CliAgentProvider implements AgentProvider {
  readonly id: string;
  readonly metadata: ProviderMetadata;
  readonly capabilities: ProviderCapabilities;
  private readonly options: ResolvedOptions;

  constructor(
    private readonly driver: CliProviderDriver,
    private readonly workspaces: WorkspaceManager,
    options: CliProviderOptions = {},
  ) {
    this.id = driver.id;
    this.metadata = driver.metadata;
    this.capabilities = driver.capabilities;
    this.options = {
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
      const version = await probe(this.driver, this.driver.versionArguments, 5_000);
      if (version.exitCode !== 0) {
        return {
          status: "unavailable",
          checkedAt,
          executable: basename(this.driver.executable),
          providerVersion: null,
          authentication: "unknown",
          diagnostics: ["Provider version probe failed"],
        };
      }
      let authentication: ProviderReadiness["authentication"] = "unknown";
      const diagnostics = ["Provider executable discovered"];
      if (this.driver.authenticationArguments) {
        const auth = await probe(this.driver, this.driver.authenticationArguments, 5_000);
        const parsed = this.driver.parseAuthentication?.(auth) ?? {
          authentication: auth.exitCode === 0 ? "ready" as const : "missing" as const,
          diagnostic: auth.exitCode === 0 ? "Provider authentication configured" : "Provider authentication missing",
        };
        authentication = parsed.authentication;
        diagnostics.push(parsed.diagnostic);
      }
      return {
        status: authentication === "missing" ? "misconfigured" : "ready",
        checkedAt,
        executable: basename(this.driver.executable),
        providerVersion: normalizedText(version.output.trim(), 200) || null,
        authentication,
        diagnostics,
      };
    } catch (error) {
      return {
        status: "unavailable",
        checkedAt,
        executable: basename(this.driver.executable),
        providerVersion: null,
        authentication: "unknown",
        diagnostics: [normalizedText(error instanceof Error ? error.message : String(error), 500)],
      };
    }
  }

  async createExecution(request: CreateExecutionRequest) {
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
    return new CliExecution(
      this.driver,
      this.workspaces,
      workspace,
      request,
      this.options,
    );
  }
}

class CliExecution extends BufferedProviderExecution {
  private readonly receipts = new IdempotentSteeringReceipts();
  private readonly seenProviderEvents = new BoundedProviderEventKeys();
  private readonly steeringQueue: QueuedInstruction[] = [];
  private activeChild: RunningChild | null = null;
  private providerSessionId: string | null;
  private started = false;
  private running = false;
  private paused = false;
  private terminal = false;
  private termination: "pause" | "cancel" | "dispose" | "timeout" | null = null;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly driver: CliProviderDriver,
    private readonly workspaces: WorkspaceManager,
    private readonly workspace: WorkspaceMetadata,
    private readonly request: CreateExecutionRequest,
    private readonly options: ResolvedOptions,
  ) {
    super(`${driver.id}-${request.branchId}`, request.observationSequence ?? 1);
    this.providerSessionId = request.recovery?.providerSessionId ?? null;
    this.paused = request.recovery?.state === "paused";
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
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
    if (this.request.recovery) {
      this.emit(
        { kind: "status", status: this.paused ? "paused" : "completed", ...this.sessionFields() },
        `recovery:${this.workspace.id}:${this.paused ? "paused" : "completed"}`,
      );
      return;
    }
    this.emit({ kind: "status", status: "starting" });
    this.enqueue(this.request.initialInstruction, null);
  }

  async steer(instruction: string, idempotencyKey: string): Promise<SteeringReceipt> {
    const existing = this.receipts.get(idempotencyKey);
    if (existing) return existing;
    if (this.terminal || this.observationsClosed) {
      const rejected = this.receipts.remember(idempotencyKey, {
        state: "rejected",
        model: "continuation",
        providerExecutionId: this.id,
        reason: "Execution cancelled",
      });
      this.emit({
        kind: "steering",
        commandId: idempotencyKey,
        state: "rejected",
        model: "continuation",
        ...(rejected.reason ? { reason: rejected.reason } : {}),
      });
      return rejected;
    }
    if (this.steeringQueue.length >= this.options.maxQueuedSteering) {
      const rejected = this.receipts.remember(idempotencyKey, {
        state: "rejected",
        model: "continuation",
        providerExecutionId: this.id,
        reason: "Steering queue limit reached",
      });
      this.emit({
        kind: "steering",
        commandId: idempotencyKey,
        state: "rejected",
        model: "continuation",
        ...(rejected.reason ? { reason: rejected.reason } : {}),
      });
      return rejected;
    }
    const receipt = this.receipts.remember(idempotencyKey, {
      state: "queued",
      model: "continuation",
      providerExecutionId: this.id,
    });
    this.steeringQueue.push({ instruction: validateInstruction(instruction), commandId: idempotencyKey });
    this.emit({ kind: "steering", commandId: idempotencyKey, state: "queued", model: "continuation" });
    this.scheduleNext();
    return receipt;
  }

  async executeCommand(): Promise<void> {
    throw new Error(`${this.driver.metadata.displayName} owns tool execution`);
  }

  async pause(reason: string): Promise<{ cursor: string | null }> {
    if (this.terminal) return { cursor: this.providerSessionId };
    const activeOperation = this.operationTail;
    const wasRunning = this.running;
    this.paused = true;
    this.termination = "pause";
    terminate(this.activeChild);
    this.emit({ kind: "warning", code: `${this.driver.id}_pause_requested`, message: normalizedText(reason, 500) });
    if (wasRunning) await activeOperation;
    else this.emit({ kind: "status", status: "paused", ...this.sessionFields() });
    return { cursor: this.providerSessionId };
  }

  async resume(cursor: string | null): Promise<void> {
    if (this.terminal) throw new Error("Cancelled execution cannot resume");
    if (!this.providerSessionId && cursor) this.providerSessionId = cursor;
    this.paused = false;
    this.termination = null;
    this.emit({ kind: "status", status: "resumed", ...this.sessionFields() });
    if (!this.running) {
      const next = this.steeringQueue.shift();
      this.enqueue(
        next?.instruction ?? "Continue from where the interrupted turn stopped.",
        next?.commandId ?? null,
      );
    }
  }

  async cancel(reason: string): Promise<void> {
    if (this.terminal) return;
    this.terminal = true;
    this.termination = "cancel";
    terminate(this.activeChild);
    this.emit({ kind: "warning", code: `${this.driver.id}_cancel_requested`, message: normalizedText(reason, 500) });
    if (!this.running) this.emit({ kind: "status", status: "cancelled", ...this.sessionFields() });
  }

  async checkpoint(summary?: string): Promise<{ providerState: string }> {
    const checkpoint = await this.workspaces.checkpoint(
      this.workspace.id,
      summary ?? `${this.driver.metadata.displayName} checkpoint`,
    );
    this.emit({
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
    return { providerState: JSON.stringify({ providerSessionId: this.providerSessionId, checkpointId: checkpoint.id }) };
  }

  async restore(checkpointId: string): Promise<void> {
    const checkpoint = await this.workspaces.restore(this.workspace.id, checkpointId);
    this.emit({
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

  override async dispose(): Promise<void> {
    if (this.observationsClosed) return;
    this.termination = "dispose";
    terminate(this.activeChild);
    await this.operationTail;
    this.closeObservations();
  }

  private enqueue(instruction: string, commandId: string | null): void {
    this.operationTail = this.operationTail.then(async () => {
      if (this.terminal || this.paused || this.observationsClosed) return;
      await this.runTurn(validateInstruction(instruction), commandId);
    }).catch((error: unknown) => {
      this.emit(normalizedError(this.driver.id, error, "adapter_failure"));
      this.emit({ kind: "status", status: "crashed", ...this.sessionFields() });
    });
  }

  private scheduleNext(): void {
    if (this.running || this.paused || this.terminal || !this.started || !this.providerSessionId) return;
    const next = this.steeringQueue.shift();
    if (next) this.enqueue(next.instruction, next.commandId);
  }

  private async runTurn(instruction: string, commandId: string | null): Promise<void> {
    this.running = true;
    this.termination = null;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let observedBytes = 0;
    let outputWarning = false;
    const child = spawn(
      this.driver.executable,
      [
        ...(this.driver.executableArgsPrefix ?? []),
        ...this.driver.buildArguments({
          instruction,
          providerSessionId: this.providerSessionId,
          workspace: this.workspace,
        }),
      ],
      {
        cwd: this.workspace.repositoryPath,
        env: (this.driver.environment ?? providerEnvironment)(process.env),
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.activeChild = child;
    this.emit({ kind: "status", status: "turn_started", processId: child.pid ?? null, ...this.sessionFields() });
    if (commandId) {
      this.emit({ kind: "steering", commandId, state: "delivered", model: "continuation" });
    }

    const consumeLine = (line: string) => {
      if (!line.trim()) return;
      const rawBytes = Buffer.byteLength(line);
      if (rawBytes > this.options.maxEventBytes) {
        this.emit({ kind: "warning", code: `${this.driver.id}_event_too_large`, message: "Dropped oversized provider event" });
        return;
      }
      try {
        const parsed = this.driver.parseEvent(line);
        if (
          parsed.eventId &&
          !this.seenProviderEvents.accept(parsed.eventId)
        ) return;
        if (parsed.providerSessionId) {
          if (this.providerSessionId && this.providerSessionId !== parsed.providerSessionId) {
            throw new Error("Provider changed persistent session identity");
          }
          this.providerSessionId = parsed.providerSessionId;
          this.emit(
            { kind: "status", status: "started", providerSessionId: parsed.providerSessionId, processId: child.pid ?? null },
            parsed.eventId ? `${parsed.eventId}:session` : undefined,
          );
        }
        for (const [index, observation] of parsed.observations.entries()) {
          if (observedBytes >= this.options.maxOutputBytes) {
            if (!outputWarning) {
              outputWarning = true;
              this.emit({ kind: "warning", code: `${this.driver.id}_output_limit_reached`, message: "Later provider output was truncated" });
            }
            continue;
          }
          const serialized = JSON.stringify(observation);
          observedBytes += Buffer.byteLength(serialized);
          this.emit(
            observation,
            parsed.eventId ? `${parsed.eventId}:observation:${index}` : undefined,
          );
        }
      } catch (error) {
        this.emit({ kind: "warning", code: `${this.driver.id}_malformed_event`, message: normalizedText(error instanceof Error ? error.message : String(error), 500) });
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      lines.forEach(consumeLine);
    });
    child.stderr.on("data", (chunk: string) => {
      stderrBuffer = normalizedText(stderrBuffer + chunk, this.options.maxOutputBytes);
    });

    let spawnError: string | null = null;
    child.once("error", (error) => { spawnError = error.message; });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      this.termination = "timeout";
      terminate(child);
    }, this.options.maxExecutionMs);
    timeout.unref();
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => child.once("close", (code, signal) => resolve({ code, signal })),
    );
    clearTimeout(timeout);
    if (stdoutBuffer.trim()) consumeLine(stdoutBuffer);
    if (stderrBuffer.trim()) {
      this.emit({ kind: "warning", code: `${this.driver.id}_stderr`, message: normalizedText(stderrBuffer, this.options.maxEventBytes) });
    }
    this.activeChild = null;
    this.running = false;

    if (this.termination === "pause") {
      this.emit({ kind: "status", status: "paused", ...this.sessionFields() });
      return;
    }
    if (this.termination === "cancel" || this.termination === "dispose") {
      if (this.termination === "cancel") this.emit({ kind: "status", status: "cancelled", ...this.sessionFields() });
      return;
    }
    if (timedOut || this.termination === "timeout") {
      this.emit({ kind: "status", status: "timed_out", ...this.sessionFields() });
      return;
    }
    if (spawnError || result.code !== 0) {
      this.emit({
        kind: "error",
        code: spawnError ? `${this.driver.id}_spawn_failed` : `${this.driver.id}_process_failed`,
        message: normalizedText(spawnError ?? `Exited ${String(result.code)} (${String(result.signal)})`, 2_000),
      });
      this.emit({ kind: "status", status: "crashed", ...this.sessionFields() });
      return;
    }

    await this.emitWorkspaceArtifacts();
    this.emit({ kind: "status", status: "turn_completed", ...this.sessionFields() });
    const next = this.steeringQueue.shift();
    if (next && !this.paused && !this.terminal) await this.runTurn(next.instruction, next.commandId);
    else this.emit({ kind: "status", status: "completed", ...this.sessionFields() });
  }

  private async emitWorkspaceArtifacts(): Promise<void> {
    const git = new GitClient(this.workspace.repositoryPath);
    const [changes, patch] = await Promise.all([git.status(), git.diff()]);
    if (changes.length === 0) return;
    const commandId = `${this.driver.id}-turn`;
    this.emit({ kind: "filesystem", commandId, changes });
    this.emit({
      kind: "git_diff",
      commandId,
      patch: normalizedText(patch, this.options.maxEventBytes),
      files: changes,
    });
    const artifactText = normalizedText(patch, this.options.maxArtifactBytes);
    const bytes = new TextEncoder().encode(artifactText);
    const stored = await this.workspaces.storeArtifact(
      this.workspace.id,
      `${this.driver.id}-changes.patch`,
      "text/x-diff",
      bytes,
    );
    this.emit({ kind: "artifact", name: stored.name, mediaType: stored.mediaType, bytes });
  }

  private sessionFields(): { providerSessionId?: string } {
    return this.providerSessionId ? { providerSessionId: this.providerSessionId } : {};
  }
}

export async function probe(
  driver: CliProviderDriver,
  args: string[],
  timeoutMs: number,
): Promise<CliProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      driver.executable,
      [...(driver.executableArgsPrefix ?? []), ...args],
      {
        env: (driver.environment ?? providerEnvironment)(process.env),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output = normalizedText(output + chunk, 4_096); });
    child.stderr.on("data", (chunk: string) => { output = normalizedText(output + chunk, 4_096); });
    child.once("error", reject);
    const timer = setTimeout(() => terminate(child), timeoutMs);
    timer.unref();
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, output });
    });
  });
}

export function providerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allow = [
    "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "SHELL", "TMPDIR",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
    "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN",
    "LLM_API_KEY", "LLM_MODEL", "LLM_BASE_URL",
  ];
  return Object.fromEntries(
    allow.flatMap((name) => source[name] === undefined ? [] : [[name, source[name]]]),
  );
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
      // Process exited after SIGTERM.
    }
  }, 2_000);
  timer.unref();
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error(`Provider limit must be between ${minimum} and ${maximum}`);
  }
  return Math.floor(candidate);
}

function validateInstruction(instruction: string): string {
  const normalized = instruction.trim();
  if (!normalized) throw new Error("Instruction cannot be empty");
  if (Buffer.byteLength(normalized) > 32 * 1024) throw new Error("Instruction exceeds 32 KiB");
  if (normalized.includes("\0")) throw new Error("Instruction contains a null byte");
  return normalized;
}
