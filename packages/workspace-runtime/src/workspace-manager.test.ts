import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceManager } from "./workspace-manager.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WorkspaceManager", () => {
  it("executes real commands and reports filesystem mutations", async () => {
    const manager = await createManager();
    const workspace = await manager.create({ id: "workspace-a" });
    const events = [];
    for await (const event of manager.execute("workspace-a", {
      executable: process.execPath,
      args: ["-e", "require('fs').writeFileSync('hello.txt','hello'); console.log('done'); console.error('warning')"],
    })) events.push(event);

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "command.stdout", chunk: "done\n" }),
      expect.objectContaining({ kind: "command.stderr", chunk: "warning\n" }),
      expect.objectContaining({ kind: "command.completed", exitCode: 0 }),
      expect.objectContaining({
        kind: "filesystem.changed",
        changes: expect.arrayContaining([expect.objectContaining({ kind: "created", path: "hello.txt" })]),
      }),
    ]));
    expect(await readFile(join(workspace.repositoryPath, "hello.txt"), "utf8")).toBe("hello");
  });

  it("creates real Git checkpoints, restores state, and forks independently", async () => {
    const manager = await createManager();
    await manager.create({ id: "workspace-source" });
    await drain(manager.execute("workspace-source", {
      executable: process.execPath,
      args: ["-e", "require('fs').writeFileSync('state.txt','one')"],
    }));
    const checkpoint = await manager.checkpoint("workspace-source", "state one");
    expect(checkpoint.commitHash).toMatch(/^[0-9a-f]{40}$/);
    await drain(manager.execute("workspace-source", {
      executable: process.execPath,
      args: ["-e", "require('fs').writeFileSync('state.txt','two')"],
    }));
    await manager.restore("workspace-source", checkpoint.id);
    const source = await manager.metadata("workspace-source");
    expect(await readFile(join(source.repositoryPath, "state.txt"), "utf8")).toBe("one");

    const fork = await manager.fork("workspace-source", checkpoint.id, "workspace-fork");
    await drain(manager.execute("workspace-fork", {
      executable: process.execPath,
      args: ["-e", "require('fs').writeFileSync('state.txt','forked')"],
    }));
    expect(await readFile(join(fork.repositoryPath, "state.txt"), "utf8")).toBe("forked");
    expect(await readFile(join(source.repositoryPath, "state.txt"), "utf8")).toBe("one");
  });

  it("recovers stable workspace metadata and isolates concurrent workspaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "parallel-runtime-"));
    roots.push(root);
    const first = new WorkspaceManager(root);
    const [a, b] = await Promise.all([
      first.create({ id: "workspace-one" }),
      first.create({ id: "workspace-two" }),
    ]);
    await Promise.all([
      drain(first.execute(a.id, { executable: process.execPath, args: ["-e", "require('fs').writeFileSync('only-a','a')"] })),
      drain(first.execute(b.id, { executable: process.execPath, args: ["-e", "require('fs').writeFileSync('only-b','b')"] })),
    ]);
    const recovered = await new WorkspaceManager(root).metadata(a.id);
    expect(recovered).toEqual(a);
    await expect(readFile(join(b.repositoryPath, "only-a"), "utf8")).rejects.toThrow();
    await expect(readFile(join(a.repositoryPath, "only-b"), "utf8")).rejects.toThrow();
  });

  it("escalates cancellation for commands that ignore graceful termination", async () => {
    const manager = await createManager();
    await manager.create({ id: "workspace-cancel" });
    const controller = new AbortController();
    const events = [];
    const startedAt = Date.now();
    for await (const event of manager.execute(
      "workspace-cancel",
      {
        executable: process.execPath,
        args: [
          "-e",
          "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)",
        ],
      },
      controller.signal,
    )) {
      events.push(event);
      if (event.kind === "command.stdout") controller.abort();
    }
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "command.completed", signal: "SIGKILL" }),
    );
    expect(Date.now() - startedAt).toBeLessThan(3_500);
  }, 5_000);
});

async function createManager(): Promise<WorkspaceManager> {
  const root = await mkdtemp(join(tmpdir(), "parallel-runtime-"));
  roots.push(root);
  return new WorkspaceManager(root);
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of iterable) {
    // Drain streaming execution.
  }
}
