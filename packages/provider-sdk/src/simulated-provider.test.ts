import { describe, expect, it } from "vitest";
import { SimulatedProvider } from "./simulated-provider.js";

describe("SimulatedProvider", () => {
  it("uses the production provider contract and deduplicates steering", async () => {
    const execution = await new SimulatedProvider().createExecution({
      sessionId: "s1",
      branchId: "b1",
      workspaceRef: "workspace",
      initialInstruction: "Implement auth",
    });

    await execution.start();
    await execution.steer("Use passkeys", "key-1");
    await execution.steer("Use passkeys", "key-1");
    await execution.dispose();

    const observed = [];
    for await (const item of execution.observations()) observed.push(item);
    expect(observed).toHaveLength(3);
  });
});

