# Relay Architecture Correction — Stage 1 Read-Only Audit

You are auditing the actual Relay repository in the current working directory.

## Execution constraint

This is STRICTLY READ-ONLY.
- Do not modify, create, delete, rename, or format any repository file.
- Do not run implementation commands.
- Use only the available read/search/list tools.
- Return the complete audit as Markdown in your final response/stdout.
- Every factual statement about implementation must cite a real `relative/file:line` reference.
- If something is only described in docs but has no implementation, say exactly that. Never convert design intent into an “implemented capability”.
- Inspect actual source tree, Git-visible files, docs, tasks, prompts, tests/config. Do not trust old prose over repository facts.

## Product correction

Relay is a Pi-based long-running Agent Runtime companion.

Relay is NOT a Spec-driven development system and must not maintain a natural-language mirror of source code.

The product target is:

1. Durable Execution State
   - Agent process exit, machine restart, or Harness change must not destroy recoverability.
   - Pi owns Agent Loop, Session, Deferred/Suspended state, Resume, Replay where Pi already provides them.
   - Relay must not duplicate Pi-native semantics.

2. Portable Runtime
   - State, Artifact, Capability and Deferred Handle references must not depend on a specific machine path, PID, or in-memory process.
   - Relay should support export / import / doctor / resume.

3. Durable Epistemic State
   - Long-running work must preserve expensive-to-rederive knowledge, not just transcript/reports.
   - Persist only knowledge that cannot be cheaply/reliably re-derived from source/runtime facts.

## First principles

### Derived, never narrated
If state can be recomputed from facts, do not persist a prose version.
Examples: progress, artifact existence, test status, code structure, session percentage.

State is evidence, not prose.

### No documentation duplication
Do not create or recommend maintaining a text translation of source code.
Persist only:
- Human Intent
- Invariants
- Architecture Decisions / Trade-offs

Expanded specs, module summaries, call graphs, etc. should be generated on demand.

### Persistent Context has a budget
Persistent context should stay small:
- global intent
- task-relevant invariants
- relevant decisions

Optimize total:
Context + Search + Wrong Turns + Rework.

## Epistemic MVP

Do not build a knowledge graph platform.

Minimal domain vocabulary:
- Investigation
- Claim
- Evidence
- Belief
- Delta
- Decision

Flow:
Investigation -> Claims -> Evidence -> Belief -> Delta -> Decision

Definitions:
- Claim: falsifiable/verifiable statement.
- Evidence: inspectable source/experiment/code/benchmark/log/paper evidence.
- Belief: current accepted epistemic state with confidence and scope.
- Delta: what new evidence changes relative to current belief.
- Decision: item requiring human judgment, not a prose report.

Core rule:
No Delta, No Attention.
If an investigation changes no belief and creates no human decision, archive machine-side evidence and do not generate a human attention item.

## Explicit non-goals for this correction
- No full Knowledge Graph
- No large Web UI
- No Notion/Obsidian clone
- No repo-wide Spec conversion
- No class/function description registry
- No Pi Agent Loop rewrite
- No microservices for architecture aesthetics
- No Redis/Kafka/Postgres for this MVP
- Do not delete working runtime behavior
- Do not invent Pi APIs

## Old Relay areas to verify, not assume
Check whether these are actually implemented or only designed:
- core
- adapter-pi
- storage-sqlite
- artifact-fs
- cli
- Effect Guard
- Artifact Lineage
- Capability Doctor
- Capsule Export / Import
- DeferredHandle persistence
- Resume / Replay

Critical question:
Does Relay currently duplicate anything that Pi already owns? If there is no code yet, say there is no code-level duplication to delete; distinguish doc-level architecture risk from implementation duplication.

## Desired logical boundary (not a forced folder migration)
packages/
  core/
  adapter-pi/
  storage-sqlite/
  artifact-fs/
  epistemic/
  cli/

`epistemic` v1 is only domain model + storage boundary for:
investigation, claim, evidence, belief, delta, decision.
It must not launch another agent runtime.

## Acceptance contracts to plan for
1. Durable Resume
   Start Pi long task -> obtain Deferred/checkpoint -> kill process -> restart Relay -> resume -> complete.
   PASS: no dependency on old PID/process memory.

2. Capability Drift
   Persist required capabilities -> restore in environment missing provider/tool -> doctor detects drift -> blocks silent resume.

3. Artifact Lineage
   artifact v1 -> resume -> artifact v2 -> prove v2's execution/evidence provenance.

4. Claim -> Evidence
   Investigation creates claim -> evidence stored -> belief updated.

5. Knowledge Delta
   Existing belief A -> new evidence -> delta = changed/unchanged/contradicted.
   If unchanged, no Human attention item.

6. Decision Gate
   Only sufficiently high impact or non-automatically-resolvable conflict produces Decision.

## Required audit output

Return a single Markdown document titled:
`# Relay Architecture Correction Audit`

It MUST contain these sections:

1. Current Repository Reality
   - Exact tree/relevant files
   - What is source, what is docs/scaffold
   - Git state/history observable to you
2. Actually Implemented Capabilities
   - Implemented vs designed-only table
3. Conflicts With Current First Principles
   - Cite real file:line for every conflict
   - Separate “doc-level direction risk” from “code-level defect”
4. Duplicate Abstractions That Can Be Removed
   - Only real duplicates; if none, say none
   - Identify any doc/task/prompt assumptions that would cause duplication if implemented literally
5. Modules/Boundaries That Should Be Preserved
6. Minimal Durable Epistemic State Insertion Point
   - exact smallest seam, dependencies allowed, dependencies forbidden
   - avoid another runtime
7. Expected File Change List
   - minimal set for the next implementation stage
   - label CREATE / MODIFY / DELETE
   - do not propose mass doc churn
8. Migration Risks
   - include repository/history/toolchain/path assumptions that are actually evidenced
9. Test Plan
   - map the six acceptance contracts to concrete executable tests
   - distinguish unit/integration/e2e
   - name what must be real vs what may be stubbed

End with:
## Go / No-Go for Implementation
Do NOT give a vague opinion. State factual prerequisites/blockers and the smallest safe next implementation slice. Do not implement it.

Also include a short “Evidence gaps” subsection for anything that cannot be proven from the repository alone, especially Pi runtime/API behavior that must be verified against the locally installed Pi version during implementation.
