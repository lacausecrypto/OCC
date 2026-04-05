import { describe, it, expect } from "vitest";
import { getStepTypeColors, STEP_TYPE_COLORS } from "../../src/components/dashboard/stepColors";

describe("stepColors", () => {
  it("STEP_TYPE_COLORS has all step types", () => {
    expect(STEP_TYPE_COLORS).toHaveProperty("agent");
    expect(STEP_TYPE_COLORS).toHaveProperty("router");
    expect(STEP_TYPE_COLORS).toHaveProperty("evaluator");
    expect(STEP_TYPE_COLORS).toHaveProperty("gate");
    expect(STEP_TYPE_COLORS).toHaveProperty("transform");
    expect(STEP_TYPE_COLORS).toHaveProperty("loop");
    expect(STEP_TYPE_COLORS).toHaveProperty("merge");
    expect(STEP_TYPE_COLORS).toHaveProperty("webhook");
    expect(STEP_TYPE_COLORS).toHaveProperty("subchain");
    expect(STEP_TYPE_COLORS).toHaveProperty("debate");
    expect(STEP_TYPE_COLORS).toHaveProperty("browser");
  });

  it("getStepTypeColors returns colors for known type", () => {
    const colors = getStepTypeColors("agent");
    expect(colors).toBeTruthy();
  });
});
