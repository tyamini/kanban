---
name: kanban-task-done
description: Move the CURRENT Kanban task to Done from inside the running task, once it has genuinely finished successfully. Use for long-running / multi-turn tasks (orchestrators, execution loops, reviewers, watchdogs) that decide their own completion instead of relying on auto-review. Do NOT use when blocked, asking a question, or waiting on a sub-agent.
---

# Move the current Kanban task to Done

> **THIS SKILL DOES NOTHING BY ITSELF. It is a set of instructions, not an
> action.** To actually finish the task you MUST run the shell command in the
> [Move this task to Done](#move-this-task-to-done) section below, yourself, in
> this turn, using your shell/Bash tool. Loading or "launching" this skill does
> **not** move the card. Do **not** say the task is done, and do **not** end your
> turn, until you have executed the command and seen its JSON result. Merely
> reading these instructions or announcing that "the skill will move it to Done"
> leaves the card stuck in `review` forever.

Signal that **this** task is finished by moving its card to **Done** with
`kanban task done`. This is the *positive completion signal* for tasks that can't
be judged done from the outside — multi-turn loops, orchestrators, reviewers,
investigators, and watchdogs that end and resume turns while still working.

Moving to Done also **auto-starts any linked backlog tasks** (see
`kanban-link-tasks`), so this is how a self-reporting task hands off to the next
stage of a pipeline.

## When to call this — and when NOT to

Call it **only when the task has actually completed its objective successfully.**

Do **NOT** call it when:

- You are **blocked** on a real problem and need the user to decide something.
- You are **asking the user a question** — just end your turn; the card stays in
  `review` waiting for them.
- You are **waiting on a sub-agent / background child process** and only ended
  your turn to wait. Ending a turn is not the same as finishing the task. Resume
  and keep working; call this only after the whole loop is truly done.

If in doubt, do **not** call it — leave the card in `review`. A task wrongly left
in review is a harmless wait; a task wrongly moved to Done is destructive (see
below).

## What moving to Done does (why the guard above matters)

`task done` will, in order:

1. **Stop this task's agent session** (it terminates the very session you are
   running in — that's expected, you are declaring yourself finished).
2. **Auto-start any linked backlog tasks** that were waiting on this one.
3. **Delete this task's worktree.**

So calling it prematurely (e.g. while a child build is still running) kills your
session, throws away in-flight work, and kicks off downstream tasks too early.
Only call it at genuine completion.

## Resolve the CLI, this task's id, and the project path

Kanban injects these into every task worktree:

```bash
# Kanban injects KANBAN_CLI as a ready-to-run command line. It may be a single
# binary (`kanban`) or a multi-token command (e.g. `node /path/dist/cli.js`), so
# it MUST be re-parsed by the shell — never used as one quoted "$KANBAN" word,
# which fails with "No such file or directory". Wrap it in a function instead:
kanban() { eval "${KANBAN_CLI:-command kanban} $(printf '%q ' "$@")"; }

# This task's own id (set by Kanban for the running task):
TASK_ID="$KANBAN_HOOK_TASK_ID"

# The MAIN project repo — NOT the worktree. task done deletes the worktree, so it
# must be targeted at the main repo path (works whether or not you are in a worktree):
MAIN_REPO="$(git rev-parse --path-format=absolute --git-common-dir | sed 's#/\.git/*$##')"
```

## Move this task to Done

**Run this now, in your shell/Bash tool** (all three snippets above + this one,
in one shell invocation is fine):

```bash
kanban task done --task-id "$TASK_ID" --project-path "$MAIN_REPO"
```

The command prints JSON including any `autoStartedTasks` that were triggered by
finishing this one.

## Confirm it worked (required)

You are only finished once you have **actually executed** the command above and
seen its JSON output (e.g. a `task` object with `"column": "trash"`). If you did
not run it, or it errored, the card is still in `review` and the task is **not**
done — run it (or report the error). Never claim completion based on having
launched this skill.

## Notes

- **Prefer this over auto-review for self-completing tasks.** If a task decides
  its own completion with this skill, **disable auto-review on it**
  (`--auto-review-enabled false`, the default). Leaving auto-review "done" enabled
  on a multi-turn loop reintroduces the premature-Done hazard: auto-review can't
  tell "finished cleanly" from "ended a turn to wait on a child" and may move the
  task to Done behind your back before this skill runs.
- Auto-review remains the right choice for **single-shot tasks** where ending a
  turn without a question reliably means the task is done. Use this skill instead
  when that assumption does not hold.
- Requires the Kanban runtime to be running (it is, if a task is executing). If
  the command fails because the runtime is unavailable, report it rather than
  retrying blindly.
