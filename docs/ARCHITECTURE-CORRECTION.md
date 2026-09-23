# Relay Architecture Correction

> 审计基线：`de8afc1 chore: recover original Relay starter`
>
> 结论先行：当前仓库不是“已有 Relay Runtime 的纠偏”，而是**只有旧版设计 starter、尚无 Runtime 实现**。因此本次不做重构式迁移；先保留正确边界，再从最小可执行切片建立 Durable Execution + Durable Epistemic State。

## 1. 当前仓库真实架构

当前仓库只有根工作区配置、设计文档、任务文档和启动脚本，没有任何 `packages/` 实现。

- `pnpm-workspace.yaml:1-2` 声明了 `packages/*`，但当前并不存在 `packages/`。
- `tsconfig.json:2-3` 的 `files` 与 `references` 均为空，说明没有 TypeScript 子工程挂入。
- `package.json:6-9` 只声明了根级 `typecheck/test/check` 脚本，没有 dependencies/devDependencies。
- `tasks/M0_BOOTSTRAP.md:28-33` 仍把五个 package 写成“Create”，不是“Modify”。
- `reports/` 只有 `.gitkeep`；而 M0 出口要求 `reports/M0_RESULT.md`，见 `tasks/M0_BOOTSTRAP.md:62-68`。

因此当前事实模型是：

```text
Relay repository
├─ design / constraints
├─ milestone task descriptions
├─ workspace scaffold
└─ zero runtime implementation
```

现有 Git 历史也不是旧 Runtime 历史。原始 starter ZIP 不包含 `.git`；恢复后建立的当前 baseline 是 `de8afc1`。不能从当前仓库推断“曾经存在实现后来被删掉”。

## 2. 已实现能力

| 能力 | 当前事实 | 证据 |
|---|---|---|
| Pi 边界声明 | 已定义，未实现 | `README.md:5-16`, `AGENTS.md:5-22` |
| core | 仅设计 | `docs/ARCHITECTURE.md:30-41`, `tasks/M0_BOOTSTRAP.md:28-33` |
| storage-sqlite | 仅设计 | `docs/ARCHITECTURE.md:43-49` |
| artifact-fs | 仅设计 | `docs/ARCHITECTURE.md:51-56` |
| adapter-pi | 仅设计 | `docs/ARCHITECTURE.md:58-66` |
| cli / doctor | 仅设计 | `docs/ARCHITECTURE.md:68-76`, `tasks/M0_BOOTSTRAP.md:35-52` |
| Effect Guard | 仅设计 | `docs/ROADMAP.md:21-36` |
| Artifact Lineage | 仅设计 | `docs/ROADMAP.md:38-52` |
| Capability Doctor | 仅设计 | `docs/ROADMAP.md:54-68` |
| Capsule export/import | 仅设计 | `docs/ROADMAP.md:70-86` |
| Deferred persistence / Resume / Replay | Relay 明确不拥有；计划复用 Pi | `AGENTS.md:7-15`, `docs/ROADMAP.md:88-101` |
| Durable Epistemic State | 尚未进入旧 starter | 旧架构模块列表仅到 CLI，见 `docs/ARCHITECTURE.md:28-76` |

所以不存在“旧代码已经正确工作的 Runtime 能力”可保留；当前应保留的是**边界与不变量**，不是虚构的实现状态。

## 3. 旧设计与当前第一性原则的冲突

### 3.1 代码级冲突

没有。因为没有实现代码，所以现在没有任何 Pi-native 能力的代码级重复，也没有代码可以删除。

### 3.2 设计/流程级冲突

### A. 路径被叙述成固定机器事实

`README.md:40-45`、`scripts/start-relay-m0.ps1:3`、`prompts/AGENTDOCK_PI_GLM53.md:15-20` 都硬编码 `D:\code\relay`，而当前工作区已统一到 `D:\code\aiproject\Relay`。同时旧测试矩阵自己要求 Runtime metadata 不依赖硬编码 `D:\...`，见 `docs/TEST-MATRIX.md:27`。

修正：脚本从自身位置推导 repo root；Runtime state/capsule 只存 portable identifier / relative reference，不存工作机绝对路径作为身份。

### B. 旧路线过度以 milestone/report 驱动

`AGENTS.md:50-63` 要求每个 milestone 产出报告。这可以保留为验收证据，但**报告不能成为 Runtime 状态源**。

修正：
- execution status 从 event/state 推导；
- test status 来自实际 test run；
- artifact existence 来自 store；
- capability readiness 来自 doctor；
- report 只记录不可重新推导的 decision、trade-off、failure boundary 与真实命令结果。

