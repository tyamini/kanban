import { describe, expect, it } from "vitest";

import type { RuntimeBoardData } from "../../src/core/api-contract";
import {
	addCatalogTask,
	addCatalogTaskToBacklog,
	addTaskDependency,
	addTaskToColumn,
	deleteTasksFromBoard,
	moveTaskToColumn,
	removeCatalogTask,
	trashTaskAndGetReadyLinkedTaskIds,
	updateCatalogTask,
	updateTask,
	updateTaskDependencyHandoff,
} from "../../src/core/task-board-mutations";

function createBoard(): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
		catalog: [],
	};
}

describe("deleteTasksFromBoard", () => {
	it("removes a trashed task and any dependencies that reference it", () => {
		const createA = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task A", baseRef: "main" },
			() => "aaaaa111",
		);
		const createB = addTaskToColumn(createA.board, "review", { prompt: "Task B", baseRef: "main" }, () => "bbbbb111");
		const linked = addTaskDependency(createB.board, "aaaaa", "bbbbb");
		if (!linked.added) {
			throw new Error("Expected dependency to be created.");
		}
		const trashed = trashTaskAndGetReadyLinkedTaskIds(linked.board, "bbbbb");
		const deleted = deleteTasksFromBoard(trashed.board, ["bbbbb"]);

		expect(deleted.deleted).toBe(true);
		expect(deleted.deletedTaskIds).toEqual(["bbbbb"]);
		expect(deleted.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
		expect(deleted.board.dependencies).toEqual([]);
	});

	it("removes multiple trashed tasks at once", () => {
		const createA = addTaskToColumn(createBoard(), "trash", { prompt: "Task A", baseRef: "main" }, () => "aaaaa111");
		const createB = addTaskToColumn(createA.board, "trash", { prompt: "Task B", baseRef: "main" }, () => "bbbbb111");

		const deleted = deleteTasksFromBoard(createB.board, ["aaaaa", "bbbbb"]);

		expect(deleted.deleted).toBe(true);
		expect(deleted.deletedTaskIds.sort()).toEqual(["aaaaa", "bbbbb"]);
		expect(deleted.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
	});
});

describe("updateTaskDependencyHandoff", () => {
	function createLinkedBoard(): { board: RuntimeBoardData; dependencyId: string } {
		const createA = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task A", baseRef: "main" },
			() => "aaaaa111",
		);
		const createB = addTaskToColumn(createA.board, "review", { prompt: "Task B", baseRef: "main" }, () => "bbbbb111");
		const linked = addTaskDependency(createB.board, "aaaaa", "bbbbb");
		if (!linked.added || !linked.dependency) {
			throw new Error("Expected dependency to be created.");
		}
		return { board: linked.board, dependencyId: linked.dependency.id };
	}

	it("sets a handoff config on the dependency", () => {
		const { board, dependencyId } = createLinkedBoard();
		const updated = updateTaskDependencyHandoff(board, dependencyId, {
			mode: "template",
			template: "Review {{from.pr_url}}",
		});
		expect(updated.updated).toBe(true);
		expect(updated.board.dependencies[0]?.handoff).toEqual({ mode: "template", template: "Review {{from.pr_url}}" });
	});

	it("clears the handoff config when passed undefined", () => {
		const { board, dependencyId } = createLinkedBoard();
		const withHandoff = updateTaskDependencyHandoff(board, dependencyId, { mode: "none" });
		const cleared = updateTaskDependencyHandoff(withHandoff.board, dependencyId, undefined);
		expect(cleared.updated).toBe(true);
		expect(cleared.board.dependencies[0]?.handoff).toBeUndefined();
	});

	it("reports updated=false for an unknown dependency id", () => {
		const { board } = createLinkedBoard();
		const result = updateTaskDependencyHandoff(board, "does-not-exist", { mode: "summary" });
		expect(result.updated).toBe(false);
		expect(result.board).toBe(board);
	});
});

describe("task images", () => {
	it("preserves images when creating and updating tasks", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task with image",
				baseRef: "main",
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
			},
			() => "aaaaa111",
		);

		expect(created.task.images).toEqual([
			{
				id: "img-1",
				data: "abc123",
				mimeType: "image/png",
			},
		]);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task with updated image",
			baseRef: "main",
			images: [
				{
					id: "img-2",
					data: "def456",
					mimeType: "image/jpeg",
				},
			],
		});

		expect(updated.task?.images).toEqual([
			{
				id: "img-2",
				data: "def456",
				mimeType: "image/jpeg",
			},
		]);
	});
});

