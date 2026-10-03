# R1/R2：主线边界与真实 provider 预检

2026-10-03 源码核对：Relay `934d5db`，RelayMuse `eb8a417`；本轮未向外部服务写入。

## 主线与实验线

Relay 已有 effect 请求哈希绑定、持久结果、UNKNOWN 禁盲重试和只读 reconcile（`packages/core/src/effect.ts`、`packages/storage-sqlite/src/journal.ts`），以及 MCP workspace 单写者锁（`packages/mcp/src/lock.ts`）。这些实现也存在于 RelayMuse；不要把已有能力再移植一次。

Muse 另有任务审批绑定 effect kind/requestHash（`packages/core/src/task.ts`）、Pi 当前分支持久结果完成门禁（`packages/adapter-pi/src/task-adapter.ts`）、任务租约（`packages/storage-sqlite/src/task-store.ts`）。它们依赖 Muse 的持久任务模型，并非 Relay effect journal 的缺失修补。保持实验线，当前不把任务调度/审批生命周期搬入主线，也不改写 Pi 原生恢复语义。MCP 锁只约束遵守该入口的进程，不保护任意直接数据库写入者。

## 现有 HTTP 配置的真实边界

`packages/mcp/src/server.ts` 的提交可设置固定 headers 和环境变量引用的 secretHeaders，但不发送 request body。reconcile 是 GET，当前不配置鉴权头；只识别 `found` 布尔值或白名单 `status`。因此不能把任意“有 POST 和 GET 的服务”直接配置为已支持 provider。AISIX 是模型 provider，localhost 业务沙箱是受控 effect provider，两者都不证明真实外部效果已接通。

## 首个低风险候选：专用测试仓库的 GitHub Actions 变量

[官方 REST 契约](https://docs.github.com/en/rest/actions/variables#create-a-repository-variable)支持按客户端给定 name/value 创建变量，并[按名称只读查询](https://docs.github.com/en/rest/actions/variables#get-a-repository-variable)；变量用于非敏感数据，读写均有仓库权限要求。

这是待确认候选，不是当前支持声明。只考虑专用测试仓库中从未使用的 `RELAY_PROBE_<随机ID>`，值为合成非秘密标记；不改变工作流、不更新已有变量、不自动删除。具体测试仓库及外部写入尚未获得授权。

需要先做 SDK 层的显式 execute/reconcile 适配，复用 `runEffect`，不扩通用 MCP 配置去猜测服务响应：

- 预先持久化固定服务地址、仓库数字ID及 repository/name/expectedValue 的请求哈希，身份由固定运行配置提供；仓库改名/同名重建不得继承旧证据。令牌只在进程中用于认证，不进入 request、journal、capsule、日志。
- 提交只允许一次创建；响应丢失、HTTP 错误或进程中断均不得自动重发。query 必须验证 repo、name 和 value 完全匹配，只有匹配证据才 CONFIRMED。
- 查询 404、无权限、不可用、名称/值不匹配都保持 UNKNOWN，不能推断“从未执行”，更不能借此再提交。后续修改/删除变量会破坏长期查询证据，故不声称无限期或生产恢复保证。
- 先在本地模拟 HTTP 契约覆盖匹配、冲突、404、401、丢响应与强杀，再完成可审阅的单次外部验收脚本；在具体仓库及写入授权确定前不发真实 POST。

适配实现的前置检查（2026-10-03 独立审查后）：

- `runEffect` 只把 `AmbiguousEffectError` 转为 UNKNOWN，普通异常会记 FAILED。适配器须将提交后无法判定结果的网络/HTTP/解析错误映射为该类型，并只返回可序列化的最小匹配证据；不能先返回成功再依赖核心发现结果不可序列化。
- 核心信任 `execute` 结果及 `reconcile.found=true`。适配器必须在两条路径核验固定服务地址、仓库身份、name/value；查询不确定只能返回 uncertain，不能返回 found=false。
- 直接 SDK 的 PREPARED 读取与提交没有提供跨进程原子抢占。验收 runner 必须在读 journal 前获取同一 workspace 的单写者锁，并持有至确认或退出；不能声称 MCP 已替 SDK 加锁。先做双进程争抢 PREPARED、确认与不确定查询竞态测试，核对 POST 至多一次、CONFIRMED 不降级，再进行外部验收。任意绕过锁的直接写库者仍在保证范围外。

外部验收记录应分别保存客户端 POST 次数、服务当前匹配对象、journal 转移及查询次数。一个对象存在不能证明远端历史只执行过一次；本契约只证明测试中客户端没有盲重发和当前状态匹配，不升级为无条件 exactly-once。

## 本地契约夹具（2026-10-03）

`packages/mcp/test/github-variable-contract.test.ts` 使用真实runEffect、SQLite journal、workspace锁及两个独立进程，但HTTP服务仅为127.0.0.1模拟器。fixture适配器明确拒绝外部origin，不能拿它直接调用GitHub。服务端只验证本地约定，不证明真实服务支持语义幂等。

六项测试覆盖：精确上下文确认/缓存；回执丢失后的404/401/503、错误name/value/repositoryId保持UNKNOWN且不增加POST；拒绝外部地址；201回执但查询不匹配仍UNKNOWN；真实强杀后核对PREPARED再双进程恢复；UNKNOWN双进程恢复。持锁者等待竞争者明确拒绝后再继续，计数为1；确认后503查询设置不触发重查或降级。子进程有独立15秒回收期限。

认证哨兵在成功和UNKNOWN后残留的journal主文件/WAL/SHM中未出现；合成变量value有意进入确认结果，不能称全部内容自动脱敏。每个子进程只执行一次入口；现有锁允许同进程重入，夹具不声称并发同进程调用自动串行化。绕过锁、跨主机、生产凭据、远端历史唯一性均未验收。

Windows隔离验证副本的typecheck与完整check通过，6项定向测试在Node24.19和22.23.3通过。构建后可运行 `node --test packages/mcp/dist/test/github-variable-contract.test.js`。真实GitHub预检、显式外部runner、具体测试仓库和授权仍未完成。
