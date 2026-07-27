import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { WorkspaceManager } from "./workspace-manager.js";

interface Result {
  operation: string;
  iterations: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
}

const root = await mkdtemp(join(tmpdir(), "parallel-benchmark-"));
const manager = new WorkspaceManager(root);
const results: Result[] = [];

try {
  results.push(
    await measure("workspace.create", 10, async (index) => {
      await manager.create({ id: `create-${index}` });
    }),
  );

  await manager.create({ id: "command-benchmark" });
  results.push(
    await measure("command.clean_round_trip", 20, async () => {
      await drain(
        manager.execute("command-benchmark", {
          executable: process.execPath,
          args: ["-e", "process.stdout.write('ok')"],
        }),
      );
    }),
  );

  await manager.create({ id: "checkpoint-benchmark" });
  results.push(
    await measure("checkpoint.commit", 10, async (index) => {
      await drain(
        manager.execute("checkpoint-benchmark", {
          executable: process.execPath,
          args: [
            "-e",
            `require('fs').writeFileSync('state.txt', ${JSON.stringify(`version-${index}`)})`,
          ],
        }),
      );
      await manager.checkpoint("checkpoint-benchmark", `benchmark ${index}`);
    }),
  );

  const sourceCheckpoint = (await manager.checkpoints("checkpoint-benchmark")).at(-1);
  if (!sourceCheckpoint) throw new Error("Benchmark checkpoint missing");
  results.push(
    await measure("workspace.fork", 8, async (index) => {
      await manager.fork(
        "checkpoint-benchmark",
        sourceCheckpoint.id,
        `fork-${index}`,
      );
    }),
  );

  const artifactBytes = new Uint8Array(4 * 1024).fill(65);
  results.push(
    await measure("artifact.store_4k", 20, async (index) => {
      await manager.storeArtifact(
        "command-benchmark",
        `benchmark-${index}.json`,
        "application/json",
        artifactBytes,
      );
    }),
  );

  const concurrentIds = Array.from({ length: 8 }, (_, index) => `parallel-${index}`);
  await Promise.all(concurrentIds.map((id) => manager.create({ id })));
  const concurrentStartedAt = performance.now();
  await Promise.all(
    concurrentIds.map((id, index) =>
      drain(
        manager.execute(id, {
          executable: process.execPath,
          args: [
            "-e",
            `require('fs').writeFileSync('worker.txt', ${JSON.stringify(String(index))})`,
          ],
        }),
      ),
    ),
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        platform: `${process.platform}-${process.arch}`,
        node: process.version,
        results,
        concurrentExecution: {
          workspaces: concurrentIds.length,
          wallClockMs: round(performance.now() - concurrentStartedAt),
        },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

async function measure(
  operation: string,
  iterations: number,
  run: (index: number) => Promise<void>,
): Promise<Result> {
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    await run(index);
    samples.push(performance.now() - startedAt);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    operation,
    iterations,
    medianMs: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    minMs: round(sorted[0] ?? 0),
    maxMs: round(sorted.at(-1) ?? 0),
  };
}

function percentile(sorted: number[], value: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)]!;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of iterable) {
    // The benchmark includes event production and stream consumption.
  }
}
