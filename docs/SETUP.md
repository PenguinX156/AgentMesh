# Set up AgentMesh for a project

AgentMesh is a local CLI and collaboration runtime that exposes a **stdio MCP server**. It is not a separate Codex, Cursor, or Gemini plugin. The MCP server gives each agent tools for reading its task, exchanging messages, submitting checkpoints, and reviewing another agent's work. Each agent still writes code through its own harness app and uses the model selected there. AgentMesh stores coordination state locally and uses Git branches and worktrees to isolate code changes.

## 1. Install the AgentMesh CLI

You need Node.js 24 or newer and Git. Until AgentMesh is published to npm, clone and build the tool repository once:

```powershell
git clone https://github.com/PenguinX156/AgentMesh.git
cd AgentMesh
npm install
npm run build
npm link
agentmesh --help
```

Keep this tool checkout in place. `npm link` points the `agentmesh` command to it. After pulling tool updates, run `npm install` and `npm run build` again. If you move the tool checkout, rebuild/relink it and rerun `agentmesh install-integrations` in each affected project.

## 2. Turn a GitHub repository into an AgentMesh project

Run this from the parent directory where you want the project clone. Substitute the repository URL and include only the harnesses you will use; repeated names create multiple agents of the same harness. Git authentication must already work if the repository is private.

```powershell
agentmesh init --repo https://github.com/OWNER/PROJECT.git --agents codex,cursor,gemini
cd PROJECT
```

If the repository is **already cloned**, run this from that checkout instead:

```powershell
agentmesh init --agents codex,cursor,gemini
```

Initialization creates `.agentmesh/collaboration-plan.json` and local SQLite state. Edit the JSON plan before starting:

- Give each agent a useful `role` and each task a specific `title`, `owner`, and `instructions`. Task owners must match agent IDs in the plan.
- Set `dependsOn` when a task must wait for another task's checkpoint. Independent tasks can proceed in separate worktrees.
- List repository-relative paths under `contracts` only for files that must stay frozen for the whole phase.
- Set at least one working command in each phase's `validation`, using argument arrays such as `[["npm", "test"], ["npm", "run", "build"]]`. AgentMesh runs these after integration.
- Choose `currentPhase` and review the generated phases. The generated plan is a scaffold, not a project-specific assignment.

The plan contains harness names and agent roles, **no model names**. Set the model in each harness interface. Commit the plan and all starting project changes; a phase needs a clean committed base:

```powershell
git add .agentmesh
git commit -m "Set up AgentMesh collaboration plan"
```

If the checkout has other uncommitted project files, review and commit them too before `start`. `.agentmesh/state.sqlite` and generated worktrees are ignored by the project's AgentMesh `.gitignore`.

## 3. Connect the harnesses to the MCP server

From the **project root**, run:

```powershell
agentmesh install-integrations
agentmesh doctor
```

`install-integrations` uses the agent roster in the plan. It registers a local `agentmesh` MCP server with each listed harness; the server command points to your built AgentMesh CLI. Existing unrelated Cursor and Gemini configuration entries are preserved. Check the command's per-harness results and verify the server is actually available in each app.

| Harness | What AgentMesh configures | How to verify |
| --- | --- | --- |
| Codex | Registers `agentmesh` through `codex mcp add` (Codex CLI must be installed for this registration). | Run `codex mcp get agentmesh` or `codex mcp list`, then check that AgentMesh tools appear in a Codex session. |
| Cursor | Adds `mcpServers.agentmesh` to `%USERPROFILE%\.cursor\mcp.json`. | Open Cursor's MCP settings or Agent tools and check that the server and its tools are available. |
| Gemini CLI | Adds `mcpServers.agentmesh` to `%USERPROFILE%\.gemini\settings.json`. | Run `gemini mcp list` from a trusted project directory or use `/mcp` in Gemini CLI. |

If a harness was already open, start a new session or reload its MCP servers after registration. The separate `cursor-agent` and `gemini` headless CLIs are needed only for `agentmesh start` automated runs; they are not required to write their MCP configuration or to work manually in the harness app. `agentmesh doctor` reports CLI availability and local config presence; it does not prove that a GUI app loaded the server. Gemini CLI is the supported Gemini harness here; other Gemini-branded apps have not been verified.

## 4. Start a manual collaboration phase

```powershell
agentmesh start --manual
agentmesh agents
agentmesh status
```

`start --manual` prints one **worktree path per agent**. Open each printed path as a separate workspace in its matching harness: Codex for the Codex worktree, Cursor for the Cursor worktree, and Gemini CLI for the Gemini worktree. Configure the desired model in that harness. The MCP server identifies a manual agent session from its managed worktree branch, so opening the original project root will show inactive AgentMesh context.

In each agent session, a useful first prompt is:

> Use the AgentMesh MCP tools to read `get_project_context`, `get_my_task`, and `get_contracts`. Work only on your assigned task in this worktree. Check `get_messages` for coordination. When your work is verified, use `submit_checkpoint` with the task ID, summary, and tests run.

Agents can use `send_message` for blockers, contract conflicts, and critical discoveries during independent work. Messages are queued in local state; another agent receives them when it calls `get_messages` or reads checkpoint context. Ordinary questions and decisions are available during review. This is not a live chat or automatic notification channel.

Once each assigned task has a checkpoint, use the review tools (`inspect_agent_diff`, `request_review`, and `submit_review`) from the other agents' worktrees. Then, from the original project checkout:

```powershell
agentmesh status
agentmesh integrate
agentmesh advance
```

`integrate` merges the agent branches onto an integration branch and runs the plan's validation commands. `advance` updates the original checkout only after successful integration. If a phase fails, inspect `agentmesh status` and the reported validation error before retrying. For command-line alternatives and recovery, see the [README](../README.md).

## Automated runs and current limits

`agentmesh start` runs installed, authenticated harness CLIs in the prepared worktrees and coordinates checkpoints and review. It passes **no model override**; each CLI uses its own configured default. Use `agentmesh start --manual` when you want to drive the agents in their apps. Codex CLI has a tested live worktree-to-integration path. Cursor Agent CLI and Gemini CLI cross-harness execution have not yet been verified live on the development host. Verify each harness's MCP connection and start with a small phase before relying on it for a large repository.

## Harness documentation

- [Codex MCP configuration](https://developers.openai.com/learn/docs-mcp)
- [Cursor MCP configuration](https://docs.cursor.com/context/model-context-protocol)
- [Gemini CLI MCP server configuration](https://geminicli.com/docs/tools/mcp-server/)
