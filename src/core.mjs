import { createHash } from 'node:crypto';

export const FORMAT = 'mctape/v1';
export const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
// Deliberately excludes account, address, order and mutation tools.
export const PUBLIC_TOOLS = new Set([
  'now-time-info', 'campaign-calendar', 'list-nutrition-foods',
  'query-meals', 'query-meal-detail', 'calculate-price',
]);

export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
  toJSON() {
    return { code: this.code, message: this.message, ...(this.data === undefined ? {} : { data: this.data }) };
  }
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
  }
  return value;
}

export function callKey(name, args = {}) {
  return createHash('sha256').update(JSON.stringify([name, sorted(args)])).digest('hex');
}

export function toolError(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function assertPublicTool(name) {
  if (!PUBLIC_TOOLS.has(name)) {
    throw new RpcError(-32602, `McTape v0.1 does not expose ${name}. Only the six supported read-only tools are available.`);
  }
}

export function validateTape(tape) {
  if (tape?.format !== FORMAT || !['synthetic', 'live-readonly'].includes(tape.source)) {
    throw new Error('Expected an mctape/v1 tape with an explicit synthetic or live-readonly source.');
  }
  if (!Array.isArray(tape.tools) || !Array.isArray(tape.entries)) throw new Error('Tape tools and entries must be arrays.');
  const names = new Set();
  for (const tool of tape.tools) {
    assertPublicTool(tool?.name);
    if (!tool.inputSchema || names.has(tool.name)) throw new Error('Missing input schema or duplicate tool name.');
    names.add(tool.name);
  }
  for (const entry of tape.entries) {
    if (!names.has(entry.tool) || !entry.arguments || typeof entry.arguments !== 'object' || Array.isArray(entry.arguments)) {
      throw new Error('Every tape entry must reference a listed tool and have object arguments.');
    }
    if (entry.key !== callKey(entry.tool, entry.arguments)) throw new Error('Tape call fingerprint does not match its arguments.');
    if ((entry.result !== undefined) === (entry.error !== undefined)) throw new Error('Each entry needs exactly one result or RPC error.');
    if (entry.result !== undefined && !Array.isArray(entry.result?.content)) throw new Error('Tool result content must be an array.');
    if (entry.error !== undefined && (!Number.isInteger(entry.error.code) || typeof entry.error.message !== 'string')) {
      throw new Error('Invalid recorded RPC error.');
    }
  }
  return tape;
}

const sensitiveKey = /authorization|bearer|token|secret|password|cookie|phone|mobile|email|address|recipient|contact|userId|userName|openId|unionId|orderId|orderNo|couponId|couponCode|sessionId|payUrl|paymentUrl|pickupCode|取餐码|手机号|收货|姓名|密码|令牌/i;

// A tape is local debugging data, not automatically safe to publish. Free-form text
// still needs human review. A shared mapping preserves opaque-ID relationships.
export function makeRedactor(secrets = []) {
  const aliases = new Map();
  const knownSecrets = secrets.filter(s => typeof s === 'string' && s.length > 0);
  function alias(value) {
    const key = JSON.stringify(value);
    if (!aliases.has(key)) aliases.set(key, `[REDACTED_${aliases.size + 1}]`);
    return aliases.get(key);
  }
  function collect(value) {
    if (Array.isArray(value)) return value.forEach(collect);
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (sensitiveKey.test(key)) alias(item);
        else collect(item);
      }
    } else if (typeof value === 'string') {
      try { collect(JSON.parse(value)); } catch { /* free-form text */ }
    }
  }
  function scrub(value) {
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitiveKey.test(key) ? alias(item) : scrub(item)]));
    }
    if (typeof value !== 'string') return value;
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return JSON.stringify(scrub(parsed));
    } catch { /* text is not JSON */ }
    let text = value;
    for (const secret of knownSecrets) text = text.split(secret).join('[REDACTED_SECRET]');
    for (const [raw, replacement] of aliases) {
      const original = JSON.parse(raw);
      if (typeof original === 'string' && original.length >= 4) text = text.split(original).join(replacement);
    }
    return text.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
      .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[REDACTED_PHONE]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
      .replace(/([?&](?:token|access_token|api_key|key|secret)=)[^&#\s]+/gi, '$1[REDACTED]');
  }
  return value => { collect(value); return scrub(value); };
}

