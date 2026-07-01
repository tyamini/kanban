import { resolveKanbanCommandLine } from "../core/kanban-command";

export const KANBAN_HOOK_TASK_ID_ENV = "KANBAN_HOOK_TASK_ID";
export const KANBAN_HOOK_WORKSPACE_ID_ENV = "KANBAN_HOOK_WORKSPACE_ID";
// The kanban CLI command line, so agents/skills running in a task worktree can
// invoke the board CLI (e.g. `$KANBAN_CLI task create …`) regardless of install.
export const KANBAN_CLI_ENV = "KANBAN_CLI";

export interface HookRuntimeContext {
	taskId: string;
	workspaceId: string;
}

function requireTrimmedEnv(env: NodeJS.ProcessEnv, key: string): string {
	const value = env[key]?.trim();
	if (!value) {
		throw new Error(`Missing required environment variable: ${key}`);
	}
	return value;
}

export function createHookRuntimeEnv(context: HookRuntimeContext): Record<string, string> {
	return {
		[KANBAN_HOOK_TASK_ID_ENV]: context.taskId,
		[KANBAN_HOOK_WORKSPACE_ID_ENV]: context.workspaceId,
		[KANBAN_CLI_ENV]: resolveKanbanCommandLine(),
	};
}

export function parseHookRuntimeContextFromEnv(env: NodeJS.ProcessEnv = process.env): HookRuntimeContext {
	const taskId = requireTrimmedEnv(env, KANBAN_HOOK_TASK_ID_ENV);
	const workspaceId = requireTrimmedEnv(env, KANBAN_HOOK_WORKSPACE_ID_ENV);
	return {
		taskId,
		workspaceId,
	};
}
