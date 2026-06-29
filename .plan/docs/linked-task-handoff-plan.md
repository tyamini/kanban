# Linked-task handoff (input/output between linked tasks)

Status: implemented (v1) — 2026-06-29
Author: design doc for review before coding
Last updated: 2026-06-29

v1 shipped with the documented defaults: OR fan-in, injection on the
dependency-driven auto-start path only. Manual starts, AND-gating, CLI parity,
and the structured `\`\`\`handoff` block remain deferred (§11). UI lives in the
downstream task's detail view (`TaskHandoffConfig`) rather than an arrow popover.

## 1. Goal

Today linked tasks only pass **control**: when an upstream task finishes
(review → Done), a downstream backlog task auto-starts. This feature adds **data**
passing — the upstream task's result flows into the downstream task's prompt so
agents can hand work off to each other.

Motivating example: Task A opens a PR; Task B (linked) reviews that PR / manages
CI. B needs A's PR URL and branch.

### Locked design decisions (from product review)

- **Mechanism:** summary injection + `{{from.*}}` template variables. Reuse the
  existing `interpolateTemplate` engine. (Structured `\`\`\`handoff` JSON block is
  explicitly deferred to a later phase — see §11.)
- **Start mode:** keep today's automatic kickoff, but surface the **resolved
  prompt** (with injected context) on the downstream card so it is auditable.
  No human gate in v1.

## 2. How linking works today (grounded references)

- **Edge model:** `runtimeBoardDependencySchema = { id, fromTaskId, toTaskId, createdAt }`
  — `src/core/api-contract.ts:188`. Stored in `board.dependencies[]` in
  `~/.cline/kanban/workspaces/<id>/board.json`. Keys are persisted with full
  names (verified against a live board.json).
- **Edge direction (important & slightly counter-intuitive):** normalized so the
  **upstream** task (the one that runs first / finishes) is `toTaskId`, and the
  **downstream** backlog task (auto-started) is `fromTaskId`. See
  `resolveDependencyEndpoints` / `addTaskDependency` — `src/core/task-board-mutations.ts:174,350`.
- **Auto-start trigger:** `getLinkedBacklogTaskIdsReadyAfterTaskTrashed`
  (`task-board-mutations.ts:208`) runs only when the upstream leaves the `review`
  column; `trashTaskAndGetReadyLinkedTaskIds` (`:417`) returns `readyTaskIds`.
- **Auto-start execution:** `performMoveTaskToTrash` in
  `web-ui/src/hooks/use-linked-backlog-task-actions.ts:105-167` moves each ready
  task to `in_progress` and starts it via `startBacklogTaskWithAnimation` (or
  `kickoffTaskInProgress`).
- **Prompt assembly:** `startTaskSession` sends `prompt: task.prompt.trim()`
  to the runtime — `web-ui/src/hooks/use-task-sessions.ts:147-187`. This is the
  single choke point where we inject context.
- **Upstream output is already in the client:** session summaries live in
  `App.tsx` as `sessions: Record<taskId, RuntimeTaskSessionSummary>`
  (`web-ui/src/App.tsx:85`), streamed from the runtime. The agent's final text is
  `sessions[upstreamId].latestHookActivity?.finalMessage`
  (schema: `api-contract.ts:272`; already rendered on cards at
  `board-card.tsx:155`). Workspace metadata (`branch`, `headCommit`,
  changed-file counts) is at `api-contract.ts:355` and reachable via
  `getTaskWorkspaceSnapshot(taskId)` (`stores/workspace-metadata-store.ts:226`).
- **Templating engine exists:** `interpolateTemplate(template, vars)` with
  `{{key}}` syntax — `web-ui/src/git-actions/build-task-git-action-prompt.ts:53`.
  Currently only used for `{{base_ref}}`.

**Conclusion:** the only missing layer is data-flow. Everything we need to read
is already in memory at the moment `performMoveTaskToTrash` fires.

