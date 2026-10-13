# McTape · 麦麦录放机

**录一次麦当劳 MCP 的真实只读调用，把这次对话变成可离线复现的调试素材。**

McTape 是给 Skill 开发者使用的本地工具。它保留工具 schema、调用参数、响应顺序、RPC 错误与耗时，让“昨天还好好的”变成一份可复现的记录。第一版包含录制桥接、离线 MCP 服务、异常注入和调用统计，无第三方依赖。

目标用户：开发麦当劳 Skill 的程序员、维护 MCP 客户端的人，以及需要给点餐 Agent 写回归用例的团队。

当前状态：**本地原型，20 项测试通过；2026-10-13 已完成麦当劳官方 MCP 的真实只读联调。** 当前工具列表为 35 项，完成 9 次业务读取/试算，其中 8 次录制与离线回放的结构化结果一致。内置 demo 仍全部为 `synthetic`，不把演示价格当成实际报价。详见 [LIVE_VALIDATION.md](LIVE_VALIDATION.md)。

## 30 秒体验

需要 Node.js 22 或更新版本。进入本项目目录后执行：

```bash
npm run demo
```

无需安装依赖，无需 Token。演示依次展示正常结果、券失效、模拟 HTTP 429、空菜单、报价缺字段、延迟和参数不匹配。示例门店、餐品、价格、响应结构与参数 schema 都是简化的虚构数据。

```text
normal          → 四次查询返回录制结果
coupon-expired  → calculate-price 返回工具执行错误
rate-limited    → query-meals 返回带模拟 429 信息的 RPC 错误
empty-menu      → query-meals 返回空餐品列表
missing-price   → calculate-price 的结构化结果与文本均缺少总价字段
slow            → query-meals 延迟 250 毫秒
参数变化         → MCTAPE_NO_MATCH，不访问真实服务
```

演示展示的是 MCP 响应变化。它没有运行第三方 Skill，因此没有证明那个 Skill 会正确停止、重试或给出提示。

## 本地一键功能测试

在 `.env.local` 中填写 `MCD_MCP_TOKEN` 后运行：

```bash
npm run smoke
```

它通过项目的实际 stdio CLI 完成真实连接、工具发现、时间查询、上海华旭国际大厦餐厅菜单、麦辣鸡腿汉堡详情与价格试算，将四次业务调用写入一个新的 `tapes/smoke-*.json`；接着离线回放，核对结构化数据与原始内容，再分别检查报价字段删除和模拟限流。每项输出 PASS，失败返回非零退出码。不会创建订单或消费积分。

重复执行会生成新的录制文件。测试依赖示例门店与餐品的实际可用性，业务失败会明确报错，不能将其视为整个 MCP 不可用。

不联网运行同一套回放与异常检查：

```bash
npm run smoke:offline
npm run smoke:offline -- --tape tapes/live-20261013-1817.json
```

`smoke:offline` 默认使用虚构 fixture，指定本地 live tape 时使用历史录制。它们不读取 `.env.local` 或访问官方服务。故障规则文件写入忽略的 `reports/`。这些检查验证 McTape，不评测第三方点餐 Skill 的处理行为。

## 接到你的 Agent 上

生成一份使用本机绝对路径的 MCP 配置：

```bash
node bin/mctape.mjs config
```

把输出导入支持 stdio MCP 的客户端，将待测 Skill 原来使用的麦当劳连接切换到 `mctape-replay`。工具仍叫 `query-meals`、`calculate-price` 等，工具说明和每次响应都会标记 **OFFLINE REPLAY**。

`mcp-config.example.json` 是环境变量占位的模板，客户端不一定自动展开这些占位符。`config` 命令会输出本机可用的绝对路径；record 配置通过宿主进程环境继承 Token。

查看内置录制的参数可打开 [fixtures/demo.json](fixtures/demo.json)。调用工具时使用其中的 `arguments`。它们属于演示 schema；真实录制使用上游返回的 schema，不猜测官方参数。

切换异常场景：

```bash
node bin/mctape.mjs config --scenario coupon-expired
node bin/mctape.mjs config --scenario rate-limited
```

直接启动回放服务器：

```bash
node bin/mctape.mjs replay --tape fixtures/demo.json
```

这是 MCP stdio 服务，会等待客户端输入 JSON-RPC；启动后没有普通交互提示。配置应直接运行 `node`。若经 npm 启动，要用 `npm run --silent replay`，防止 npm 日志混入协议 stdout。

## 录制真实查询

