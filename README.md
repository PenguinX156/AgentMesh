# AgentMesh

AgentMesh is a local TypeScript runtime for coordinating existing coding agents. It gives each agent its own Git branch and worktree, records task and checkpoint state in SQLite, exposes an MCP collaboration interface, and validates merged work on an integration branch before advancing a phase.

**Status:** active development. The Git and SQLite workflow, MCP protocol handshake, and mocked multi-agent runs are tested. A real Codex model call is currently blocked by the model entitlement of the CLI login on the development host. Cursor Agent CLI and Gemini CLI are not installed there. See [Production readiness](docs/PRODUCTION_READINESS.md).

## Requirements

- Node.js 24 or newer
- Git with worktree support
- At least one supported coding-agent CLI authenticated for real runs: `codex`, `cursor-agent`, or `gemini`
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

Run these commands from the root of the project that the agents will build:

```bash
agentmesh init --agents codex,cursor,gemini --type cli
```

`init` creates `.agentmesh/collaboration-plan.json`, `.agentmesh/.gitignore`, and a local SQLite database. It initializes Git if necessary and detects available npm test/build/lint/typecheck scripts for validation. Edit the plan to describe real phase tasks, frozen contract paths, and **at least one validation command for every phase**. The initial profile is a scaffold. Commit the plan and existing project files before proceeding. `start` checks for validation commands before launching a harness.

Optionally have the available agents inspect isolated planning worktrees and produce a project-specific draft:

```bash
agentmesh plan
```

Inspect and commit the new plan. `plan` uses bounded proposals and one synthesis pass; it does not silently execute the draft. A failed or invalid synthesis leaves the committed plan intact.

```bash
agentmesh install-integrations
agentmesh doctor
agentmesh start
agentmesh status
```

`start` runs the current phase: ready tasks execute in dependency order, agents commit independently, checkpoints are recorded, cross-reviews run when configured, and the integration worktree runs the plan's validation commands. High intensity requires two reviewers per agent when at least three agents participate. If a harness, review, or validation step fails, inspect `status` and the integration record. Use `agentmesh resume` for incomplete or failed phases. Failed integration history is preserved under an `agentmesh/failed/...` branch before retry. `agentmesh advance` fast-forwards the project checkout only after a validated integration, commits the next phase selection, and removes clean old agent worktrees.

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

## Harness integration

`install-integrations` registers the AgentMesh MCP server with installed CLIs. AgentMesh launches each harness with `AGENTMESH_ROOT` and `AGENTMESH_AGENT_ID`, which identify its project and agent to the MCP server. The server can also infer identity from a managed worktree and reports inactive context outside AgentMesh. MCP is for agent-to-runtime state and exceptional messages; the adapter layer launches and resumes CLI sessions. Model names are optional per-agent plan values.

The adapters currently use `codex exec`, Cursor Agent CLI print mode, and Gemini CLI headless mode. They expose capabilities according to documented CLI behavior; real availability is reported by `doctor`. Cursor's editor executable alone is not the separate `cursor-agent` CLI. Gemini's documented plan approval mode is used for read-only planning/review, but has not been verified on this development host.

AgentMesh does not provide an OS sandbox. Headless harnesses may run commands and modify files in their isolated worktrees. Run only trusted agents, review validation commands, and use the harnesses' own permission settings where appropriate. Git isolation protects agents from concurrent file changes; it does not confine their operating-system access.

## Development

```bash
npm test
npm pack --dry-run
```

The tests cover initialization, MCP handshake, dependency scheduling, separate worktrees, frozen contracts, cross-review, integration validation, recovery, phase advancement, subprocess cancellation, and Windows batch arguments. Web, plugin, game, and library fixtures run through the integration path. `scripts/smoke-codex.mjs` is an optional live CLI check.

See [Architecture](docs/ARCHITECTURE.md), [Implementation status](docs/IMPLEMENTATION_STATUS.md), and [Production readiness](docs/PRODUCTION_READINESS.md).
