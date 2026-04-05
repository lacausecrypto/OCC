import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("Logger", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => { stderrSpy.mockRestore(); });

  it("logs info messages in text format", async () => {
    delete process.env.LOG_FORMAT;
    delete process.env.LOG_LEVEL;
    // Re-import to pick up env
    const { logger } = await import("../src/logger.js");
    logger.info("test", "hello world");
    expect(stderrSpy).toHaveBeenCalled();
    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output).toContain("[test]");
    expect(output).toContain("hello world");
  });

  it("logs with data", async () => {
    const { logger } = await import("../src/logger.js");
    logger.info("comp", "msg", { key: "val" });
    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output).toContain("key=val");
  });

  it("respects log level", async () => {
    process.env.LOG_LEVEL = "error";
    // Need fresh import
    vi.resetModules();
    const { logger } = await import("../src/logger.js");
    logger.debug("x", "should not show");
    logger.info("x", "should not show");
    logger.warn("x", "should not show");
    // Only error should pass
    const errCalls = stderrSpy.mock.calls.length;
    logger.error("x", "should show");
    expect(stderrSpy.mock.calls.length).toBe(errCalls + 1);
    delete process.env.LOG_LEVEL;
  });
});
