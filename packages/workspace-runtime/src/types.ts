export interface WorkspaceMetadata {
  id: string;
  path: string;
  repositoryPath: string;
  repositoryUrl: string | null;
  baseRef: string | null;
  branch: string;
  createdAt: string;
  parentWorkspaceId: string | null;
  parentCheckpoint: string | null;
}

export interface CreateWorkspaceRequest {
  id: string;
  repositoryUrl?: string;
  baseRef?: string;
  parentWorkspaceId?: string;
  parentCheckpoint?: string;
}

export interface ExecuteCommandRequest {
  executable: string;
  args?: string[];
  environment?: Record<string, string>;
  timeoutMs?: number;
}

export type FileChangeKind = "created" | "modified" | "deleted" | "renamed";

export interface FileChange {
  kind: FileChangeKind;
  path: string;
  previousPath?: string;
}

export type RuntimeEvent =
  | {
      kind: "command.started";
      commandId: string;
      executable: string;
      args: string[];
      startedAt: string;
    }
  | {
      kind: "command.stdout" | "command.stderr";
      commandId: string;
      chunk: string;
    }
  | {
      kind: "command.completed";
      commandId: string;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      durationMs: number;
    }
  | { kind: "filesystem.changed"; commandId: string; changes: FileChange[] }
  | { kind: "git.diff"; commandId: string; patch: string; files: FileChange[] };

export interface Checkpoint {
  id: string;
  workspaceId: string;
  commitHash: string;
  parentCommitHash: string | null;
  summary: string;
  createdAt: string;
  branch: string;
  clean: boolean;
}

export interface StoredArtifact {
  id: string;
  workspaceId: string;
  name: string;
  mediaType: string;
  contentHash: string;
  byteSize: number;
  path: string;
  version: number;
  createdAt: string;
}

