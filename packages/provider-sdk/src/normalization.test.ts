import { describe, expect, it } from "vitest";
import { normalizedText, normalizedTool } from "./normalization.js";

describe("provider normalization", () => {
  it("redacts common credentials before provider content can become durable", () => {
    const text = normalizedText(
      'Authorization: Bearer secret-token api_key="sk-ant-12345678901234567890" cog_abcdefghijklmnop',
    );
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain("12345678901234567890");
    expect(text).not.toContain("cog_abcdefghijklmnop");
    expect(text).toContain("[REDACTED]");
  });

  it("redacts structured tool inputs and outputs", () => {
    const observation = normalizedTool({
      phase: "completed",
      name: "request",
      callId: "call-1",
      arguments: { password: "not-for-events" },
      result: "Bearer another-secret",
    });
    expect(JSON.stringify(observation)).not.toContain("not-for-events");
    expect(JSON.stringify(observation)).not.toContain("another-secret");
  });
});
