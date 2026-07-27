import type { ProviderObservationInput } from "./execution.js";

export interface ProviderTextLimits {
  eventBytes: number;
  outputBytes: number;
}

export function normalizedText(
  value: unknown,
  maximumBytes = 256 * 1024,
): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const text = redactSecrets(serialized ?? String(value));
  if (utf8Bytes(text) <= maximumBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(text.slice(0, middle)) <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

const bearerToken = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const secretAssignment =
  /(\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret|cookie)\b["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi;
const knownToken =
  /\b(?:sk-[A-Za-z0-9_-]{12,}|cog_[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_-]{12,})\b/g;

export function redactSecrets(value: string): string {
  return value
    .replace(bearerToken, "$1[REDACTED]")
    .replace(secretAssignment, "$1[REDACTED]")
    .replace(knownToken, "[REDACTED]");
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function normalizedError(
  provider: string,
  error: unknown,
  code = "provider_error",
): ProviderObservationInput {
  return {
    kind: "error",
    code: `${provider}_${code}`,
    message: normalizedText(error instanceof Error ? error.message : String(error), 4_096),
  };
}

export function normalizedTool(input: {
  phase: "started" | "completed";
  name: string;
  callId: string;
  arguments?: unknown;
  result?: unknown;
  exitCode?: number | null;
  maximumBytes?: number;
}): ProviderObservationInput {
  const maximumBytes = input.maximumBytes ?? 256 * 1024;
  return {
    kind: "tool",
    phase: input.phase,
    name: input.name,
    callId: input.callId,
    ...(input.arguments !== undefined
      ? { input: normalizedText(input.arguments, maximumBytes) }
      : {}),
    ...(input.result !== undefined
      ? { output: normalizedText(input.result, maximumBytes) }
      : {}),
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
  };
}

export function safeUsage(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

export function stableProviderEventKey(input: {
  type: string;
  id?: unknown;
  sequence?: unknown;
}): string | null {
  if (typeof input.id === "string" && input.id) return `${input.type}:${input.id}`;
  if (typeof input.sequence === "number" || typeof input.sequence === "string") {
    return `${input.type}:${String(input.sequence)}`;
  }
  return null;
}
