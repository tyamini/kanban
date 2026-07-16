import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
	RuntimeBoardData,
	RuntimeConfigResponse,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
} from "../../src/core/api-contract";
import { createTaskOrchestrator } from "../../src/server/task-orchestrator";
import { loadWorkspaceContext, loadWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "../../src/trpc/app-router";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

// Sessions the fake runtime reports as "live"; the tests mutate this to model
// agent state transitions (running -> awaiting_review -> interrupted, etc).
type FakeSessions = Record<string, RuntimeTaskSessionSummary>;

function summary(taskId: string, overrides: Partial<RuntimeTaskSessionSummary>): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: Date.now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	} as RuntimeTaskSessionSummary;
}

function initGitRepository(path: string): void {
	const init = spawnSync("git", ["init"], { cwd: path, stdio: "ignore", env: createGitTestEnv() });
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
}

const CONFIG: RuntimeConfigResponse = {
	commitPromptTemplate: "Commit against {{base_ref}}",
	openPrPromptTemplate: "Open a PR against {{base_ref}}",
	commitPromptTemplateDefault: "default commit",
	openPrPromptTemplateDefault: "default pr",
} as unknown as RuntimeConfigResponse;

interface Harness {
	orchestrator: ReturnType<typeof createTaskOrchestrator>;
	scope: RuntimeTrpcWorkspaceScope;
	fakeSessions: FakeSessions;
	changedFilesByTaskId: Record<string, number>;
	startCalls: Array<{ taskId: string; prompt: string }>;
	chatCalls: Array<{ taskId: string; text: string }>;
	inputCalls: Array<{ taskId: string; text: string }>;
	readBoard: () => Promise<RuntimeBoardData>;
}

async function createHarness(workspacePath: string, initialBoard: RuntimeBoardData): Promise<Harness> {
	const context = await loadWorkspaceContext(workspacePath);
	await saveWorkspaceState(workspacePath, { board: initialBoard, sessions: {}, expectedRevision: 0 });

	const scope: RuntimeTrpcWorkspaceScope = { workspaceId: context.workspaceId, workspacePath };
	const fakeSessions: FakeSessions = {};
	const changedFilesByTaskId: Record<string, number> = {};
	const startCalls: Harness["startCalls"] = [];
	const chatCalls: Harness["chatCalls"] = [];
	const inputCalls: Harness["inputCalls"] = [];

	const workspaceApi = {
		loadState: async (): Promise<RuntimeWorkspaceStateResponse> => {
			const state = await loadWorkspaceState(workspacePath);
			return { ...state, sessions: { ...fakeSessions } };
		},
		ensureWorktree: async () => ({ ok: true, path: join(workspacePath, ".wt") }),
		loadGitSummary: async (_scope: unknown, input: { taskId: string } | null) => {
			const changedFiles = input ? (changedFilesByTaskId[input.taskId] ?? 0) : 0;
			return {
				ok: true,
				summary: {
					currentBranch: "task-branch",
					upstreamBranch: null,
					changedFiles,
					additions: 0,
					deletions: 0,
					aheadCount: 0,
					behindCount: 0,
				},
			};
		},
	} as unknown as RuntimeTrpcContext["workspaceApi"];

	const runtimeApi = {
		loadConfig: async () => CONFIG,
		startTaskSession: async (_scope: unknown, input: { taskId: string; prompt: string }) => {
			startCalls.push({ taskId: input.taskId, prompt: input.prompt });
			fakeSessions[input.taskId] = summary(input.taskId, { state: "running" });
			return { ok: true, summary: fakeSessions[input.taskId] };
		},
		sendTaskChatMessage: async (_scope: unknown, input: { taskId: string; text: string }) => {
			chatCalls.push({ taskId: input.taskId, text: input.text });
			return { ok: true, summary: null };
		},
		sendTaskSessionInput: async (_scope: unknown, input: { taskId: string; text: string }) => {
			inputCalls.push({ taskId: input.taskId, text: input.text });
			return { ok: true, summary: null };
		},
	} as unknown as RuntimeTrpcContext["runtimeApi"];

	const orchestrator = createTaskOrchestrator({
		runtimeApi,
		workspaceApi,
		getScopedClineTaskSessionService: async () =>
			({ listSummaries: () => [] }) as unknown as Awaited<
				ReturnType<Parameters<typeof createTaskOrchestrator>[0]["getScopedClineTaskSessionService"]>
			>,
		broadcastRuntimeWorkspaceStateUpdated: () => undefined,
		getWorkspacePathById: () => workspacePath,
		listManagedWorkspaces: () => [{ workspaceId: context.workspaceId, workspacePath }],
		warn: () => undefined,
		safetySweepIntervalMs: 0,
	});

	return {
		orchestrator,
		scope,
		fakeSessions,
		changedFilesByTaskId,
		startCalls,
		chatCalls,
		inputCalls,
		readBoard: async () => (await loadWorkspaceState(workspacePath)).board,
	};
}

