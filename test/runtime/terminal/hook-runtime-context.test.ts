import { describe, expect, it } from "vitest";

import {
	createHookRuntimeEnv,
	KANBAN_CLI_ENV,
	KANBAN_HOOK_TASK_ID_ENV,
	KANBAN_HOOK_WORKSPACE_ID_ENV,
	parseHookRuntimeContextFromEnv,
} from "../../../src/terminal/hook-runtime-context";

describe("hook-runtime-context", () => {
	it("creates expected environment variables", () => {
		const env = createHookRuntimeEnv({
			taskId: "task-1",
			workspaceId: "workspace-1",
		});
		expect(env[KANBAN_HOOK_TASK_ID_ENV]).toBe("task-1");
		expect(env[KANBAN_HOOK_WORKSPACE_ID_ENV]).toBe("workspace-1");
		// The kanban CLI command line is injected so worktree agents/skills can call it.
		expect(env[KANBAN_CLI_ENV]).toBeTruthy();
	});

	it("parses hook runtime context from env", () => {
		const parsed = parseHookRuntimeContextFromEnv({
			[KANBAN_HOOK_TASK_ID_ENV]: "task-2",
			[KANBAN_HOOK_WORKSPACE_ID_ENV]: "workspace-2",
		});
		expect(parsed).toEqual({
			taskId: "task-2",
			workspaceId: "workspace-2",
		});
	});

	it("throws when required env vars are missing", () => {
		expect(() => parseHookRuntimeContextFromEnv({})).toThrow(
			`Missing required environment variable: ${KANBAN_HOOK_TASK_ID_ENV}`,
		);
	});
});
