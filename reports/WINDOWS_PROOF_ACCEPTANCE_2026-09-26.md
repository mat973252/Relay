# Windows 验证缺口修复（2026-09-26）

基线：`1026d25`。本阶段只修复构建依赖和验证脚本，不改变 effect runner、MCP provider 状态解释或锁协议。

## 复现与修复

1. 原生 Windows Node 24.13.0 的全新检出、冻结安装后，第一次 `corepack pnpm typecheck` 报 `adapter-pi/test/deferred.test.ts:21` 无法解析 `@relay/cli/capsule`。adapter-pi 已有该测试依赖，却遗漏 TypeScript project reference。补齐引用后，从清理过的构建产物开始即可通过，不再依赖手动先构建 CLI。
2. core boundary 测试原先将被检文件规范化成 `/`，却与 Windows `join()` 生成的 `\` 路径比较，错误拒绝合法的 `cli/src/env.ts`。改用 `path.relative()` 与同平台 `join()` 比较；不放宽允许读取环境变量的文件范围。
3. 原始 crash demo 在 Windows 的自杀子进程退出时得到 `signal=null,status=1,remoteCommitted=true`，因此在恢复之前失败。现在子进程通过 IPC 报告已观察到远端提交，由父进程请求强制终止，并在恢复前验证 journal 仍为 `SUBMITTED`。只有确实请求过终止并观察到对应退出结果，才接受崩溃前提；不把任意非零退出当成功。
4. demo 另行统计所有 POST 请求，最终要求 counter 和 POST 数都为 1。provider 自己的幂等去重不能掩盖重复请求。

## 验证

所有效果测试均使用一次性工作区和本机 loopback provider，没有真实业务写入或模型请求。

| 环境 | 构建 / 全套测试 | crash demo |
| --- | --- | --- |
| Windows Node 24.13.0 / pnpm 10.33.0 | 全新冻结安装；clean typecheck 通过；199 项中 197 通过、2 跳过 | 7 项断言通过；POST=1、counter=1；SUBMITTED 经 reconcile 变为 CONFIRMED |
| WSL Ubuntu Node 22.18.0 / pnpm 10.33.0 | 冻结安装、clean typecheck 及 199/199 通过，无跳过 | 7 项断言通过；POST=1、counter=1 |
| WSL Ubuntu Node 24.4.1 / pnpm 10.33.0 | 冻结安装、clean typecheck 及 199/199 通过，无跳过 | 7 项断言通过；POST=1、counter=1 |

Windows 的两项跳过是既有平台限制：chmod 无法可靠拒绝当前进程写入，以及测试进程不允许创建 symlink。不能据此声称这两种拒绝路径在 Windows 已被验证。

复现命令（在独立检出根目录）：

```text
corepack pnpm install --frozen-lockfile
corepack pnpm exec tsc -b --clean
corepack pnpm typecheck
corepack pnpm -r --if-present test
node examples/crash-demo.mjs
git diff --check
```

Linux 使用 `corepack pnpm check` 运行相同构建及全套测试。Pi CLI 集成检查需要 PATH 中的 Pi；受控复跑将 `packages/adapter-pi/node_modules/.bin` 加入 PATH，使用 lockfile 安装的 Pi 0.87.0。一次去掉全局 PATH 后未加本地 Pi 的运行因 `pi --version` 不可用而失败，属于测试环境前提缺失；保留该失败记录，不计入通过次数。

额外负向检查（临时变体已删除）：

- 在 demo 恢复后注入相同 key 的第二次 POST，最终 counter 仍为 1，但 `submit requests === 1` 明确 FAIL，demo 退出 1。
- 在未获允许的 core 源文件中加入 `process.env` 标记，boundary 测试明确拒绝；删除标记文件后 6/6 通过。

## 剩余门槛

- `found-flag` 配置仍假定非 202 的同步 2xx 提交响应证明执行完成，并假定 reconcile 的 `found:false` 是确定的未执行证明。这是原有契约边界，不适用于仅表示已接收或最终一致查询的 provider。必须先选择具体服务与操作，再核对其完成、pending、未找到、认证和超时语义；AISIX 模型连接本身不能代替这项验证。
- 锁保护参与同一协议的本机进程；工作区及锁目录必须受信任。任意绕过协议改写文件/数据库的同权限进程，不在本次证据范围内。
- 本次是本地 Windows/WSL 证据，不是 hosted CI、Windows Node 22、真实业务 provider 或生产采用证据。Step 6/7、许可证选择和包发布仍未完成。
- 本报告只更新旧验收记录中的 Windows 构建/测试/demo 缺口。旧报告保留为历史；AgentLens M8 的离线验收与 Relay 整体安全门槛分别判断。

## 变更文件

`packages/adapter-pi/tsconfig.json`、`packages/core/test/boundary.test.ts`、`examples/crash-demo.mjs`、`README.md` 和本报告。
