# 社区需求驱动：让不确定操作有明确的下一步

研究核对日期：2026-09-26。

| 来源 | 证据性质 | 可支持的结论 |
| --- | --- | --- |
| [Temporal forum，2025-10](https://community.temporal.io/t/is-retry-policy-applicable-to-platform-temporal-error/18482) | 用户接入不支持幂等的外部 API，询问选择性重试 | 远端结果未知时，重试策略本身不能提供业务安全 |
| [MCP #1597，2025-10](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1597) | 协议提案讨论响应丢失导致重复非幂等操作 | 支持身份和不确定性处理需求；不是已核实的业务损失事故 |

已有替代：工作流重试策略、provider 幂等键/查询 API、手工检查日志。Relay 无法给缺乏幂等或可查询契约的 provider 凭空补上 exactly-once。

本轮取舍：新增 `effects --explain`，保留 key 身份，将 PREPARED / SUBMITTED / UNKNOWN / CONFIRMED / FAILED 翻译为具体操作建议。候选 MCP 参数只来自匹配的 kind/key，仍要求核验归属及配置。没有重试、网络请求、改变引擎语义、额外控制台或自动恢复。

读取采用既有 SqliteEffectJournalReader，不创建缺失数据库，不迁移表，不读取自由文本 payload。SQLite WAL 协调文件可能被创建或使用；主数据库字节和 mtime 通过回归检查。损坏事件可来自其他 key，告警明确其全库采样范围。退出 0 仅表示成功解释，不表示业务成功。

真实采用与减少重复操作的效果尚未测量。完整验收结果见 reports/COMMUNITY_GUIDANCE_ACCEPTANCE_2026-09-26.md。
