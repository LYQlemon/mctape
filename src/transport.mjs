import { RpcError, VERSIONS } from './core.mjs';

const ENDPOINT = 'https://mcp.mcd.cn';

function rpcResult(message, id) {
  if (!message || message.jsonrpc !== '2.0' || message.id !== id) throw new RpcError(-32000, 'Upstream returned an unexpected JSON-RPC response.');
  if (message.error) throw new RpcError(message.error.code, message.error.message, message.error.data);
  if (!Object.hasOwn(message, 'result')) throw new RpcError(-32000, 'Upstream response has no result.');
  return message.result;
}

export async function readResponse(response, id) {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) return rpcResult(await response.json(), id);
  if (!contentType.includes('text/event-stream') || !response.body) throw new RpcError(-32000, 'Expected JSON or SSE from the MCP endpoint.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        bytes += value.byteLength;
        if (bytes > 32 * 1024 * 1024) throw new RpcError(-32000, 'MCP response exceeded 32 MiB.');
        buffer += decoder.decode(value, { stream: true });
      }
      if (done) buffer += decoder.decode();
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        let message;
        try { message = JSON.parse(data); } catch { throw new RpcError(-32000, 'Invalid JSON in an MCP SSE message.'); }
        if (message.id === id) return rpcResult(message, id);
      }
      if (done) throw new RpcError(-32000, 'SSE ended before the matching RPC response.');
    }
  } finally {
    // Complete once the matching response arrives, even when the SSE stays open.
    await reader.cancel().catch(() => {});
  }
}

export class RemoteMcp {
  constructor(token, { fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
    if (!token || /[\r\n]/.test(token)) throw new Error('Set MCD_MCP_TOKEN in the environment before recording.');
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.nextId = 0;
    this.protocolVersion = VERSIONS[0];
    this.sessionId = undefined;
  }
  async send(method, params = {}, notification = false) {
    const id = notification ? undefined : ++this.nextId;
    const headers = { Authorization: `Bearer ${this.token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (method !== 'initialize') headers['MCP-Protocol-Version'] = this.protocolVersion;
    let response;
    try {
      response = await this.fetchImpl(ENDPOINT, {
        method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new RpcError(-32000, `MCP endpoint returned HTTP ${response.status}; no automatic retry was attempted.`, { httpStatus: response.status });
      }
      if (method === 'initialize') this.sessionId = response.headers.get('Mcp-Session-Id') ?? undefined;
      if (notification) { await response.body?.cancel().catch(() => {}); return undefined; }
      return await readResponse(response, id);
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw new RpcError(-32000, 'MCP network, timeout or response decoding failure; no automatic retry was attempted.');
    }
  }
  async initialize() {
    const result = await this.send('initialize', { protocolVersion: VERSIONS[0], capabilities: {}, clientInfo: { name: 'mcd-mctape', version: '0.1.0' } });
    if (!VERSIONS.includes(result.protocolVersion)) throw new RpcError(-32000, 'Upstream selected an unsupported protocol version.');
    this.protocolVersion = result.protocolVersion;
    await this.send('notifications/initialized', {}, true);
  }
  async listTools() {
    const tools = [];
    const cursors = new Set();
    let cursor;
    do {
      const result = await this.send('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(result.tools)) throw new RpcError(-32000, 'Invalid upstream tools/list result.');
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (cursor) {
        if (typeof cursor !== 'string' || cursors.has(cursor) || cursors.size >= 100) throw new RpcError(-32000, 'Invalid or repeated tool pagination cursor.');
        cursors.add(cursor);
      }
    } while (cursor);
    return tools;
  }
  call(name, args) { return this.send('tools/call', { name, arguments: args }); }
}
