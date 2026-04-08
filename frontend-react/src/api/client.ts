// ─── Base API client with typed HTTP methods ────────────────────────────────

export class ApiClient {
  baseUrl: string;
  apiKey: string | null;

  constructor(baseUrl = "", apiKey: string | null = null) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: this.headers(),
      signal: signal ?? AbortSignal.timeout(15000),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new ApiError(res.status, text, url);
    }
    // Handle 204 No Content
    if (res.status === 204) return undefined as T;
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return res.json() as Promise<T>;
    }
    return res.text() as unknown as T;
  }

  get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>("GET", path, undefined, signal);
  }

  post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>("POST", path, body, signal);
  }

  put<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>("PUT", path, body, signal);
  }

  delete<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>("DELETE", path, undefined, signal);
  }
}

export class ApiError extends Error {
  status: number;
  url: string;

  constructor(status: number, message: string, url: string) {
    super(`API ${status}: ${message} (${url})`);
    this.name = "ApiError";
    this.status = status;
    this.url = url;
  }
}

/** Singleton API client instance */
export const api = new ApiClient();