export function scenarioFaults(scenario = 'normal') {
  const scenarios = {
    normal: [],
    'coupon-expired': [{ tool: 'calculate-price', onCall: 1, kind: 'tool-error', message: 'SIMULATED_COUPON_EXPIRED: this coupon expired after menu selection.' }],
    'rate-limited': [{ tool: 'query-meals', onCall: 1, kind: 'rpc-error', code: -32000, message: 'SIMULATED_HTTP_429: upstream rate limit.', data: { simulated: true, httpStatus: 429 } }],
    slow: [{ tool: 'query-meals', onCall: 1, kind: 'delay', ms: 250 }],
    'empty-menu': [{ tool: 'query-meals', onCall: 1, kind: 'replace', result: { content: [{ type: 'text', text: '{"items":[]}' }], structuredContent: { items: [] } } }],
    'missing-price': [{ tool: 'calculate-price', onCall: 1, kind: 'drop-field', path: ['structuredContent', 'totalPrice'] }],
  };
  if (!Object.hasOwn(scenarios, scenario)) throw new Error(`Unknown scenario: ${scenario}`);
  return structuredClone(scenarios[scenario]);
}

export function validateFaults(faults) {
  if (!Array.isArray(faults)) throw new Error('Faults must be an array.');
  const kinds = new Set(['tool-error', 'rpc-error', 'delay', 'replace', 'drop-field']);
  for (const fault of faults) {
    assertPublicTool(fault.tool);
    if (!kinds.has(fault.kind) || !Number.isInteger(fault.onCall) || fault.onCall < 1) throw new Error('Invalid fault kind or onCall occurrence.');
    if (fault.kind === 'delay' && (!Number.isFinite(fault.ms) || fault.ms < 0 || fault.ms > 30000)) throw new Error('Delay must be between 0 and 30000 ms.');
    if (fault.kind === 'drop-field' && (!Array.isArray(fault.path) || !fault.path.length || fault.path.some(p => typeof p !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(p)))) throw new Error('Invalid fault path.');
    if (fault.kind === 'replace' && !Array.isArray(fault.result?.content)) throw new Error('Replacement needs an MCP tool result.');
    if (fault.kind === 'rpc-error' && !Number.isInteger(fault.code)) throw new Error('RPC error code must be an integer.');
  }
  return faults;
}

