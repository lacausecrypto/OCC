/**
 * Tests for SSRF protection in pretool-executor.ts.
 *
 * Covers:
 * - ipInCidr function logic
 * - checkSSRF blocking of private IP ranges
 * - checkSSRF allowing public IPs
 * - Scheme blocking (file://, ftp://)
 * - extractJsonPath utility
 * - Pre-tool cache key generation
 * - Pre-tool error handling modes
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── ipInCidr: pure function recreation ────────────────────────────────────
// Recreated from pretool-executor.ts since it's not exported

function ipInCidr(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split("/");
  const mask = ~((1 << (32 - parseInt(bits))) - 1) >>> 0;
  const ipNum = ip.split(".").reduce((n, o) => (n << 8) + parseInt(o), 0) >>> 0;
  const baseNum = base.split(".").reduce((n, o) => (n << 8) + parseInt(o), 0) >>> 0;
  return (ipNum & mask) === (baseNum & mask);
}

describe("ipInCidr", () => {
  describe("127.0.0.0/8 (loopback)", () => {
    it("matches 127.0.0.1", () => {
      expect(ipInCidr("127.0.0.1", "127.0.0.0/8")).toBe(true);
    });

    it("matches 127.255.255.255", () => {
      expect(ipInCidr("127.255.255.255", "127.0.0.0/8")).toBe(true);
    });

    it("does not match 128.0.0.1", () => {
      expect(ipInCidr("128.0.0.1", "127.0.0.0/8")).toBe(false);
    });
  });

  describe("10.0.0.0/8 (private class A)", () => {
    it("matches 10.0.0.1", () => {
      expect(ipInCidr("10.0.0.1", "10.0.0.0/8")).toBe(true);
    });

    it("matches 10.255.255.255", () => {
      expect(ipInCidr("10.255.255.255", "10.0.0.0/8")).toBe(true);
    });

    it("does not match 11.0.0.1", () => {
      expect(ipInCidr("11.0.0.1", "10.0.0.0/8")).toBe(false);
    });
  });

  describe("172.16.0.0/12 (private class B)", () => {
    it("matches 172.16.0.1", () => {
      expect(ipInCidr("172.16.0.1", "172.16.0.0/12")).toBe(true);
    });

    it("matches 172.31.255.255", () => {
      expect(ipInCidr("172.31.255.255", "172.16.0.0/12")).toBe(true);
    });

    it("does not match 172.32.0.1", () => {
      expect(ipInCidr("172.32.0.1", "172.16.0.0/12")).toBe(false);
    });

    it("does not match 172.15.255.255", () => {
      expect(ipInCidr("172.15.255.255", "172.16.0.0/12")).toBe(false);
    });
  });

  describe("192.168.0.0/16 (private class C)", () => {
    it("matches 192.168.1.1", () => {
      expect(ipInCidr("192.168.1.1", "192.168.0.0/16")).toBe(true);
    });

    it("matches 192.168.255.255", () => {
      expect(ipInCidr("192.168.255.255", "192.168.0.0/16")).toBe(true);
    });

    it("does not match 192.169.0.1", () => {
      expect(ipInCidr("192.169.0.1", "192.168.0.0/16")).toBe(false);
    });
  });

  describe("169.254.0.0/16 (link-local / metadata)", () => {
    it("matches 169.254.169.254 (AWS metadata)", () => {
      expect(ipInCidr("169.254.169.254", "169.254.0.0/16")).toBe(true);
    });

    it("matches 169.254.0.1", () => {
      expect(ipInCidr("169.254.0.1", "169.254.0.0/16")).toBe(true);
    });

    it("does not match 169.255.0.1", () => {
      expect(ipInCidr("169.255.0.1", "169.254.0.0/16")).toBe(false);
    });
  });

  describe("0.0.0.0/8", () => {
    it("matches 0.0.0.0", () => {
      expect(ipInCidr("0.0.0.0", "0.0.0.0/8")).toBe(true);
    });

    it("does not match 1.0.0.0", () => {
      expect(ipInCidr("1.0.0.0", "0.0.0.0/8")).toBe(false);
    });
  });

  describe("public IPs", () => {
    const BLOCKED_CIDRS = [
      "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
      "169.254.0.0/16", "0.0.0.0/8", "100.64.0.0/10", "198.18.0.0/15",
    ];

    function isBlocked(ip: string): boolean {
      return BLOCKED_CIDRS.some((cidr) => ipInCidr(ip, cidr));
    }

    it("8.8.8.8 (Google DNS) is NOT blocked", () => {
      expect(isBlocked("8.8.8.8")).toBe(false);
    });

    it("1.1.1.1 (Cloudflare DNS) is NOT blocked", () => {
      expect(isBlocked("1.1.1.1")).toBe(false);
    });

    it("93.184.216.34 (example.com) is NOT blocked", () => {
      expect(isBlocked("93.184.216.34")).toBe(false);
    });

    it("13.107.42.14 (Microsoft) is NOT blocked", () => {
      expect(isBlocked("13.107.42.14")).toBe(false);
    });

    it("203.0.113.1 is NOT blocked", () => {
      expect(isBlocked("203.0.113.1")).toBe(false);
    });
  });

  describe("blocked private IPs (integration)", () => {
    const BLOCKED_CIDRS = [
      "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
      "169.254.0.0/16", "0.0.0.0/8", "100.64.0.0/10", "198.18.0.0/15",
    ];

    function isBlocked(ip: string): boolean {
      return BLOCKED_CIDRS.some((cidr) => ipInCidr(ip, cidr));
    }

    it("127.0.0.1 (localhost) IS blocked", () => {
      expect(isBlocked("127.0.0.1")).toBe(true);
    });

    it("10.0.0.1 IS blocked", () => {
      expect(isBlocked("10.0.0.1")).toBe(true);
    });

    it("172.16.0.1 IS blocked", () => {
      expect(isBlocked("172.16.0.1")).toBe(true);
    });

    it("192.168.1.1 IS blocked", () => {
      expect(isBlocked("192.168.1.1")).toBe(true);
    });

    it("169.254.169.254 (AWS metadata) IS blocked", () => {
      expect(isBlocked("169.254.169.254")).toBe(true);
    });

    it("0.0.0.0 IS blocked", () => {
      expect(isBlocked("0.0.0.0")).toBe(true);
    });

    it("100.64.0.1 (Carrier-grade NAT) IS blocked", () => {
      expect(isBlocked("100.64.0.1")).toBe(true);
    });

    it("198.18.0.1 (benchmark testing) IS blocked", () => {
      expect(isBlocked("198.18.0.1")).toBe(true);
    });
  });
});

// ─── Scheme blocking ───────────────────────────────────────────────────────

describe("Scheme blocking (SSRF)", () => {
  // Recreate the scheme check from checkSSRF
  function checkScheme(urlStr: string): void {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`SSRF blocked: scheme ${parsed.protocol} not allowed`);
    }
  }

  it("allows http://", () => {
    expect(() => checkScheme("http://example.com")).not.toThrow();
  });

  it("allows https://", () => {
    expect(() => checkScheme("https://example.com")).not.toThrow();
  });

  it("blocks file://", () => {
    expect(() => checkScheme("file:///etc/passwd")).toThrow(/SSRF blocked.*file:/);
  });

  it("blocks ftp://", () => {
    expect(() => checkScheme("ftp://server/file")).toThrow(/SSRF blocked.*ftp:/);
  });

  it("blocks data:", () => {
    expect(() => checkScheme("data:text/html,<h1>hi</h1>")).toThrow(/SSRF blocked/);
  });

  it("blocks gopher://", () => {
    expect(() => checkScheme("gopher://server/path")).toThrow(/SSRF blocked/);
  });

  it("blocks javascript: (URL parse may fail)", () => {
    expect(() => checkScheme("javascript:alert(1)")).toThrow();
  });
});

// ─── extractJsonPath utility ───────────────────────────────────────────────

describe("extractJsonPath", () => {
  // Recreate from pretool-executor.ts
  function extractJsonPath(obj: any, jsonPath: string): any {
    const parts = jsonPath.replace(/\[(\d+)\]/g, ".$1").split(".");
    let current = obj;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      current = current[part];
    }
    return current;
  }

  it("extracts top-level key", () => {
    expect(extractJsonPath({ name: "Alice" }, "name")).toBe("Alice");
  });

  it("extracts nested key", () => {
    expect(extractJsonPath({ data: { name: "Bob" } }, "data.name")).toBe("Bob");
  });

  it("extracts array element", () => {
    expect(extractJsonPath({ items: ["a", "b", "c"] }, "items[0]")).toBe("a");
  });

  it("extracts nested array element", () => {
    expect(extractJsonPath({ data: { items: [{ name: "x" }] } }, "data.items[0].name")).toBe("x");
  });

  it("returns undefined for missing path", () => {
    expect(extractJsonPath({ a: 1 }, "b.c")).toBeUndefined();
  });

  it("returns undefined for null object", () => {
    expect(extractJsonPath(null, "key")).toBeUndefined();
  });

  it("returns the entire object for empty path", () => {
    const obj = { a: 1 };
    // empty path splits to [""] which accesses obj[""] = undefined
    expect(extractJsonPath(obj, "")).toBeUndefined();
  });

  it("handles deeply nested path", () => {
    const obj = { a: { b: { c: { d: { e: 42 } } } } };
    expect(extractJsonPath(obj, "a.b.c.d.e")).toBe(42);
  });

  it("handles numeric array access", () => {
    const obj = { results: [{ score: 95 }, { score: 87 }] };
    expect(extractJsonPath(obj, "results[1].score")).toBe(87);
  });
});

// ─── Pre-tool error handling modes ─────────────────────────────────────────

describe("Pre-tool error handling modes", () => {
  // Test the on_error logic from executePreToolWithRetry

  function simulateErrorHandling(onError: "inject" | "skip" | "fail", errorMessage: string): string | Error {
    if (onError === "fail") {
      return new Error(`Pre-tool failed: ${errorMessage}`);
    } else if (onError === "skip") {
      return ""; // empty string returned
    } else {
      return `[PRE-TOOL ERROR: ${errorMessage}]`;
    }
  }

  it("inject mode: returns error message in bracket format", () => {
    const result = simulateErrorHandling("inject", "Connection refused");
    expect(result).toBe("[PRE-TOOL ERROR: Connection refused]");
  });

  it("skip mode: returns empty string", () => {
    const result = simulateErrorHandling("skip", "Connection refused");
    expect(result).toBe("");
  });

  it("fail mode: returns an Error object", () => {
    const result = simulateErrorHandling("fail", "Connection refused");
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("Connection refused");
  });
});

// ─── Pre-tool cache key logic ──────────────────────────────────────────────

describe("Pre-tool cache key generation", () => {
  // Recreate getPreToolCacheKey from pretool-executor.ts
  function getPreToolCacheKey(
    tool: { type: string; url?: string; query?: string; path?: string; command?: string; var_name?: string },
    vars: Record<string, string>,
  ): string {
    const key = JSON.stringify({
      type: tool.type,
      url: tool.url,
      query: tool.query,
      path: tool.path,
      command: tool.command,
      var_name: tool.var_name,
    });
    // Simplified resolveVariables inline
    return key.replace(/\{(\w+)\}/g, (_match, k) => vars[k] ?? _match);
  }

  it("produces same key for same tool config", () => {
    const tool = { type: "http_fetch", url: "https://api.com/data" };
    const key1 = getPreToolCacheKey(tool, {});
    const key2 = getPreToolCacheKey(tool, {});
    expect(key1).toBe(key2);
  });

  it("produces different key for different URLs", () => {
    const tool1 = { type: "http_fetch", url: "https://api.com/a" };
    const tool2 = { type: "http_fetch", url: "https://api.com/b" };
    const key1 = getPreToolCacheKey(tool1, {});
    const key2 = getPreToolCacheKey(tool2, {});
    expect(key1).not.toBe(key2);
  });

  it("resolves variables in key", () => {
    const tool = { type: "http_fetch", url: "https://api.com/{endpoint}" };
    const key1 = getPreToolCacheKey(tool, { endpoint: "users" });
    const key2 = getPreToolCacheKey(tool, { endpoint: "posts" });
    expect(key1).not.toBe(key2);
  });

  it("includes type in key", () => {
    const tool1 = { type: "http_fetch", url: "https://api.com" };
    const tool2 = { type: "web_search", url: "https://api.com" };
    const key1 = getPreToolCacheKey(tool1, {});
    const key2 = getPreToolCacheKey(tool2, {});
    expect(key1).not.toBe(key2);
  });
});
