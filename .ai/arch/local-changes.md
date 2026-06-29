# Local Changes — Private Fork of cline/kanban

This repository is a **private fork** of [`cline/kanban`](https://github.com/cline/kanban).
`origin` points at the private fork; `upstream` points at `cline/kanban`. This
document explains every intentional divergence from upstream and how to build,
deploy, and stay in sync.

## Remotes & sync model

- `origin`   → private fork (your development line; `main` carries the changes below)
- `upstream` → `https://github.com/cline/kanban.git` (read-only baseline)

Pull upstream improvements periodically:

```bash
git fetch upstream
git merge upstream/main      # or: git rebase upstream/main
git push
```

## Local changes (vs upstream)

Each item is a single focused commit so it can be reviewed, reverted, or sent
upstream independently.

1. **Disable Sentry telemetry** — `src/telemetry/sentry-node.ts`,
   `web-ui/src/telemetry/sentry.ts`
   Empties the hardcoded Sentry DSNs so no crash/error data leaves the machine.
   PostHog and OpenTelemetry are already env-gated upstream and stay off because
   we build without their keys (no `POSTHOG_KEY` / `OTEL_*` set).

2. **Cursor agent support** — `src/core/agent-catalog.ts`, `src/core/api-contract.ts`,
   `src/terminal/agent-session-adapters.ts`, `src/terminal/session-manager.ts`,
   `src/terminal/cursor-workspace-trust.ts`
   Registers the `cursor-agent` CLI as a launchable agent and makes it usable end
   to end:
   - **Lifecycle hooks** written to `~/.cursor/hooks.json` (a guard script that
     no-ops outside a Kanban session): `stop`/`sessionEnd` → review,
     tool/session events → in-progress.
   - **Workspace-trust auto-confirm** — Cursor's interactive "Do you trust this
     directory?" prompt is answered automatically (it shares Codex's wording).
   - **"Clarifying Questions" output detector** — Cursor fires no hook when it
     pauses to ask the user a question, so a PTY detector flags the card for
     review when that picker appears.

3. **Configurable remote hosts** — `src/server/middleware.ts`
   Adds `KANBAN_ALLOWED_HOSTS` (comma-separated host/host:port) to the Host and
   CORS allowlists so the server is reachable by hostname/IP over plain HTTP,
   while always permitting loopback so local CLI subcommands keep working when
   bound to a remote interface.

4. **Fix `--no-passcode`** — `src/cli.ts`
   Upstream read a non-existent `options.noPasscode`; Commander stores the
   negatable flag as `options.passcode === false`. The flag now actually
   disables the remote passcode. (Good upstream PR candidate.)

5. **`crypto.randomUUID` polyfill for insecure contexts** —
   `web-ui/src/main.tsx`, `web-ui/src/utils/crypto-random-uuid-polyfill.ts`
   `crypto.randomUUID` is undefined over plain HTTP on a non-localhost host,
   which crashed the link-tasks UI. Polyfilled from `crypto.getRandomValues`
   (available in insecure contexts). (Good upstream PR candidate.)

6. **Auto-review "Move to Done" mode** — `src/core/api-contract.ts`,
   `src/core/task-board-mutations.ts`, `src/commands/task.ts`,
   `web-ui/src/types/board.ts`, `web-ui/src/hooks/app-utils.tsx`,
   `web-ui/src/hooks/use-review-auto-actions.ts`,
   `web-ui/src/components/task-create-dialog.tsx`,
   `web-ui/src/components/task-inline-create-card.tsx`
   Adds a third auto-review mode (`done`) alongside `commit`/`pr` that moves a
   finished task straight to Done instead of making a commit/PR. Unlike the
   commit/pr modes it has no "changed files" gate, so a task that intentionally
   produces no changes still advances. The mode value is threaded through every
   parse/persist site (runtime enum + legacy `move_to_done` mapping, the
   `normalizeTaskAutoReviewMode` persistence path, the CLI `parseAutoReviewMode`,
   and the web-ui localStorage/board normalizers) so it is never silently
   rewritten back to `commit`.

7. **Linked-task handoff (input/output between linked tasks)** —
   `src/core/api-contract.ts`, `src/core/task-board-mutations.ts`,
   `web-ui/src/types/board.ts`, `web-ui/src/state/board-state.ts`,
   `web-ui/src/handoff/*`, `web-ui/src/utils/interpolate-template.ts`,
   `web-ui/src/hooks/use-linked-backlog-task-actions.ts`,
   `web-ui/src/hooks/use-task-sessions.ts`, `web-ui/src/hooks/use-board-interactions.ts`,
   `web-ui/src/components/task-handoff-config.tsx`,
   `web-ui/src/components/task-inline-create-card.tsx`, `web-ui/src/App.tsx`
   Extends the existing task-dependency links so an upstream task's result flows
   into the downstream task's prompt when the dependency auto-starts it. A new
   optional `handoff` field on the dependency edge (`mode: summary|template|none`,
   plus an optional template) persists in `board.json`. On the auto-start path,
   the upstream's final agent message + git workspace metadata are bound to
   `{{from.*}}` variables (`from.summary`, `from.pr_url`, `from.branch`, …) and
   injected into the downstream prompt via a shared `interpolateTemplate` engine —
   client-side only, so no runtime/tRPC change. Default mode (`summary`) prepends
   the upstream's final message; `template` lets the user write a custom prompt.
   **Configured in the task editor itself**: the `TaskHandoffConfig` panel renders
   inside `TaskInlineCreateCard` (the inline edit form), built in `App.tsx` from
   the edited task's incoming dependency and fed the *live* edit-prompt for an
   accurate resolved-prompt preview. It is hidden entirely unless the task has an
   incoming link, so it only appears on the downstream/consumer task. (Earlier the
   panel lived in `card-detail-view.tsx`'s right agent pane, which was undiscoverable
   — users look in the task editor — so it was moved.) Direction reminder: the
   link's `to` task runs first (producer); the `from` task runs second and receives
   the handoff. Design notes and deferred work (structured handoff block, AND-gating,
   manual-start injection, CLI parity) live in `.plan/docs/linked-task-handoff-plan.md`.

8. **Reviewable Done tasks (open transcript + re-prompt; deferred teardown)** —
   `src/core/api-contract.ts`, `src/trpc/runtime-api.ts`,
   `web-ui/src/hooks/use-task-sessions.ts`,
   `web-ui/src/hooks/use-linked-backlog-task-actions.ts`,
   `web-ui/src/hooks/use-board-interactions.ts`,
   `web-ui/src/components/board-card.tsx`,
   `web-ui/src/components/card-detail-view.tsx`,
   `web-ui/src/components/detail-panels/cline-agent-chat-panel.tsx`,
   `web-ui/src/components/detail-panels/done-task-reprompt-composer.tsx`,
   `web-ui/src/App.tsx`
   Makes the `trash`/"Done" column a reviewable, resumable state instead of an
   immediate destroy. Three coupled changes:
   - **Deferred teardown.** `performMoveTaskToTrash` no longer deletes the worktree
     or stops the agent on move-to-Done — it only closes the per-task detail shell.
     The agent session + worktree stay alive so a Done task can be reopened. The
     real discard (agent stop + `deleteWorktree`) happens only at clear-trash
     (`handleConfirmClearTrash`, unchanged), which is now the single teardown point.
   - **Openable Done + transcript.** `handleCardSelect` no longer bails on `trash`
     and `board-card.tsx` makes Done cards clickable/hoverable (dependency-linking
     stays disabled via the separate `isCardOpenable` flag). The detail view enables
     the terminal for `trash` (`isTaskTerminalEnabled`) so CLI/PTY agents show their
     live terminal transcript, and renders `ClineAgentChatPanel` in a new `readOnly`
     mode (composer + action footer hidden) so the native Cline agent shows its
     persisted chat transcript.
   - **Re-prompt back to In Progress.** `DoneTaskRepromptComposer` (shown under the
     read-only transcript) submits a prompt to `resumeDoneTaskWithPrompt`, which
     moves the card `trash → in_progress`, reuses the existing worktree, and resumes
     the agent *continuing the same conversation* with the new prompt. This rides a
     new `resumeFromPersistence` flag threaded `api-contract` → `runtime-api` →
     `use-task-sessions`: for Cline it hydrates persisted history and runs the prompt
     as the next turn; for CLI/PTY agents it also adds the agent's `--continue`/
     `resume` flag. Lost dependency links (dropped when the task entered Done) stay
     lost, by design.
   Caveat: CLI/PTY agents (claude/codex/…) have no server-side transcript store, so
   their Done transcript is the live terminal — visible within the browser session,
   but not replayed after a full page reload (no server-side buffer). The native
   Cline agent persists the full transcript and survives reloads. Server-side
   terminal-output logging for CLI agents is deferred follow-up work.

## Build & deploy

Prerequisites: Node 22+ (`nvm use 22`).

```bash
scripts/serve-kanban.sh        # state-aware: installs/builds only if needed, then (re)starts only if needed
```

This one command handles a fresh clone, a post-`git pull` rebuild, or an
already-running up-to-date server (no-op). See the **deploy-server** skill
(`.claude/skills/deploy-server/SKILL.md`) for the decision logic, individual
actions (`build`/`start`/`stop`/`restart`/`status`), environment knobs, and
verification steps.

## Security note

The server is served over plain HTTP and (by default) with `--no-passcode`, so
anyone who can reach `KANBAN_HOST:KANBAN_PORT` has full agent access (agents read
repos and run shell commands). Only run it on a trusted network, behind your own
auth, or via an SSH tunnel. Set `KANBAN_PASSCODE_FLAG=""` to re-enable the
generated passcode.
