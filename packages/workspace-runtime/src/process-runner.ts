import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExecuteCommandRequest, RuntimeEvent } from "./types.js";

export class ProcessRunner {
  async *execute(
    repositoryPath: string,
    request: ExecuteCommandRequest,
    signal?: AbortSignal,
  ): AsyncIterable<RuntimeEvent> {
    validateCommand(request);
    const commandId = randomUUID();
    const startedAt = new Date();
    yield {
      kind: "command.started",
      commandId,
      executable: request.executable,
      args: request.args ?? [],
      startedAt: startedAt.toISOString(),
    };

    const home = join(repositoryPath, "..", "home");
    await mkdir(home, { recursive: true });
    const child = spawn(request.executable, request.args ?? [], {
      cwd: repositoryPath,
      env: isolatedEnvironment(home, request.environment),
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const queue: RuntimeEvent[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;

    const push = (event: RuntimeEvent): void => {
      queue.push(event);
      wake?.();
      wake = undefined;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) =>
      push({ kind: "command.stdout", commandId, chunk }),
    );
    child.stderr.on("data", (chunk: string) =>
      push({ kind: "command.stderr", commandId, chunk }),
    );
    child.on("error", (error) =>
      push({ kind: "command.stderr", commandId, chunk: `${error.message}\n` }),
    );
    child.on("close", (code, closeSignal) => {
      exitCode = code;
      exitSignal = closeSignal;
      finished = true;
      wake?.();
    });

    const abort = (): void => {
      terminate(child.pid, "SIGTERM");
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = request.timeoutMs
      ? setTimeout(() => terminate(child.pid, "SIGTERM"), request.timeoutMs)
      : undefined;
    timeout?.unref();

    try {
      while (!finished || queue.length > 0) {
        const event = queue.shift();
        if (event) yield event;
        else await new Promise<void>((resolve) => { wake = resolve; });
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      if (timeout) clearTimeout(timeout);
      if (!finished) terminate(child.pid, "SIGKILL");
    }
    yield {
      kind: "command.completed",
      commandId,
      exitCode,
      signal: exitSignal,
      durationMs: Date.now() - startedAt.getTime(),
    };
  }
}

function terminate(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    // The process may have exited between observation and cancellation.
  }
}

function isolatedEnvironment(
  home: string,
  supplied: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    CI: "true",
  };
  for (const [key, value] of Object.entries(supplied ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid environment key ${key}`);
    if (["HOME", "PATH", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"].includes(key)) {
      throw new Error(`Environment key ${key} is controlled by the runtime`);
    }
    base[key] = value;
  }
  return base;
}

function validateCommand(request: ExecuteCommandRequest): void {
  if (!request.executable || request.executable.includes("\0")) {
    throw new Error("A valid executable is required");
  }
  if ((request.args ?? []).some((argument) => argument.includes("\0"))) {
    throw new Error("Command arguments cannot contain null bytes");
  }
}
