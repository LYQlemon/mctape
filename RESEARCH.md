# 选题调研：为什么做 McTape

调研日期：2026-10-13，北京时间。公开 GitHub API 抓取 7 页、共 616 条 issue，包含重复报名和已关闭项，其中 551 条为 open。正文里提取到 524 个不同的 GitHub 仓库 URL；这是报名链接去重数量，不代表已通过审核的项目数。抓取时最新 issue 为 #623；活动持续新增项目，以下是当时的快照。

范围：扫描 issue 标题与简介，详细查看重点相近项目和官方文档。没有逐个审计 524 个仓库的源码，因此“未发现”只指这批报名简介，不代表全网不存在类似工具，也不证明已有工具不具备某项功能。

## 已拥挤的方向

以下统计按标题关键词命中，允许类别重叠；不同报名 URL 去重也可能包含同项目的不同写法，不能视为精准市场份额。

| 方向 | 命中的 issue | 不同项目 URL |
| --- | ---: | ---: |
| 省钱、预算、精算、最优组合 | 110 | 99 |
| 营养、热量、健身与控卡 | 74 | 63 |
| 多人、拼单与团餐 | 36 | 29 |
| 年度、人格、记忆与回忆 | 42 | 33 |
| 权益、积分、到期与抽奖 | 44 | 41 |

更细的创意也已有直接对手：

| 原本可能想到的点子 | 已有作品 | 对 McTape 选题的影响 |
| --- | --- | --- |
| 帮用户避开凑单陷阱 | [#357 麦麦省钱助手](https://github.com/M-China/mcd-developer-innovation-challenge/issues/357) | 不能把“主动劝退”当成新核心 |
| 把订单当 Pull Request 审核 | [#348 MealPR](https://github.com/M-China/mcd-developer-innovation-challenge/issues/348) | 程序员视觉隐喻已有深入实现 |
| 点餐前运行 CI 流水线 | [#322 MealCI](https://github.com/M-China/mcd-developer-innovation-challenge/issues/322) | “Meal CI”名称容易混淆，需要面向真正接口调试 |
| 点错或重复下单后的补救 | [#481 麦单回正](https://github.com/M-China/mcd-developer-innovation-challenge/issues/481) | 订单补救已有专门方案 |
| 给任何 Skill 加交易确认护栏 | [#621 麦麦护栏](https://github.com/M-China/mcd-developer-innovation-challenge/issues/621) | McTape 不以通用交易批准为产品核心 |
| 给开源作者买汉堡 | [#558 Buy Me a Big Mac](https://github.com/M-China/mcd-developer-innovation-challenge/issues/558) | 开源赞助也已有项目 |
| 让朋友复刻某份点法 | [#511 麦麦抄作业](https://github.com/M-China/mcd-developer-innovation-challenge/issues/511) | 攻略复刻和跨店核价已有作品 |

[#505 NightFuel](https://github.com/M-China/mcd-developer-innovation-challenge/issues/505) 的简介提到录制真实响应作为 fixtures；[#556 McWorth](https://github.com/M-China/mcd-developer-innovation-challenge/issues/556) 区分历史回放与合成数据。这说明录制素材确有工程用途，但这两个项目的核心仍是点餐。抓取简介中没有发现明确面向其他 Skill 开发者、以可复用 MCP 录制服务、严格参数回放和故障注入为核心的项目。这个结论应随新报名重新检查。

## 比较后留下的三个方向

| 点子 | 真实痛点与最小实现 | 与已有作品的差异 | 代价或限制 |
| --- | --- | --- | --- |
| **McTape 麦麦录放机** | 一次真实只读录制，离线提供同名 MCP 工具，复现券失效、空菜单和字段缺失 | 服务其他 Skill 的开发者，核心是接口复现而非配餐 | 用户圈较小；需做好协议、脱敏和真实联调 |
| 拆袋验收员 | 从实际订单展开核对清单，让用户勾选漏项或错项，整理附证据的反馈草稿 | 聚焦取餐之后的履约核对；已有“验收”多是点餐计划核验 | 图片无法确认隐藏餐品或配料；官方没有单独退款/投诉工具，用户自行发送反馈 |
| 个人饱腹实验本 | 将订单与本人饭后满意度、剩余量、多久又饿等自评关联，逐步学习合适份量 | 不把营养值直接当成“吃饱”；核心数据来自实际饭后反馈 | 需要持续手工输入，不能只靠 MCP；与适量点餐、口味记忆项目存在相邻重叠 |

选择 McTape 的理由：开发者活动本身就聚集了目标用户；可以用一个 cassette 展示清楚收益；技术资产可迁移到其他 MCP；工程范围容易收敛。它仍需要好用的示例、安装体验和可公开复现的真实案例，才可能获得社区认可。不能据此保证排名。

## 本轮实现与下一阶段

本轮已经实现独立 Node.js 项目、只读录制桥接、参数匹配的 stdio 回放、五种内置异常、调用统计、项目 Skill 入口和 20 项自动测试。无需联网就能演示。

下一阶段优先级：

1. 已于 2026-10-13 完成菜单 → 套餐详情 → 价格试算的真实录制与回放，结果见 LIVE_VALIDATION.md。
2. 给一个真实待测 Skill 加业务断言：遇到失效券是否重核价、报价缺字段是否停止输出确定价格。这才能从“响应可复现”进一步证明调试收益。
3. 若真实示例有价值，再加可视化 trace diff、cassette 字段修订和不同版本 schema 差异；无需先扩大到所有工具。

## 活动事实

报名截止是 **2026-10-25 23:59（北京时间）**。赛事按公开 GitHub Star 排名；有差异的选题和易复现演示有助于传播，但创意本身不直接决定名次。完整规则要求真实使用麦当劳 MCP，并包含 README、官方原文参赛声明、MCP 接入说明、环境变量占位的配置示例和可运行内容。仅有 demo 或文档不足以证明真实接入。[官方 README](https://github.com/M-China/mcd-developer-innovation-challenge)、[完整活动规则](https://github.com/M-China/mcd-developer-innovation-challenge/blob/main/activityGuidelines.md)。

本轮没有创建远程仓库、提交报名 issue 或虚构 WorkBuddy 开发记录。
