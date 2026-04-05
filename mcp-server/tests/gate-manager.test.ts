import { describe, it, expect } from "vitest";
import { GateSuspendError, getGateResult, setGateResult, deleteGateResult, hasGateResult } from "../src/gate-manager.js";

describe("Gate Manager", () => {
  it("GateSuspendError has correct properties", () => {
    const err = new GateSuspendError("step1", "exec1");
    expect(err).toBeInstanceOf(Error);
    expect(err.stepId).toBe("step1");
    expect(err.executionId).toBe("exec1");
    expect(err.name).toBe("GateSuspendError");
    expect(err.message).toContain("step1");
  });

  it("set/get/has/delete gate results", () => {
    setGateResult("e1:s1", "approved");
    expect(hasGateResult("e1:s1")).toBe(true);
    expect(getGateResult("e1:s1")).toBe("approved");
    deleteGateResult("e1:s1");
    expect(hasGateResult("e1:s1")).toBe(false);
    expect(getGateResult("e1:s1")).toBeUndefined();
  });

  it("set multiple gate results independently", () => {
    setGateResult("a:1", "yes");
    setGateResult("b:2", "no");
    expect(getGateResult("a:1")).toBe("yes");
    expect(getGateResult("b:2")).toBe("no");
    deleteGateResult("a:1");
    deleteGateResult("b:2");
  });

  it("delete non-existent key does not throw", () => {
    expect(() => deleteGateResult("nonexistent")).not.toThrow();
  });
});
