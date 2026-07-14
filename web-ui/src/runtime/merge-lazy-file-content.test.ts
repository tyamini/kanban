import { describe, expect, it } from "vitest";

import type { RuntimeWorkspaceFileChange } from "@/runtime/types";
import { mergeLazyFileContent } from "@/runtime/use-lazy-diff-content";

function truncatedFile(path: string): RuntimeWorkspaceFileChange {
	return {
		path,
		status: "modified",
		additions: 0,
		deletions: 0,
		oldText: null,
		newText: null,
	};
}

describe("mergeLazyFileContent", () => {
	it("returns the same array reference when nothing is loaded", () => {
		const files = [truncatedFile("a.ts"), truncatedFile("b.ts")];
		expect(mergeLazyFileContent(files, {})).toBe(files);
	});

	it("replaces content and stats for loaded files only", () => {
		const files = [truncatedFile("a.ts"), truncatedFile("b.ts")];
		const merged = mergeLazyFileContent(files, {
			"a.ts": {
				path: "a.ts",
				status: "modified",
				additions: 3,
				deletions: 1,
				oldText: "old",
				newText: "new",
			},
		});
		expect(merged[0]).toMatchObject({ oldText: "old", newText: "new", additions: 3, deletions: 1 });
		expect(merged[1]).toMatchObject({ oldText: null, newText: null });
	});
});
