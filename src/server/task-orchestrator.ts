// Headless, server-side task orchestrator.
//
// Historically all board orchestration lived in browser React effects: moving a
// card to review when its agent paused, running auto-commit/PR, moving finished
// tasks to done, and starting linked backlog tasks. Closing the tab stalled the
// whole pipeline and a mid-start disconnect could orphan a card.
//
// This module moves that "brain" into the runtime process so every runtime --
// local or remote -- drives its own board without any browser attached. The
// browser becomes a pure viewer that renders server-broadcast state and issues
// user intents as mutations.
//
// The orchestrator reconciles a workspace whenever something happens that could
// change the desired board state: a session summary transition, a workspace
// metadata change, a low-frequency safety sweep, or startup. Each reconcile is
// idempotent and serialized per workspace so concurrent triggers cannot race.
import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type {
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeConfigResponse,
	RuntimeTaskAutoReviewMode,
	RuntimeTaskHandoff,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import { getTaskColumnId, moveTaskToColumn, trashTaskAndGetReadyLinkedTaskIds } from "../core/task-board-mutations";
import { mutateWorkspaceState } from "../state/workspace-state";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "../trpc/app-router";
import { findBoardCard, type StartTaskOnRuntimeDeps, startTaskOnRuntime } from "./task-start";

const DEFAULT_SAFETY_SWEEP_INTERVAL_MS = 15_000;
const AUTO_REVIEW_PTY_SUBMIT_DELAY_MS = 200;

export interface CreateTaskOrchestratorDependencies {
	runtimeApi: RuntimeTrpcContext["runtimeApi"];
	workspaceApi: RuntimeTrpcContext["workspaceApi"];
	getScopedClineTaskSessionService: (scope: RuntimeTrpcWorkspaceScope) => Promise<ClineTaskSessionService>;
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	getWorkspacePathById: (workspaceId: string) => string | null;
	listManagedWorkspaces: () => Array<{ workspaceId: string; workspacePath: string | null }>;
	warn: (message: string) => void;
	/** Safety-sweep interval in ms. Set to 0 to disable (used by tests). */
	safetySweepIntervalMs?: number;
}

export interface TaskOrchestrator {
	/** Queue a reconcile for a workspace after any activity that could change board state. */
	notifyWorkspaceActivity: (workspaceId: string) => void;
	/** Reconcile every managed workspace, recovering orphaned in-progress tasks. */
	reconcileAllOnStartup: () => Promise<void>;
	/** Await the currently-queued reconcile work for a workspace (test hook). */
	waitForIdle: (workspaceId: string) => Promise<void>;
	dispose: () => void;
}

// ── Ported client helpers (kept identical in spirit to web-ui) ───────────────

function resolveAutoReviewMode(mode: RuntimeTaskAutoReviewMode | null | undefined): RuntimeTaskAutoReviewMode {
	if (mode === "pr" || mode === "done") {
		return mode;
	}
	return "commit";
}

function resolveHandoffMode(mode: RuntimeTaskHandoff["mode"] | null | undefined): RuntimeTaskHandoff["mode"] {
	if (mode === "summary" || mode === "template") {
		return mode;
	}
	return "none";
}

function isActiveTaskSessionState(summary: RuntimeTaskSessionSummary | null): boolean {
	return summary?.state === "running" || summary?.state === "awaiting_review";
}

// Combine the terminal-agent summary and the Cline summary for a task, matching
// the precedence the browser applies (active session wins, then most recent).
function selectLastTurnSummary(
	terminalSummary: RuntimeTaskSessionSummary | null,
	clineSummary: RuntimeTaskSessionSummary | null,
): RuntimeTaskSessionSummary | null {
	if (!terminalSummary) {
		return clineSummary;
	}
	if (!clineSummary) {
		return terminalSummary;
	}
	const terminalIsActive = isActiveTaskSessionState(terminalSummary);
	const clineIsActive = isActiveTaskSessionState(clineSummary);
	if (terminalIsActive !== clineIsActive) {
		return clineIsActive ? clineSummary : terminalSummary;
	}
	if (terminalSummary.updatedAt !== clineSummary.updatedAt) {
		return terminalSummary.updatedAt > clineSummary.updatedAt ? terminalSummary : clineSummary;
	}
	if (clineSummary.agentId === "cline" && terminalSummary.agentId !== "cline") {
		return clineSummary;
	}
	return terminalSummary;
}

const USER_RESPONSE_NOTIFICATION_TYPES = new Set(["user_attention", "permission_prompt", "permission.asked"]);
const USER_ATTENTION_TOOL_NAMES = new Set(["AskUserQuestion", "ask_followup_question", "plan_mode_respond"]);

function messageEndsWithQuestion(message: string | null | undefined): boolean {
	if (!message) {
		return false;
	}
	const trimmed = message.replace(/[\s>*_`"')\]]+$/g, "");
	return trimmed.endsWith("?");
}

// A task in review may be *blocked* (agent asked a question / requested
// permission) rather than *finished*. Auto-review must not commit/PR/done a
// blocked task behind the user's back.
function isAwaitingUserResponse(summary: RuntimeTaskSessionSummary | undefined): boolean {
	const activity = summary?.latestHookActivity;
	if (!activity) {
		return false;
	}
	if (activity.notificationType && USER_RESPONSE_NOTIFICATION_TYPES.has(activity.notificationType)) {
		return true;
	}
	if (activity.activityText?.trim().startsWith("Waiting for approval") === true) {
		return true;
	}
	if (
		activity.toolName &&
		USER_ATTENTION_TOOL_NAMES.has(activity.toolName) &&
		activity.activityText?.trim().startsWith("Using ") === true
	) {
		return true;
	}
	return messageEndsWithQuestion(activity.finalMessage);
}

function interpolateTemplate(template: string, variables: Record<string, string>): string {
	let result = template;
	for (const [key, value] of Object.entries(variables)) {
		result = result.replaceAll(`{{${key}}}`, value);
	}
	return result;
}

const PR_URL_PATTERN = /https?:\/\/github\.com\/[^\s)]+\/pull\/\d+/i;

function extractPrUrl(text: string | null | undefined): string {
	if (!text) {
		return "";
	}
	const match = text.match(PR_URL_PATTERN);
	return match ? match[0] : "";
}

interface UpstreamWorkspaceSnapshot {
	branch: string | null;
	headCommit: string | null;
	changedFiles: number | null;
}

function buildHandoffVariables(
	upstream: RuntimeBoardCard,
	summary: RuntimeTaskSessionSummary | undefined,
	workspace: UpstreamWorkspaceSnapshot | null,
): Record<string, string> {
	const summaryText = summary?.latestHookActivity?.finalMessage?.trim() ?? "";
	return {
		"from.title": upstream.title ?? "",
		"from.summary": summaryText,
		"from.branch": workspace?.branch ?? "",
		"from.head_commit": workspace?.headCommit ?? "",
		"from.pr_url": extractPrUrl(summaryText),
		"from.changed_files": workspace?.changedFiles != null ? String(workspace.changedFiles) : "",
	};
}

// Compute the prompt a downstream task should run with, injecting upstream
// handoff context. Returns the downstream's own prompt when handoff is disabled.
function resolveHandoffPrompt(input: {
	downstream: RuntimeBoardCard;
	upstream: RuntimeBoardCard;
	handoff: RuntimeTaskHandoff | undefined;
	upstreamSummary: RuntimeTaskSessionSummary | undefined;
	upstreamWorkspace: UpstreamWorkspaceSnapshot | null;
}): string {
	const basePrompt = input.downstream.prompt.trim();
	const mode = resolveHandoffMode(input.handoff?.mode);
	if (mode === "none") {
		return basePrompt;
	}
	if (mode === "template") {
		const template = input.handoff?.template?.trim();
		if (!template) {
			return basePrompt;
		}
		return interpolateTemplate(
			template,
			buildHandoffVariables(input.upstream, input.upstreamSummary, input.upstreamWorkspace),
		);
	}
	const summaryText = input.upstreamSummary?.latestHookActivity?.finalMessage?.trim() ?? "";
	if (!summaryText) {
		return basePrompt;
	}
	const block = `## Context from upstream task "${input.upstream.title ?? ""}"\n${summaryText}`;
	return basePrompt ? `${block}\n\n---\n\n${basePrompt}` : block;
}

function buildGitActionPrompt(
	action: Extract<RuntimeTaskAutoReviewMode, "commit" | "pr">,
	baseRef: string,
	config: RuntimeConfigResponse,
): string {
	const template =
		action === "commit"
			? config.commitPromptTemplate?.trim() ||
				config.commitPromptTemplateDefault?.trim() ||
				"Handle this commit action using the provided git context."
			: config.openPrPromptTemplate?.trim() ||
				config.openPrPromptTemplateDefault?.trim() ||
				"Handle this pull request action using the provided git context.";
	return interpolateTemplate(template, { base_ref: baseRef });
}

function cardsInColumn(board: RuntimeBoardData, columnId: string): RuntimeBoardCard[] {
	return board.columns.find((column) => column.id === columnId)?.cards ?? [];
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export function createTaskOrchestrator(deps: CreateTaskOrchestratorDependencies): TaskOrchestrator {
	const startTaskDeps: StartTaskOnRuntimeDeps = {
		loadState: deps.workspaceApi.loadState,
		ensureWorktree: deps.workspaceApi.ensureWorktree,
		startTaskSession: deps.runtimeApi.startTaskSession,
		broadcastRuntimeWorkspaceStateUpdated: deps.broadcastRuntimeWorkspaceStateUpdated,
	};

	const queues = new Map<string, Promise<void>>();
	const previousSummaryByWorkspace = new Map<string, Map<string, RuntimeTaskSessionSummary>>();
	const armedActionByWorkspace = new Map<string, Map<string, RuntimeTaskAutoReviewMode>>();
	const gitActionInFlightByWorkspace = new Map<string, Set<string>>();
	let disposed = false;

	const enqueue = (workspaceId: string, task: () => Promise<void>): Promise<void> => {
		const previous = queues.get(workspaceId) ?? Promise.resolve();
		const next = previous
			.catch(() => undefined)
			.then(() => task())
			.catch((error) => {
				deps.warn(
					`[orchestrator] reconcile failed for ${workspaceId}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			});
		queues.set(workspaceId, next);
		return next;
	};

	const buildCombinedSummaries = async (
		scope: RuntimeTrpcWorkspaceScope,
		terminalMergedSessions: Record<string, RuntimeTaskSessionSummary>,
	): Promise<Map<string, RuntimeTaskSessionSummary>> => {
		const combined = new Map<string, RuntimeTaskSessionSummary>();
		for (const [taskId, summary] of Object.entries(terminalMergedSessions)) {
			combined.set(taskId, summary);
		}
		try {
			const clineService = await deps.getScopedClineTaskSessionService(scope);
			for (const clineSummary of clineService.listSummaries()) {
				const existing = combined.get(clineSummary.taskId) ?? null;
				const selected = selectLastTurnSummary(existing, clineSummary);
				if (selected) {
					combined.set(clineSummary.taskId, selected);
				}
			}
		} catch {
			// Cline service may be unavailable for this workspace; terminal summaries suffice.
		}
		return combined;
	};

	const getChangedFileCount = async (
		scope: RuntimeTrpcWorkspaceScope,
		card: RuntimeBoardCard,
	): Promise<number | null> => {
		const summary = await deps.workspaceApi.loadGitSummary(scope, { taskId: card.id, baseRef: card.baseRef });
		if (!summary.ok) {
			return null;
		}
		return summary.summary.changedFiles;
	};

	const getUpstreamWorkspaceSnapshot = async (
		scope: RuntimeTrpcWorkspaceScope,
		card: RuntimeBoardCard,
	): Promise<UpstreamWorkspaceSnapshot | null> => {
		try {
			const summary = await deps.workspaceApi.loadGitSummary(scope, { taskId: card.id, baseRef: card.baseRef });
			if (!summary.ok) {
				return null;
			}
			return {
				branch: summary.summary.currentBranch,
				headCommit: null,
				changedFiles: summary.summary.changedFiles,
			};
		} catch {
			return null;
		}
	};

	const moveTaskToDoneAndChain = async (scope: RuntimeTrpcWorkspaceScope, taskId: string): Promise<void> => {
		const preState = await deps.workspaceApi.loadState(scope);
		const upstreamCard = findBoardCard(preState.board, taskId);
		const preDependencies = preState.board.dependencies;

		const trashMutation = await mutateWorkspaceState<{ readyTaskIds: string[] }>(scope.workspacePath, (latest) => {
			const columnId = getTaskColumnId(latest.board, taskId);
			if (!columnId || columnId === "trash") {
				return { board: latest.board, value: { readyTaskIds: [] }, save: false };
			}
			const trashed = trashTaskAndGetReadyLinkedTaskIds(latest.board, taskId);
			if (!trashed.moved) {
				return { board: latest.board, value: { readyTaskIds: [] }, save: false };
			}
			return { board: trashed.board, value: { readyTaskIds: trashed.readyTaskIds }, save: true };
		});

		if (!trashMutation.saved) {
			return;
		}
		await deps.broadcastRuntimeWorkspaceStateUpdated(scope.workspaceId, scope.workspacePath);

		const readyTaskIds = trashMutation.value.readyTaskIds;
		if (readyTaskIds.length === 0) {
			return;
		}

		const upstreamSummary = upstreamCard
			? (await buildCombinedSummaries(scope, preState.sessions)).get(taskId)
			: undefined;
		const upstreamWorkspace = upstreamCard ? await getUpstreamWorkspaceSnapshot(scope, upstreamCard) : null;

		for (const readyTaskId of readyTaskIds) {
			let promptOverride: string | undefined;
			const downstreamCard = findBoardCard(trashMutation.state.board, readyTaskId);
			if (downstreamCard && upstreamCard) {
				const dependency = preDependencies.find((dep) => dep.fromTaskId === readyTaskId && dep.toTaskId === taskId);
				const resolvedPrompt = resolveHandoffPrompt({
					downstream: downstreamCard,
					upstream: upstreamCard,
					handoff: dependency?.handoff,
					upstreamSummary,
					upstreamWorkspace,
				});
				if (resolvedPrompt !== downstreamCard.prompt.trim()) {
					promptOverride = resolvedPrompt;
				}
			}
			const started = await startTaskOnRuntime(startTaskDeps, { scope, taskId: readyTaskId, promptOverride });
			if (!started.ok) {
				deps.warn(`[orchestrator] failed to start linked task ${readyTaskId}: ${started.error ?? "unknown"}`);
			}
		}
	};

	const runGitAction = async (
		scope: RuntimeTrpcWorkspaceScope,
		card: RuntimeBoardCard,
		action: Extract<RuntimeTaskAutoReviewMode, "commit" | "pr">,
		config: RuntimeConfigResponse,
		summary: RuntimeTaskSessionSummary | undefined,
	): Promise<void> => {
		const prompt = buildGitActionPrompt(action, card.baseRef, config);
		const isCline = (summary?.agentId ?? card.agentId) === "cline";
		if (isCline) {
			await deps.runtimeApi.sendTaskChatMessage(scope, { taskId: card.id, text: prompt, mode: "act" });
			return;
		}
		await deps.runtimeApi.sendTaskSessionInput(scope, { taskId: card.id, text: prompt, appendNewline: false });
		await delay(AUTO_REVIEW_PTY_SUBMIT_DELAY_MS);
		await deps.runtimeApi.sendTaskSessionInput(scope, { taskId: card.id, text: "\r", appendNewline: false });
	};

	const runAutoReview = async (
		scope: RuntimeTrpcWorkspaceScope,
		board: RuntimeBoardData,
		summaries: Map<string, RuntimeTaskSessionSummary>,
	): Promise<void> => {
		const reviewCards = cardsInColumn(board, "review");
		const reviewIds = new Set(reviewCards.map((card) => card.id));
		const armedMap = armedActionByWorkspace.get(scope.workspaceId) ?? new Map<string, RuntimeTaskAutoReviewMode>();
		const inFlight = gitActionInFlightByWorkspace.get(scope.workspaceId) ?? new Set<string>();
		for (const armedTaskId of [...armedMap.keys()]) {
			if (!reviewIds.has(armedTaskId)) {
				armedMap.delete(armedTaskId);
			}
		}

		let config: RuntimeConfigResponse | null = null;
		const ensureConfig = async (): Promise<RuntimeConfigResponse> => {
			if (!config) {
				config = await deps.runtimeApi.loadConfig(scope);
			}
			return config;
		};

		for (const card of reviewCards) {
			if (card.autoReviewEnabled !== true) {
				armedMap.delete(card.id);
				continue;
			}
			const summary = summaries.get(card.id);
			if (isAwaitingUserResponse(summary)) {
				continue;
			}
			const mode = resolveAutoReviewMode(card.autoReviewMode);
			if (mode === "done") {
				await moveTaskToDoneAndChain(scope, card.id);
				continue;
			}

			if (inFlight.has(card.id)) {
				continue;
			}
			const changedFiles = await getChangedFileCount(scope, card);
			if (changedFiles === null) {
				continue;
			}
			const armed = armedMap.get(card.id);
			if (armed) {
				if (changedFiles === 0) {
					armedMap.delete(card.id);
					await moveTaskToDoneAndChain(scope, card.id);
				}
				continue;
			}
			if (mode === "commit" && changedFiles === 0) {
				await moveTaskToDoneAndChain(scope, card.id);
				continue;
			}
			if (changedFiles <= 0) {
				continue;
			}
			armedMap.set(card.id, mode);
			inFlight.add(card.id);
			const gitActionConfig = await ensureConfig();
			void runGitAction(scope, card, mode, gitActionConfig, summary)
				.catch((error) => {
					deps.warn(
						`[orchestrator] auto-review ${mode} failed for ${card.id}: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
					armedMap.delete(card.id);
				})
				.finally(() => {
					inFlight.delete(card.id);
				});
		}

		armedActionByWorkspace.set(scope.workspaceId, armedMap);
		gitActionInFlightByWorkspace.set(scope.workspaceId, inFlight);
	};

	const reconcileWorkspace = async (
		workspaceId: string,
		workspacePath: string,
		options?: { recovery?: boolean },
	): Promise<void> => {
		const scope: RuntimeTrpcWorkspaceScope = { workspaceId, workspacePath };

		// 1. Startup recovery: restart in_progress cards that have no live session
		//    (restart-interrupted tasks and mid-start orphans like the 50ffb bug).
		if (options?.recovery) {
			const recoveryState = await deps.workspaceApi.loadState(scope);
			const recoverySummaries = await buildCombinedSummaries(scope, recoveryState.sessions);
			for (const card of cardsInColumn(recoveryState.board, "in_progress")) {
				const summary = recoverySummaries.get(card.id);
				if (isActiveTaskSessionState(summary ?? null)) {
					continue;
				}
				const started = await startTaskOnRuntime(startTaskDeps, { scope, taskId: card.id });
				if (!started.ok) {
					deps.warn(`[orchestrator] startup recovery could not restart ${card.id}: ${started.error ?? "unknown"}`);
				}
			}
		}

		const state = await deps.workspaceApi.loadState(scope);
		const summaries = await buildCombinedSummaries(scope, state.sessions);
		const previous = previousSummaryByWorkspace.get(workspaceId) ?? new Map<string, RuntimeTaskSessionSummary>();

		// 2. Session -> column sync (only on transitions, mirroring the browser).
		const columnSync = await mutateWorkspaceState<boolean>(workspacePath, (latest) => {
			let board = latest.board;
			for (const summary of summaries.values()) {
				const priorSummary = previous.get(summary.taskId);
				if (priorSummary && priorSummary.updatedAt > summary.updatedAt) {
					continue;
				}
				const columnId = getTaskColumnId(board, summary.taskId);
				if (summary.state === "awaiting_review" && columnId === "in_progress") {
					const moved = moveTaskToColumn(board, summary.taskId, "review");
					if (moved.moved) {
						board = moved.board;
					}
				} else if (summary.state === "running" && columnId === "review") {
					const moved = moveTaskToColumn(board, summary.taskId, "in_progress");
					if (moved.moved) {
						board = moved.board;
					}
				} else if (
					summary.state === "interrupted" &&
					priorSummary &&
					priorSummary.state !== "interrupted" &&
					columnId &&
					columnId !== "trash"
				) {
					const moved = moveTaskToColumn(board, summary.taskId, "trash");
					if (moved.moved) {
						board = moved.board;
					}
				}
			}
			const changed = board !== latest.board;
			return { board: changed ? board : latest.board, value: changed, save: changed };
		});

		if (columnSync.value) {
			await deps.broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath);
		}

		const nextPrevious = new Map<string, RuntimeTaskSessionSummary>();
		for (const summary of summaries.values()) {
			nextPrevious.set(summary.taskId, summary);
		}
		previousSummaryByWorkspace.set(workspaceId, nextPrevious);

		// 3. Auto-review for cards now in review.
		await runAutoReview(scope, columnSync.state.board, summaries);
	};

	const notifyWorkspaceActivity = (workspaceId: string): void => {
		if (disposed) {
			return;
		}
		const workspacePath = deps.getWorkspacePathById(workspaceId);
		if (!workspacePath) {
			return;
		}
		void enqueue(workspaceId, () => reconcileWorkspace(workspaceId, workspacePath));
	};

	const reconcileAllOnStartup = async (): Promise<void> => {
		if (disposed) {
			return;
		}
		const managed = deps.listManagedWorkspaces();
		await Promise.all(
			managed.map(({ workspaceId, workspacePath }) => {
				if (!workspacePath) {
					return Promise.resolve();
				}
				return enqueue(workspaceId, () => reconcileWorkspace(workspaceId, workspacePath, { recovery: true }));
			}),
		);
	};

	const safetySweepIntervalMs = deps.safetySweepIntervalMs ?? DEFAULT_SAFETY_SWEEP_INTERVAL_MS;
	let sweepTimer: NodeJS.Timeout | null = null;
	if (safetySweepIntervalMs > 0) {
		sweepTimer = setInterval(() => {
			for (const { workspaceId, workspacePath } of deps.listManagedWorkspaces()) {
				if (workspacePath) {
					notifyWorkspaceActivity(workspaceId);
				}
			}
		}, safetySweepIntervalMs);
		sweepTimer.unref?.();
	}

	return {
		notifyWorkspaceActivity,
		reconcileAllOnStartup,
		waitForIdle: async (workspaceId: string) => {
			await (queues.get(workspaceId) ?? Promise.resolve());
		},
		dispose: () => {
			disposed = true;
			if (sweepTimer) {
				clearInterval(sweepTimer);
				sweepTimer = null;
			}
		},
	};
}
