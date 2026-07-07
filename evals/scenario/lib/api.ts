// Minimal Paperclip API client for the live scenario runner. Uses global fetch
// (Node >= 18). Every mutating call carries the run-id audit header, matching
// the harness contract.

export interface ApiClientOptions {
  baseUrl: string;
  apiKey: string;
  runId?: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`${method} ${path} -> ${status}: ${body.slice(0, 300)}`);
    this.name = "ApiError";
  }
}

export class ApiClient {
  constructor(private readonly opts: ApiClientOptions) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    // local_trusted loopback servers accept unauthenticated calls; only send a
    // bearer when a key is configured.
    if (this.opts.apiKey) h["Authorization"] = `Bearer ${this.opts.apiKey}`;
    if (this.opts.runId) h["X-Paperclip-Run-Id"] = this.opts.runId;
    return h;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.opts.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, method, path, text);
    return (text ? JSON.parse(text) : null) as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }
}