### C. Capsule 存在“复制 Pi 状态”风险

旧架构允许 capsule 包含 “selected Pi durable/session material”，见 `docs/ARCHITECTURE.md:122-135`，但同时又规定 SQLite 不能成为第二套 Pi session store，见 `docs/ARCHITECTURE.md:43-49`。

修正：Capsule 对 Pi 状态只做**显式引用、必要材料选择、完整性校验和迁移 glue**；禁止定义 Relay Session、Relay DeferredHandle、Relay Replay Engine。

### D. Durable Epistemic State 缺位

旧 `@relay/core` 领域列表只有 Effect / Artifact / Capability / Capsule，见 `docs/ARCHITECTURE.md:30-39`，没有 Investigation / Claim / Evidence / Belief / Delta / Decision。

这不是“大知识图谱缺失”，而是长期 Agent 的最小认知持久化缺口。

## 4. 可以删除的重复抽象

当前**没有真实实现层重复抽象可删除**。

需要删除的是后续实现中的诱因，而不是现在凭空删代码：

- 不创建 Relay Agent Loop。
- 不创建 Relay Session Tree。
- 不创建 Relay DeferredHandle。
- 不创建 Relay Resume / Tool Replay 语义。
- 不把 `docs/ARCHITECTURE.md:128` 的 Pi durable/session material 扩大成完整 Pi session 镜像。
- `adapter-pi` 只保留 adapter seam：发现/引用/调用当前 Pi 公共能力。

旧 starter 已明确禁止重复实现这些能力，见 `AGENTS.md:7-15`，这一边界继续保留。

## 5. 必须保留的模块与不变量

### 保留

1. **Effect Guard 不变量**：不确定副作用必须进入 `UNKNOWN`，不能盲重试。见 `AGENTS.md:67-71`、`docs/ARCHITECTURE.md:78-95`。
2. **Artifact content-addressed identity + lineage**：见 `docs/ARCHITECTURE.md:97-111`。
3. **Capability Doctor 在恢复前阻断 drift**：Required capability 必须 AVAILABLE，见 `docs/ARCHITECTURE.md:113-120`。
4. **Capsule 是迁移格式，不是 Runtime**：见 `docs/ARCHITECTURE.md:122-150`。
5. **Pi ownership boundary**：Pi 管 loop/session/deferred/resume/replay，见 `AGENTS.md:5-22`。
6. **TypeScript + Node 22/24 + SQLite + pnpm**：见 `AGENTS.md:24-33`。

### 调整逻辑边界

```text
packages/
  core/             # execution-domain primitives; no Pi
  adapter-pi/       # only Pi-specific seam
  storage-sqlite/   # Relay-owned durable facts
  artifact-fs/      # CAS + lineage content
  epistemic/        # epistemic domain + port only; no agent runtime
  cli/              # operator commands
```

## 6. Durable Epistemic State 最小插入点

第一版 `packages/epistemic` 只定义：

```text
Investigation
  -> Claim
  -> Evidence
  -> Belief
  -> Delta
  -> Decision
```

### 最小职责

- `Investigation`: 调研边界、目标与生命周期 ID。
- `Claim`: 可被证实/证伪的陈述。
- `Evidence`: inspectable evidence reference；优先引用 artifact/effect/source，不复制大段内容。
- `Belief`: 当前接受状态，至少包含 scope + confidence。
- `Delta`: `changed | unchanged | contradicted`，描述新证据相对 Belief 的变化。
- `Decision`: 只有需要 Human 判断的高影响或不可自动消解冲突。

核心 invariant：

```text
No Delta, No Attention.
```

`unchanged` 只落 evidence/delta，不产生 Human attention item。

### 依赖边界

允许：
- 纯 TypeScript domain types / pure functions；
- storage port；
- artifact/effect 的 opaque reference type。

禁止：
- Pi import；
- LLM/model call；
- agent loop；
- scheduler/daemon；
- UI；
- Knowledge Graph；
- 为了“好看”引入服务化依赖。

SQLite implementation 留在 `storage-sqlite`，`epistemic` 本身只拥有 domain + port，避免把领域包变成第二 Runtime。

## 7. 预计修改文件

### Stage A — Foundation / M0

CREATE:
- `.gitignore`
- `packages/core/**`
- `packages/adapter-pi/**`
- `packages/storage-sqlite/**`
- `packages/artifact-fs/**`
- `packages/cli/**`
- package tests
- `reports/M0_RESULT.md`

