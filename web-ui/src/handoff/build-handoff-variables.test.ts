import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard, ReviewTaskWorkspaceSnapshot } from "@/types";
import { buildHandoffVariables, extractPrUrl } from "./build-handoff-variables";

function makeCard(overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id: "task-1",
		title: "Open the PR",
		prompt: "do the thing",
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

function makeWorkspace(overrides: Partial<ReviewTaskWorkspaceSnapshot> = {}): ReviewTaskWorkspaceSnapshot {
	return {
		taskId: "task-1",
		path: "/tmp/wt",
		branch: "feature/foo",
		isDetached: false,
		headCommit: "abc123",
		changedFiles: 3,
		additions: 10,
		deletions: 2,
		...overrides,
	};
}

describe("extractPrUrl", () => {
	it("pulls a GitHub PR url out of free text", () => {
		expect(extractPrUrl("Done! PR: https://github.com/acme/widgets/pull/42 — please review")).toBe(
			"https://github.com/acme/widgets/pull/42",
		);
	});

	it("returns empty string when no PR url is present", () => {
		expect(extractPrUrl("no link here")).toBe("");
		expect(extractPrUrl(null)).toBe("");
		expect(extractPrUrl(undefined)).toBe("");
	});
});

describe("buildHandoffVariables", () => {
	it("maps upstream task, summary and workspace into from.* variables", () => {
		const vars = buildHandoffVariables(
			makeCard(),
			makeSummary("Created https://github.com/acme/widgets/pull/7"),
			makeWorkspace(),
		);
		expect(vars).toEqual({
			"from.title": "Open the PR",
			"from.summary": "Created https://github.com/acme/widgets/pull/7",
			"from.branch": "feature/foo",
			"from.head_commit": "abc123",
			"from.pr_url": "https://github.com/acme/widgets/pull/7",
			"from.changed_files": "3",
		});
	});

	it("falls back to empty strings when data is missing", () => {
		const vars = buildHandoffVariables(makeCard({ title: "" }), undefined, null);
		expect(vars["from.summary"]).toBe("");
		expect(vars["from.branch"]).toBe("");
		expect(vars["from.pr_url"]).toBe("");
		expect(vars["from.changed_files"]).toBe("");
	});
});
