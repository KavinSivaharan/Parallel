import { describe, expect, it } from "vitest";
import {
  providerCapabilitiesV1Schema,
  providerReadinessSchema,
} from "./index.js";
import { SimulatedProvider } from "./simulated-provider.js";

describe("provider capability protocol", () => {
  it("validates versioned capability declarations and readiness", async () => {
    const provider = new SimulatedProvider();
    expect(providerCapabilitiesV1Schema.parse(provider.capabilities)).toEqual(
      provider.capabilities,
    );
    expect(providerReadinessSchema.parse(await provider.readiness()).status).toBe("ready");
  });

  it("rejects unknown capability versions and fields", () => {
    const provider = new SimulatedProvider();
    expect(() =>
      providerCapabilitiesV1Schema.parse({
        ...provider.capabilities,
        schemaVersion: 2,
      }),
    ).toThrow();
    expect(() =>
      providerCapabilitiesV1Schema.parse({
        ...provider.capabilities,
        fabricatedCapability: true,
      }),
    ).toThrow();
  });
});
