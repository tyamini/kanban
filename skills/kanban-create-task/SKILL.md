---
name: kanban-create-task
description: Create a new task in the Kanban backlog from inside a running task. Use when the agent should enqueue follow-up work, break work into board tasks, or build a multi-step workflow on the Kanban board that other agents will pick up.
---

# Create a Kanban task

Add a task to the **Backlog** of the current project's Kanban board using the
`kanban task create` CLI. The new task is a normal board card that a dedicated
agent can start later (or that auto-starts when a task it is linked to finishes).

Use this when the work you are doing should spawn separate follow-up tasks
(decomposition, follow-on work, parallelizable pieces) rather than doing it all
inline.

## Resolve the CLI and the project path

You are typically running inside a Kanban **task worktree** (a path under
`~/.cline/worktrees/…`). Board commands must target the **main project repo**, not
the worktree, so pass `--project-path`.

```bash
# Kanban injects KANBAN_CLI as a ready-to-run command line for tasks it spawns.
# It may be a single binary (`kanban`) or a multi-token command (e.g.
# `node /path/dist/cli.js`), so it MUST be re-parsed by the shell — never used as
# one quoted "$KANBAN" word, which fails with "No such file or directory". Wrap it
# in a function instead (falls back to the global binary if not injected):
kanban() { eval "${KANBAN_CLI:-command kanban} $(printf '%q ' "$@")"; }

# The main project repo (works whether or not you are in a worktree):
MAIN_REPO="$(git rev-parse --path-format=absolute --git-common-dir | sed 's#/\.git/*$##')"
```

## Create the task

```bash
kanban task create --prompt "Write unit tests for the auth module" --project-path "$MAIN_REPO"
```

Common options (all optional except `--prompt`):

- `--prompt "<text>"` — required. The task instructions for the agent that will run it.
- `--title "<text>"` — optional; derived from the prompt if omitted.
- `--base-ref <branch>` — base branch for the task's worktree. Defaults to the current/default branch.
- `--auto-review-enabled true --auto-review-mode commit|pr|done` — automatically commit / open a PR / move to Done when the task reaches review. Combine with links (see `kanban-link-tasks`) to build autonomous pipelines.
- `--agent-id <id>` — override the agent (`cline|claude|codex|droid|gemini|opencode|default`).

The command prints JSON including the new task's `id` (needed to link tasks).
Capture it, e.g.:

```bash
TASK_ID="$(kanban task create --prompt "…" --project-path "$MAIN_REPO" | sed -n 's/.*"id" *: *"\([^"]*\)".*/\1/p' | head -n1)"
```

## Notes

- Requires the Kanban runtime to be running (it is, if a task is executing). If a
  command fails because the runtime is unavailable, report it rather than retrying blindly.
- To wire up execution order between tasks, use the **kanban-link-tasks** skill.
