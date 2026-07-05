import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	deletePersistedTerminalSnapshot,
	persistTerminalSnapshot,
	readPersistedTerminalSnapshot,
} from "../../../src/terminal/terminal-snapshot-store";

let tempHome: string;
let previousHome: string | undefined;

beforeEach(async () => {
	previousHome = process.env.HOME;
	tempHome = await mkdtemp(join(tmpdir(), "kanban-snapshot-test-"));
	process.env.HOME = tempHome;
});

afterEach(async () => {
	if (previousHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = previousHome;
	}
	await rm(tempHome, { recursive: true, force: true });
});

describe("terminal-snapshot-store", () => {
	it("round-trips a persisted snapshot", async () => {
		await persistTerminalSnapshot("task-1", { snapshot: "hello world", cols: 100, rows: 30 });
		const restored = await readPersistedTerminalSnapshot("task-1");
		expect(restored).toEqual({ snapshot: "hello world", cols: 100, rows: 30 });
	});

	it("returns null when no snapshot has been persisted", async () => {
		expect(await readPersistedTerminalSnapshot("missing")).toBeNull();
	});

	it("does not persist an empty snapshot", async () => {
		await persistTerminalSnapshot("task-empty", { snapshot: "", cols: 80, rows: 24 });
		expect(await readPersistedTerminalSnapshot("task-empty")).toBeNull();
	});

	it("falls back to default dimensions for non-positive cols/rows", async () => {
		await persistTerminalSnapshot("task-dims", { snapshot: "data", cols: 0, rows: -5 });
		const restored = await readPersistedTerminalSnapshot("task-dims");
		expect(restored).toEqual({ snapshot: "data", cols: 120, rows: 40 });
	});

	it("overwrites a previous snapshot for the same task", async () => {
		await persistTerminalSnapshot("task-2", { snapshot: "first", cols: 80, rows: 24 });
		await persistTerminalSnapshot("task-2", { snapshot: "second", cols: 80, rows: 24 });
		const restored = await readPersistedTerminalSnapshot("task-2");
		expect(restored?.snapshot).toBe("second");
	});

	it("deletes a persisted snapshot", async () => {
		await persistTerminalSnapshot("task-3", { snapshot: "bye", cols: 80, rows: 24 });
		expect(await readPersistedTerminalSnapshot("task-3")).not.toBeNull();
		await deletePersistedTerminalSnapshot("task-3");
		expect(await readPersistedTerminalSnapshot("task-3")).toBeNull();
	});

	it("does not throw when deleting a missing snapshot", async () => {
		await expect(deletePersistedTerminalSnapshot("never-existed")).resolves.toBeUndefined();
	});

	it("isolates snapshots that use filesystem-unsafe task ids", async () => {
		await persistTerminalSnapshot("../evil/../id", { snapshot: "safe", cols: 80, rows: 24 });
		const restored = await readPersistedTerminalSnapshot("../evil/../id");
		expect(restored?.snapshot).toBe("safe");
	});
});
