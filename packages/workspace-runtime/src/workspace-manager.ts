import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { GitClient } from "./git-client.js";
import { ProcessRunner } from "./process-runner.js";
import type {
  Checkpoint,
  CheckpointComparison,
  CreateWorkspaceRequest,
  ExecuteCommandRequest,
  RuntimeEvent,
  StoredArtifact,
  WorkspaceMetadata,
} from "./types.js";

export class WorkspaceManager {
  private readonly runner = new ProcessRunner();

  constructor(private readonly root: string) {}

  async create(request: CreateWorkspaceRequest): Promise<WorkspaceMetadata> {
    const paths = this.paths(request.id);
    if (await exists(paths.metadata)) return this.metadata(request.id);
    await mkdir(paths.root, { recursive: true });
    if (request.repositoryUrl) {
      await runAt(this.root, [
        "clone",
        "--no-hardlinks",
        ...(request.baseRef ? ["--branch", request.baseRef] : []),
        request.repositoryUrl,
        paths.repository,
      ]);
    } else {
      await mkdir(paths.repository, { recursive: true });
      const git = new GitClient(paths.repository);
      await git.run(["init", "-b", "main"]);
      await configureGit(git);
      await git.run(["commit", "--allow-empty", "-m", "Initialize Parallel workspace"]);
    }
    const git = new GitClient(paths.repository);
    await configureGit(git);
    const branch = (await git.run(["branch", "--show-current"])).trim() || "detached";
    const metadata: WorkspaceMetadata = {
      id: request.id,
      path: paths.root,
      repositoryPath: paths.repository,
      repositoryUrl: request.repositoryUrl ?? null,
      baseRef: request.baseRef ?? null,
      branch,
      createdAt: new Date().toISOString(),
      parentWorkspaceId: request.parentWorkspaceId ?? null,
      parentCheckpoint: request.parentCheckpoint ?? null,
    };
    await writeJson(paths.metadata, metadata);
    await writeJson(paths.checkpoints, []);
    await writeJson(paths.artifacts, []);
    return metadata;
  }

  async metadata(workspaceId: string): Promise<WorkspaceMetadata> {
    return readJson<WorkspaceMetadata>(this.paths(workspaceId).metadata);
  }

  async *execute(
    workspaceId: string,
    request: ExecuteCommandRequest,
    signal?: AbortSignal,
  ): AsyncIterable<RuntimeEvent> {
    const metadata = await this.metadata(workspaceId);
    const git = new GitClient(metadata.repositoryPath);
    for await (const event of this.runner.execute(metadata.repositoryPath, request, signal)) {
      yield event;
      if (event.kind === "command.completed") {
        const changes = await git.status();
        if (changes.length > 0) {
          yield { kind: "filesystem.changed", commandId: event.commandId, changes };
          const patch = await git.diff();
          yield { kind: "git.diff", commandId: event.commandId, patch, files: changes };
        }
      }
    }
  }

  async checkpoint(workspaceId: string, summary: string): Promise<Checkpoint> {
    const metadata = await this.metadata(workspaceId);
    const git = new GitClient(metadata.repositoryPath);
    const parent = (await git.run(["rev-parse", "HEAD"], true)).trim() || null;
    const history = await this.checkpoints(workspaceId);
    await git.run(["add", "-A"]);
    await git.run(["commit", "--allow-empty", "-m", `checkpoint: ${summary}`]);
    const commitHash = (await git.run(["rev-parse", "HEAD"])).trim();
    const checkpoint: Checkpoint = {
      id: randomUUID(),
      workspaceId,
      commitHash,
      parentCommitHash: parent,
      parentCheckpointId: history.at(-1)?.id ?? null,
      summary,
      createdAt: new Date().toISOString(),
      branch: (await git.run(["branch", "--show-current"])).trim(),
      clean: (await git.status()).length === 0,
    };
    await writeJson(this.paths(workspaceId).checkpoints, [...history, checkpoint]);
    return checkpoint;
  }

  async checkpoints(workspaceId: string): Promise<Checkpoint[]> {
    return readJson<Checkpoint[]>(this.paths(workspaceId).checkpoints);
  }

  async restore(workspaceId: string, checkpointId: string): Promise<Checkpoint> {
    const checkpoint = (await this.checkpoints(workspaceId)).find((item) => item.id === checkpointId);
    if (!checkpoint) throw new Error(`Checkpoint ${checkpointId} not found`);
    const metadata = await this.metadata(workspaceId);
    const git = new GitClient(metadata.repositoryPath);
    await git.run(["reset", "--hard", checkpoint.commitHash]);
    await git.run(["clean", "-fd"]);
    return checkpoint;
  }

  async compareCheckpoints(
    workspaceId: string,
    fromCheckpointId: string,
    toCheckpointId: string,
  ): Promise<CheckpointComparison> {
    const history = await this.checkpoints(workspaceId);
    const from = history.find((item) => item.id === fromCheckpointId);
    const to = history.find((item) => item.id === toCheckpointId);
    if (!from || !to) throw new Error("Both checkpoints must belong to the workspace");
    const repository = (await this.metadata(workspaceId)).repositoryPath;
    const git = new GitClient(repository);
    const [patch, names] = await Promise.all([
      git.run(["diff", "--binary", "--no-ext-diff", from.commitHash, to.commitHash]),
      git.run(["diff", "--name-status", "-z", "--find-renames", from.commitHash, to.commitHash]),
    ]);
    return { from, to, files: parseNameStatus(names), patch };
  }

