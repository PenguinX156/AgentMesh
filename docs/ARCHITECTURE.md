# Architecture

AgentMesh keeps durable collaboration decisions in `.agentmesh/collaboration-plan.json` and transient coordination state in `.agentmesh/state.sqlite` with WAL mode. The plan is schema-checked before use. The SQLite tables record phases, agents, tasks, events, reviews, and integration attempts.

`Runtime` owns deterministic transitions. It creates every agent branch from one foundation commit, schedules only dependency-ready tasks, requires clean committed checkpoints, checks frozen paths against the foundation, ties reviews to exact commit IDs, merges onto a dedicated integration branch, runs configured validation, and advances only a completed phase. A failed integration is recorded; `recover` preserves reachable history under a backup branch and reopens tasks.

`Git` owns branch and worktree operations and refuses to remove a dirty checkout. `HarnessAdapter` owns external CLI launch and resume. `mcp.ts` exposes a compact agent-facing interface. The CLI calls the same runtime methods as MCP. Normal progress does not generate cross-agent messages; blocker and contract-conflict events mark exceptional synchronization needs.

The review packet carries bounded diffs and checkpoint summaries. Automatic review runs a harness in its own checkout with a read-only mode where documented and verifies the checkout did not change. When automatic review fails, the phase waits for a manual review. AgentMesh has no independent engineering decision engine; `plan` asks participating harnesses for proposals and validates their synthesized plan.

The integration branch is a checkout under `.agentmesh/integration`. `advance` fast-forwards the project branch after validation and commits the next phase selection. Old agent branches remain as Git refs; clean old worktrees are removed.
