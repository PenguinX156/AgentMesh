# Decisions

- **Git is the code isolation boundary.** Each agent owns a branch and worktree from one immutable phase foundation. Integration is separate from the project branch until validation succeeds.
- **SQLite holds transient state; JSON holds durable workflow decisions.** JSON was selected because it is schema-checkable, diffable, and Git-readable without requiring a YAML parser.
- **MCP and session control are separate.** MCP serves agent-to-runtime collaboration; adapters invoke and resume the harness CLI.
- **Reviews are commit-bound.** An approval cannot authorize later, unreviewed commits.
- **Validation is required.** Empty validation arrays may exist in a newly initialized scaffold, but integration refuses them.
- **Recovery preserves history.** Failed integration commits receive a backup ref before the owned integration checkout resets to the phase foundation.
