---
name: kanban-link-tasks
description: Link two Kanban tasks so one runs after another (a dependency / execution order). Use when building a workflow where task B should only start after task A finishes. Pairs with kanban-create-task.
---

# Link Kanban tasks

Create a dependency between two board tasks with `kanban task link`. When the
**prerequisite** task finishes review and is moved to Done, the **waiting** task
auto-starts (if it is in the backlog). This is how you chain work into an
autonomous pipeline.

## Resolve the CLI and the project path

You are typically inside a task worktree, so target the main repo with `--project-path`.

```bash
# Kanban injects KANBAN_CLI as a ready-to-run command line. It may be a single
# binary (`kanban`) or a multi-token command (e.g. `node /path/dist/cli.js`), so
# it MUST be re-parsed by the shell — never used as one quoted "$KANBAN" word,
# which fails with "No such file or directory". Wrap it in a function instead:
kanban() { eval "${KANBAN_CLI:-command kanban} $(printf '%q ' "$@")"; }
MAIN_REPO="$(git rev-parse --path-format=absolute --git-common-dir | sed 's#/\.git/*$##')"
```

## Create the link

Direction: `--task-id` is the task that **waits**; `--linked-task-id` is the
**prerequisite** that must finish first.

```bash
# Run PREREQ first, then WAITER:
kanban task link --task-id <WAITER_ID> --linked-task-id <PREREQ_ID> --project-path "$MAIN_REPO"
```

On the board the arrow points in execution order — from the prerequisite into the
waiting task (prerequisite → waiter).

## Building a workflow

Typical pattern: create the tasks first, then link each dependency edge.

```bash
A="$(kanban task create --prompt "Step A" --auto-review-enabled true --auto-review-mode commit --project-path "$MAIN_REPO" | sed -n 's/.*"id" *: *"\([^"]*\)".*/\1/p' | head -n1)"
B="$(kanban task create --prompt "Step B (after A)" --project-path "$MAIN_REPO" | sed -n 's/.*"id" *: *"\([^"]*\)".*/\1/p' | head -n1)"

# B waits on A → A runs first, then B:
kanban task link --task-id "$B" --linked-task-id "$A" --project-path "$MAIN_REPO"
```

With auto-review enabled on A, when A finishes it auto-commits, moves to Done, and
B auto-starts — no manual step in between.

## Notes

- A link requires at least one of the two tasks to be in the backlog (the waiter).
- The saved direction is stable: finishing the waiter does NOT start the prerequisite; only finishing the prerequisite starts the waiter.
- Use `kanban task list --project-path "$MAIN_REPO"` to inspect task IDs and existing links.
