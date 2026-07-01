import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard } from "@/types";
import { resolveHandoffPrompt } from "./resolve-handoff-prompt";

function makeCard(overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id: "task",
		title: "Task",
		prompt: "base prompt",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function makeSummary(finalMessage: string | undefined): RuntimeTaskSessionSummary {
	return { latestHookActivity: finalMessage ? { finalMessage } : undefined } as RuntimeTaskSessionSummary;
}

const upstream = makeCard({ id: "up", title: "Open PR" });

describe("resolveHandoffPrompt", () => {
	it("defaults to none (base prompt unchanged) when no handoff is configured", () => {
		const result = resolveHandoffPrompt({
			downstream: makeCard({ prompt: "review the PR" }),
			upstream,
			handoff: undefined,
			upstreamSummary: makeSummary("PR ready at https://example.com/pr/1"),
			upstreamWorkspace: null,
		});
		expect(result).toBe("review the PR");
	});

	it("prepends a context block in summary mode", () => {
		const result = resolveHandoffPrompt({
			downstream: makeCard({ prompt: "review the PR" }),
			upstream,
			handoff: { mode: "summary" },
			upstreamSummary: makeSummary("PR ready at https://example.com/pr/1"),
			upstreamWorkspace: null,
		});
		expect(result).toBe(
			'## Context from upstream task "Open PR"\nPR ready at https://example.com/pr/1\n\n---\n\nreview the PR',
		);
	});

	it("returns the base prompt unchanged when summary is empty", () => {
		const result = resolveHandoffPrompt({
			downstream: makeCard({ prompt: "review the PR" }),
			upstream,
			handoff: { mode: "summary" },
			upstreamSummary: makeSummary(undefined),
			upstreamWorkspace: null,
		});
		expect(result).toBe("review the PR");
	});

	it("returns the base prompt for mode none", () => {
		const result = resolveHandoffPrompt({
			downstream: makeCard({ prompt: "review the PR" }),
			upstream,
			handoff: { mode: "none" },
			upstreamSummary: makeSummary("ignored"),
			upstreamWorkspace: null,
		});
		expect(result).toBe("review the PR");
	});

	it("interpolates a custom template", () => {
		const result = resolveHandoffPrompt({
			downstream: makeCard({ prompt: "ignored base" }),
			upstream,
			handoff: { mode: "template", template: "Review {{from.summary}} on {{from.branch}}" },
			upstreamSummary: makeSummary("the change"),
			upstreamWorkspace: {
				taskId: "up",
				path: "/x",
				branch: "feat/x",
				isDetached: false,
				headCommit: null,
				changedFiles: null,
				additions: null,
				deletions: null,
			},
		});
		expect(result).toBe("Review the change on feat/x");
	});

	it("falls back to base prompt when template mode has no template", () => {
		const result = resolveHandoffPrompt({
			downstream: makeCard({ prompt: "base" }),
			upstream,
			handoff: { mode: "template" },
			upstreamSummary: makeSummary("x"),
			upstreamWorkspace: null,
		});
		expect(result).toBe("base");
	});
});