## 3. Data model

Extend the edge (no new store; it already persists in board.json):

```ts
// src/core/api-contract.ts — runtimeBoardDependencySchema
handoff: z
  .object({
    mode: z.enum(["summary", "template", "none"]).default("summary"),
    template: z.string().optional(), // used only when mode === "template"
  })
  .optional(),
```

- Absent `handoff` ⇒ treated as `mode: "summary"` (sensible default: linking
  implies "pass the result"). This keeps existing links working with the new
  behavior, which matches user intent.
- Mirror the type in `web-ui/src/types/board.ts` and the (de)serializers in
  `web-ui/src/state/board-state.ts`.

## 4. Handoff variables

New util (web-ui), e.g. `web-ui/src/handoff/build-handoff-variables.ts`:

```ts
buildHandoffVariables(upstream: BoardCard, summary?: RuntimeTaskSessionSummary,
                      ws?: ReviewTaskWorkspaceSnapshot): Record<string,string>
```

| Variable | Source |
|---|---|
| `{{from.title}}` | `upstream.title` |
| `{{from.summary}}` | `summary.latestHookActivity?.finalMessage` (trimmed) |
| `{{from.branch}}` | `ws?.branch` / workspace metadata |
| `{{from.head_commit}}` | workspace metadata `headCommit` |
| `{{from.pr_url}}` | best-effort GitHub PR URL regex over `finalMessage` |
| `{{from.changed_files}}` | workspace metadata change counts |

Unknown/empty variables resolve to an empty string (current
`interpolateTemplate` behavior). `from.pr_url` parsing is best-effort only; the
robust structured path is the deferred phase in §11.

## 5. Resolution & injection flow

Single helper `resolveHandoffPrompt(downstream, upstream, dep, sessions, wsLookup)`:

1. Read `dep.handoff?.mode ?? "summary"`.
2. `"none"` ⇒ return `downstream.prompt` unchanged.
3. Build vars via §4.
4. `"summary"` ⇒ prepend a delimited block to the base prompt:
   ```
   ## Context from upstream task "<from.title>"
   <from.summary>

   ---
   <downstream.prompt>
   ```
   (Omit the block entirely if `from.summary` is empty, to avoid noise.)
5. `"template"` ⇒ `interpolateTemplate(dep.handoff.template, vars)`.

**Wire-in point:** `performMoveTaskToTrash`
(`use-linked-backlog-task-actions.ts:125-163`). When mapping `readyTaskIds` →
ready cards, also resolve the dependency edge and compute the enriched prompt,
then pass it into the start call. Two clean options:

- Add an optional `promptOverride?: string` to
  `kickoffTaskInProgress` / `startBacklogTaskWithAnimation` →
  `startTaskSession(task, { promptOverride })`, OR
- Persist the resolved prompt onto the downstream card (`resolvedPrompt`) right
  before kickoff so the existing `startTaskSession` path and the card UI both read
  it.

**Recommended:** the `promptOverride` option for the run, **plus** store a
`lastResolvedPrompt` snapshot on the card for the auditable display (§6). This
avoids mutating the user's authored `prompt` while keeping the injected prompt
visible.

The hook will need two new inputs (both already exist in `App.tsx` and can be
threaded down like the other props): the `sessions` summary map and a workspace
snapshot lookup.

## 6. UI / UX

- **The arrow is the config surface.** The dependency overlay
  (`web-ui/src/components/dependencies/dependency-overlay.tsx`) already draws the
  SVG link. Add a small mid-arrow **badge** indicating mode: `↳ result`
  (summary), `↳ custom` (template), `↳ —` (none). Clicking it opens a
  **Handoff popover** (new `dependency-handoff-popover.tsx`):
  - Toggle "Pass upstream result to this task" (on by default).
  - Mode radio: *Append summary* / *Custom template* / *None*.
  - Custom mode: textarea + insertable **variable chips**
    (`{{from.summary}}`, `{{from.pr_url}}`, `{{from.branch}}`, …) and a **live
    resolved preview** using the upstream's current summary.