1. 在[麦当劳 MCP 开放平台](https://open.mcd.cn/mcp)申请个人 Token，并配置到运行 MCP 客户端的进程环境变量 `MCD_MCP_TOKEN`。Token 不写进命令行或配置文件。GUI 客户端是否继承终端环境取决于其启动方式，请使用客户端支持的环境注入方式。
2. 可先运行 `node bin/mctape.mjs schemas`，查看当前服务器实际返回的六个支持工具的 schema。
3. 生成录制连接配置，并导入客户端：

```bash
node bin/mctape.mjs config --mode record --out tapes/session-001.json
```

4. 在客户端中使用 `mctape-record` 执行查询。初始化会保存当前工具 schema；之后每个调用保存时间、参数、响应或 RPC 错误，以及耗时。每次写入通过临时文件原子替换完成，文件权限为 `0600`。
5. 使用生成的记录回放：

```bash
node bin/mctape.mjs config --tape tapes/session-001.json
node bin/mctape.mjs report --tape tapes/session-001.json
```

输出路径必须是新文件。已有文件会被拒绝，避免误覆盖。网络失败和限流不会自动重试，而会记录为错误，由待测 Skill 决定处理方式。

录制只暴露以下六个工具，忽略上游的其他工具和写操作，不依赖上游 `readOnlyHint` 作为放行依据：

| 工具 | 用途 |
| --- | --- |
| `now-time-info` | 记录时间上下文 |
| `campaign-calendar` | 活动信息 |
| `list-nutrition-foods` | 营养数据 |
| `query-meals` | 门店菜单 |
| `query-meal-detail` | 餐品和套餐详情 |
| `calculate-price` | 价格试算 |

第一版不录制个人订单、配送地址、账户余额或券包。试算参数仍可能携带券标识；保存时会替换敏感字段，重算替换后参数的指纹，保留同一标识的对应关系。回放应使用录制文件中的替换后参数。

Token、常见身份字段、手机号、邮箱及 JSON 文本中的敏感字段会自动处理，但这**不是匿名化认证**：自由文本中的姓名、地址、未知字段与私人券规则仍可能留在记录中。`tapes/` 默认不进 Git；公开前应人工检查。当前随源码提供的 fixture 完全虚构，不来自私人账户。

## 自定义异常

```bash
node bin/mctape.mjs replay --tape fixtures/demo.json --faults examples/faults.json
```

故障规则通过 `tool` 和 `onCall` 指定目标工具及第几次成功匹配的调用：

```json
[
  {
    "tool": "calculate-price",
    "onCall": 1,
    "kind": "drop-field",
    "path": ["structuredContent", "totalPrice"]
  }
]
```

支持 `tool-error`、`rpc-error`、`delay`、`replace`、`drop-field`。注入延迟最多 30 秒。字段路径不存在会报错，避免一个没有生效的故障被误当成验证成功。

内置 `empty-menu`、`missing-price` 的字段结构只适用于演示 cassette。对真实记录使用自定义规则，并从实际响应选择路径。`rate-limited` 在 stdio 层注入携带模拟 HTTP 状态的 JSON-RPC 错误，不是启动一个真正返回 HTTP 429 的服务。`slow` 是响应延迟；是否触发超时由客户端超时设置决定。

## 回放语义

- 工具名与完整参数一起生成指纹：对象键顺序无关，数组顺序与数字/字符串类型保留。
- 每条录制最多消费一次。同参数的多条记录按录制顺序返回；其他参数组合可以交错调用。它验证调用匹配与单键顺序，不强制整段工作流的全局顺序。
- 没有匹配、记录已消费、门店或参数改变时明确报错；回放进程没有真实请求入口。
- schema 和响应属于录制时刻，不代表当下数据。注入错误也不是官方真实错误码。

## Skill 与验证

根目录 [SKILL.md](SKILL.md) 可作为项目技能入口，脚本与源码需要随技能保留。它指导宿主选择录制、回放和故障模式，不替代原有的点餐 Skill。

```bash
npm test
node bin/mctape.mjs report --tape fixtures/demo.json
```

20 项测试覆盖请求指纹、录制消费、故障注入、敏感值替换、标准输入输出协议、初始化生命周期、JSON/SSE 响应、会话与协议头、工具分页、429 错误、写操作阻断、文件权限与防覆盖。自动测试使用虚构数据或模拟上游；真实只读联调与本地 live cassette 回放另见 LIVE_VALIDATION.md。

协议支持范围：MCP stdio 工具服务，以及连接官方 endpoint 的 Streamable HTTP 请求、JSON/SSE 响应、初始化会话和工具分页。尚未实现 SSE 断线续传、服务端发起请求、取消通知传播、Schema 完整校验或客户端行为评分。当前固定使用已实现的协议版本；不宣称覆盖完整 MCP SDK。

参赛资料见 [MCP_INTEGRATION.md](MCP_INTEGRATION.md)、原文 [CONTEST_DECLARATION.md](CONTEST_DECLARATION.md) 和配置模板。**真实只读联调已完成，脱敏结果摘要见 LIVE_VALIDATION.md；报名之前仍需审核公开材料，再将本目录发布为独立公开仓库。** 本项目由 Codex 开发，没有 WorkBuddy 开发记录，不申报 WorkBuddy 专项奖励。

竞品梳理与选择理由见 [RESEARCH.md](RESEARCH.md)。本项目是独立开发者原型，非麦当劳官方产品。
