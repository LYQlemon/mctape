import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callKey, makeRedactor, McpServer, Replay, RpcError, scenarioFaults, validateTape } from '../src/core.mjs';
import { Recorder } from '../src/recorder.mjs';
import { RemoteMcp, readResponse } from '../src/transport.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/demo.json', import.meta.url), 'utf8'));
const tape = () => structuredClone(fixture);
const menu = fixture.entries[1];
const price = fixture.entries[3];
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };

test('call fingerprints normalize object keys but preserve array order and scalar types', () => {
  assert.equal(callKey('x', { b: 2, a: { z: 3, c: 4 } }), callKey('x', { a: { c: 4, z: 3 }, b: 2 }));
  assert.notEqual(callKey('x', { a: [1, 2] }), callKey('x', { a: [2, 1] }));
  assert.notEqual(callKey('x', { a: 1 }), callKey('x', { a: '1' }));
});

test('replay consumes exact matches once; changed store never reaches a live fallback', async () => {
  const replay = new Replay(tape());
  const result = await replay.call(menu.tool, menu.arguments);
  assert.deepEqual(result.structuredContent, menu.result.structuredContent);
  assert.equal(result._meta.mctape.source, 'synthetic');
  assert.match(result.content[0].text, /not a current/);
  assert.equal((await replay.call(menu.tool, menu.arguments)).isError, true);
  assert.equal((await replay.call(menu.tool, { ...menu.arguments, storeCode: 'OTHER' })).isError, true);
  await assert.rejects(replay.call('campaign-calendar', {}), error => error.code === -32602);
});

test('repeated identical calls retain response order', async () => {
  const recording = tape();
  const second = structuredClone(menu);
  second.result.structuredContent.items = [];
  recording.entries.push(second);
  const replay = new Replay(recording);
  assert.equal((await replay.call(menu.tool, menu.arguments)).structuredContent.items.length, 1);
  assert.equal((await replay.call(menu.tool, menu.arguments)).structuredContent.items.length, 0);
});

test('tampered fingerprints and mutation tools are rejected', () => {
  const bad = tape();
  bad.entries[0].key = 'changed';
  assert.throws(() => validateTape(bad), /fingerprint/);
  bad.tools.push({ name: 'create-order', inputSchema: { type: 'object' } });
  assert.throws(() => new Replay(bad), /does not expose/);
});

test('coupon expiry is an explicit tool error, not a successful quote', async () => {
  const replay = new Replay(tape(), scenarioFaults('coupon-expired'));
  const result = await replay.call(price.tool, price.arguments);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.match(result.content[1].text, /SIMULATED_COUPON_EXPIRED/);
});

test('rate limit injection produces an RPC error with simulated transport metadata', async () => {
  const replay = new Replay(tape(), scenarioFaults('rate-limited'));
  await assert.rejects(replay.call(menu.tool, menu.arguments), error => error.code === -32000 && error.data.httpStatus === 429 && error.data.simulated);
});

test('missing-price removes the field from both structured and textual results', async () => {
  const replay = new Replay(tape(), scenarioFaults('missing-price'));
  const result = await replay.call(price.tool, price.arguments);
  assert.equal(result.structuredContent.totalPrice, undefined);
  assert.equal(JSON.parse(result.content[1].text).totalPrice, undefined);
});

test('empty-menu differs from a transport or tool error', async () => {
  const replay = new Replay(tape(), scenarioFaults('empty-menu'));
  const result = await replay.call(menu.tool, menu.arguments);
  assert.deepEqual(result.structuredContent.items, []);
  assert.ok(!result.isError);
});

test('fault occurrence targets only the selected call', async () => {
  const recording = tape();
  recording.entries.push(structuredClone(price));
  const replay = new Replay(recording, [{ tool: price.tool, onCall: 2, kind: 'tool-error', message: 'second call' }]);
  assert.ok(!(await replay.call(price.tool, price.arguments)).isError);
  assert.equal((await replay.call(price.tool, price.arguments)).isError, true);
});

