---
name: deploy-server
description: Build and deploy this Kanban fork's local server. Use when asked to build, (re)deploy, start/stop/restart, or check the status of the Kanban web server, or when the server is down and needs to come back up.
---

# Deploy the Kanban Server

Build the fork from source (telemetry-free) and run the web server detached on
the LAN. Background and rationale for the local changes live in
`.ai/arch/local-changes.md`.

## Prerequisites

- Node 22+: `nvm use 22` (this fork is built/run on Node 22).
- A git repo to open as the board (default `~/hello-kanban`).

## TL;DR — one command does the right thing

```bash
scripts/serve-kanban.sh            # = deploy (default)
```

`deploy` is **state-aware** — run it any time (fresh clone, after `git pull`,
after editing code, or when the server is already up) and it does only what's
needed:

```
        ┌─ deps missing? ───────────────► npm install (root + web-ui)
deploy ─┤
        ├─ rebuild needed? ─────────────► npm run build      (else skip)
        │     (dist/cli.js missing, or any source/build input newer than it)
        │
        └─ then decide the server:
              • not running              ► start (detached)
              • running + just rebuilt    ► restart (pick up new build)
              • running + build unchanged ► nothing to do
```

So: **already deployed and up to date → no-op. Code changed → rebuild + restart.
Only the server is down → just start.** No need to decide manually.

Builds never set `POSTHOG_KEY`, `OTEL_*`, or `SENTRY_AUTH_TOKEN`, keeping the
bundle telemetry-free. Verify a build:

```bash
rg -c "ingest\..*sentry\.io|data\.cline\.bot" dist/cli.js dist/web-ui/assets/*.js || echo "clean: no telemetry endpoints"
```

## Actions / manual control

The repo script needs no global install and survives logout (`setsid`+`nohup`):

```bash
scripts/serve-kanban.sh deploy     # default: smart build-if-needed + (re)start-if-needed
scripts/serve-kanban.sh status     # running? + whether the build is up to date / stale / missing
scripts/serve-kanban.sh build      # force a build (installs deps first if missing)
scripts/serve-kanban.sh start      # (re)start from the current dist/
scripts/serve-kanban.sh restart    # same as start (stops any existing first)
scripts/serve-kanban.sh stop       # stop the server
```

How "rebuild needed" is decided: no `dist/cli.js`, or any of `src/`,
`web-ui/src/`, `package.json`, `web-ui/package.json`, `scripts/build.mjs`,
`web-ui/vite.config.ts`, or the `tsconfig*.json` files is newer than the built
`dist/cli.js` (so edits and `git pull`/`merge`/`checkout` all trigger a rebuild).

Defaults: binds `0.0.0.0:3484`, `--no-passcode`, logs to
`/tmp/kanban-server.log`. The Host-header/CORS allowlist is **derived from the
machine it runs on** (short + FQDN hostname and all bound IPv4 addresses, plus
`localhost`/`127.0.0.1`) — nothing host-specific is hard-coded. `start` prints
the effective allowlist. Override with `KANBAN_ALLOWED_HOSTS` only if you need an
explicit list.

Override via env, e.g.:

```bash
KANBAN_PORT=4000 scripts/serve-kanban.sh start          # different port
KANBAN_PASSCODE_FLAG="" scripts/serve-kanban.sh restart # re-enable the passcode
KANBAN_ALLOWED_HOSTS="my-host,10.0.0.5" scripts/serve-kanban.sh start
```

| Env | Default | Meaning |
|-----|---------|---------|
| `KANBAN_PROJECT` | `~/hello-kanban` | git repo the board opens on |
| `KANBAN_HOST` | `0.0.0.0` | bind interface |
| `KANBAN_PORT` | `3484` | port |
| `KANBAN_ALLOWED_HOSTS` | this machine's hostname(s) + IPs | Host-header/CORS allowlist (auto-detected) |
| `KANBAN_LOG` | `/tmp/kanban-server.log` | server log path |
| `KANBAN_PASSCODE_FLAG` | `--no-passcode` | set to `""` to require the generated passcode |

## 3. Verify

```bash
scripts/serve-kanban.sh status
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: $(hostname -s):3484" http://127.0.0.1:3484/   # expect 200
```

Then open `http://<KANBAN_HOST-or-hostname>:<KANBAN_PORT>/<project>` in a browser.

## Notes

- The server detaches (PPID 1), so it keeps running after the shell exits; only a
  reboot or `scripts/serve-kanban.sh stop` stops it.
- After a machine reboot, just re-run `scripts/serve-kanban.sh start` (no rebuild
  needed if `dist/` already exists).
- Security: plain HTTP + `--no-passcode` means anyone who can reach the port gets
  full agent access. Run only on a trusted network, behind your own auth, or via
  an SSH tunnel (`ssh -L 3484:127.0.0.1:3484 <host>` then use `localhost:3484`).
