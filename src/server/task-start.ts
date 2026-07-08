// Atomic, in-process "start a task" primitive shared by the CLI, the tRPC
// `runtime.startTask` mutation, and the headless task orchestrator.
//
// The browser used to orchestrate task starts as three separate RPC calls
// (ensureWorktree -> startTaskSession -> move-to-in_progress). A disconnect
// between those calls could leave a card stuck in `in_progress` with a worktree
// but no agent (the `50ffb` orphan bug). Collapsing the sequence into a single
// server-side function makes it atomic from the caller's perspective and lets
// the server drive it without any browser involvement.
import type { RuntimeBoardCard, RuntimeBoardData } from "../core/api-contract";
import { getTaskColumnId, moveTaskToColumn } from "../core/task-board-mutations";
import { mutateWorkspaceState } from "../state/workspace-state";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "../trpc/app-router";

export interface StartTaskOnRuntimeDeps {
	loadState: RuntimeTrpcContext["workspaceApi"]["loadState"];
	ensureWorktree: RuntimeTrpcContext["workspaceApi"]["ensureWorktree"];
	startTaskSession: RuntimeTrpcContext["runtimeApi"]["startTaskSession"];
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
}

export interface StartTaskOnRuntimeInput {
	scope: RuntimeTrpcWorkspaceScope;
	taskId: string;
	/**
	 * Overrides the card's stored prompt for this start. Used by dependency
	 * chaining to inject upstream handoff context into a downstream task.
	 */
	promptOverride?: string;
}

export interface StartTaskOnRuntimeResult {
	ok: boolean;
	/** The task was already running, so no new session was started. */
	alreadyRunning: boolean;
	/** The card was moved into in_progress (false when it was already there). */
	moved: boolean;
	error?: string;
}

export function findBoardCard(board: RuntimeBoardData, taskId: string): RuntimeBoardCard | null {
	const normalized = taskId.trim();
	if (!normalized) {
		return null;
	}
	for (const column of board.columns) {
		const card = column.cards.find((candidate) => candidate.id === normalized);
		if (card) {
			return card;
		}
	}
	return null;
}

export async function startTaskOnRuntime(
	deps: StartTaskOnRuntimeDeps,
	input: StartTaskOnRuntimeInput,
): Promise<StartTaskOnRuntimeResult> {
	const { scope, taskId } = input;
	const state = await deps.loadState(scope);
	const fromColumnId = getTaskColumnId(state.board, taskId);
	if (!fromColumnId) {
		return { ok: false, alreadyRunning: false, moved: false, error: `Task "${taskId}" was not found.` };
	}
	if (fromColumnId !== "backlog" && fromColumnId !== "in_progress") {
		return {
			ok: false,
			alreadyRunning: false,
			moved: false,
			error: `Task "${taskId}" is in "${fromColumnId}" and can only be started from backlog or in_progress.`,
		};
	}

	const task = findBoardCard(state.board, taskId);
	if (!task) {
		return { ok: false, alreadyRunning: false, moved: false, error: `Task "${taskId}" could not be resolved.` };
	}

	const existingSession = state.sessions[task.id] ?? null;
	const shouldStartSession = !existingSession || existingSession.state !== "running";

	if (shouldStartSession) {
		const ensured = await deps.ensureWorktree(scope, { taskId: task.id, baseRef: task.baseRef });
		if (!ensured.ok) {
			return {
				ok: false,
				alreadyRunning: false,
				moved: false,
				error: ensured.error ?? "Could not ensure task worktree.",
			};
		}

		const started = await deps.startTaskSession(scope, {
			taskId: task.id,
			prompt: input.promptOverride ?? task.prompt,
			taskTitle: task.title,
			startInPlanMode: task.startInPlanMode,
			baseRef: task.baseRef,
			agentId: task.agentId,
			clineSettings: task.clineSettings,
		});
		if (!started.ok || !started.summary) {
			return {
				ok: false,
				alreadyRunning: false,
				moved: false,
				error: started.error ?? "Could not start task session.",
			};
		}
	}

	const moved = await mutateWorkspaceState(scope.workspacePath, (latestState) => {
		const movement = moveTaskToColumn(latestState.board, taskId, "in_progress");
		return {
			board: movement.moved ? movement.board : latestState.board,
			value: movement,
			save: movement.moved,
		};
	});

	await deps.broadcastRuntimeWorkspaceStateUpdated(scope.workspaceId, scope.workspacePath);

	return {
		ok: true,
		alreadyRunning: !shouldStartSession,
		moved: moved.value.moved,
	};
}
