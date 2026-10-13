import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { FORMAT, PUBLIC_TOOLS, RpcError, assertPublicTool, callKey, makeRedactor } from './core.mjs';

export class Recorder {
  constructor(remote, output, secrets = []) {
    this.remote = remote;
    this.output = output;
    this.redact = makeRedactor(secrets);
    this.tape = { format: FORMAT, source: 'live-readonly', endpoint: 'https://mcp.mcd.cn', createdAt: new Date().toISOString(), tools: [], entries: [] };
    this.started = false;
  }
  async initialize() {
    await mkdir(dirname(this.output), { recursive: true, mode: 0o700 });
    // Reserve the output exclusively before any network call; never clobber a tape.
    await writeFile(this.output, '', { flag: 'wx', mode: 0o600 });
    try {
      await this.remote.initialize();
      this.tape.protocolVersion = this.remote.protocolVersion;
      this.tape.tools = (await this.remote.listTools()).filter(tool => PUBLIC_TOOLS.has(tool.name));
      this.started = true;
      await this.flush();
    } catch (error) {
      await unlink(this.output).catch(() => {});
      throw error;
    }
  }
  listTools() { return structuredClone(this.tape.tools); }
  async call(name, args = {}) {
    assertPublicTool(name);
    if (!this.started || !this.tape.tools.some(tool => tool.name === name)) throw new RpcError(-32602, 'Tool is unavailable in this upstream schema snapshot.');
    const startedAt = performance.now();
    const entry = { tool: name, arguments: structuredClone(args), recordedAt: new Date().toISOString() };
    try {
      const result = await this.remote.call(name, args);
      if (!Array.isArray(result?.content)) throw new RpcError(-32000, 'Upstream returned an invalid tool result.');
      entry.result = structuredClone(result);
      return result;
    } catch (error) {
      const safeError = error instanceof RpcError ? error : new RpcError(-32000, 'Upstream call failed.');
      entry.error = safeError.toJSON();
      throw safeError;
    } finally {
      entry.durationMs = Math.round(performance.now() - startedAt);
      this.tape.entries.push(entry);
      await this.flush();
    }
  }
  snapshot() {
    // Tool schemas describe keys, not user values: retain their JSON Schema shape.
    const safeEntries = this.redact(this.tape.entries);
    for (const entry of safeEntries) entry.key = callKey(entry.tool, entry.arguments);
    return { ...this.tape, entries: safeEntries };
  }
  async flush() {
    const temporary = `${this.output}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(this.snapshot(), null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, this.output);
  }
}
