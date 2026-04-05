import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApiClient, ApiError } from "../../src/api/client";

describe("ApiClient", () => {
  let client: ApiClient;

  beforeEach(() => {
    client = new ApiClient("/api", null);
    vi.restoreAllMocks();
  });

  it("creates with default values", () => {
    const c = new ApiClient();
    expect(c.baseUrl).toBe("/api");
    expect(c.apiKey).toBeNull();
  });

  it("sends GET requests", async () => {
    const mockResponse = { data: "test" };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await client.get<typeof mockResponse>("/test");
    expect(result).toEqual(mockResponse);
    expect(fetch).toHaveBeenCalledWith(
      "/api/test",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("sends POST requests with body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await client.post("/test", { key: "value" });
    expect(fetch).toHaveBeenCalledWith(
      "/api/test",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ key: "value" }),
      }),
    );
  });

  it("sends PUT requests", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await client.put("/test", { data: 1 });
    expect(fetch).toHaveBeenCalledWith(
      "/api/test",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("sends DELETE requests", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    const result = await client.delete("/test/1");
    expect(result).toBeUndefined();
  });

  it("includes Authorization header when apiKey is set", async () => {
    client.apiKey = "test-key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await client.get("/test");
    const callArgs = vi.mocked(fetch).mock.calls[0];
    const headers = (callArgs[1] as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-key");
  });

  it("does not include Authorization when apiKey is null", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await client.get("/test");
    const callArgs = vi.mocked(fetch).mock.calls[0];
    const headers = (callArgs[1] as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("throws ApiError on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Not Found", { status: 404 }),
    );

    await expect(client.get("/missing")).rejects.toThrow(ApiError);
    await expect(client.get("/missing")).rejects.toThrow(/404/);
  });

  it("handles 204 No Content", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    const result = await client.delete("/item");
    expect(result).toBeUndefined();
  });

  it("returns text for non-JSON responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("plain text", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );

    const result = await client.get<string>("/text");
    expect(result).toBe("plain text");
  });

  it("includes Content-Type application/json header", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await client.get("/test");
    const callArgs = vi.mocked(fetch).mock.calls[0];
    const headers = (callArgs[1] as RequestInit).headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });
});

describe("ApiError", () => {
  it("stores status and url", () => {
    const err = new ApiError(404, "Not Found", "/api/test");
    expect(err.status).toBe(404);
    expect(err.url).toBe("/api/test");
    expect(err.name).toBe("ApiError");
    expect(err.message).toContain("404");
    expect(err.message).toContain("/api/test");
  });

  it("is an instance of Error", () => {
    const err = new ApiError(500, "Internal Error", "/api/fail");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApiError);
  });
});
