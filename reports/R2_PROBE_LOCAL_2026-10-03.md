# R2 单次外部验收入口：本地候选

2026-10-03。本报告只确认源码入口和本地验证，真实provider验收未完成。

## 行为与接口

源码示例`packages/mcp/examples/github-probe-cli.ts`提供plan/execute/reconcile；具体使用、授权前提和限制见[契约](../docs/REAL-PROVIDER-CONTRACT.md)。固定GitHub origin，只使用合成变量，计划hash绑定字段和workspace；hash不是人类授权证明。无更新/删除/自动换key路径，PREPARED核对不执行，UNKNOWN仅查询。

`takeWorkspaceOwnership`新增可选`reentrant:false`。默认语义保留；新入口拒绝借用与出借同进程所有权，并防止其自身并发调用。journal关闭后才释放锁，释放失败报告内部错误并保留状态。此选项不构成对任意直接释放锁、改库或绕过HTTP者的防护。

## 实际验证

- 新入口11项：授权hash/令牌/非法计划、精确提交确认、丢回执与不匹配查询、所有既有状态的execute拒绝、PREPARED/missing的只读处理、碰撞/身份、请求hash、确定的pre-POST失败、同进程并发及借锁边界、计划await变更、清理异常、两个真实子进程竞争。
- 初版实际复现两个审查问题：借用同进程锁后会误释放；锁文件被替换为目录后释放异常外抛。修复后与既有锁测试共27项在Windows Node24.19/22.23.3通过。
- 完整`check`（typecheck与全部包测试）通过：230 pass、2 skip。两个skip为既有Windows权限/模式场景，不记为通过。真实Pi CLI的无模型doctor集成保留通过，不代表模型/provider调用。
- 实际CLI生成本地计划后，在清空本次进程令牌的条件下执行缺授权/缺令牌/missing记录三路径，分别返回approval_required/token_missing/record_missing，exit2，GET/POST均0。
- 独立只读审查实际使用gpt-6.1-sol/medium；修复后复核无具体遗漏，是静态证据，不替代上述测试。
- Linux补验：源码`8ce37ccfcfe4f2a0cb2187fe881d0b1f3f30906f`的完整189个跟踪文件归档，复用相同锁文件的冻结依赖并重新typecheck。新入口与既有锁27项在Node22.23.3、24.19.0各通过，零失败/跳过。使用非root、断网、只读根与依赖的新容器；跟踪源码哈希前后一致，容器/volume回收成功。此项没有重复整个仓库check，也不代表真实GitHub请求。

所有HTTP响应由注入transport合成；双进程用本地文件表示合成提交，没有真实HTTP服务。认证与错误哨兵未写入成功/UNKNOWN后的journal残留文件，不能外推为任意输入自动脱敏。客户端尝试计数不能证明远端历史唯一执行次数。

## 待完成

已请求专用测试仓库名称，尚无回复；仍需确认数字ID、只读凭据和具体创建计划授权。真实GitHub请求、远端对象证据及真实崩溃矩阵未完成。源码入口不进入npm发布文件列表，但锁选项属于MCP模块；当前变更尚未发布。
