# Production readiness audit

AgentMesh is **not yet production-ready**. This checklist maps the primary specification to code and evidence without treating unverified behavior as complete.

| Area | Implementation | Evidence / status |
| --- | --- | --- |
| Plan, profiles, phase/task schema | `src/config.ts`, `src/planning.ts` | Profile and mocked planning tests pass; live multi-harness planning unverified |
| SQLite WAL coordination | `src/state.ts` | Doctor integrity check, legacy task-key migration, and concurrent-run lock tests pass; corrupt-state restoration remains |
| Separate branches and worktrees | `src/git.ts`, `src/runtime.ts` | Two-agent Git test passes; interrupted creation recovery is partial |
| Frozen contracts and checkpoints | `src/runtime.ts`, `src/git.ts` | Contract rejection and coordinator-committed checkpoint tests pass |
| Cross-agent review | `src/runtime.ts`, `src/harness.ts` | Mocked review test passes; live Cursor/Gemini behavior unverified |
| Integration and validation | `src/runtime.ts`, `src/git.ts` | Integration, failed-validation recovery, and next-phase tests pass |
| CLI and diagnostics | `src/cli.ts`, `src/doctor.ts` | CLI initialization and doctor smoke pass; command UX needs wider clean-install tests |
| Agent-facing MCP | `src/mcp.ts` | Real JSON-RPC initialize/list/call handshake passes |
| Codex/Cursor/Gemini control | `src/harness.ts` | CLI shapes checked against official docs and output parsers tested; live Codex call/resume and worktree execution pass with `gpt-5.5`; Cursor/Gemini CLIs absent |
| Install integrations | `src/install.ts` | Codex registration and readback pass in an isolated Codex home; live MCP use from a Codex model and Cursor/Gemini setup remain |
| Token efficiency | `src/runtime.ts` | Bounded diffs/proposals and checkpoint packets; no usage benchmark yet |
| Security and recovery | `src/process.ts`, `src/git.ts`, `src/runtime.ts`, `src/state.ts` | Argument-safe subprocess calls, Windows `.cmd` regression, backup recovery, and concurrent-run lock tested; threat review and orphan-process recovery remain |
| Multiple project types | `src/config.ts`, `tests/dogfood.test.ts`, `tests/profiles.test.ts` | Library, web HTTP, plugin, and game runs pass with mocked harnesses; one live Codex CLI fixture passes; browser and protocol compatibility remain |
| Clean installation | `package.json`, `scripts/smoke-package.mjs` | Fresh tarball install, `init`, and `doctor` pass on Windows; other platforms remain |

External source references used for adapter design: [Codex CLI/MCP](https://developers.openai.com/learn/docs-mcp), [Cursor CLI parameters](https://docs.cursor.com/en/cli/reference/parameters), [Cursor headless mode](https://docs.cursor.com/en/cli/headless), and [Gemini CLI configuration](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md).

The first-run CLI currently separates collaborative `plan` from `start`; a committed plan with explicit validation commands is required before work begins. The automatic work/review/integration flow is validated with realistic fixtures and mock adapters, and a live one-agent Codex flow passes. Real multi-harness execution remains externally unverified.