describe("per-task agent/model/provider overrides", () => {
	it("persists agentId on the card when creating a task", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Smart task", baseRef: "main", agentId: "claude" },
			() => "aaaaa111",
		);

		expect(created.task.agentId).toBe("claude");
	});

	it("persists task-level Cline settings on the card when creating a task", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Dumb task",
				baseRef: "main",
				agentId: "cline",
				clineSettings: {
					providerId: "anthropic",
					modelId: "claude-sonnet-4-20250514",
					reasoningEffort: "high",
				},
			},
			() => "aaaaa111",
		);

		expect(created.task.agentId).toBe("cline");
		expect(created.task.clineSettings).toEqual({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-20250514",
			reasoningEffort: "high",
		});
	});

	it("leaves override fields undefined when not provided", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Default task", baseRef: "main" },
			() => "aaaaa111",
		);

		expect(created.task.agentId).toBeUndefined();
		expect(created.task.clineSettings).toBeUndefined();
	});

	it("updates agentId from undefined to a value", () => {
		const created = addTaskToColumn(createBoard(), "backlog", { prompt: "Task", baseRef: "main" }, () => "aaaaa111");
		expect(created.task.agentId).toBeUndefined();

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			agentId: "codex",
		});

		expect(updated.updated).toBe(true);
		expect(updated.task?.agentId).toBe("codex");
	});

	it("updates clineModelId", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task", baseRef: "main", clineSettings: { modelId: "old-model" } },
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			clineSettings: { modelId: "new-model" },
		});

		expect(updated.task?.clineSettings?.modelId).toBe("new-model");
	});

	it("preserves existing overrides when update input omits them (undefined)", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task",
				baseRef: "main",
				agentId: "claude",
				clineSettings: {
					providerId: "anthropic",
					modelId: "claude-sonnet-4-20250514",
					reasoningEffort: "low",
				},
			},
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Updated prompt",
			baseRef: "main",
			// agentId and clineSettings are undefined, so existing overrides should persist
		});

		expect(updated.task?.agentId).toBe("claude");
		expect(updated.task?.clineSettings).toEqual({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-20250514",
			reasoningEffort: "low",
		});
	});

	it("clears overrides when update input provides null", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task",
				baseRef: "main",
				agentId: "codex",
				clineSettings: {
					providerId: "openai",
					modelId: "gpt-4",
					reasoningEffort: "medium",
				},
			},
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			agentId: null,
			clineSettings: null,
		});

		expect(updated.task?.agentId).toBeUndefined();
		expect(updated.task?.clineSettings).toBeUndefined();
	});

	it("preserves overrides across move operations", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Movable task",
				baseRef: "main",
				agentId: "claude",
				clineSettings: {
					providerId: "anthropic",
					modelId: "claude-sonnet-4-20250514",
					reasoningEffort: "high",
				},
			},
			() => "aaaaa111",
		);

		const moved = moveTaskToColumn(created.board, created.task.id, "in_progress");

		expect(moved.moved).toBe(true);
		expect(moved.task?.agentId).toBe("claude");
		expect(moved.task?.clineSettings).toEqual({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-20250514",
			reasoningEffort: "high",
		});
	});
});

describe("task catalog", () => {
	it("adds an entry to the catalog without touching the columns", () => {
		const result = addCatalogTask(createBoard(), { prompt: "Common chore", baseRef: "main" }, () => "ctlg1");
		expect(result.board.catalog).toHaveLength(1);
		expect(result.board.catalog[0]?.id).toBe("ctlg1");
		expect(result.board.columns.every((column) => column.cards.length === 0)).toBe(true);
	});

	it("never reuses a catalog id when creating a column task", () => {
		const withCatalog = addCatalogTask(createBoard(), { prompt: "Template", baseRef: "main" }, () => "dup");
		const ids = ["dup", "dup", "frsh"];
		let call = 0;
		const created = addTaskToColumn(
			withCatalog.board,
			"backlog",
			{ prompt: "Real task", baseRef: "main" },
			() => ids[call++] ?? "fallback",
		);
		// The first two uuids collide with the catalog id, so a unique one is chosen.
		expect(created.task.id).toBe("frsh");
	});

	it("duplicates a catalog entry into the backlog with a new id, leaving the entry intact", () => {
		const withCatalog = addCatalogTask(
			createBoard(),
			{ prompt: "Run the linter", baseRef: "main", autoReviewMode: "pr" },
			() => "ctlgA",
		);
		const added = addCatalogTaskToBacklog(withCatalog.board, "ctlgA", () => "bklgA");
		expect(added.added).toBe(true);
		expect(added.task?.id).toBe("bklgA");
		expect(added.task?.prompt).toBe("Run the linter");
		expect(added.task?.autoReviewMode).toBe("pr");
		// Catalog entry is unchanged; backlog has the duplicate.
		expect(added.board.catalog).toHaveLength(1);
		expect(added.board.catalog[0]?.id).toBe("ctlgA");
		const backlog = added.board.columns.find((column) => column.id === "backlog");
		expect(backlog?.cards.map((card) => card.id)).toEqual(["bklgA"]);
	});

	it("reports added=false for an unknown catalog id", () => {
		const result = addCatalogTaskToBacklog(createBoard(), "missing", () => "x");
		expect(result.added).toBe(false);
		expect(result.task).toBeNull();
	});

	it("updates and removes catalog entries", () => {
		const withCatalog = addCatalogTask(createBoard(), { prompt: "Old", baseRef: "main" }, () => "c1");
		const updated = updateCatalogTask(withCatalog.board, "c1", { prompt: "New prompt", baseRef: "dev" });
		expect(updated.updated).toBe(true);
		expect(updated.board.catalog[0]?.prompt).toBe("New prompt");
		expect(updated.board.catalog[0]?.baseRef).toBe("dev");

		const removed = removeCatalogTask(updated.board, "c1");
		expect(removed.removed).toBe(true);
		expect(removed.board.catalog).toHaveLength(0);
	});
});
