# Borrowed-machine provisioning & unsupervised Claude Code

How Kanban turns a freshly **borrowed** machine (the AWS Jenkins pool, or an
office box) into a host that can run task agents **unsupervised** — fully
authenticated and with zero interactive prompts blocking the first session.

Provisioning lives in `src/remote/borrow-machine-setup.ts`
(`provisionBorrowedMachine`), run once over SSH right after a machine is
borrowed. The remote Kanban runtime that actually spawns the agents is launched
by `src/remote/remote-runtime-bootstrap.ts`.

This doc captures the **non-obvious** findings — the parts that took reverse
engineering the Claude Code binary and live experiments to pin down — so nobody
has to rediscover them.

## The goal

A borrowed box is disposable and headless. When a task starts, the remote
runtime spawns the CLI agent (`claude --dangerously-skip-permissions`) in a PTY.
Anything that makes that agent **stop and wait for a human keypress** silently
wedges the task. So provisioning must pre-satisfy every one-time gate:

1. `gh` installed + authenticated (Jenkins REST + repo access).
2. Claude Code logged in (no login/onboarding flow).
3. Claude's **managed-settings** approval prompt pre-accepted.
4. Claude's **Bypass Permissions** disclaimer pre-accepted.
5. Claude's per-folder **trust** prompt suppressed.

Items 1–2 are mirrored from the hub; 3–5 are the tricky ones below.

## Findings (the hard-won bits)

### gh install: pin the version, don't query the API
`api.github.com/.../releases/latest` returns **HTTP 403** on some borrow
networks (notably the AWS pool) even though the release-asset download host is
reachable. The installer pins a version (`GH_VERSION`, overridable via
`KANBAN_BORROW_GH_VERSION`) and downloads the tarball directly into
`~/.local/bin`. See `GH_INSTALL_SCRIPT` in `borrow-machine-setup.ts`.

### Claude auth: token alone is not enough
Copying `~/.claude/.credentials.json` (the OAuth token) makes Claude "have a
token" but it still re-runs the **login + onboarding** flow, because the
account/onboarding state lives in `~/.claude.json`. We mirror a **sanitized**
subset of that file (`CLAUDE_CONFIG_KEEP_KEYS`: `hasCompletedOnboarding`,
`oauthAccount`, `userID`, …) — deliberately *not* the whole file, which also
holds hub-specific `projects`, MCP wiring, and large path-keyed caches that are
noise or actively harmful on the remote.

### Managed-settings prompt ← `~/.claude/remote-settings.json`
The org pushes telemetry env (OTEL/`DN_TELEMETRY_ENDPOINT`) as **server-managed
settings**. On an interactive launch Claude shows:

> Managed settings require approval … Settings requiring approval:
> CLAUDE_CODE_ENHANCED_TELEMETRY_BETA, DN_TELEMETRY_ENDPOINT, …

The acceptance is **not** stored in `~/.claude.json` (verified: a first-run
writes ~30 keys, none an approval flag). It is the presence of
**`~/.claude/remote-settings.json`** itself: Claude writes that file *only after*
you approve, and on later launches skips the prompt when the on-disk copy
matches what the server pushes. A machine that has merely *fetched* the settings
(and displayed them in the prompt) does **not** have the file.

Fix: provisioning mirrors the hub's already-approved `~/.claude/remote-settings.json`.
Hub and remote fetch identical settings from the same server, so the copy
matches and the prompt never appears.

Caveat: this holds only while the server keeps pushing the same settings; if the
org changes the managed telemetry config, Claude prompts once more (by design).

`CLAUDE_CODE_MANAGED_SETTINGS_PATH` was a dead end — it overrides the *local*
policy file, not the server-pushed one, so it has no effect on this prompt.

### Bypass-Permissions disclaimer ← `bypassPermissionsModeAccepted`
Because agents launch with `--dangerously-skip-permissions`, a fresh machine
shows the "In Bypass Permissions mode … Yes, I accept" disclaimer. The binary
gate is:

```
if (mode === "bypassPermissions")
  return !hasSkipDangerousModePermissionPrompt() && !config.bypassPermissionsModeAccepted;
```

