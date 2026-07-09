# Remote Runtime Rebuild Stall Investigation

## Problem summary

While dogfooding remote-machine federation on a borrowed AWS instance, the
entire Kanban hub UI froze — "everything stuck, even local projects" — shortly
after a routine `/deploy-server` (hub restart). It then partially recovered
("now live, only the AWS projects are stuck"), and disconnecting SSH did not
help. The borrowed box also dropped SSH sessions ("connection closed by remote
host") during this window.

The confusing part: nothing about the Jenkins/`gh` auth work that had just been
committed was actually broken. A plain hub restart was enough to trigger the
whole cascade.

## What actually happened (root cause chain)

1. **A hub restart forces a full rebuild on every connected remote.** The
   "remote is up to date" check hashes the *entire shipped source tarball* and
   compares it to a stamp file on the remote
   (`ensureRemoteRuntime` in `src/remote/remote-runtime-bootstrap.ts`). Any hub
   source change (i.e. the commits that preceded the deploy) changes the hash,
   so `upToDate` is false and the hub re-ships the source and runs
   `npm install` + `npm install` (web-ui) + `npm run build` **on the remote
   box**.

2. **That build sank an undersized instance.** `npm run build` runs
   `tsc` + a `vite` build (~3k modules, memory-hungry). On the small AWS
   instance this drove it into OOM/thrashing. The kernel started killing forks,
   which is what produced the dropped SSH sessions ("closed by remote host").

3. **No timeout on the build exec.** `connection.exec` in
   `src/remote/ssh-connection-manager.ts` resolved only on the stream `close`
   event, with no ceiling. A thrashing box can hold a channel half-open forever
   without emitting `close`, so `ensureRemoteRuntime` never returned and the
   machine sat in `bootstrapping` indefinitely.

4. **No timeout on the remote state fetches, and the active workspace was the
   AWS project.** On load the SPA fetches the active workspace's state. The hub
   routes a remote workspace's state to the remote runtime over the SSH tunnel
   (`buildWorkspaceStateSnapshot` -> `remoteProjects.getWorkspaceState` ->
   `RemoteRuntimeClient`). Those fetches (`checkHealth`, `workspace.getState`)
   had **no `AbortSignal`**. Through a tunnel to a runtime that was down (being
   rebuilt), the TCP connection can accept but never respond, so the fetch hung.
   Because the *active* workspace was the dead remote, the SPA never got past
   its initial load — which is why it looked like "even local is frozen." The
   project *list* itself is built from in-memory summaries
   (`listRemoteProjectSummaries`, synchronous), so once the active-state fetch
   finally gave up (the one existing bound, `HEALTH_POLL_TIMEOUT_MS = 120s`),
   local boards came back but the AWS board stayed dead.

5. **Disconnecting SSH re-triggered the rebuild.** `connection.onClose` fires a
   best-effort auto-reconnect (`remote-machine-manager.ts`), which re-enters
   `performConnect` -> `ensureRemoteRuntime` -> tries to rebuild again on the
   same wounded box. So manual disconnects did not break the loop.

Net: it was not a defect in the `gh`/Jenkins change. It was the
rebuild-on-every-hub-change design colliding with an undersized remote, made
catastrophic by the total absence of timeouts on remote calls.

## Fast triage checklist (for next time)

Works even when the UI looks globally frozen:

1. **Is the active workspace a remote?** A global freeze is almost always a
   stalled *active* remote workspace. The project list never blocks; only the
   active workspace's state fetch does.
2. **On the remote:** `tail -f ~/.cline/kanban-remote-runtime.log` (or use
   `readRemoteRuntimeLogTail`), plus `free -m` and `dmesg | tail` to spot OOM
   kills. Heavy CPU + rising swap during "Installing dependencies and
   building..." = the rebuild is the problem.
3. **On the hub:** grep logs for `bootstrapping` / "Installing dependencies and
   building". If it never advances to "Starting the remote Kanban runtime", the
   build exec is stuck.
4. **Escape hatch:** `removeMachine` (not just disconnect) stops the
   auto-reconnect loop; the UI recovers once no dead remote is the active
   workspace.

## Fixes applied

- **Optional, opt-in timeout on `connection.exec`** (`SshExecOptions.timeoutMs`
  in `ssh-connection-manager.ts`). Default is still **unbounded** so genuinely
  long operations are unaffected unless a caller opts in.
- **Probe-class exec calls are bounded** in `remote-runtime-bootstrap.ts`
  (`REMOTE_PROBE_TIMEOUT_MS = 20s`, launch `REMOTE_LAUNCH_TIMEOUT_MS = 60s`):
  version checks, install probe, build-stamp read, `$HOME`/`uname` resolution,
  `mkdir`, log tail, and daemon launch.
- **Long operations get a *generous* ceiling, not a short timeout**
  (`DEFAULT_REMOTE_BUILD_TIMEOUT_MS = 30 min`, overridable via
  `KANBAN_REMOTE_BUILD_TIMEOUT_MS`): the Node download/extract and the
  `npm install` + build execs. This only kills the infinite-hang failure mode; it
  will not interrupt a real multi-minute build.
- **`AbortSignal` timeouts on probe-class remote calls** in
  `remote-runtime-client.ts` (`HEALTH_FETCH_TIMEOUT_MS = 5s`,
  `REMOTE_QUERY_TIMEOUT_MS = 15s`): `checkHealth`, `listProjects`,
  `getWorkspaceState`. Deliberately **not** applied to `addProject` (may clone a
  repo) or other potentially-long user actions.
- **Documented the degrade contract** at `buildWorkspaceStateSnapshot`
  (`workspace-registry.ts`): the remote branch now fails fast instead of
  hanging, and the existing catch on hub-global paths degrades the active
  workspace to a `null` state (the snapshot schema already allows this), so the
  SPA renders the project list and lets you switch away from a dead remote.

## Recommended follow-ups (not yet done)

These were out of scope for the timeout/degrade pass but would prevent the class
of problem at the source:

1. **Decouple hub redeploys from remote rebuilds.** Hash only build-affecting
   inputs (`package.json` + `src/**` + `web-ui/src/**`) rather than the whole
   tarball, or gate the rebuild behind an explicit "update remote runtime"
   action. A hub restart should not reflexively rebuild every remote.
2. **Preflight resource check before building on a remote.** Read `free -m` /
   `nproc`; if the box is too small for a `vite` build, refuse (or build the
   web-ui on the hub and ship `dist` instead of building remotely).
3. **Back off auto-reconnect.** Cap attempts / use exponential delay, and never
   auto-reconnect straight into a rebuild.

## Key files

- `src/remote/remote-runtime-bootstrap.ts` — rebuild trigger, exec timeouts.
- `src/remote/ssh-connection-manager.ts` — `exec` timeout plumbing.
- `src/remote/remote-runtime-client.ts` — `AbortSignal` on probe fetches.
- `src/remote/remote-machine-manager.ts` — connect flow, health poll,
  auto-reconnect, `getWorkspaceState` (catches -> null).
- `src/server/workspace-registry.ts` — `buildWorkspaceStateSnapshot` degrade
  contract.
- `src/server/runtime-state-hub.ts` — snapshot builder + broadcaster (both catch
  and degrade to `null`).
