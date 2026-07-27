import { spawn } from "node:child_process";
import type { FileChange } from "./types.js";

export class GitClient {
  constructor(private readonly repositoryPath: string) {}

  async run(args: string[], allowFailure = false): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn("git", args, {
        cwd: this.repositoryPath,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: "C",
          GIT_TERMINAL_PROMPT: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0 || allowFailure) resolve(stdout);
        else reject(new Error(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`));
      });
    });
  }

  async status(): Promise<FileChange[]> {
    const output = await this.run(["status", "--porcelain=v1", "-z"]);
    const records = output.split("\0").filter(Boolean);
    const changes: FileChange[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      const code = record.slice(0, 2);
      const path = record.slice(3);
      if (code.includes("R")) {
        const nextPath = records[++index];
        if (nextPath) changes.push({ kind: "renamed", path: nextPath, previousPath: path });
      } else if (code === "??" || code.includes("A")) {
        changes.push({ kind: "created", path });
      } else if (code.includes("D")) {
        changes.push({ kind: "deleted", path });
      } else {
        changes.push({ kind: "modified", path });
      }
    }
    return changes;
  }

  async diff(): Promise<string> {
    const [unstaged, staged] = await Promise.all([
      this.run(["diff", "--binary", "--no-ext-diff"]),
      this.run(["diff", "--cached", "--binary", "--no-ext-diff"]),
    ]);
    return `${staged}${unstaged}`;
  }
}

