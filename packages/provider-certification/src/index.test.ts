import { SimulatedProvider } from "@parallel/provider-sdk";
import { describe, expect, it } from "vitest";
import { certifyProvider } from "./index.js";

describe("provider certification", () => {
  it("produces a machine-readable report and skips truthful unsupported probes", async () => {
    const report = await certifyProvider({
      provider: new SimulatedProvider(),
      createRequest: {
        sessionId: "cert-session",
        branchId: "cert-branch",
        workspaceRef: "workspace://cert",
        initialInstruction: "Certify the simulator",
        idempotencyKey: "cert-create",
      },
    });

    expect(report.schemaVersion).toBe(1);
    expect(report.provider.id).toBe("simulator");
    expect(report.summary.failed).toBe(0);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "capability_honesty", status: "passed" }),
        expect.objectContaining({ id: "event_ordering", status: "passed" }),
        expect.objectContaining({ id: "process_crash", status: "skipped" }),
      ]),
    );
  });
});
