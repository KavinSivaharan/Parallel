import { describe, expect, it } from "vitest";
import { providerEnvironment, redactProviderText } from "./security.js";

describe("Codex provider security", () => {
  it("redacts common secret forms", () => {
    const text = redactProviderText(
      "Authorization: Bearer abc.def password=hunter2 api_key=sk-secretvalue123",
    );
    expect(text).not.toContain("abc.def");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("sk-secretvalue123");
  });

  it("passes only the explicit host environment allowlist", () => {
    const environment = providerEnvironment({
      PATH: "/bin",
      HOME: "/safe-home",
      OPENAI_API_KEY: "must-not-pass",
      DATABASE_URL: "must-not-pass",
    });
    expect(environment.HOME).toBe("/safe-home");
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.DATABASE_URL).toBeUndefined();
  });
});
