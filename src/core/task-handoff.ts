// Shared task-handoff resolution.
//
// When an upstream task finishes and unlocks a downstream (linked) task, the
// dependency's `handoff` setting controls what context the downstream task
// starts with. This logic is shared by two completion paths that must behave
// identically:
//   - the server-side orchestrator's auto-review completion
//     (`moveTaskToDoneAndChain`), and
//   - the CLI `task done` path (`trashTaskById`) used by the
//     `kanban-task-done` skill for self-completing tasks.
// Keeping it here prevents the two paths from drifting (a skill-completed task
// must hand off context just like an auto-reviewed one).
import type { RuntimeBoardCard, RuntimeTaskHandoff, RuntimeTaskSessionSummary } from "./api-contract";

export interface UpstreamWorkspaceSnapshot {
	branch: string | null;
	headCommit: string | null;
	changedFiles: number | null;
}

export function resolveHandoffMode(mode: RuntimeTaskHandoff["mode"] | null | undefined): RuntimeTaskHandoff["mode"] {
	if (mode === "summary" || mode === "template") {
		return mode;
	}
	return "none";
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

export function getUpstreamSummaryText(summary: RuntimeTaskSessionSummary | undefined): string {
	return summary?.latestHookActivity?.finalMessage?.trim() ?? "";
}

function buildHandoffVariables(
	upstream: RuntimeBoardCard,
	summary: RuntimeTaskSessionSummary | undefined,
	workspace: UpstreamWorkspaceSnapshot | null,
): Record<string, string> {
	const summaryText = getUpstreamSummaryText(summary);
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
export function resolveHandoffPrompt(input: {
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
	const summaryText = getUpstreamSummaryText(input.upstreamSummary);
	if (!summaryText) {
		return basePrompt;
	}
	const block = `## Context from upstream task "${input.upstream.title ?? ""}"\n${summaryText}`;
	return basePrompt ? `${block}\n\n---\n\n${basePrompt}` : block;
}
