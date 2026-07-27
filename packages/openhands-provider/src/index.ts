import {
  CliAgentProvider,
  type CliParsedEvent,
  type CliProviderDriver,
  type CliProviderOptions,
} from "@parallel/cli-provider-runtime";
import {
  defineCapabilities,
  normalizedText,
  normalizedTool,
  safeUsage,
} from "@parallel/provider-sdk";
import type { WorkspaceManager } from "@parallel/workspace-runtime";

export interface OpenHandsProviderOptions extends CliProviderOptions {
  executable?: string;
  executableArgsPrefix?: string[];
}

export class OpenHandsProvider extends CliAgentProvider {
  constructor(
    workspaces: WorkspaceManager,
    options: OpenHandsProviderOptions = {},
  ) {
    super(openHandsDriver(options), workspaces, options);
  }
}

export function openHandsDriver(
  options: OpenHandsProviderOptions = {},
): CliProviderDriver {
  return {
    id: "openhands",
    metadata: {
      id: "openhands",
      displayName: "OpenHands",
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
      usageReporting: false,
      workspaceOwnership: "parallel",
      concurrentExecutions: true,
    }),
    executable: options.executable ?? process.env.OPENHANDS_EXECUTABLE ?? "openhands",
    ...(options.executableArgsPrefix
      ? { executableArgsPrefix: options.executableArgsPrefix }
      : {}),
    versionArguments: ["--version"],
    buildArguments: ({ instruction, providerSessionId }) => [
      "--headless",
      "--json",
      ...(providerSessionId ? ["--resume", providerSessionId] : []),
      "-t",
      instruction,
    ],
    parseEvent: parseOpenHandsEvent,
  };
}

export function parseOpenHandsEvent(line: string): CliParsedEvent {
  const event = JSON.parse(line) as Record<string, unknown>;
  const type = text(event.type);
  const action = text(event.action) || text(record(event.action)?.type);
  const eventId =
    text(event.event_id) || text(event.id) || text(event.uuid) || undefined;
  const providerSessionId =
    text(event.conversation_id) ||
    text(event.conversationId) ||
    text(record(event.conversation)?.id) ||
    undefined;
  const observations: CliParsedEvent["observations"] = [];

  if (type === "action") {
    const callId = text(event.tool_call_id) || eventId || "openhands-action";
    const command = event.command ?? record(event.args)?.command;
    observations.push(normalizedTool({
      phase: "started",
      name: action || "action",
      callId,
      arguments: command ?? event.args ?? event,
    }));
  } else if (type === "observation") {
    const callId =
      text(event.tool_call_id) ||
      text(event.action_id) ||
      eventId ||
      "openhands-observation";
    observations.push(normalizedTool({
      phase: "completed",
      name: action || text(event.observation) || "action",
      callId,
      result: event.content ?? event.output ?? event.message,
      ...(typeof event.exit_code === "number" ? { exitCode: event.exit_code } : {}),
    }));
  } else if (["message", "assistant", "agent"].includes(type)) {
    const content = event.content ?? event.message ?? event.text;
    if (content !== undefined) {
      observations.push({
        kind: "output",
        channel: "final",
        text: normalizedText(content),
      });
    }
  } else if (type === "error") {
    observations.push({
      kind: "error",
      code: "openhands_reported_error",
      message: normalizedText(event.message ?? event.error ?? event, 4_096),
    });
  }

  const metrics = record(event.metrics) ?? record(event.usage);
  if (metrics) {
    const inputTokens = safeUsage(metrics.input_tokens ?? metrics.prompt_tokens);
    const outputTokens = safeUsage(metrics.output_tokens ?? metrics.completion_tokens);
    if (inputTokens > 0 || outputTokens > 0) {
      observations.push({
        kind: "usage",
        inputTokens,
        cachedInputTokens: safeUsage(metrics.cached_input_tokens),
        outputTokens,
        reasoningOutputTokens: 0,
      });
    }
  }

  return {
    ...(eventId ? { eventId } : {}),
    ...(providerSessionId ? { providerSessionId } : {}),
    observations,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
