# Deploy Kanban

Short guide to run this fork's server on a machine.

## 1. Prerequisites

- **Node 22+** — `nvm use 22`
- **GitHub CLI authenticated** — agents commit, push, and open PRs as you:

```bash
gh auth login       # then verify:
gh auth status
```

- **Claude authenticated** — the agent that runs tasks must be logged in:

```bash
claude              # log in once, then exit
```

## 2. Set your git identity

Commits and PRs the agents make are attributed to this name/email, so set it
(global is fine, or per-repo inside the board project):

```bash
git config --global user.name  "Your Name"
git config --global user.email "you@example.com"
```

## 3. Deploy

One state-aware command installs deps, builds (telemetry-free), and (re)starts
the server only as needed — safe to re-run any time:

```bash
scripts/serve-kanban.sh          # deploy (default)
```

Other actions: `status`, `build`, `start`, `stop`, `restart`. Defaults bind
`0.0.0.0:3484` with `--no-passcode` and log to `/tmp/kanban-server.log`.
Full details (env knobs, rebuild logic, verification) are in the
**deploy-server** skill at `.claude/skills/deploy-server/SKILL.md`.

## 4. Verify

```bash
scripts/serve-kanban.sh status
```

Then open `http://<host>:3484/<project>` in a browser.

> **Security:** plain HTTP + `--no-passcode` means anyone who can reach the port
> gets full agent access. Run only on a trusted network or via an SSH tunnel
> (`ssh -L 3484:127.0.0.1:3484 <host>`). Set `KANBAN_PASSCODE_FLAG=""` to require
> the generated passcode.
