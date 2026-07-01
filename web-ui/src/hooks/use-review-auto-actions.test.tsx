import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskGitAction } from "@/git-actions/build-task-git-action-prompt";
import { useReviewAutoActions } from "@/hooks/use-review-auto-actions";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { resetWorkspaceMetadataStore, setTaskWorkspaceSnapshot } from "@/stores/workspace-metadata-store";
import type { BoardColumnId, BoardData, ReviewTaskWorkspaceSnapshot, TaskAutoReviewMode } from "@/types";

function createBoard(autoReviewEnabled: boolean, autoReviewMode: TaskAutoReviewMode = "commit"): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{
				id: "review",
				title: "Review",
				cards: [
					{
						id: "task-1",
						title: "Test task",
						prompt: "Test task",
						startInPlanMode: false,
						autoReviewEnabled,
						autoReviewMode,
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

function createSessionSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "awaiting_review",
		mode: null,
		agentId: null,
		workspacePath: "/tmp/task-1",
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: "hook",
		exitCode: null,
		lastHookAt: 1,
		latestHookActivity: null,
		...overrides,
	};
}

// Native Cline ask_followup_question / plan_mode_respond.
function createUserAttentionSessions(): Record<string, RuntimeTaskSessionSummary> {
	return {
		"task-1": createSessionSummary({
			latestHookActivity: {
				activityText: "Using ask_followup_question",
				toolName: "ask_followup_question",
				toolInputSummary: null,
				finalMessage: null,
				hookEventName: "tool_call",
				notificationType: "user_attention",
				source: "cline-sdk",
			},
		}),
	};
}

// Claude Code AskUserQuestion / permission prompt: surfaces as a PermissionRequest
// hook with activityText "Waiting for approval" and notificationType null.
function createWaitingForApprovalSessions(): Record<string, RuntimeTaskSessionSummary> {
	return {
		"task-1": createSessionSummary({
			reviewReason: "error",
			latestHookActivity: {
				activityText: "Waiting for approval",
				toolName: "AskUserQuestion",
				toolInputSummary: null,
				finalMessage: null,
				hookEventName: "PermissionRequest",
				notificationType: null,
				source: "claude",
			},
		}),
	};
}

const workspaceSnapshots: Record<string, ReviewTaskWorkspaceSnapshot> = {
	"task-1": {
		taskId: "task-1",
		path: "/tmp/task-1",
		branch: "task-1",
		isDetached: false,
		headCommit: "abc123",
		changedFiles: 3,
		additions: 10,
		deletions: 2,
	},
};

function HookHarness({
	board,
	sessions = {},
	changedFiles = 3,
	runAutoReviewGitAction,
	requestMoveTaskToTrash,
}: {
	board: BoardData;
	sessions?: Record<string, RuntimeTaskSessionSummary>;
	/** Override the task-1 workspace changedFiles. null = no snapshot loaded yet. */
	changedFiles?: number | null;
	runAutoReviewGitAction: (taskId: string, action: TaskGitAction) => Promise<boolean>;
	requestMoveTaskToTrash: (taskId: string, fromColumnId: BoardColumnId) => Promise<void>;
}): null {
	const baseSnapshot = workspaceSnapshots["task-1"] ?? null;
	setTaskWorkspaceSnapshot(changedFiles === null || !baseSnapshot ? null : { ...baseSnapshot, changedFiles });
	useReviewAutoActions({
		board,
		sessions,
		taskGitActionLoadingByTaskId: {},
		runAutoReviewGitAction,
		requestMoveTaskToTrash,
	});
	return null;
}

describe("useReviewAutoActions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		resetWorkspaceMetadataStore();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
		vi.useRealTimers();
	});

	it("cancels a scheduled auto review action when autoReviewEnabled is turned off", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestMoveTaskToTrash = vi.fn(async () => {});

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(true)}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(false)}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(runAutoReviewGitAction).not.toHaveBeenCalled();
		expect(requestMoveTaskToTrash).not.toHaveBeenCalled();
	});

	it("auto-moves a finished 'done' mode task to done", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestMoveTaskToTrash = vi.fn(async () => {});

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(true, "done")}
					sessions={{ "task-1": createSessionSummary() }}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(requestMoveTaskToTrash).toHaveBeenCalledWith("task-1", "review", { skipWorkingChangeWarning: true });
		expect(runAutoReviewGitAction).not.toHaveBeenCalled();
	});

	it("does not move a 'done' mode task to done while a native agent awaits a user answer", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestMoveTaskToTrash = vi.fn(async () => {});

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(true, "done")}
					sessions={createUserAttentionSessions()}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(requestMoveTaskToTrash).not.toHaveBeenCalled();
		expect(runAutoReviewGitAction).not.toHaveBeenCalled();
	});

	it("does not move a 'done' mode task to done while a Claude Code question awaits approval", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestMoveTaskToTrash = vi.fn(async () => {});

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(true, "done")}
					sessions={createWaitingForApprovalSessions()}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(requestMoveTaskToTrash).not.toHaveBeenCalled();
		expect(runAutoReviewGitAction).not.toHaveBeenCalled();
	});

	it("does not commit a task awaiting a user answer even with working changes", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestMoveTaskToTrash = vi.fn(async () => {});

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(true, "commit")}
					sessions={createUserAttentionSessions()}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(runAutoReviewGitAction).not.toHaveBeenCalled();
		expect(requestMoveTaskToTrash).not.toHaveBeenCalled();
	});

	it("auto-moves a finished 'commit' task with no changes straight to Done", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestMoveTaskToTrash = vi.fn(async () => {});

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(true, "commit")}
					sessions={{ "task-1": createSessionSummary() }}
					changedFiles={0}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		// Nothing to commit -> move to Done, without running a git action.
		expect(runAutoReviewGitAction).not.toHaveBeenCalled();
		expect(requestMoveTaskToTrash).toHaveBeenCalledWith("task-1", "review", { skipWorkingChangeWarning: true });
	});

	it("does not auto-move a 'pr' task with no changes to Done (a PR may still be needed)", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestMoveTaskToTrash = vi.fn(async () => {});

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(true, "pr")}
					sessions={{ "task-1": createSessionSummary() }}
					changedFiles={0}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(runAutoReviewGitAction).not.toHaveBeenCalled();
		expect(requestMoveTaskToTrash).not.toHaveBeenCalled();
	});

	it("does not move a 'commit' task to Done while its workspace snapshot is still loading", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestMoveTaskToTrash = vi.fn(async () => {});

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(true, "commit")}
					sessions={{ "task-1": createSessionSummary() }}
					changedFiles={null}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(runAutoReviewGitAction).not.toHaveBeenCalled();
		expect(requestMoveTaskToTrash).not.toHaveBeenCalled();
	});

	it("auto-moves a 'done' task once the user answers and the question clears", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestMoveTaskToTrash = vi.fn(async () => {});

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(true, "done")}
					sessions={createWaitingForApprovalSessions()}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(requestMoveTaskToTrash).not.toHaveBeenCalled();

		// User answered: the question marker clears and the agent has wrapped up.
		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(true, "done")}
					sessions={{ "task-1": createSessionSummary() }}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(requestMoveTaskToTrash).toHaveBeenCalledWith("task-1", "review", { skipWorkingChangeWarning: true });
	});
});