i.e. shown only when **both** are false. `hasSkipDangerousModePermissionPrompt()`
is true if any settings layer sets `skipDangerousModePermissionPrompt: true`
(that's why the hub, which has it in `~/.claude/settings.json`, never prompts).
The other suppressor is `bypassPermissionsModeAccepted: true` in `~/.claude.json`
— exactly what accepting the dialog persists.

Fix: `buildSanitizedClaudeConfig()` seeds `bypassPermissionsModeAccepted: true`
into the mirrored `~/.claude.json`.

### Per-folder trust ← `CLAUDE_CODE_SANDBOXED=1`
The next prompt is the per-folder "Is this a project you trust?". Its gate
(`usm()` in the binary):

```
if (process.env.CLAUDE_CODE_SANDBOXED) return true;   // trusted
… else check projects[cwd]?.hasTrustDialogAccepted, then walk up parent dirs
```

Pre-trusting a path is fragile: on the AWS boxes the agent's **cwd differs from
`$HOME`** (login lands in `/var/jenkins_home/dn` while `$HOME=/home/dn`), so
seeding `projects[$HOME].hasTrustDialogAccepted` doesn't cover the real
workspace. `CLAUDE_CODE_SANDBOXED=1` is the cwd-independent switch, and it is
semantically correct — a borrowed box is a disposable sandbox. Audit: that env
var is referenced in **exactly one** place in the binary (this trust gate), so
it has no other behavioral side effects.

Fix: the remote runtime is launched with `CLAUDE_CODE_SANDBOXED=1` in its env
(`runtimeEnv` in `remote-runtime-bootstrap.ts`); the Claude agents it spawns
inherit it. Scoped to remote runtimes only — the hub is untouched.

### Remote hangs must degrade, never freeze the hub
Newer/again-memory-starved AWS boxes could stall during the remote runtime
rebuild, and with no timeouts that hang propagated up and froze the hub UI.
SSH `exec` and the tRPC remote client now take bounded timeouts, and remote
workspace-state fetch **degrades to null** rather than blocking. Long steps
(remote `npm install`+build) get a generous 30-min budget so they are not
killed mid-build. Full write-up:
`.plan/docs/remote-runtime-rebuild-stall-investigation.md`.

## How to reproduce / verify a prompt fix

The reliable technique (used to pin down all three prompts) is a throwaway
`$HOME` sandbox on the target box, driven with `script` for a real PTY:

```bash
# seed only what you want to test; omit a suppressor to see the prompt return
rm -rf /tmp/fh && mkdir -p /tmp/fh/.claude
cp ~/.claude/.credentials.json      /tmp/fh/.claude/
cp ~/.claude/remote-settings.json   /tmp/fh/.claude/     # managed-settings suppressor
# ~/.claude.json seeded with onboarding + bypassPermissionsModeAccepted:true
HOME=/tmp/fh CLAUDE_CODE_SANDBOXED=1 \
  timeout 14 script -qfc "claude --dangerously-skip-permissions" /tmp/cap.txt </dev/null
# strip escapes and read /tmp/cap.txt: with all three, it goes straight to the REPL
```

Notes: Claude suppresses the TUI entirely when stdout is not a terminal (a bare
`> file` redirect yields an empty capture) — use `script` to get a PTY. Strip
ANSI with `sed -r 's/\x1B\[[0-9;?]*[a-zA-Z]//g; …'` before grepping.

## Touched files

- `src/remote/borrow-machine-setup.ts` — gh pin, sanitized `~/.claude.json`
  (+ `bypassPermissionsModeAccepted`), mirror `remote-settings.json`.
- `src/remote/remote-runtime-bootstrap.ts` — `CLAUDE_CODE_SANDBOXED=1` in
  `runtimeEnv`; bounded SSH/build timeouts.
- `src/remote/ssh-connection-manager.ts` — `timeoutMs` on `exec`.
- `src/remote/remote-runtime-client.ts` — AbortSignal fetch timeouts.
- `src/server/workspace-registry.ts` — degrade remote state to null.
- `src/remote/gh-auth.ts`, `jenkins-borrow-*.ts` — gh-token Jenkins auth (+CSRF).