function columnOf(board: RuntimeBoardData, taskId: string): string | null {
	for (const column of board.columns) {
		if (column.cards.some((card) => card.id === taskId)) {
			return column.id;
		}
	}
	return null;
}

function boardWith(cards: {
	backlog?: RuntimeBoardData["columns"][number]["cards"];
	in_progress?: RuntimeBoardData["columns"][number]["cards"];
	review?: RuntimeBoardData["columns"][number]["cards"];
	dependencies?: RuntimeBoardData["dependencies"];
}): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: cards.backlog ?? [] },
			{ id: "in_progress", title: "In Progress", cards: cards.in_progress ?? [] },
			{ id: "review", title: "Review", cards: cards.review ?? [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: cards.dependencies ?? [],
		catalog: [],
	};
}

function card(
	id: string,
	overrides: Record<string, unknown> = {},
): RuntimeBoardData["columns"][number]["cards"][number] {
	return {
		id,
		title: id,
		prompt: `prompt for ${id}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	} as RuntimeBoardData["columns"][number]["cards"][number];
}

describe.sequential("task-orchestrator integration", () => {
	let tempHome: { path: string; cleanup: () => void };
	let sandbox: { path: string; cleanup: () => void };
	let previousHome: string | undefined;

	beforeEach(() => {
		tempHome = createTempDir("kanban-orch-home-");
		sandbox = createTempDir("kanban-orch-ws-");
		previousHome = process.env.HOME;
		process.env.HOME = tempHome.path;
		process.env.USERPROFILE = tempHome.path;
	});

	afterEach(() => {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		sandbox.cleanup();
		tempHome.cleanup();
	});

	it("moves an awaiting-review task to review, then auto-done chains a linked backlog task with handoff", async () => {
		const workspacePath = join(sandbox.path, "proj");
		mkdirSync(workspacePath, { recursive: true });
		initGitRepository(workspacePath);

		const board = boardWith({
			in_progress: [card("U", { autoReviewEnabled: true, autoReviewMode: "done" })],
			backlog: [card("D")],
			dependencies: [
				{ id: "dep1", fromTaskId: "D", toTaskId: "U", createdAt: Date.now(), handoff: { mode: "summary" } },
			],
		});
		const harness = await createHarness(workspacePath, board);

		harness.fakeSessions.U = summary("U", {
			state: "awaiting_review",
			reviewReason: "hook",
			latestHookActivity: { finalMessage: "shipped the feature" } as RuntimeTaskSessionSummary["latestHookActivity"],
		});

		harness.orchestrator.notifyWorkspaceActivity(harness.scope.workspaceId);
		await harness.orchestrator.waitForIdle(harness.scope.workspaceId);
		// Chaining kicks off a nested reconcile-independent start; drain once more.
		await harness.orchestrator.waitForIdle(harness.scope.workspaceId);

		const finalBoard = await harness.readBoard();
		expect(columnOf(finalBoard, "U")).toBe("trash");
		expect(columnOf(finalBoard, "D")).toBe("in_progress");
		const startForD = harness.startCalls.find((c) => c.taskId === "D");
		expect(startForD).toBeDefined();
		expect(startForD?.prompt).toContain("shipped the feature");
	});

	it("auto-review commit mode sends a commit prompt while changes exist, then moves to done when clean", async () => {
		const workspacePath = join(sandbox.path, "proj");
		mkdirSync(workspacePath, { recursive: true });
		initGitRepository(workspacePath);

		const board = boardWith({
			review: [card("T", { autoReviewEnabled: true, autoReviewMode: "commit", agentId: "cline" })],
		});
		const harness = await createHarness(workspacePath, board);
		harness.fakeSessions.T = summary("T", { state: "awaiting_review", agentId: "cline", reviewReason: "hook" });
		harness.changedFilesByTaskId.T = 3;

		harness.orchestrator.notifyWorkspaceActivity(harness.scope.workspaceId);
		await harness.orchestrator.waitForIdle(harness.scope.workspaceId);

		expect(harness.chatCalls.some((c) => c.taskId === "T" && c.text.includes("Commit against main"))).toBe(true);
		expect(columnOf(await harness.readBoard(), "T")).toBe("review");

		// Agent committed: no more changes. Next reconcile should move it to done.
		harness.changedFilesByTaskId.T = 0;
		harness.orchestrator.notifyWorkspaceActivity(harness.scope.workspaceId);
		await harness.orchestrator.waitForIdle(harness.scope.workspaceId);

		expect(columnOf(await harness.readBoard(), "T")).toBe("trash");
	});

	it("auto-review pr mode sends a PR prompt while changes exist, then moves to done when clean", async () => {
		const workspacePath = join(sandbox.path, "proj");
		mkdirSync(workspacePath, { recursive: true });
		initGitRepository(workspacePath);

		const board = boardWith({
			review: [card("T", { autoReviewEnabled: true, autoReviewMode: "pr", agentId: "cline" })],
		});
		const harness = await createHarness(workspacePath, board);
		harness.fakeSessions.T = summary("T", { state: "awaiting_review", agentId: "cline", reviewReason: "hook" });
		harness.changedFilesByTaskId.T = 2;

		harness.orchestrator.notifyWorkspaceActivity(harness.scope.workspaceId);
		await harness.orchestrator.waitForIdle(harness.scope.workspaceId);

		expect(harness.chatCalls.some((c) => c.taskId === "T" && c.text.includes("Open a PR against main"))).toBe(true);
		expect(columnOf(await harness.readBoard(), "T")).toBe("review");

		// Agent opened the PR and committed everything: working tree is now clean.
		harness.changedFilesByTaskId.T = 0;
		harness.orchestrator.notifyWorkspaceActivity(harness.scope.workspaceId);
		await harness.orchestrator.waitForIdle(harness.scope.workspaceId);

		expect(columnOf(await harness.readBoard(), "T")).toBe("trash");
	});

	it("auto-review pr mode moves to done when the tree is already clean (armed flag lost / PR done before reconcile)", async () => {
		// Reproduces the "did the PR but stuck in review" bug: the in-memory armed
		// flag is lost (hub restart / remote reconnect) after the PR was opened, so
		// the pr card re-reaches reconcile with a clean tree and no armed state. It
		// must still move to done rather than being stuck in review forever.
		const workspacePath = join(sandbox.path, "proj");
		mkdirSync(workspacePath, { recursive: true });
		initGitRepository(workspacePath);

		const board = boardWith({
			review: [card("T", { autoReviewEnabled: true, autoReviewMode: "pr" })],
		});
		const harness = await createHarness(workspacePath, board);
		harness.fakeSessions.T = summary("T", { state: "awaiting_review", reviewReason: "hook" });
		harness.changedFilesByTaskId.T = 0;

		harness.orchestrator.notifyWorkspaceActivity(harness.scope.workspaceId);
		await harness.orchestrator.waitForIdle(harness.scope.workspaceId);

		// No PR prompt should be sent (nothing to commit/push), and the card must
		// not linger in review.
		expect(harness.inputCalls.some((c) => c.taskId === "T")).toBe(false);
		expect(columnOf(await harness.readBoard(), "T")).toBe("trash");
	});

	it("recovers an orphaned in_progress task with no live session on startup", async () => {
		const workspacePath = join(sandbox.path, "proj");
		mkdirSync(workspacePath, { recursive: true });
		initGitRepository(workspacePath);

		const board = boardWith({ in_progress: [card("orphan")] });
		const harness = await createHarness(workspacePath, board);
		// No session for "orphan" -> it is a mid-start/restart orphan.

		await harness.orchestrator.reconcileAllOnStartup();
		await harness.orchestrator.waitForIdle(harness.scope.workspaceId);

		expect(harness.startCalls.some((c) => c.taskId === "orphan")).toBe(true);
	});
});
