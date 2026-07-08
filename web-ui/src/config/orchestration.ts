/**
 * Whether the runtime server owns board orchestration (session->column moves,
 * auto-review commit/PR/done, and linked-task chaining driven by auto-review).
 *
 * This fork's runtime always runs the headless `task-orchestrator`, so the
 * browser must not also run those reactive loops or it would double-execute
 * them against the same agents. The browser stays a pure viewer that renders
 * the server-broadcast board and issues user intents as mutations.
 *
 * Flip to `false` only to fall back to the legacy fully client-driven behavior.
 */
export const SERVER_DRIVEN_ORCHESTRATION = true;
