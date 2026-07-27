import type {
  AgentProvider,
  CreateExecutionRequest,
  ProviderCapabilities,
  ProviderExecution,
  ProviderObservation,
} from "@parallel/provider-sdk";
import {
  WorkspaceManager,
  type RuntimeEvent,
} from "@parallel/workspace-runtime";

type ObservationInput<T> = T extends unknown ? Omit<T, "id" | "sequence"> : never;

export class LocalWorkspaceProvider implements AgentProvider {
  readonly id = "local-workspace";
  readonly capabilities: ProviderCapabilities = {
    pause: true,
    resume: true,
    checkpoint: true,
    toolApproval: false,
    filesystemArtifacts: true,
    shellExecution: true,
  };

  constructor(private readonly workspaces: WorkspaceManager) {}

  async createExecution(request: CreateExecutionRequest): Promise<ProviderExecution> {
    const metadata =
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
    return new LocalWorkspaceExecution(
      `workspace-${request.branchId}`,
      metadata.id,
      this.workspaces,
      request.observationSequence ?? 1,
    );
  }
}

class LocalWorkspaceExecution implements ProviderExecution {
  private readonly queue: ProviderObservation[] = [];
  private readonly waiters: Array<() => void> = [];
  private readonly seen = new Set<string>();
  private sequence: number;
  private disposed = false;
  private activeAbort: AbortController | null = null;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    readonly id: string,
    private readonly workspaceId: string,
    private readonly workspaces: WorkspaceManager,
    initialSequence: number,
  ) {
    this.sequence = initialSequence;
  }

  async start(): Promise<void> {
    const workspace = await this.workspaces.metadata(this.workspaceId);
    this.push({
      kind: "workspace",
      workspaceId: workspace.id,
      repositoryPath: workspace.repositoryPath,
      repositoryUrl: workspace.repositoryUrl,
      baseRef: workspace.baseRef,
      branch: workspace.branch,
      parentWorkspaceId: workspace.parentWorkspaceId,
      parentCheckpoint: workspace.parentCheckpoint,
    });
    this.push({ kind: "status", status: "started" });
  }

  async steer(): Promise<void> {
    throw new Error("Local workspace runtime accepts structured commands, not natural-language steering");
  }

  async executeCommand(
    request: {
      executable: string;
      args?: string[];
      environment?: Record<string, string>;
      timeoutMs?: number;
    },
    idempotencyKey: string,
  ): Promise<void> {
    if (this.seen.has(idempotencyKey)) return;
    this.seen.add(idempotencyKey);
    this.enqueue(async () => {
      const controller = new AbortController();
      this.activeAbort = controller;
      let terminalLog = "";
      let terminalCommandId: string | null = null;
      try {
        for await (const event of this.workspaces.execute(
          this.workspaceId,
          request,
          controller.signal,
        )) {
          if (event.kind === "command.started") terminalCommandId = event.commandId;
          if (event.kind === "command.stdout") terminalLog += `[stdout] ${event.chunk}`;
          if (event.kind === "command.stderr") terminalLog += `[stderr] ${event.chunk}`;
          this.push(runtimeObservation(event));
          if (event.kind === "git.diff" && event.patch) {
            this.push({
              kind: "artifact",
              name: `command-${event.commandId}.patch`,
              mediaType: "text/x-diff",
              bytes: new TextEncoder().encode(event.patch),
            });
          }
          if (event.kind === "command.completed" && terminalCommandId) {
            const artifact = await this.workspaces.storeArtifact(
              this.workspaceId,
              `command-${terminalCommandId}.log`,
              "text/plain",
              new TextEncoder().encode(
                `${terminalLog}[exit] code=${String(event.exitCode)} durationMs=${event.durationMs}\n`,
              ),
            );
            this.push({
              kind: "artifact",
              name: artifact.name,
              mediaType: artifact.mediaType,
              bytes: new Uint8Array(
                await import("node:fs/promises").then((fs) => fs.readFile(artifact.path)),
              ),
            });
          }
        }
      } finally {
        this.activeAbort = null;
      }
    });
  }

  async pause(): Promise<{ cursor: string }> {
    this.activeAbort?.abort();
    this.push({ kind: "status", status: "paused" });
    return { cursor: String(this.sequence - 1) };
  }

  async resume(): Promise<void> {
    this.push({ kind: "status", status: "resumed" });
  }

  async checkpoint(summary?: string): Promise<{ providerState: string }> {
    this.enqueue(async () => {
      const checkpoint = await this.workspaces.checkpoint(
        this.workspaceId,
        summary ?? `Execution checkpoint ${new Date().toISOString()}`,
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
    });
    return { providerState: "checkpoint queued" };
  }

  async restore(checkpointId: string, idempotencyKey: string): Promise<void> {
    if (this.seen.has(idempotencyKey)) return;
    this.seen.add(idempotencyKey);
    this.enqueue(async () => {
      const checkpoint = await this.workspaces.restore(this.workspaceId, checkpointId);
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
    });
  }

  async dispose(): Promise<void> {
    this.activeAbort?.abort();
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

  private push(input: ObservationInput<ProviderObservation>): void {
    const sequence = this.sequence++;
    this.queue.push({
      ...input,
      id: `${this.id}:${sequence}`,
      sequence,
    } as ProviderObservation);
    this.wake();
  }

  private wake(): void {
    this.waiters.splice(0).forEach((resolve) => resolve());
  }

  private enqueue(operation: () => Promise<void>): void {
    this.operationTail = this.operationTail
      .then(operation)
      .catch((error: unknown) => {
        this.push({
          kind: "error",
          code: "workspace_operation_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }
}

function runtimeObservation(event: RuntimeEvent): ObservationInput<ProviderObservation> {
  switch (event.kind) {
    case "command.started":
      return {
        kind: "terminal",
        phase: "started",
        commandId: event.commandId,
        executable: event.executable,
        args: event.args,
      };
    case "command.stdout":
    case "command.stderr":
      return {
        kind: "terminal",
        phase: event.kind === "command.stdout" ? "stdout" : "stderr",
        commandId: event.commandId,
        chunk: event.chunk,
      };
    case "command.completed":
      return {
        kind: "terminal",
        phase: "completed",
        commandId: event.commandId,
        exitCode: event.exitCode,
        durationMs: event.durationMs,
      };
    case "filesystem.changed":
      return {
        kind: "filesystem",
        commandId: event.commandId,
        changes: event.changes,
      };
    case "git.diff":
      return {
        kind: "git_diff",
        commandId: event.commandId,
        patch: event.patch,
        files: event.files,
      };
  }
}