test('invalid fault paths and excessive delays cannot silently corrupt the result', async () => {
  assert.throws(() => new Replay(tape(), [{ tool: menu.tool, onCall: 1, kind: 'delay', ms: 30001 }]), /Delay/);
  assert.throws(() => new Replay(tape(), [{ tool: menu.tool, onCall: 1, kind: 'drop-field', path: ['__proto__'] }]), /path/);
  const replay = new Replay(tape(), [{ tool: price.tool, onCall: 1, kind: 'drop-field', path: ['structuredContent', 'missing'] }]);
  await assert.rejects(replay.call(price.tool, price.arguments), /absent/);
});

test('redaction handles nested objects, JSON text, shared coupon IDs, phones and token literals', () => {
  const scrub = makeRedactor(['unit-test-secret']);
  const value = scrub({ arguments: { couponId: 'coupon-private-123' }, result: { token: 'unit-test-secret', text: '{"couponId":"coupon-private-123","note":"Bearer unit-test-secret 13800138000 user@example.com"}' } });
  const encoded = JSON.stringify(value);
  for (const secret of ['unit-test-secret', 'coupon-private-123', '13800138000', 'user@example.com']) assert.ok(!encoded.includes(secret));
  assert.equal(value.arguments.couponId, JSON.parse(value.result.text).couponId);
});

test('MCP initialization lifecycle, tool listing and mutation rejection', async () => {
  const server = new McpServer(new Replay(tape()));
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).error.code, -32002);
  assert.equal((await server.handle(initialize)).result.serverInfo.name, 'mcd-mctape');
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.equal(list.result.tools.length, 4);
  assert.match(list.result.tools[0].description, /OFFLINE REPLAY/);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create-order', arguments: {} } })).error.code, -32602);
});

test('MCP rejects malformed requests and never responds to ordinary notifications', async () => {
  const server = new McpServer(new Replay(tape()));
  for (const message of [null, [], { jsonrpc: '1.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: null, method: 'ping' }]) {
    assert.equal((await server.handle(message)).error.code, -32600);
  }
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }), null);
});

test('stdio integration emits only JSON-RPC lines, handles parse errors and resolves calls', () => {
  const messages = [initialize, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 'list', method: 'tools/list' }, { jsonrpc: '2.0', id: 'menu', method: 'tools/call', params: { name: menu.tool, arguments: menu.arguments } }];
  const cli = fileURLToPath(new URL('../bin/mctape.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [cli, 'replay'], { input: 'invalid json\n' + messages.map(m => JSON.stringify(m)).join('\n') + '\n', encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  const lines = child.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 4);
  assert.equal(lines[0].error.code, -32700);
  assert.equal(lines[3].id, 'menu');
  assert.equal(lines[3].result.structuredContent.items[0].code, 'DEMO_COMBO');
});

test('SSE decoding handles split CRLF frames and returns before the stream closes', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of [': heartbeat\r\n\r', '\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n', 'data: {"jsonrpc":"2.0","id":7,\r\ndata: "result":{"ok":true}}\r\n\r\n']) controller.enqueue(new TextEncoder().encode(chunk));
    },
    cancel() { cancelled = true; },
  });
  const result = await readResponse(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }), 7);
  assert.deepEqual(result, { ok: true });
  assert.equal(cancelled, true);
});

test('SSE EOF and mismatched JSON response IDs fail explicitly', async () => {
  await assert.rejects(readResponse(new Response('data: {"jsonrpc":"2.0","id":9,"result":{}}\n\n', { headers: { 'content-type': 'text/event-stream' } }), 7), /ended/);
  await assert.rejects(readResponse(new Response('{"jsonrpc":"2.0","id":9,"result":{}}', { headers: { 'content-type': 'application/json' } }), 7), /unexpected/);
});