export class Replay {
  constructor(tape, faults = []) {
    this.tape = validateTape(tape);
    this.faults = validateFaults(faults);
    this.used = new Set();
    this.counts = new Map();
    this.trace = [];
  }
  listTools() {
    return this.tape.tools.map(tool => ({
      ...structuredClone(tool),
      description: `[McTape OFFLINE REPLAY; source=${this.tape.source}] ${tool.description ?? ''}`,
    }));
  }
  async call(name, args = {}) {
    assertPublicTool(name);
    if (!this.tape.tools.some(tool => tool.name === name)) throw new RpcError(-32602, 'Tool is not present in this tape schema snapshot.');
    const key = callKey(name, args);
    const index = this.tape.entries.findIndex((entry, i) => !this.used.has(i) && entry.key === key);
    if (index < 0) {
      this.trace.push({ tool: name, outcome: 'unmatched', key });
      return toolError('MCTAPE_NO_MATCH: no unused recording matches these exact arguments. Replay never falls back to the live server.');
    }
    this.used.add(index);
    const occurrence = (this.counts.get(name) ?? 0) + 1;
    this.counts.set(name, occurrence);
    const entry = this.tape.entries[index];
    let result = structuredClone(entry.result);
    const active = this.faults.filter(f => f.tool === name && f.onCall === occurrence);
    try {
      if (entry.error) throw new RpcError(entry.error.code, entry.error.message, entry.error.data);
      for (const fault of active) {
        if (fault.kind === 'tool-error') result = toolError(fault.message ?? 'SIMULATED_TOOL_ERROR');
        if (fault.kind === 'rpc-error') throw new RpcError(fault.code, fault.message ?? 'SIMULATED_RPC_ERROR', fault.data);
        if (fault.kind === 'delay') await new Promise(resolve => setTimeout(resolve, fault.ms));
        if (fault.kind === 'replace') result = structuredClone(fault.result);
        if (fault.kind === 'drop-field') {
          let target = result;
          for (const part of fault.path.slice(0, -1)) target = target?.[part];
          const last = fault.path.at(-1);
          if (!target || !Object.hasOwn(target, last)) throw new RpcError(-32602, 'Fault path is absent in this recording; configure a path from the actual response.');
          delete target[last];
          if (fault.path[0] === 'structuredContent') result.content = [{ type: 'text', text: JSON.stringify(result.structuredContent) }];
        }
      }
      result._meta = { ...result._meta, mctape: { replay: true, source: this.tape.source, recordedAt: entry.recordedAt, injected: active.map(f => f.kind) } };
      result.content.unshift({ type: 'text', text: `[McTape offline replay: ${this.tape.source}${active.length ? '; simulated fault' : ''}. This is not a current McDonald’s quote.]` });
      this.trace.push({ tool: name, occurrence, outcome: result.isError ? 'tool-error' : 'result', faults: active.map(f => f.kind) });
      return result;
    } catch (error) {
      this.trace.push({ tool: name, occurrence, outcome: 'rpc-error', faults: active.map(f => f.kind) });
      throw error;
    }
  }
}

export class McpServer {
  constructor(backend) { this.backend = backend; this.phase = 'new'; }
  async handle(message) {
    const id = message?.id ?? null;
    const hasId = message && Object.hasOwn(message, 'id');
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
        (hasId && !(typeof message.id === 'string' || (typeof message.id === 'number' && Number.isFinite(message.id))))) {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
    }
    if (!hasId) {
      if (message.method === 'notifications/initialized' && this.phase === 'initialized') this.phase = 'ready';
      return null;
    }
    try {
      let result;
      if (message.method === 'initialize') {
        if (this.phase !== 'new') throw new RpcError(-32600, 'Already initialized');
        if (!message.params || typeof message.params.protocolVersion !== 'string') throw new RpcError(-32602, 'Missing protocolVersion');
        await this.backend.initialize?.();
        this.phase = 'initialized';
        result = { protocolVersion: VERSIONS.includes(message.params.protocolVersion) ? message.params.protocolVersion : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: 'mcd-mctape', version: '0.1.0' }, instructions: this.backend instanceof Replay ? 'OFFLINE recording replay. All returned prices, menus and errors are historical or synthetic; never treat them as live.' : 'Read-only recording bridge. Only six supported tools are exposed.' };
      } else if (message.method === 'ping') {
        result = {};
      } else {
        if (this.phase !== 'ready') throw new RpcError(-32002, 'Complete initialize and notifications/initialized first.');
        if (message.method === 'tools/list') result = { tools: await this.backend.listTools() };
        else if (message.method === 'tools/call') {
          const params = message.params;
          if (!params || typeof params.name !== 'string' || (params.arguments !== undefined && (!params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments)))) throw new RpcError(-32602, 'Expected tool name and object arguments.');
          result = await this.backend.call(params.name, params.arguments ?? {});
        } else throw new RpcError(-32601, 'Method not found');
      }
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      return { jsonrpc: '2.0', id, error: error instanceof RpcError ? error.toJSON() : { code: -32603, message: 'McTape could not complete the request.' } };
    }
  }
}
