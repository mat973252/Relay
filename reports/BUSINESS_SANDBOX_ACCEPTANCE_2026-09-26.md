# 订单报表业务沙箱验收

日期：2026-09-26。基于本地 `48f3a7e`，执行用户“自己构造真实业务”的要求。

## 结论

**这一自建业务契约的隔离验收通过。** 业务数据是三笔合成订单，但模型请求、Pi 会话、Relay MCP 进程、业务 HTTP 进程、SQLite 持久化、强制终止/重启和 CSV 文件都实际运行，没有用预设模型输出代替真实工具选择。Relay 产品执行引擎及锁实现未改变。

最终真实模型运行使用 `aisix/glm-5.3-flash`、Pi 0.87.0、Windows Node 24.13.0。最终证据见 [evidence.json](business-sandbox-2026-09-26/evidence.json)，产物见 [orders.csv](business-sandbox-2026-09-26/orders.csv)。

## 业务契约与故障

- 导出 2026 年 9 月的合成订单，业务身份 `export-orders:monthly-orders-202609`。
- POST 先把任务持久化，再返回 202；接单不是完成。可注入落库后断线或不返回响应，以便杀掉 Relay。
- 查询副本暂不可见返回 `not_visible`；任务仍在处理返回 `pending`。二者都没有“确定未执行”的含义，保持 UNKNOWN。
- worker 根据持久化的 released 标志读取订单、生成 CSV、计算 SHA-256，再更新任务为 complete。查询还会校验文件哈希，只有有效产物才能证明完成。
- 422 仅用于本沙箱明确的接单前拒绝，不能推广为所有 provider 的通用含义。
- 故障与 worker 放行由父进程 IPC 控制，不向模型暴露控制接口。worker 在业务 provider 进程内，不是另一个独立进程。

## 可重复故障测试

`packages/mcp/test/business-sandbox.test.ts` 包含五项集成测试：

1. 202 接单后，双进程重启，经历不可见、pending、complete。
2. 接单后断开 HTTP 连接，再双进程重启恢复。
3. 业务已落库但响应未到达时强制终止 Relay，再双进程重启恢复；崩溃时 journal 为 SUBMITTED。
4. 明确拒绝：零任务、零产物，不因 reconcile 重发。
5. 两个不同请求：两个稳定 ID、两个任务、两个产物，没有相互串用。

前三项均在 pending 期间再次调用相同 ID 的 submit，验证它只查询旧操作；完成后再次调用仍不发新 POST。最终分别断言一个业务任务、一份准确 CSV、一次 POST。业务服务的幂等去重不会掩盖重复 HTTP 请求。

| 环境 | 结果 |
| --- | --- |
| Windows Node 24.13.0 / pnpm 10.33.0 | typecheck、全套 204 项：202 通过、2 跳过 |
| WSL Ubuntu Node 22.18.0 | typecheck、新增业务集成 5/5，通过 |
| WSL Ubuntu Node 24.4.1 | typecheck、新增业务集成 5/5，通过 |

Windows 两项既有跳过仍是 chmod 和 symlink 权限限制。此前 `48f3a7e` 的 Linux 全套 199/199 已单独验收；本次不把局部 5/5 宣称为重跑全部 204 项。

## 真实模型与新会话恢复

每阶段都是隔离的新 Pi 会话，只有三个 Relay custom tools，没有 builtin tools、用户 AGENTS、skills 或 extensions。AISIX 配置仅由现有 Pi ModelRuntime 解析；不复制凭据到证据目录。恢复 prompt 不提供 operationId，要求先发现持久化未完成操作。

| 阶段 | 模型实际调用 | Relay 实测状态 |
| --- | --- | --- |
| submit | list_unresolved → submit_action | 接单后断线，UNKNOWN |
| recover | list_unresolved → reconcile_operation | 原 ID 查询暂不可见，UNKNOWN |
| confirm | list_unresolved → reconcile_operation | CSV 完成且哈希正确，CONFIRMED |

submit 与 recover 之间，业务服务与 Relay 均被强制终止并重启；业务服务使用同一个数据库与端口。恢复阶段没有再次 submit；整个最终模型运行只有一次 POST、一个任务和一份 CSV。所有桥接参数逐项与实际 Pi JSONL 中的 model toolCall 参数比较，不从模型文字推断调用发生。

模型链路完成后，还实际运行了 AgentLens 仓外安装包的 import/inspect。三段会话分别使用当时采集的 history 快照，避免用最终状态覆盖早期未知状态：

- submit：Run passed，但独立 Relay evidence 仍是 UNKNOWN。
- recover：Run passed，独立 Relay evidence 仍是 UNKNOWN。
- confirm：Run passed，独立 Relay evidence 为 CONFIRMED。

AgentLens 当前只对 submit 参数做 key 匹配，因此 recover/confirm 的查询记录没有自动关联，sidecar 显示 unassociated；没有把它们包装成已验证的会话因果关系或完整 Recovery 事件。原会话 SHA-256 在导入前后保持一致。

## 发现的接入问题

首次用现有 `aisix/deepseek-v4-flash` 路径时，Pi 收到 `stopReason=toolUse` 但 content 为空，零工具调用；沙箱断言正确失败，没有业务 POST。服务报告的该次 usage 为 input 575、output 337、total 912。此现象尚未隔离到模型、网关或 SDK 某一层，不能归因于 Relay，也不能宣称该模型工具链通过。

改用已配置的 GLM-5.3-Flash 后，两轮模型运行均通过；上述冻结证据来自最终一轮。费用字段取决于本地模型配置，不能把 usage 中的 cost=0 当作免费调用证明。

## 复跑

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
node --test packages/mcp/dist/test/business-sandbox.test.js
node examples/business-sandbox.mjs glm-5.3-flash
```

最后一条是显式选择的联网模型验收，不属于默认测试；需要已有 Pi AISIX 配置。脚本打印新的一次性证据目录。每段模型会话限时 90 秒，并限制工具调用数；确定性测试不需要模型或凭据。

## 保证范围

本轮证明该沙箱契约下的持久化、恢复、避免重复 POST，以及实际模型遵循恢复流程。没有证明所有模型都遵循提示词；模型另造业务 ID、绕过 Relay 直连服务、非协议数据库写者、跨主机锁、断电时磁盘持久性、HTTP 与独立 worker 的进程隔离均不在范围内。模拟副本延迟与 worker 放行是确定性故障注入，不是生产流量。

没有调用第三方真实业务写入，没有发布包或把 hosted CI 标为通过。这个业务沙箱已经可运行，不再等待用户指定外部服务。