- **Downstream card detail** (`card-detail-view.tsx`): an "**Input from →
  <upstream title>**" section that previews the exact prompt the agent will
  receive (uses `lastResolvedPrompt` once available, else a live resolve).
- **Upstream card** after completion: subtle "→ handed off to N task(s)".
- Persisting handoff config reuses the existing `setBoard` + dependency mutation
  path; add `updateTaskDependencyHandoff(board, depId, handoff)` alongside
  `addTaskDependency`/`removeTaskDependency` in `task-board-mutations.ts` and the
  `board-state.ts` wrapper.

## 7. Edge cases

- **Fan-in (multiple upstreams → one downstream):** today each dependency
  evaluates independently, so the downstream starts when **any** upstream
  finishes (OR semantics). v1 keeps OR. If multiple upstreams are already done,
  inject each one's block in edge-creation order. (AND-gating = future work; note
  it explicitly in the popover copy so behavior isn't surprising.)
- **Upstream has no `finalMessage`** (e.g. interrupted, or "do nothing"): summary
  block is omitted; downstream runs with its own prompt only.
- **Manual start** (user drags the downstream to In-Progress themselves, not via
  the trigger): v1 injects only on the dependency-driven auto-start path. Manual
  starts use the plain prompt. (Document this; revisit if confusing.)
- **resume-from-trash:** unchanged — `startTaskSession` already uses an empty
  prompt when `resumeFromTrash`, so no injection there.
- **Stale summary:** we read the summary at kickoff time, which is right after the
  upstream finishes, so it reflects the final state.

## 8. Telemetry

Extend existing dependency events
(`web-ui/src/telemetry/events.ts`: `trackTaskDependencyCreated`,
`trackTasksAutoStartedFromDependency`) with a `handoffMode` dimension and a
`trackHandoffInjected({ mode, hadSummary })` event.

## 9. Testing

- Unit: `buildHandoffVariables` (PR-URL regex incl. no-match), `resolveHandoffPrompt`
  for all three modes + empty-summary omission.
- Unit: `updateTaskDependencyHandoff` mutation + (de)serialization round-trip in
  `board-state.ts` (mirrors the existing dependency tests in
  `board-state.test.ts`).
- Integration-ish: extend the auto-start flow test to assert the enriched prompt
  is passed through `startTaskSession`.
- All under `npm run test:fast` (precommit gate). Build/typecheck must use Node 22.

## 10. Phased implementation

1. **Core schema + mutations** — `api-contract.ts` handoff field;
   `updateTaskDependencyHandoff` in `task-board-mutations.ts`; CLI parity not
   required for v1.
2. **Web types + state** — `types/board.ts`, `board-state.ts` (wrapper +
   (de)serialize), tests.
3. **Resolution layer** — `build-handoff-variables.ts`, `resolve-handoff-prompt.ts`,
   tests.
4. **Wire-in** — thread `sessions` + workspace lookup into
   `useLinkedBacklogTaskActions`; compute override in `performMoveTaskToTrash`;
   add `promptOverride` to the start path; store `lastResolvedPrompt`.
5. **UI** — arrow badge + handoff popover; card-detail "Input from" preview;
   upstream "handed off to" note.
6. **Telemetry + docs**, then deploy/verify loop.

## 11. Deferred / future

- **Structured handoff block (#2):** have upstream agents emit a fenced
  `\`\`\`handoff { "pr_url": ..., "branch": ... }` block; parse it into typed
  vars for reliable extraction (the auto-PR template already nudges agents to
  report PR URL/branches — `src/config/runtime-config.ts:84`). Falls back to the
  regex from §4.
- **AND-gating** for fan-in (start only when *all* upstreams finish).
- **Manual-start injection** (resolve handoff even when user starts the
  downstream by hand).
- **CLI parity** for handoff config on `task link`.