MODIFY:
- `AGENTS.md`：加入 Derived, never narrated / No documentation duplication / persistent-context budget / No Delta No Attention。
- `package.json`：声明真实 devDependencies/scripts。
- `tsconfig.json`：project references。
- `README.md:40-45`：去掉旧固定目录。
- `scripts/start-relay-m0.ps1:3`：从脚本路径推导 repo root。
- `prompts/AGENTDOCK_PI_GLM53.md:15-20`：修正工作目录与新原则。

### Stage B — Epistemic MVP

CREATE:
- `packages/epistemic/src/types.ts`
- `packages/epistemic/src/delta.ts`
- `packages/epistemic/src/store.ts`
- tests for Claim→Evidence / Knowledge Delta / Decision Gate

MODIFY:
- root project references/workspace wiring；
- `storage-sqlite` 增加 epistemic repository implementation。

不做：
- 大规模重写 `docs/ROADMAP.md`；
- 给每个 class/function 写 spec；
- 新建知识库文档体系。

## 8. Migration 风险

1. **没有旧实现可迁移**：最大风险是误把 starter 文档当实现事实。
2. **旧绝对路径已过时**：见 `README.md:40-45`、`scripts/start-relay-m0.ps1:3`、`prompts/AGENTDOCK_PI_GLM53.md:15-20`。
3. **Pi API 不能猜**：旧 M0 已要求实现前检查 extension/package entry、lifecycle、session metadata、tool hooks、AgentHarness、resume/deferred API，见 `tasks/M0_BOOTSTRAP.md:7-24`。
4. **根 test 脚本现在不能证明 TypeScript 测试可执行**：`package.json:7-9` 只有 `tsc -b` 与 `node --test`，但无 TS 工程/依赖。
5. **密钥隔离必须机械化**：旧设计已经禁止序列化 secrets，见 `AGENTS.md:45-46`；实现要通过 test/grep 验收，而不是报告声称。
6. **跨机路径/大小写差异**：Runtime identity 必须用 portable IDs/relative refs，不把 Windows 路径作为身份。

## 9. 测试计划

| Contract | 级别 | 真实闭环 | PASS |
|---|---|---|---|
| Durable Resume | E2E | 真实 Pi session/deferred 或当前 Pi 可支持的最接近 durable checkpoint；kill 进程；新 Relay 进程 resume | 不依赖旧 PID/内存，不重复 submit |
| Capability Drift | Integration | 保存 required capability snapshot；恢复环境移除 provider/tool；doctor 执行 | 明确 BLOCKED，不能静默 resume |
| Artifact Lineage | Integration | v1 → 新进程/恢复 → v2 | v2 可追到 execution/evidence/v1 |
| Claim → Evidence | Unit + SQLite integration | Investigation + Claim + Evidence → Belief | belief 可按 id/scope 重建 |
| Knowledge Delta | Unit | belief A + 新 evidence | 严格得到 changed/unchanged/contradicted；unchanged 无 attention |
| Decision Gate | Unit | impact / unresolved conflict fixture | 仅高影响或不可自动解决冲突产生 Decision |

另外沿用旧测试矩阵最关键的副作用 invariant：
- crash after remote commit before local confirmation → `UNKNOWN`，见 `docs/TEST-MATRIX.md:10`；
- resume 不得重复 unsafe effect，见 `docs/TEST-MATRIX.md:24-25`；
- artifact migration 保持 digest + lineage，见 `docs/TEST-MATRIX.md:26`。

### 哪些必须真实

必须真实：
- Pi extension load；
- Pi public API integration；
- process kill/restart；
- SQLite reopen；
- filesystem CAS；
- capsule integrity；
- provider/tool capability discovery。

可以 stub：
- 外部危险副作用 provider，使用本地 HTTP counter；
- 远程 deferred provider，前期用可观察 submission-count 的 mock async provider。

## Implementation Gate

可以进入实现，但顺序应是：

```text
M0 foundation
  -> epistemic pure-domain slice
  -> effect/artifact/capability durable slices
  -> capsule
  -> real Pi durable resume/deferred E2E
```

不是因为旧 Roadmap 有 M0 才机械执行，而是因为当前仓库**零实现**，必须先建立最小可编译、可测试、可加载的 Pi adapter seam；随后立刻插入 epistemic pure-domain slice，避免再次沿旧 Roadmap 一路实现到最后才补认知状态。

当前无需再次向 Human 请求“是否采用六实体模型”的确认：这已经是本次架构修正的输入约束。
