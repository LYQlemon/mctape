#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { McpServer, Replay, makeRedactor, scenarioFaults, validateTape } from '../src/core.mjs';
import { Recorder } from '../src/recorder.mjs';
import { RemoteMcp } from '../src/transport.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultTape = resolve(root, 'fixtures/demo.json');

async function loadTape(path) { return validateTape(JSON.parse(await readFile(path, 'utf8'))); }

async function stdio(backend) {
  const server = new McpServer(backend);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); }
    catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      continue;
    }
    const response = await server.handle(message);
    if (response) process.stdout.write(JSON.stringify(response) + '\n');
  }
}

function report(tape) {
  const counts = new Map();
  let errors = 0;
  for (const entry of tape.entries) {
    counts.set(entry.tool, (counts.get(entry.tool) ?? 0) + 1);
    if (entry.error || entry.result?.isError) errors++;
  }
  return {
    format: tape.format, source: tape.source, createdAt: tape.createdAt,
    calls: tape.entries.length, recordedErrors: errors,
    averageDurationMs: tape.entries.length ? Math.round(tape.entries.reduce((sum, e) => sum + (e.durationMs ?? 0), 0) / tape.entries.length) : null,
    tools: Object.fromEntries(counts),
    note: 'A successful replay verifies reproducibility, not the behavior of a consuming Skill. Replay prices are not current quotes.',
  };
}

async function demo() {
  const tape = await loadTape(defaultTape);
  console.log('McTape · 麦麦录放机\n演示来源：synthetic（全部虚构，不连接麦当劳）\n');
  for (const scenario of ['normal', 'coupon-expired', 'rate-limited', 'empty-menu', 'missing-price', 'slow']) {
    const replay = new Replay(tape, scenarioFaults(scenario));
    const outcomes = [];
    for (const entry of tape.entries) {
      try {
        const result = await replay.call(entry.tool, entry.arguments);
        const missing = entry.tool === 'calculate-price' && result.structuredContent?.totalPrice === undefined;
        const empty = entry.tool === 'query-meals' && result.structuredContent?.items?.length === 0;
        outcomes.push(result.isError ? `${entry.tool}: tool error` : missing ? `${entry.tool}: price missing` : empty ? `${entry.tool}: empty menu` : `${entry.tool}: result`);
      } catch (error) { outcomes.push(`${entry.tool}: RPC error ${error.code}`); }
    }
    console.log(`${scenario}\n  ${outcomes.join('\n  ')}\n`);
  }
  const replay = new Replay(tape);
  const mismatch = await replay.call('query-meals', { storeCode: 'UNRECORDED_STORE', beType: 1 });
  console.log(`参数不匹配 → ${mismatch.content[0].text}\n\n接入 Agent：node bin/mctape.mjs config（输出 stdio MCP 配置）`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { tape: { type: 'string' }, out: { type: 'string' }, scenario: { type: 'string' }, faults: { type: 'string' }, mode: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  const command = positionals[0] ?? 'help';
  if (values.help || command === 'help') {
    console.log(`McTape v0.1 — Node.js 22+, no dependencies
  node bin/mctape.mjs demo
  node bin/mctape.mjs report --tape <file.json>
  node bin/mctape.mjs replay --tape <file.json> [--scenario normal|coupon-expired|rate-limited|slow|empty-menu|missing-price] [--faults <faults.json>]
  node bin/mctape.mjs record --out <new-file.json>
  node bin/mctape.mjs schemas
  node bin/mctape.mjs config [--mode replay|record] [--tape <file.json>] [--out <new-file.json>]

replay and record are stdio MCP servers. schemas and record require MCD_MCP_TOKEN.
Replay has no live fallback. Built-in empty-menu/missing-price shapes target the synthetic demo; use custom faults for live recordings.`);
    return;
  }
  if (positionals.length !== 1) throw new Error('Expected exactly one command.');
  if (command === 'demo') return demo();
  if (command === 'config') {
    const mode = values.mode ?? 'replay';
    if (!['record', 'replay'].includes(mode)) throw new Error('Config mode must be replay or record.');
    const args = [resolve(root, 'bin/mctape.mjs'), mode];
    if (mode === 'replay') {
      args.push('--tape', resolve(values.tape ?? defaultTape));
      if (values.scenario) args.push('--scenario', values.scenario);
      if (values.faults) args.push('--faults', resolve(values.faults));
    } else {
      if (!values.out) throw new Error('Recording config requires --out for a new tape file.');
      args.push('--out', resolve(values.out));
    }
    return console.log(JSON.stringify({ mcpServers: { [`mctape-${mode}`]: { command: process.execPath, args } } }, null, 2));
  }
  if (command === 'report') return console.log(JSON.stringify(report(await loadTape(resolve(values.tape ?? defaultTape))), null, 2));
  if (command === 'replay') {
    const faults = values.faults ? JSON.parse(await readFile(resolve(values.faults), 'utf8')) : scenarioFaults(values.scenario);
    return stdio(new Replay(await loadTape(resolve(values.tape ?? defaultTape)), faults));
  }
  if (command === 'record') {
    if (!values.out) throw new Error('record requires --out pointing to a new tape file.');
    const remote = new RemoteMcp(process.env.MCD_MCP_TOKEN);
    const recorder = new Recorder(remote, resolve(values.out), [process.env.MCD_MCP_TOKEN]);
    process.stderr.write('[McTape] Read-only recording bridge. Live tape files stay local; review them before sharing.\n');
    return stdio(recorder);
  }
  if (command === 'schemas') {
    const remote = new RemoteMcp(process.env.MCD_MCP_TOKEN);
    await remote.initialize();
    const { PUBLIC_TOOLS } = await import('../src/core.mjs');
    return console.log(JSON.stringify((await remote.listTools()).filter(tool => PUBLIC_TOOLS.has(tool.name)), null, 2));
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch(error => {
  const redact = makeRedactor([process.env.MCD_MCP_TOKEN]);
  process.stderr.write(`McTape: ${redact(error.message)}\n`);
  process.exitCode = 1;
});
