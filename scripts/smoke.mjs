#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { makeRedactor, validateTape } from '../src/core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(root, 'bin/mctape.mjs');
const { values } = parseArgs({ options: { offline: { type: 'boolean' }, tape: { type: 'string' } } });
const redact = makeRedactor([process.env.MCD_MCP_TOKEN]);

function ensure(condition, message) { if (!condition) throw new Error(message); }
function requests(entries) {
  return [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mctape-smoke', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ...entries.map((entry, index) => ({ jsonrpc: '2.0', id: index + 3, method: 'tools/call', params: { name: entry.tool, arguments: entry.arguments } })),
  ].map(message => JSON.stringify(message)).join('\n') + '\n';
}
function run(args, entries) {
  const caFlags = process.execArgv.filter(arg => arg === '--use-system-ca');
  const child = spawnSync(process.execPath, [...caFlags, cli, ...args], {
    cwd: root, input: requests(entries), encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
  });
  ensure(!child.error, `测试进程未完成：${child.error?.code ?? 'unknown'}`);
  ensure(child.status === 0, `测试进程退出失败：${redact(child.stderr.trim())}`);
  const responses = child.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  ensure(responses.length === entries.length + 2, 'MCP 响应数量与请求不一致。');
  ensure(responses[0].result?.serverInfo?.name === 'mcd-mctape', 'MCP 初始化失败。');
  ensure(Array.isArray(responses[1].result?.tools), 'MCP 工具发现失败。');
  responses.slice(2).forEach((response, index) => ensure(response.id === index + 3, 'MCP 响应 ID 不一致。'));
  return responses.slice(2);
}

async function main() {
  const tag = new Date().toISOString().replace(/[:.]/g, '-');
  let tapePath;
  if (values.offline) {
    tapePath = values.tape ? resolve(values.tape) : resolve(root, 'fixtures/demo.json');
    console.log('模式：离线测试，不访问麦当劳服务。');
  } else {
    ensure(!values.tape, '--tape 仅适用于 --offline。');
    ensure(process.env.MCD_MCP_TOKEN, '请先在 .env.local 中填写 MCD_MCP_TOKEN。');
    tapePath = resolve(root, `tapes/smoke-${tag}.json`);
    const entries = [
      { tool: 'now-time-info', arguments: {} },
      { tool: 'query-meals', arguments: { storeCode: '1450713', orderType: 1, beType: 1 } },
      { tool: 'query-meal-detail', arguments: { storeCode: '1450713', orderType: 1, beType: 1, code: '1440' } },
      { tool: 'calculate-price', arguments: { storeCode: '1450713', orderType: 1, beType: 1, items: [{ productCode: '1440', quantity: 1 }] } },
    ];
    console.log('模式：真实只读测试，上海华旭国际大厦餐厅／麦辣鸡腿汉堡；不创建订单。');
    console.log('正在连接官方服务并录制 4 次查询／试算……');
    const responses = run(['record', '--out', tapePath], entries);
    responses.forEach((response, index) => ensure(!response.error && !response.result?.isError && response.result?.structuredContent?.success === true && response.result?.structuredContent?.code === 200, `${entries[index].tool} 业务调用失败；详情保存在本次 tape。`));
    console.log('PASS 真实连接、工具发现与 4 次业务查询／试算');
    const amount = responses[3].result.structuredContent.data?.price;
    ensure(Number.isInteger(amount), '官方试算缺少整数分金额 data.price。');
    console.log(`本次单品试算：¥${(amount / 100).toFixed(2)}（以当前返回为准）`);
  }
  const tape = validateTape(JSON.parse(await readFile(tapePath, 'utf8')));
  ensure(tape.entries.length > 0, '录制文件为空。');
  const normal = run(['replay', '--tape', tapePath], tape.entries);
  tape.entries.forEach((entry, index) => {
    if (entry.error) ensure(isDeepStrictEqual(normal[index].error, entry.error), '录制的 RPC 错误回放不一致。');
    else {
      ensure(isDeepStrictEqual(normal[index].result?.structuredContent, entry.result.structuredContent), '结构化回放结果不一致。');
      ensure(isDeepStrictEqual(normal[index].result?.content?.slice(1), entry.result.content), '文本或其他内容回放不一致。');
      ensure(normal[index].result?._meta?.mctape?.source === tape.source, '回放来源标签不一致。');
    }
  });
  console.log(`PASS stdio 离线回放：${tape.entries.length} 次响应与录制一致`);
  const reports = resolve(root, 'reports');
  await mkdir(reports, { recursive: true, mode: 0o700 });
  const priceIndex = tape.entries.findIndex(entry => entry.tool === 'calculate-price' && entry.result);
  ensure(priceIndex >= 0, '异常测试需要一条 calculate-price 的成功录制。');
  const result = tape.entries[priceIndex].result;
  const path = Object.hasOwn(result.structuredContent?.data ?? {}, 'price') ? ['structuredContent', 'data', 'price'] : ['structuredContent', 'totalPrice'];
  let check = result;
  for (const key of path) { ensure(check != null && Object.hasOwn(check, key), '未找到价格字段，不能声称故障注入成功。'); check = check[key]; }
  const faultPath = resolve(reports, `smoke-fault-${tag}.json`);
  await writeFile(faultPath, JSON.stringify([{ tool: 'calculate-price', onCall: 1, kind: 'drop-field', path }]), { flag: 'wx', mode: 0o600 });
  const missing = run(['replay', '--tape', tapePath, '--faults', faultPath], tape.entries);
  let changed = missing[priceIndex].result;
  for (const key of path.slice(0, -1)) changed = changed?.[key];
  ensure(changed && !Object.hasOwn(changed, path.at(-1)), '报价字段缺失故障没有生效。');
  ensure(missing[priceIndex].result?._meta?.mctape?.injected?.includes('drop-field'), '缺少注入来源标签。');
  console.log(`PASS 报价缺字段注入：${path.join('.')}`);
  const menuIndex = tape.entries.findIndex(entry => entry.tool === 'query-meals');
  ensure(menuIndex >= 0, '限流测试需要一条 query-meals 录制。');
  const limited = run(['replay', '--tape', tapePath, '--scenario', 'rate-limited'], tape.entries);
  ensure(limited[menuIndex].error?.data?.httpStatus === 429 && limited[menuIndex].error?.data?.simulated === true, '模拟限流没有生效。');
  console.log('PASS 模拟限流注入：query-meals 返回带模拟 429 信息的 RPC 错误');
  console.log(`全部功能检查通过。录制文件：${tapePath}`);
  console.log('这些检查验证 McTape 本身，不包含第三方 Skill 的行为评测。');
}
main().catch(error => { console.error(`FAIL ${redact(error.message)}`); process.exitCode = 1; });
