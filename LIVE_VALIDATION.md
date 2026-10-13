# 真实只读联调记录

验证完成时间：2026-10-13 18:18:50（北京时间）。本轮使用用户提供的个人 Token 连接官方 `https://mcp.mcd.cn`；Token 仅通过关闭回显的标准输入传入测试进程，不写入命令行、源码或记录文件。

## 结果

- MCP 初始化、鉴权和工具发现成功，协商协议为 `2025-06-18`，返回 35 个工具。
- 9 次业务读取/试算均返回 `structuredContent.success=true`、`code=200`；其中 8 次进入 McTape 的只读录制，额外 1 次门店搜索仅用于选取公开测试门店。
- 实际使用工具：`now-time-info`、`campaign-calendar`、`list-nutrition-foods`、`query-nearby-stores`、`query-meals`、`query-meal-detail`、`calculate-price`。
- 营养查询返回 160 项餐品；公开测试门店上海黄浦华旭国际大厦餐厅（storeCode `1450713`）菜单返回 113 项。
- 测试录制与回放只涉及六个支持的只读工具；门店搜索属于独立测试步骤，并未扩大产品录制工具白名单。

| 官方试算 | 服务器返回的分值 | 查询时金额 |
| --- | ---: | ---: |
| 麦辣鸡腿汉堡单品 | 2250 | ¥22.50 |
| 麦辣鸡腿汉堡三件套（麦辣鸡腿汉堡、中薯条、可乐中杯） | 3350 | ¥33.50 |

金额仅代表这家门店、该次到店自取请求的历史试算结果，不代表其他门店或未来售价。试算未使用券、未附带购买会员卡。

## 离线验证

8 次录制调用逐条回放，结构化响应与保存记录完全一致。额外验证：

- 删除首次 `calculate-price` 的 `structuredContent.data.price`，该次响应确实缺少这个字段，后续核价记录仍正常回放。
- 对首次 `query-meals` 注入带模拟 429 信息的 RPC 错误，确实返回错误，其他录制条目可独立复现。

这些检查验证录制器与回放器，不证明某个第三方 Skill 能正确处理缺字段或限流。模拟异常不是本轮真实遇到的官方故障。

## 接口观察

1. 真实数据位于 `structuredContent`，有 `success`、`code`、`message`、`datetime`、`traceId`、`data` 外层。只看 MCP 的 `isError` 不足以判断业务成功。
2. 当前 `query-meals.data.categories[].meals` 含餐品编码；名称与价格可从 `data.meals` 映射读取。本轮响应含菜单价格，不能将其他版本的“菜单无价格”观察当成恒定事实。
3. 菜单 `currentPrice` 是元的字符串，价格试算 `data.price` 是整数分。不可混用单位。
4. `list-nutrition-foods.data` 是以 `[160]{productName,...}:` 开头的紧凑表格字符串，并非 JSON 数组。
5. 套餐详情使用 `data.rounds[].id`；试算的子项字段为 `items[].roundList[].round`，按实际 schema 使用字符串；餐品字段为 `items[].productCode`。
6. 默认 `query-nearby-stores.searchType=1` 搜收藏。本轮明确用 `searchType=2`、城市上海、关键词人民广场定位公开测试门店。

## 本地文件与复现

完整录制保存于 `tapes/live-20261013-1817.json`，权限 `0600`；摘要保存于 `reports/live-20261013.json`。两个目录均被 `.gitignore` 排除，不自动作为公开参赛附件。

```bash
node bin/mctape.mjs report --tape tapes/live-20261013-1817.json
node bin/mctape.mjs config --tape tapes/live-20261013-1817.json
node bin/mctape.mjs config --tape tapes/live-20261013-1817.json --faults examples/live-missing-price.json
```

`examples/live-missing-price.json` 是按本轮实际响应路径编写的故障规则；内置 demo 的 `missing-price` 路径保持适用于 synthetic fixture。

本轮未创建订单、付款、取消订单、领券、兑换或抽奖。正式公开前仍需审核拟公开材料；本轮也未测试第三方宿主客户端或写操作链路。
