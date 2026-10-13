# 麦当劳 MCP 接入与验证状态

McTape 将麦当劳 MCP 用作 Skill 开发者的真实数据和接口契约来源。它把一次只读调用保存为本地 cassette，再以同名工具提供离线回放，减少反复联网调试，帮助复现异常和接口返回差异。

## Server 与工具

- 官方 MCP Server：`https://mcp.mcd.cn`
- 上游传输：Streamable HTTP，POST 接受 JSON 或 SSE 响应。
- 鉴权：进程环境中的 `MCD_MCP_TOKEN`，仅在上游请求中构造 Bearer 头。
- 下游传输：本地 stdio MCP。
- 实现的协议版本：`2025-06-18`、`2025-03-26`、`2024-11-05`；初始化选用已实现的版本并记录上游协商结果。

支持录制与回放的官方工具：`now-time-info`、`campaign-calendar`、`list-nutrition-foods`、`query-meals`、`query-meal-detail`、`calculate-price`。工具参数从当前 `tools/list` 原样发现；不把虚构 demo schema 当成实际接口契约。

工具列表由名称白名单过滤，上游注解不改变允许范围。不会转发 `create-order`、`cancel-order`、`mall-create-order`、`draw-lottery`、`auto-bind-coupons` 等状态变更工具。

## 调用流程

```text
宿主 Agent / 待测 Skill
  → McTape record（stdio）
  → initialize + notifications/initialized + tools/list
  → 麦当劳 MCP（Streamable HTTP，真实只读请求）
  → 本地 cassette（schema / 参数 / 结果或错误 / 时间 / 耗时）

同一 Skill
  → McTape replay（stdio，不建立上游连接）
  → 完整参数匹配 / 按需注入故障
  → 带 OFFLINE REPLAY 来源标签的响应
```

录制支持初始化后的 Session ID 与协议版本头、工具列表分页、JSON 与分块 SSE 响应。收到匹配 RPC 结果即停止读取 SSE，不等待长连接关闭。非成功 HTTP 状态、超时、解码失败均明确返回错误，不自动重复请求。

## 本轮已验证与尚未验证

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| stdio MCP 初始化、工具列表、调用 | 模拟集成已通过 | `test/mctape.test.mjs` 中子进程测试 |
| HTTP JSON、SSE、Session、协议头与分页 | 模拟上游已通过 | 注入 fetch 与 ReadableStream 测试 |
| 只读录制、敏感值替换、错误保存、防覆盖 | 本地已通过 | Recorder 测试 |
| 参数指纹、单键顺序回放、无匹配报错 | 本地已通过 | Replay 测试 |
| 券失效、限流、空菜单、字段缺失、延迟 | 演示可运行；前四种有自动测试 | `npm run demo` 与测试 |
| 官方麦当劳 MCP Token 鉴权、实际 tools/list | **真实通过，返回 35 个工具** | LIVE_VALIDATION.md，2026-10-13 |
| 官方实际餐品、套餐与核价调用 | **真实通过，业务 success=true / code=200** | 上海门店 113 项菜单、单品与套餐详情、两次价格试算 |
| 宿主 Skill 对故障的正确处理 | **需要单独验证** | 回放器只提供响应，不替宿主做行为判定 |

2026-10-13 已补做官方真实只读联调：9 次业务读取/试算全部成功，其中 8 次写入本地 live cassette 并完成离线回放；还验证了真实返回路径上的报价字段缺失与模拟限流。详见 LIVE_VALIDATION.md。未创建订单、消耗积分或执行支付；没有测试第三方宿主 Skill 的行为正确性。

## 复现真实联调的最小步骤

1. 配置个人 Token 到宿主进程环境，启动一个新的 record 连接。
2. 保存当前 `tools/list`，调用 `now-time-info`；按实际 schema 选一组门店菜单和餐品详情查询，再执行一次价格试算。
3. 确认 `source=live-readonly` 的 cassette 包含这些真实调用；人工核对字段与替换后的参数。
4. 切换到 replay，复现同组请求；从真实返回选择一个字段路径注入异常，观察宿主 Skill 的处理结果。
5. 发布前仅提交审核过的脱敏材料，记录验证日期、工具名、调用数量和结论。不要提交完整私人 cassette、Token 或伪造 WorkBuddy 开发记录。

## 业务价值与边界

价值在于让其他麦当劳 Skill 的接口行为可以复现：券在选择与核价之间失效、返回缺字段、菜单为空、服务限流，这些情况无需反复等待真实故障出现。开发者仍需自行编写业务断言或观察宿主行为。

当前不支持完整 JSON Schema 校验、服务端发起请求、SSE 断线续传、取消传播、真实写操作录制或正式评测排行榜。文件里的查询结果是历史快照；公开调试案例前要检查自由文本和不熟悉字段，自动替换不能保证完全匿名。

依据：[官方 MCP 接入指南](https://github.com/M-China/mcd-mcp-server)、[MCP transports 规范](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)、[MCP tools 规范](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)、[赛事完整规则](https://github.com/M-China/mcd-developer-innovation-challenge/blob/main/activityGuidelines.md)。
