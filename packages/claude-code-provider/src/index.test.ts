import { describe, expect, it } from "vitest";
import { claudeCodeDriver, parseClaudeCodeEvent } from "./index.js";

describe("Claude Code adapter", () => {
  it("declares continuation semantics and builds a safe structured invocation", () => {
    const driver = claudeCodeDriver();
    expect(driver.capabilities.steering).toBe("continuation");
    expect(driver.capabilities.toolCallVisibility).toBe("structured");
    const args = driver.buildArguments({
      instruction: "Fix the test",
      providerSessionId: "session-123",
      workspace: {} as never,
    });
    expect(args).toEqual(expect.arrayContaining([
      "--output-format", "stream-json", "--resume", "session-123", "Fix the test",
    ]));
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("normalizes text, tools, usage, identity, errors, and duplicate IDs", () => {
    const assistant = parseClaudeCodeEvent(JSON.stringify({
      type: "assistant",
      uuid: "event-1",
      session_id: "session-1",
      message: {
        content: [
          { type: "text", text: "I changed the service." },
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pnpm test" } },
          { type: "thinking", thinking: "private" },
        ],
        usage: { input_tokens: 12, output_tokens: 8, cache_read_input_tokens: 2 },
      },
    }));
    expect(assistant.eventId).toBe("event-1");
    expect(assistant.providerSessionId).toBe("session-1");
    expect(assistant.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "output", text: "I changed the service." }),
      expect.objectContaining({ kind: "tool", phase: "started", callId: "tool-1" }),
    ]));
    expect(JSON.stringify(assistant)).not.toContain("private");

    const result = parseClaudeCodeEvent(JSON.stringify({
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 12,
        output_tokens: 8,
        cache_read_input_tokens: 2,
      },
    }));
    expect(result.observations).toContainEqual(expect.objectContaining({
      kind: "usage",
      inputTokens: 12,
      cachedInputTokens: 2,
      outputTokens: 8,
    }));

    const failed = parseClaudeCodeEvent(JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "authentication failed",
    }));
    expect(failed.observations).toContainEqual(expect.objectContaining({
      kind: "error",
      code: "claude_error_during_execution",
    }));
  });
});