test('Streamable HTTP negotiates sessions, sends headers and follows tool pagination', async () => {
  const calls = [];
  const remote = new RemoteMcp('test-token', { fetchImpl: async (url, options) => {
    const request = JSON.parse(options.body);
    calls.push({ url, ...options, request });
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result;
    if (request.method === 'initialize') result = { protocolVersion: '2025-03-26' };
    else result = request.params.cursor ? { tools: [fixture.tools[1]] } : { tools: [fixture.tools[0]], nextCursor: 'page-2' };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'content-type': 'application/json', ...(request.method === 'initialize' ? { 'Mcp-Session-Id': 'test-session' } : {}) } });
  } });
  await remote.initialize();
  const tools = await remote.listTools();
  assert.equal(tools.length, 2);
  assert.equal(calls[1].headers['Mcp-Session-Id'], 'test-session');
  assert.equal(calls[1].headers['MCP-Protocol-Version'], '2025-03-26');
  assert.equal(calls[0].headers.Accept, 'application/json, text/event-stream');
  assert.equal(calls[0].url, 'https://mcp.mcd.cn');
  assert.equal(calls[0].redirect, 'error');
});

test('HTTP 429 and network errors are surfaced without automatic retries', async () => {
  let attempts = 0;
  const remote = new RemoteMcp('test-token', { fetchImpl: async () => { attempts++; return new Response(null, { status: 429 }); } });
  await assert.rejects(remote.send('tools/list'), error => error.data.httpStatus === 429);
  assert.equal(attempts, 1);
  const broken = new RemoteMcp('test-token', { fetchImpl: async () => { throw new Error('raw credential value'); } });
  await assert.rejects(broken.send('tools/list'), error => !error.message.includes('raw credential'));
});

test('recorder captures schemas and redacted responses, preserves JSON Schema and file permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mctape-test-'));
  try {
    const output = join(dir, 'live.json');
    let mutations = 0;
    const remote = {
      protocolVersion: '2025-06-18', async initialize() {},
      async listTools() { return [...fixture.tools, { name: 'create-order', inputSchema: { type: 'object' } }]; },
      async call() { mutations++; return { content: [{ type: 'text', text: '{"couponId":"private-coupon","token":"recording-secret"}' }], structuredContent: { couponId: 'private-coupon' } }; },
    };
    const recorder = new Recorder(remote, output, ['recording-secret']);
    await recorder.initialize();
    await assert.rejects(recorder.call('create-order', {}), /does not expose/);
    assert.equal(mutations, 0);
    await recorder.call('calculate-price', { couponId: 'private-coupon' });
    const recording = JSON.parse(await readFile(output, 'utf8'));
    validateTape(recording);
    assert.equal(recording.tools.length, 4);
    assert.deepEqual(recording.tools[3].inputSchema, fixture.tools[3].inputSchema);
    assert.ok(!JSON.stringify(recording).includes('private-coupon'));
    assert.ok(!JSON.stringify(recording).includes('recording-secret'));
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal((await new Replay(recording).call(recording.entries[0].tool, recording.entries[0].arguments))._meta.mctape.source, 'live-readonly');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('recorder never overwrites an existing tape and records upstream RPC failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mctape-test-'));
  try {
    const output = join(dir, 'live.json');
    let initializationCalls = 0;
    const remote = { protocolVersion: '2025-06-18', async initialize() { initializationCalls++; }, async listTools() { return fixture.tools; }, async call() { throw new RpcError(-32000, 'failure', { httpStatus: 429 }); } };
    const recorder = new Recorder(remote, output);
    await recorder.initialize();
    await assert.rejects(recorder.call(menu.tool, menu.arguments), /failure/);
    const saved = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(saved.entries[0].error.data.httpStatus, 429);
    await assert.rejects(new Replay(saved).call(menu.tool, menu.arguments), /failure/);
    await assert.rejects(new Recorder(remote, output).initialize(), /EEXIST/);
    assert.equal(initializationCalls, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
