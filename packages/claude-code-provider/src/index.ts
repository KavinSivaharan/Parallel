import {
  CliAgentProvider,
  type CliParsedEvent,
  type CliProviderDriver,
  type CliProviderOptions,
  type CliProbeResult,
} from "@parallel/cli-provider-runtime";
import {
  defineCapabilities,
  normalizedText,
  normalizedTool,
  safeUsage,
} from "@parallel/provider-sdk";
import type { WorkspaceManager } from "@parallel/workspace-runtime";

export interface ClaudeCodeProviderOptions extends CliProviderOptions {
  executable?: string;
  executableArgsPrefix?: string[];
}

export class ClaudeCodeProvider extends CliAgentProvider {
  constructor(
    workspaces: WorkspaceManager,
    options: ClaudeCodeProviderOptions = {},
  ) {
    super(claudeCodeDriver(options), workspaces, options);
  }
}

export function claudeCodeDriver(
  options: ClaudeCodeProviderOptions = {},
): CliProviderDriver {
  return {
    id: "claude-code",
    metadata: {
      id: "claude-code",
      displayName: "Claude Code",
      adapterVersion: "1.0.0",
      providerVersion: null,
    },
    capabilities: defineCapabilities({
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
    }),
    executable: options.executable ?? process.env.CLAUDE_EXECUTABLE ?? "claude",
    ...(options.executableArgsPrefix
      ? { executableArgsPrefix: options.executableArgsPrefix }
      : {}),
    versionArguments: ["--version"],
    authenticationArguments: ["auth", "status"],
    parseAuthentication: parseClaudeAuthentication,
    buildArguments: ({ instruction, providerSessionId }) => [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--safe-mode",
      "--no-chrome",
      "--strict-mcp-config",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Bash",
      "Edit",
      "Read",
      "Write",
      "Glob",
      "Grep",
      ...(providerSessionId ? ["--resume", providerSessionId] : []),
      instruction,
    ],
    parseEvent: parseClaudeCodeEvent,
  };
}

export function parseClaudeCodeEvent(line: string): CliParsedEvent {
  const event = JSON.parse(line) as Record<string, unknown>;
  const type = string(event.type);
  const subtype = string(event.subtype);
  const eventId = string(event.uuid) || undefined;
  const providerSessionId = string(event.session_id) || undefined;
  const observations: CliParsedEvent["observations"] = [];

  if (type === "assistant") {
    const message = record(event.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const rawBlock of content) {
      const block = record(rawBlock);
      if (!block) continue;
      if (block.type === "text" && typeof block.text === "string" && block.text) {
        observations.push({
          kind: "output",
          channel: "final",
          text: normalizedText(block.text),
        });
      } else if (block.type === "tool_use") {
        observations.push(normalizedTool({
          phase: "started",
          name: string(block.name) || "tool",
          callId: string(block.id) || `claude-tool-${eventId ?? "unknown"}`,
          arguments: block.input,
        }));
      }
    }
  } else if (type === "user") {
    const message = record(event.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const rawBlock of content) {
      const block = record(rawBlock);
      if (block?.type !== "tool_result") continue;
      observations.push(normalizedTool({
        phase: "completed",
        name: "tool",
        callId: string(block.tool_use_id) || `claude-tool-result-${eventId ?? "unknown"}`,
        result: block.content,
        exitCode: block.is_error === true ? 1 : 0,
      }));
    }
  } else if (type === "result") {
    const usage = record(event.usage);
    if (usage) {
      observations.push({
        kind: "usage",
        inputTokens: safeUsage(usage.input_tokens),
        cachedInputTokens:
          safeUsage(usage.cache_read_input_tokens) +
          safeUsage(usage.cache_creation_input_tokens),
        outputTokens: safeUsage(usage.output_tokens),
        reasoningOutputTokens: 0,
      });
    }
    if (event.is_error === true) {
      observations.push({
        kind: "error",
        code: `claude_${subtype || "result_error"}`,
        message: normalizedText(event.result ?? "Claude Code reported an error", 4_096),
      });
    }
  } else if (type === "system" && subtype === "api_retry") {
    observations.push({
      kind: "warning",
      code: "claude_api_retry",
      message: normalizedText(event.error ?? "Claude Code API retry", 1_000),
    });
  }

  return {
    ...(eventId ? { eventId } : {}),
    ...(providerSessionId ? { providerSessionId } : {}),
    observations,
  };
}

function parseClaudeAuthentication(result: CliProbeResult) {
  try {
    const value = JSON.parse(result.output) as { loggedIn?: unknown };
    const ready = result.exitCode === 0 && value.loggedIn === true;
    return {
      authentication: ready ? "ready" as const : "missing" as const,
      diagnostic: ready
        ? "Claude authentication configured; upstream expiry is verified on execution"
        : "Run `claude auth login` on the API host",
    };
  } catch {
    return {
      authentication: "missing" as const,
      diagnostic: "Claude authentication status was not valid JSON",
    };
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
