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
