# Agent workspace instructions

This repository may be used through multiple persistent git worktrees.

At the beginning of each session, determine your current workspace by running:

- `git rev-parse --show-toplevel`
- `git branch --show-current`
- `git status --short`

## Agent identity

If the current branch is:

- `agent/bonsai` → you are the Bonsai agent
- `agent/qwen` → you are the Qwen agent
- `agent/codex` → you are the Codex agent
- `main` → this is the integration workspace, not an agent worktree

The worktree directory should normally match the agent name:

- `pboard-bonsai`
- `pboard-qwen`
- `pboard-codex`

Do not assume your identity from previous sessions.
Always derive it from the current git branch/worktree.

## Workflow

When working on an `agent/*` branch:

- Work only inside the current worktree.
- Never switch branches.
- Never modify another worktree.
- Implement the requested task completely.
- Inspect the existing architecture before changing it.
- Run relevant tests.
- Update tests and documentation when appropriate.
- Keep changes focused.
- Commit completed work to the current agent branch when requested.

When running on `main`:

- Treat this workspace as the integration workspace.
- Do not perform feature work unless explicitly requested.
