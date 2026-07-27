export interface CodexThreadStarted {
  type: "thread.started";
  thread_id: string;
}

export interface CodexTurnStarted {
  type: "turn.started";
}

export interface CodexTurnCompleted {
  type: "turn.completed";
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
}

export interface CodexTurnFailed {
  type: "turn.failed";
  error?: { message?: string };
}

export interface CodexError {
  type: "error";
  message?: string;
}

export interface CodexItemEvent {
  type: "item.started" | "item.updated" | "item.completed";
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
    changes?: unknown;
  };
}

export type CodexJsonEvent =
  | CodexThreadStarted
  | CodexTurnStarted
  | CodexTurnCompleted
  | CodexTurnFailed
  | CodexError
  | CodexItemEvent
  | { type: string; [key: string]: unknown };

export function parseCodexEvent(line: string): CodexJsonEvent {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex event must be a JSON object");
  }
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string" || type.length === 0) {
    throw new Error("Codex event is missing a type");
  }
  return value as CodexJsonEvent;
}
