/**
 * Minimal MCP Streamable HTTP client for the relay service on 127.0.0.1.
 * Each call opens a short MCP session at mcp-proxy; the proxy keeps ONE
 * chrome-devtools-mcp process and therefore one DevTools connection to Chrome,
 * so new sessions here never cause a new "Allow remote debugging?" dialog.
 */

export const PROTOCOL_VERSION = '2025-03-26';

export type JsonRpcMessage = { jsonrpc: '2.0'; id?: number | string; method?: string; result?: any; error?: { code: number; message: string } };

/** Pull JSON-RPC messages out of an SSE body (`data:` lines, events split by blank lines). */
export function parseSse(text: string): JsonRpcMessage[] {
  const out: JsonRpcMessage[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data.trim()) continue;
    try { out.push(JSON.parse(data)); } catch { /* keep-alive or partial event */ }
  }
  return out;
}

/** Response body → messages, for both JSON and SSE answers. */
export function parseBody(contentType: string | null, text: string): JsonRpcMessage[] {
  if ((contentType ?? '').includes('text/event-stream')) return parseSse(text);
  if (!text.trim()) return [];
  const v = JSON.parse(text);
  return Array.isArray(v) ? v : [v];
}

async function readUntilId(res: Response, id: number, signal?: AbortSignal): Promise<JsonRpcMessage | null> {
  const ct = res.headers.get('content-type');
  if (!(ct ?? '').includes('text/event-stream') || !res.body) {
    return parseBody(ct, await res.text()).find(m => m.id === id) ?? null;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      const hit = parseSse(buf).find(m => m.id === id);
      if (hit) return hit;
      if (done) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return null;
}

export class McpHttpClient {
  private session: string | null = null;
  private nextId = 1;
  private url: string;
  private signal?: AbortSignal;
  constructor(url: string, signal?: AbortSignal) {
    this.url = url;
    this.signal = signal;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL_VERSION };
    if (this.session) h['Mcp-Session-Id'] = this.session;
    return h;
  }

  async request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    // Stop: tell the service to cancel this request too (MCP notifications/cancelled), not just stop waiting.
    const cancel = () => { void fetch(this.url, { method: 'POST', headers: this.headers(), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: String(this.signal?.reason ?? 'cancelled') } }), signal: AbortSignal.timeout(5_000) }).then(r => r.text()).catch(() => ''); };
    this.signal?.addEventListener('abort', cancel, { once: true });
    try {
      return await this.send(id, method, params);
    } finally {
      this.signal?.removeEventListener('abort', cancel);
    }
  }

  private async send(id: number, method: string, params: unknown): Promise<any> {
    const res = await fetch(this.url, { method: 'POST', headers: this.headers(), body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: this.signal });
    if (!res.ok) throw new Error(`MCP ${method}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    const msg = await readUntilId(res, id, this.signal);
    if (!msg) throw new Error(`MCP ${method}: нет ответа`);
    if (msg.error) throw new Error(`MCP ${method}: ${msg.error.message}`);
    return msg.result;
  }

  async notify(method: string): Promise<void> {
    const res = await fetch(this.url, { method: 'POST', headers: this.headers(), body: JSON.stringify({ jsonrpc: '2.0', method }), signal: this.signal });
    await res.text().catch(() => '');
  }

  async initialize(): Promise<{ name: string; version: string }> {
    const r = await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'bb-browser-relay', version: '0.2.0' } });
    await this.notify('notifications/initialized');
    return r?.serverInfo ?? { name: 'unknown', version: '' };
  }

  async close(): Promise<void> {
    if (!this.session) return;
    await fetch(this.url, { method: 'DELETE', headers: this.headers() }).then(r => r.text()).catch(() => '');
    this.session = null;
  }
}

export type ToolContent = { type: string; text?: string; data?: string; mimeType?: string; resource?: { uri?: string; text?: string } };

/** Render tool content as bounded text; images are handed back separately for saving. */
export function renderContent(content: ToolContent[], maxChars: number): { text: string; images: { data: string; mimeType: string }[] } {
  const parts: string[] = [];
  const images: { data: string; mimeType: string }[] = [];
  for (const c of content ?? []) {
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c.type === 'image' && c.data) images.push({ data: c.data, mimeType: c.mimeType ?? 'image/png' });
    else if (c.type === 'resource' && c.resource?.text) parts.push(c.resource.text);
    else parts.push(`[${c.type}]`);
  }
  let text = parts.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n… [обрезано: ${text.length - maxChars} знаков]`;
  return { text, images };
}
