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

Windows隔离验证副本的typecheck与完整check通过，6项定向测试在Node24.19和22.23.3通过。构建后可运行 `node --test packages/mcp/dist/test/github-variable-contract.test.js`。只读预检和显式外部runner现已实现并完成本地验证，见后文；具体测试仓库、真实写入授权及真实GitHub验收仍未完成。

## 只读GitHub预检入口（源码示例）

`packages/mcp/examples/github-preflight.ts` 是独立源码示例，不进入SDK公共API或npm打包入口。按根目录构建后可运行：

```sh
node packages/mcp/dist/examples/github-preflight.js --repo OWNER/REPO --repo-id 123 --name RELAY_PROBE_UNIQUE
```

调用前由用户在本机配置`RELAY_GITHUB_TOKEN`，不要把值放到命令参数、聊天或日志。示例不自动读取gh/Codex凭据；没有令牌直接阻断且不请求网络。只对固定`https://api.github.com`发GET，拒绝重定向，核对仓库数字ID和完整名称，并分页读取变量列表；不输出已有变量名称/值、响应正文、异常正文或额外输入字段。

根据[GitHub变量API](https://docs.github.com/en/rest/actions/variables#list-repository-variables)，变量列表需要对应读取权限；仓库admin/push信息不能证明Variables写权限。输出始终`variablesWrite=unverified`、`postAuthorized=false`。退出0仅表示本次枚举完成且未见同名项，2表示阻断，64表示参数错误。404不等于不存在；总数变化、重复项、不完整分页、身份变化或查询失败均不通过。分页上限100页，超限保守阻断。

GitHub分页不是原子快照；等量增删可能不被总数检测，`atomicSnapshot=false`保留此限制。预检不能为后续POST提供唯一性保证，也不能代替用户授权、实际Variables写权限或单写者执行入口。此脚本完全没有POST/修改/删除分支；本轮仅以注入HTTP响应及无令牌实际CLI验证，尚未对具体远端仓库执行。

## 外部执行入口设计（2026-10-03；实现与验证状态见后文）

范围只限一个专用测试仓库中的一个随机测试变量。保持现有SDK状态机不变，独立验收入口分为计划、首次提交和只读核对；不把执行与恢复藏在同一个重试命令中。

计划文件只含固定 `https://api.github.com`、repo全名与数字ID、随机 `RELAY_PROBE_` 名称、合成非秘密value、固定key/kind/requestHash、规范化workspace路径及计划版本。生成计划本身不联网、不授予权限。用户审核具体计划后，首次提交命令才接受该计划；命令开关、文件中的approved字段或预检exit0均不能作为用户授权的替代。令牌只从本次进程的RELAY_GITHUB_TOKEN取得，不读取其他工具凭据。

先规范化workspace并限制同进程只有一个入口调用，再取得同一workspace锁，随后打开journal、核对key/kind/hash和既有记录；直到journal关闭才释放锁。两个路径指向同一目录时必须归一化，不能建立两把锁。不同workspace、直接改库、绕过入口的HTTP及跨主机不在保证范围内。

| 命令 / 本地记录 | 外部请求与结果 |
| --- | --- |
| 首次提交 / 无记录 | 已有具体授权且只读预检通过后，调用runEffect；执行路径再核验仓库身份，最多一次POST；只有随后GET精确匹配才确认 |
| 首次提交 / 任意既有记录 | 拒绝，不POST，提示核对同一计划；不能换新key掩盖未知结果 |
| 只读核对 / 无记录 | 拒绝，不创建record、不POST |
| 只读核对 / PREPARED | 返回prepared_not_submitted，不调用runEffect、不修改状态、不POST；后续是否继续这次未提交操作由操作者另行决定 |
| 只读核对 / SUBMITTED或UNKNOWN | 只GET核对固定身份/name/value；匹配才确认，否则保持UNKNOWN，不返回found=false |
| 只读核对 / CONFIRMED或FAILED | 返回既有终态，不重查、不POST；另做远端审计不能降级或重放该终态 |
| 任意命令 / 身份、hash或workspace不符 | 在执行前拒绝，保留原journal，不发POST |

PREPARED处理刻意与SDK默认继续执行区分。`runEffect`在PREPARED下会先markSubmitted再execute，因此只读命令不能把PREPARED直接交给它。SQLite的markSubmitted已经用 `WHERE status = 'PREPARED'` 和changes校验保护单次转移，不能仅凭源码中先读后写就宣称现有SQLite双进程必然重复POST；外部入口仍需要workspace锁，把身份/权限检查与journal决策纳入一个单写者范围。

发送前能确定未开始HTTP提交的失败可保留明确not_submitted证据；一旦进入POST调用，响应丢失、非201、查询失败或上下文不匹配均保守映射UNKNOWN。请求计数在调用前递增，包含发送失败尝试；进程强杀时本地计数尾部可能缺失，不能据此宣称远端历史执行次数。验收单列客户端可观察尝试数、远端当前对象及journal转移，允许unobserved，不补造数字。

实现前冻结测试：无授权/无令牌/碰撞/身份不符POST0；首次成功POST1；丢回执后核对POST仍1；所有既有状态的首次提交POST0；PREPARED只读核对保留原状态；UNKNOWN不匹配保持UNKNOWN；双进程与同进程竞争只允许一个入口执行；计划字段改变拒绝；令牌哨兵不进入journal/报告；终态缓存不再请求。先用注入transport和本地fixture覆盖，随后才安排已授权专用仓库的真实验收。此设计没有增加真实服务已支持的声明。

## 单次验收入口（源码候选，尚无真实GitHub验收）

`packages/mcp/examples/github-probe.ts`与`github-probe-cli.ts`实现上述分离入口，不进入npm的dist/src公开文件列表。先构建源码，生成本地计划（不会请求网络）：

```sh
node packages/mcp/dist/examples/github-probe-cli.js --mode plan --repo OWNER/TEST_REPO --repo-id 123 --workspace PATH_TO_NEW_PROBE_WORKSPACE
```

计划生成随机32位标记，name/value均是绑定的合成数据，不能传业务值；打印planFile、完整计划和planHash，`postAuthorized=false`。计划文件以独占创建写入，不覆盖旧计划。令牌不在计划中。查看目标repo及数字ID、workspace、name/value和请求哈希后，由操作者另行取得用户对这次创建的明确授权；拿到授权才在本机配置RELAY_GITHUB_TOKEN并执行：

```sh
node packages/mcp/dist/examples/github-probe-cli.js --mode execute --plan PATH_TO_PLAN --approve-plan-hash REVIEWED_PLAN_HASH
node packages/mcp/dist/examples/github-probe-cli.js --mode reconcile --plan PATH_TO_SAME_PLAN
```

传递hash只是避免无意执行被改动的计划，不是认证、签名或用户授权证明；拥有本机工具权限的人能计算hash或绕过此脚本。首次提交仍会重新预检，并在POST前再查仓库身份。确定失败在POST前发生时记录FAILED；开始POST后不能判定的结果保留UNKNOWN。恢复不需要重新授权写入，因为它没有提交路径；PREPARED原样保留，SUBMITTED/UNKNOWN只查询，终态只读缓存。

确认退出0；blocked/unknown/failed/prepared_not_submitted或内部错误退出2；参数/计划文件读取失败退出64。结果只输出固定原因码及本次进程观察到的GET/POST尝试数，缺失进程输出不能推断尝试数为0。内部错误要求检查journal，不自动重跑execute。没有更新、删除、自动cleanup或自动换key功能。

本地注入transport验证覆盖前述状态表、身份变化后的明确未提交失败、同进程重入拒绝及两个真实子进程持锁竞争。全部远端响应均为合成；跨进程测试未连接HTTP服务。没有声称远端执行次数、真实GitHub权限、跨主机恢复或生产安全通过。具体专用测试仓库与真实写入仍需单独授权。

独立审查后补验：入口请求`takeWorkspaceOwnership(..., { reentrant: false })`，既不借用别的同进程持有者，也不向其出借；其他既有调用者默认重入行为不变。释放失败返回error/lock_release_failed_inspect_journal（退出2），不会误报参数错误或抹去CONFIRMED记录。两个缺陷均先复现再修复；补充await期间调用者修改计划时使用已审字段副本的测试。Windows Node24完整check通过（230 pass、2个平台相关skip），Node22/24新入口与既有锁27项通过；其中新入口11项。Linux新入口未测，测试没有真实GitHub流量。
