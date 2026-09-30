# AgentMesh

AgentMesh is a local TypeScript runtime for coordinating existing coding agents. It gives each agent its own Git branch and worktree, records task and checkpoint state in SQLite, exposes an MCP collaboration interface, and validates merged work on an integration branch before advancing a phase.

**New to AgentMesh?** Follow the [setup guide](docs/SETUP.md) to install the CLI once, set up a GitHub repository, connect Codex, Cursor, and Antigravity through MCP, and start a manual collaboration phase. Keep the AgentMesh tool checkout separate from the project repository; setup adds only `.agentmesh` project files.

**Status:** active development. The Git and SQLite workflow, MCP protocol handshake, mocked multi-agent runs, and a single-agent live Codex worktree-to-integration run are tested. Cursor Agent CLI and Gemini CLI are not installed on the development host. See [Production readiness](docs/PRODUCTION_READINESS.md).

## Requirements

- Node.js 24 or newer
- Git with worktree support
- At least one supported harness app with AgentMesh MCP configured for manual runs; headless CLI authentication is needed only for automated runs
- A Git repository with a clean committed starting state before each phase

## Local install

```bash
npm install
npm run build
npm link
agentmesh doctor
```

The package contains a `bin` entry for a future `npm install -g agentmesh` release. It has not been published.

## Run a project

To clone an existing GitHub repository, initialize AgentMesh, and register MCP connections for the selected harnesses in one step:

```bash
agentmesh setup --repo https://github.com/OWNER/REPO.git --agents codex,cursor,antigravity
cd REPO
```

For an existing local checkout, run `agentmesh setup --agents codex,cursor,antigravity` from its root (or pass `--root PATH`). `setup` creates `.agentmesh/collaboration-plan.json`, `.agentmesh/.gitignore`, and a local SQLite database, then runs harness MCP registration. It detects available npm test/build/lint/typecheck scripts for validation. Edit the plan to describe real phase tasks, frozen contract paths, and **at least one validation command for every phase**. The initial profile is a scaffold. Commit the plan and existing project files before starting a phase. `agentmesh init` remains available when you only want to initialize a project without registering integrations.

Optionally have the available agents inspect isolated planning worktrees and produce a project-specific draft:

```bash
agentmesh plan
```

Inspect and commit the new plan. `plan` uses bounded proposals and one synthesis pass; it does not silently execute the draft. A failed or invalid synthesis leaves the committed plan intact.

```bash
agentmesh doctor
agentmesh start --manual
agentmesh agents
agentmesh status
```

`start --manual` prepares a branch and worktree for each agent and prints their paths. Open each worktree in its harness app and select the model there. The MCP registration identifies the project and agent, while a managed worktree branch takes precedence when available. Call `prepare_task` before editing a task with cross-agent dependencies. `submit_checkpoint` commits verified changes on that agent's branch. After all agents checkpoint, use MCP `submit_review` or the CLI review command from the reviewer worktree, then run `agentmesh integrate` and `agentmesh advance`. During independent work, direct messages are reserved for blockers, contract conflicts, and critical discoveries; review requests are allowed after the sender's tasks are complete. Messages are queued for `get_messages` and checkpoint context without interrupting another agent.

For an automated headless run, use `agentmesh start` with agents whose separate CLIs are installed. Antigravity uses the manual MCP flow. Ready tasks execute in dependency order through the installed harness CLIs, followed by checkpoints, cross-review, and integration validation. AgentMesh passes no model override, so each CLI uses its own configured default. High intensity requires two reviewers per agent when at least three agents participate. If a harness, review, or validation step fails, inspect `status` and the integration record. Use `agentmesh resume` for incomplete or failed phases. Failed integration history is preserved under an `agentmesh/failed/...` branch before retry. `agentmesh advance` fast-forwards the project checkout after validated integration, selects the next phase or marks the project complete, and removes clean old agent worktrees.

Manual checkpoint and review commands are available when a harness cannot provide a usable response:

