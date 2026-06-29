import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { type BoardCard, type ReviewTaskWorkspaceSnapshot, resolveTaskHandoffMode, type TaskHandoff } from "@/types";
import { interpolateTemplate } from "@/utils/interpolate-template";
import { buildHandoffVariables, getUpstreamSummaryText } from "./build-handoff-variables";

export interface ResolveHandoffPromptInput {
	downstream: BoardCard;
	upstream: BoardCard;
	handoff: TaskHandoff | undefined;
	upstreamSummary: RuntimeTaskSessionSummary | undefined;
	upstreamWorkspace: ReviewTaskWorkspaceSnapshot | null | undefined;
}

function buildSummaryContextPrompt(downstreamPrompt: string, upstreamTitle: string, summaryText: string): string {
	if (!summaryText) {
		return downstreamPrompt;
	}
	const block = `## Context from upstream task "${upstreamTitle}"\n${summaryText}`;
	return downstreamPrompt ? `${block}\n\n---\n\n${downstreamPrompt}` : block;
}

/**
 * Compute the prompt a downstream task should run with, injecting context from
 * the upstream task that triggered it. Returns the downstream task's own prompt
 * unchanged when the handoff is disabled or there is nothing to inject.
 */
export function resolveHandoffPrompt(input: ResolveHandoffPromptInput): string {
	const basePrompt = input.downstream.prompt.trim();
	const mode = resolveTaskHandoffMode(input.handoff?.mode);

	if (mode === "none") {
		return basePrompt;
	}

	if (mode === "template") {
		const template = input.handoff?.template?.trim();
		if (!template) {
			return basePrompt;
		}
		const variables = buildHandoffVariables(input.upstream, input.upstreamSummary, input.upstreamWorkspace);
		return interpolateTemplate(template, variables);
	}

	// mode === "summary"
	const summaryText = getUpstreamSummaryText(input.upstreamSummary);
	return buildSummaryContextPrompt(basePrompt, input.upstream.title ?? "", summaryText);
}
