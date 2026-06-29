import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard, ReviewTaskWorkspaceSnapshot } from "@/types";

/**
 * Variables exposed to handoff templates as `{{from.*}}` tokens. These describe
 * the upstream task whose completion triggered the downstream task to start.
 */
export interface HandoffVariableDescriptor {
	token: string;
	description: string;
}

export const HANDOFF_VARIABLE_DESCRIPTORS: HandoffVariableDescriptor[] = [
	{ token: "{{from.title}}", description: "the upstream task title" },
	{ token: "{{from.summary}}", description: "the upstream agent's final message" },
	{ token: "{{from.branch}}", description: "the upstream task's git branch" },
	{ token: "{{from.head_commit}}", description: "the upstream task's HEAD commit" },
	{ token: "{{from.pr_url}}", description: "the PR URL detected in the upstream summary" },
	{ token: "{{from.changed_files}}", description: "number of files the upstream task changed" },
];

// Best-effort detection of a GitHub PR URL inside free-form agent text.
const PR_URL_PATTERN = /https?:\/\/github\.com\/[^\s)]+\/pull\/\d+/i;

export function extractPrUrl(text: string | null | undefined): string {
	if (!text) {
		return "";
	}
	const match = text.match(PR_URL_PATTERN);
	return match ? match[0] : "";
}

export function getUpstreamSummaryText(summary: RuntimeTaskSessionSummary | undefined): string {
	return summary?.latestHookActivity?.finalMessage?.trim() ?? "";
}

export function buildHandoffVariables(
	upstream: BoardCard,
	summary: RuntimeTaskSessionSummary | undefined,
	workspace: ReviewTaskWorkspaceSnapshot | null | undefined,
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
