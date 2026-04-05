import { describe, it, expect } from "vitest";
import { sanitizeName } from "../src/loader.js";

describe("sanitizeName", () => {
  it("accepts valid names", () => {
    expect(sanitizeName("deep-researcher")).toBe("deep-researcher");
    expect(sanitizeName("my_chain.v2")).toBe("my_chain.v2");
    expect(sanitizeName("Chain123")).toBe("Chain123");
  });

  it("rejects path traversal", () => {
    expect(() => sanitizeName("../../etc/passwd")).toThrow("Invalid name");
    expect(() => sanitizeName("../evil")).toThrow("Invalid name");
    expect(() => sanitizeName("foo/bar")).toThrow("Invalid name");
    expect(() => sanitizeName("foo\\bar")).toThrow("Invalid name");
  });

  it("rejects shell metacharacters", () => {
    expect(() => sanitizeName("chain;rm -rf")).toThrow("Invalid name");
    expect(() => sanitizeName('chain"injection')).toThrow("Invalid name");
    expect(() => sanitizeName("chain<script>")).toThrow("Invalid name");
    expect(() => sanitizeName("chain|pipe")).toThrow("Invalid name");
  });

  it("rejects empty or starting with dot", () => {
    expect(() => sanitizeName("")).toThrow("Invalid name");
    expect(() => sanitizeName(".hidden")).toThrow("Invalid name");
    expect(() => sanitizeName("-dash")).toThrow("Invalid name");
  });

  it("rejects null bytes", () => {
    expect(() => sanitizeName("chain\x00evil")).toThrow("Invalid name");
  });
});
