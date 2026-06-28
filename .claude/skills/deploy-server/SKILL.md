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

## 1. Build (only after a clone or code change)

```bash
nvm use 22
npm install
npm --prefix web-ui install
npm run build
```

Do **not** set `POSTHOG_KEY`, `OTEL_*`, or `SENTRY_AUTH_TOKEN` — building without
them keeps the bundle telemetry-free. Verify:

```bash
rg -c "ingest\..*sentry\.io|data\.cline\.bot" dist/cli.js dist/web-ui/assets/*.js || echo "clean: no telemetry endpoints"
```

## 2. Deploy / manage

Use the repo script (no global install, survives logout via `setsid`+`nohup`):

```bash
scripts/serve-kanban.sh start      # or: restart | stop | status
```

Defaults: binds `0.0.0.0:3484`, `--no-passcode`, allows hosts
`tyamini-dev,10.10.73.144`, logs to `/tmp/kanban-server.log`.

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
| `KANBAN_ALLOWED_HOSTS` | `tyamini-dev,10.10.73.144` | extra Host-header/CORS allowlist |
| `KANBAN_LOG` | `/tmp/kanban-server.log` | server log path |
| `KANBAN_PASSCODE_FLAG` | `--no-passcode` | set to `""` to require the generated passcode |

## 3. Verify

```bash
scripts/serve-kanban.sh status
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: tyamini-dev:3484" http://127.0.0.1:3484/   # expect 200
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
