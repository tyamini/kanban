import type {
	RuntimeAgentId,
	RuntimeBoardColumnId,
	RuntimeTaskAutoReviewMode,
	RuntimeTaskClineSettings,
	RuntimeTaskHandoff,
	RuntimeTaskHandoffMode,
	RuntimeTaskImage,
} from "@/runtime/types";

export type BoardColumnId = RuntimeBoardColumnId;

export type TaskAutoReviewMode = RuntimeTaskAutoReviewMode;
export type TaskImage = RuntimeTaskImage;

export const DEFAULT_TASK_AUTO_REVIEW_MODE: TaskAutoReviewMode = "commit";

export function resolveTaskAutoReviewMode(mode: TaskAutoReviewMode | null | undefined): TaskAutoReviewMode {
	if (mode === "pr" || mode === "done") {
		return mode;
	}
	return DEFAULT_TASK_AUTO_REVIEW_MODE;
}

export function getTaskAutoReviewActionLabel(mode: TaskAutoReviewMode | null | undefined): string {
	const resolvedMode = resolveTaskAutoReviewMode(mode);
	if (resolvedMode === "pr") return "PR";
	if (resolvedMode === "done") return "done";
	return "commit";
}

export function getTaskAutoReviewCancelButtonLabel(mode: TaskAutoReviewMode | null | undefined): string {
	const resolvedMode = resolveTaskAutoReviewMode(mode);
	if (resolvedMode === "pr") return "Cancel Auto-PR";
	if (resolvedMode === "done") return "Cancel Auto-done";
	return "Cancel Auto-commit";
}

export interface BoardCard {
	id: string;
	title: string;
	prompt: string;
	startInPlanMode: boolean;
	autoReviewEnabled?: boolean;
	autoReviewMode?: TaskAutoReviewMode;
	images?: TaskImage[];
	agentId?: RuntimeAgentId;
	clineSettings?: RuntimeTaskClineSettings;
	baseRef: string;
	createdAt: number;
	updatedAt: number;
}

export interface BoardColumn {
	id: BoardColumnId;
	title: string;
	cards: BoardCard[];
}

export type TaskHandoffMode = RuntimeTaskHandoffMode;
export type TaskHandoff = RuntimeTaskHandoff;

export const DEFAULT_TASK_HANDOFF_MODE: TaskHandoffMode = "none";

export function resolveTaskHandoffMode(mode: TaskHandoffMode | null | undefined): TaskHandoffMode {
	if (mode === "summary" || mode === "template" || mode === "none") {
		return mode;
	}
	return DEFAULT_TASK_HANDOFF_MODE;
}

export interface BoardDependency {
	id: string;
	fromTaskId: string;
	toTaskId: string;
	createdAt: number;
	handoff?: TaskHandoff;
}

/** A reusable task template stored in the per-project catalog (same shape as a card). */
export type BoardCatalogEntry = BoardCard;

export interface BoardData {
	columns: BoardColumn[];
	dependencies: BoardDependency[];
	/** Per-project catalog of reusable task templates (inert; never run or linked). */
	catalog: BoardCatalogEntry[];
}

export interface ReviewTaskWorkspaceSnapshot {
	taskId: string;
	path: string;
	branch: string | null;
	isDetached: boolean;
	headCommit: string | null;
	changedFiles: number | null;
	additions: number | null;
	deletions: number | null;
}

export interface CardSelection {
	card: BoardCard;
	column: BoardColumn;
	allColumns: BoardColumn[];
}