```bash
agentmesh checkpoint --agent codex --task codex-work --summary "Implemented and tested"
agentmesh review --reviewer cursor --subject codex --verdict approve --body "Reviewed diff"
agentmesh review --auto
agentmesh fix --agent codex
agentmesh integrate
agentmesh recover
```

At a completed checkpoint, edit a proposed plan JSON file for future phases and run `agentmesh revise-plan --file path/to/plan.json`. This commits the revision on the integration branch. `advance` accepts plan-only changes after validation and refuses post-validation code changes or rewrites of completed phases.

## Collaboration plan

The plan is a Git-readable JSON file. Example:

```json
{
  "version": 1,
  "projectType": "library",
  "intensity": "normal",
  "agents": [
    { "id": "codex", "harness": "codex", "role": "API implementation" },
    { "id": "gemini", "harness": "gemini", "role": "test design" }
  ],
  "phases": [{
    "id": "phase-1",
    "title": "Public API",
    "tasks": [
      { "id": "api", "title": "Implement API", "owner": "codex", "dependsOn": [], "instructions": "Define and implement the API." },
      { "id": "tests", "title": "Test API", "owner": "gemini", "dependsOn": ["api"], "instructions": "Exercise the API." }
    ],
    "contracts": ["schema/public.json"],
    "validation": [["npm", "test"], ["npm", "run", "build"]]
  }],
  "currentPhase": "phase-1",
  "integration": { "branch": "agentmesh/integration", "requireReviews": true }
}
```

Validation commands are argument arrays and run without a shell. Frozen contracts are repository-relative paths; changing one on an agent branch blocks checkpoint submission and integration. The plan file itself is frozen during a phase.

Automatic review refuses diffs larger than 20,000 characters so the review prompt fits Windows process argument limits. For a larger change, split the task or inspect the agent branch directly and submit a manual review; AgentMesh will not present a clipped diff as complete evidence.

## Harness integration

`setup` runs `install-integrations`; you can rerun `agentmesh setup` or `agentmesh install-integrations` after moving or rebuilding the tool. Registration adds AgentMesh MCP to Codex when its CLI is available and writes Cursor, Gemini CLI, and Antigravity MCP configuration for manual app use. The global `agentmesh` entry points to this project and this harness's agent; registering another project replaces that entry, so rerun registration when switching projects. Verify each app actually loads the server. A managed worktree branch overrides a conflicting configured agent. The plan and adapters do not specify model names.

The automated adapters use `codex exec`, Cursor Agent CLI print mode, and Gemini CLI headless mode. Antigravity currently supports manual MCP sessions. Cursor's editor executable alone is not the separate `cursor-agent` CLI. Gemini's documented plan approval mode is used for read-only planning/review, but has not been verified on this development host.

AgentMesh invokes Codex with its workspace-write sandbox for work and read-only sandbox for planning and review. It performs Git commits itself because Git worktree metadata lives outside the agent's checkout. Cursor and Gemini use their documented headless permission modes; AgentMesh cannot guarantee OS-level confinement for those harnesses. Review validation commands and use trusted agents. Git isolation protects agents from concurrent file changes but does not itself confine operating-system access.

## Development

```bash
npm test
npm pack --dry-run
```

The tests cover initialization, MCP handshake and messages, manual worktree startup, dependency scheduling, separate worktrees, coordinator commits, frozen contracts, cross-review, integration validation, recovery, phase advancement, subprocess cancellation, and Windows batch arguments. Web, plugin, game, and library fixtures run through the integration path. `scripts/smoke-github-onboarding.mjs` checks live cloning and initialization. `scripts/smoke-codex.mjs` and `scripts/smoke-codex-workflow.mjs` use the Codex CLI's configured default for optional live checks.

See [Architecture](docs/ARCHITECTURE.md), [Implementation status](docs/IMPLEMENTATION_STATUS.md), and [Production readiness](docs/PRODUCTION_READINESS.md).
