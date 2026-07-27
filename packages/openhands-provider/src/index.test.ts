import { describe, expect, it } from "vitest";
import { openHandsDriver, parseOpenHandsEvent } from "./index.js";

describe("OpenHands adapter", () => {
  it("uses documented headless JSONL and resume arguments", () => {
    const driver = openHandsDriver();
    expect(driver.capabilities.steering).toBe("continuation");
    expect(driver.capabilities.usageReporting).toBe(false);
    expect(driver.buildArguments({
      instruction: "Add tests",
      providerSessionId: "conversation-1",
      workspace: {} as never,
    })).toEqual([
      "--headless", "--json", "--resume", "conversation-1", "-t", "Add tests",
    ]);
  });

  it("normalizes action, observation, message, and conversation identity", () => {
    const action = parseOpenHandsEvent(JSON.stringify({
      type: "action",
      id: "action-1",
      conversation_id: "conversation-1",
      action: "run",
      command: "pytest",
    }));
    expect(action.providerSessionId).toBe("conversation-1");
    expect(action.observations).toContainEqual(expect.objectContaining({
      kind: "tool",
      phase: "started",
      name: "run",
    }));
    const observation = parseOpenHandsEvent(JSON.stringify({
      type: "observation",
      action_id: "action-1",
      content: "2 passed",
      exit_code: 0,
    }));
    expect(observation.observations).toContainEqual(expect.objectContaining({
      kind: "tool",
      phase: "completed",
      exitCode: 0,
    }));
  });
});