  async fork(
    sourceWorkspaceId: string,
    checkpointId: string,
    targetWorkspaceId: string,
  ): Promise<WorkspaceMetadata> {
    const source = await this.metadata(sourceWorkspaceId);
    const sourceHistory = await this.checkpoints(sourceWorkspaceId);
    const checkpointIndex = sourceHistory.findIndex((item) => item.id === checkpointId);
    const checkpoint = sourceHistory[checkpointIndex];
    if (!checkpoint) throw new Error(`Checkpoint ${checkpointId} not found`);
    const target = this.paths(targetWorkspaceId);
    if (await exists(target.metadata)) return this.metadata(targetWorkspaceId);
    await mkdir(target.root, { recursive: true });
    await runAt(this.root, ["clone", "--no-hardlinks", source.repositoryPath, target.repository]);
    const git = new GitClient(target.repository);
    const branch = `parallel/fork-${targetWorkspaceId.toLowerCase()}`;
    await git.run(["checkout", "-b", branch, checkpoint.commitHash]);
    await configureGit(git);
    const metadata: WorkspaceMetadata = {
      id: targetWorkspaceId,
      path: target.root,
      repositoryPath: target.repository,
      repositoryUrl: source.repositoryUrl,
      baseRef: branch,
      branch,
      createdAt: new Date().toISOString(),
      parentWorkspaceId: sourceWorkspaceId,
      parentCheckpoint: checkpointId,
    };
    await writeJson(target.metadata, metadata);
    await writeJson(
      target.checkpoints,
      sourceHistory
        .slice(0, checkpointIndex + 1)
        .map((item) => ({ ...item, workspaceId: targetWorkspaceId })),
    );
    await writeJson(target.artifacts, []);
    return metadata;
  }

  async storeArtifact(
    workspaceId: string,
    name: string,
    mediaType: string,
    content: Uint8Array,
  ): Promise<StoredArtifact> {
    await this.metadata(workspaceId);
    const paths = this.paths(workspaceId);
    await mkdir(paths.artifactData, { recursive: true });
    const contentHash = createHash("sha256").update(content).digest("hex");
    const history = await this.artifacts(workspaceId);
    const version = history.filter((item) => item.name === name).length + 1;
    const id = randomUUID();
    const path = join(paths.artifactData, `${id}-${basename(name)}`);
    await writeFile(path, content);
    const artifact: StoredArtifact = {
      id,
      workspaceId,
      name,
      mediaType,
      contentHash,
      byteSize: content.byteLength,
      path,
      version,
      createdAt: new Date().toISOString(),
    };
    await writeJson(paths.artifacts, [...history, artifact]);
    return artifact;
  }

  async artifacts(workspaceId: string): Promise<StoredArtifact[]> {
    return readJson<StoredArtifact[]>(this.paths(workspaceId).artifacts);
  }

  async cleanup(workspaceId: string): Promise<void> {
    await rm(this.paths(workspaceId).root, { recursive: true, force: true });
  }

  private paths(workspaceId: string) {
    validateWorkspaceId(workspaceId);
    const root = resolve(this.root, workspaceId);
    if (!root.startsWith(`${resolve(this.root)}/`)) throw new Error("Workspace path escaped root");
    return {
      root,
      repository: join(root, "repository"),
      metadata: join(root, "metadata.json"),
      checkpoints: join(root, "checkpoints.json"),
      artifacts: join(root, "artifacts.json"),
      artifactData: join(root, "artifact-data"),
    };
  }
}

async function configureGit(git: GitClient): Promise<void> {
  await git.run(["config", "user.name", "Parallel Runtime"]);
  await git.run(["config", "user.email", "runtime@parallel.local"]);
  await git.run(["config", "commit.gpgsign", "false"]);
}

async function runAt(cwd: string, args: string[]): Promise<void> {
  await mkdir(cwd, { recursive: true });
  const git = new GitClient(cwd);
  await git.run(args);
}

function validateWorkspaceId(workspaceId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(workspaceId)) {
    throw new Error("Invalid workspace ID");
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseNameStatus(output: string): CheckpointComparison["files"] {
  const records = output.split("\0").filter(Boolean);
  const files: CheckpointComparison["files"] = [];
  for (let index = 0; index < records.length; index += 1) {
    const status = records[index]!;
    const path = records[++index];
    if (!path) break;
    if (status.startsWith("R")) {
      const nextPath = records[++index];
      if (nextPath) files.push({ kind: "renamed", path: nextPath, previousPath: path });
    } else if (status === "A") {
      files.push({ kind: "created", path });
    } else if (status === "D") {
      files.push({ kind: "deleted", path });
    } else {
      files.push({ kind: "modified", path });
    }
  }
  return files;
}
