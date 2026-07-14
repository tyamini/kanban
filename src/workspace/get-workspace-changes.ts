import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type {
	RuntimeWorkspaceChangesResponse,
	RuntimeWorkspaceFileChange,
	RuntimeWorkspaceFileStatus,
} from "../core/api-contract";
import { mapWithConcurrency } from "./concurrency";
import { getGitStdout } from "./git-utils";

const WORKSPACE_CHANGES_CACHE_MAX_ENTRIES = 128;

/**
 * Maximum number of changed files for which we eagerly materialize the full
 * old/new text of every file. Above this, the response lists the files (path,
 * status, +/- counts) but leaves `oldText`/`newText` null and sets
 * `truncated: true`; per-file content is then loaded lazily on demand. This
 * prevents a huge diff from fanning out into thousands of `git show` spawns.
 */
const MAX_MATERIALIZED_DIFF_FILES = 300;

/** Upper bound on concurrent per-file git invocations while building a diff. */
const GIT_DIFF_FILE_CONCURRENCY = 8;

interface WorkspaceChangesCacheEntry {
	stateKey: string;
	response: RuntimeWorkspaceChangesResponse;
	lastAccessedAt: number;
}

const workspaceChangesCache = new Map<string, WorkspaceChangesCacheEntry>();

interface NameStatusEntry {
	path: string;
	status: RuntimeWorkspaceFileStatus;
	previousPath?: string;
}

interface ChangesBetweenRefsInput {
	cwd: string;
	fromRef: string;
	toRef: string;
}

interface ChangesFromRefInput {
	cwd: string;
	fromRef: string;
}

/** Options shared by every changes query. */
export interface WorkspaceChangesOptions {
	/**
	 * When set, only the file matching this repo-relative path is computed and
	 * its content is always materialized (used for lazy per-file loading of a
	 * truncated diff). Caching and the materialization cap are bypassed.
	 */
	onlyPath?: string;
}

interface DiffStat {
	additions: number;
	deletions: number;
}

interface FileFingerprint {
	path: string;
	size: number | null;
	mtimeMs: number | null;
	ctimeMs: number | null;
}

/**
 * Describes how to read the "before" and "after" side of a file for a specific
 * kind of diff (working copy, ref..ref, ref..working-tree).
 */
interface MaterializeContext {
	repoRoot: string;
	/** `git` args (including trailing "--") for a batched `--numstat` call. */
	numstatBaseArgs: string[];
	readOldText: (entry: NameStatusEntry) => Promise<string | null>;
	readNewText: (entry: NameStatusEntry) => Promise<string | null>;
}

function mapNameStatus(code: string): RuntimeWorkspaceFileStatus {
	const kind = code.charAt(0);
	if (kind === "M") return "modified";
	if (kind === "A") return "added";
	if (kind === "D") return "deleted";
	if (kind === "R") return "renamed";
	if (kind === "C") return "copied";
	return "unknown";
}

function toLineCount(text: string): number {
	if (!text) {
		return 0;
	}
	return text.split("\n").length;
}

function oldTextApplies(entry: NameStatusEntry): boolean {
	return entry.status !== "added" && entry.status !== "untracked";
}

function newTextApplies(entry: NameStatusEntry): boolean {
	return entry.status !== "deleted";
}

function parseTrackedChanges(output: string): NameStatusEntry[] {
	const entries: NameStatusEntry[] = [];
	const lines = output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	for (const line of lines) {
		const parts = line.split("\t");
		const statusCode = parts[0];
		const status = mapNameStatus(statusCode);

		if ((status === "renamed" || status === "copied") && parts.length >= 3) {
			const previousPath = parts[1];
			const path = parts[2];
			if (path) {
				entries.push({
					path,
					previousPath: previousPath || undefined,
					status,
				});
			}
			continue;
		}

		const path = parts[1];
		if (path) {
			entries.push({
				path,
				status,
			});
		}
	}

	return entries;
}

async function buildFileFingerprints(repoRoot: string, paths: string[]): Promise<FileFingerprint[]> {
	if (paths.length === 0) {
		return [];
	}
	const uniqueSortedPaths = Array.from(new Set(paths)).sort((left, right) => left.localeCompare(right));
	const entries = await Promise.all(
		uniqueSortedPaths.map(async (path) => {
			const absolutePath = join(repoRoot, path);
			try {
				const fileStat = await stat(absolutePath);
				return {
					path,
					size: fileStat.size,
					mtimeMs: fileStat.mtimeMs,
					ctimeMs: fileStat.ctimeMs,
				} satisfies FileFingerprint;
			} catch {
				return {
					path,
					size: null,
					mtimeMs: null,
					ctimeMs: null,
				} satisfies FileFingerprint;
			}
		}),
	);
	return entries;
}

function fingerprintsToken(fingerprints: FileFingerprint[]): string {
	return fingerprints
		.map((entry) => `${entry.path}\t${entry.size ?? "null"}\t${entry.mtimeMs ?? "null"}\t${entry.ctimeMs ?? "null"}`)
		.join("\n");
}

function pruneWorkspaceChangesCache(): void {
	if (workspaceChangesCache.size <= WORKSPACE_CHANGES_CACHE_MAX_ENTRIES) {
		return;
	}
	const entries = Array.from(workspaceChangesCache.entries()).sort(
		(left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt,
	);
	const removeCount = entries.length - WORKSPACE_CHANGES_CACHE_MAX_ENTRIES;
	for (let index = 0; index < removeCount; index += 1) {
		const candidate = entries[index];
		if (!candidate) {
			break;
		}
		workspaceChangesCache.delete(candidate[0]);
	}
}

function readCachedChanges(scopeKey: string, stateKey: string): RuntimeWorkspaceChangesResponse | null {
	const existing = workspaceChangesCache.get(scopeKey);
	if (existing && existing.stateKey === stateKey) {
		existing.lastAccessedAt = Date.now();
		return existing.response;
	}
	return null;
}

function writeCachedChanges(scopeKey: string, stateKey: string, response: RuntimeWorkspaceChangesResponse): void {
	workspaceChangesCache.set(scopeKey, {
		stateKey,
		response,
		lastAccessedAt: Date.now(),
	});
	pruneWorkspaceChangesCache();
}

async function readHeadFile(repoRoot: string, path: string): Promise<string | null> {
	try {
		return await getGitStdout(["show", `HEAD:${path}`], repoRoot);
	} catch {
		return null;
	}
}

async function readFileAtRef(repoRoot: string, ref: string, path: string): Promise<string | null> {
	try {
		return await getGitStdout(["show", `${ref}:${path}`], repoRoot);
	} catch {
		return null;
	}
}

async function readWorkingTreeFile(repoRoot: string, path: string): Promise<string | null> {
	try {
		return await readFile(join(repoRoot, path), "utf8");
	} catch {
		return null;
	}
}

function fallbackStats(oldText: string | null, newText: string | null): DiffStat {
	if (oldText == null && newText == null) {
		return { additions: 0, deletions: 0 };
	}
	if (oldText == null) {
		return { additions: toLineCount(newText ?? ""), deletions: 0 };
	}
	if (newText == null) {
		return { additions: 0, deletions: toLineCount(oldText) };
	}

	const oldLines = toLineCount(oldText);
	const newLines = toLineCount(newText);
	return {
		additions: Math.max(newLines - oldLines, 0),
		deletions: Math.max(oldLines - newLines, 0),
	};
}

/**
 * Run a single batched `git diff --numstat` and index the results by path.
 * One git process replaces the previous one-numstat-per-file fan-out.
 */
async function readDiffStatsByPath(repoRoot: string, numstatArgs: string[]): Promise<Map<string, DiffStat>> {
	const statsByPath = new Map<string, DiffStat>();
	let output: string;
	try {
		output = await getGitStdout(numstatArgs, repoRoot);
	} catch {
		return statsByPath;
	}
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		const parts = trimmed.split("\t");
		if (parts.length < 3) {
			continue;
		}
		const [addedRaw, deletedRaw] = parts;
		const path = parts.slice(2).join("\t");
		if (!path) {
			continue;
		}
		const additions = Number.parseInt(addedRaw ?? "", 10);
		const deletions = Number.parseInt(deletedRaw ?? "", 10);
		statsByPath.set(path, {
			additions: Number.isFinite(additions) ? additions : 0,
			deletions: Number.isFinite(deletions) ? deletions : 0,
		});
	}
	return statsByPath;
}

function resolveStats(
	entry: NameStatusEntry,
	statsByPath: Map<string, DiffStat>,
	oldText: string | null,
	newText: string | null,
): DiffStat {
	if (entry.status === "untracked") {
		return { additions: toLineCount(newText ?? ""), deletions: 0 };
	}
	const fromNumstat = statsByPath.get(entry.path);
	if (fromNumstat) {
		return fromNumstat;
	}
	return fallbackStats(oldText, newText);
}

/**
 * Build the file-change list for a set of changed entries with bounded git
 * concurrency. When the changeset is larger than the materialization cap (and a
 * specific file was not requested), file text is left null and `truncated` is
 * set so the client can lazily fetch content per file.
 */
async function materializeChanges(
	allChanges: NameStatusEntry[],
	context: MaterializeContext,
	options: WorkspaceChangesOptions,
): Promise<{ files: RuntimeWorkspaceFileChange[]; truncated: boolean }> {
	const targetChanges =
		options.onlyPath !== undefined ? allChanges.filter((entry) => entry.path === options.onlyPath) : allChanges;

	const materializeContent = options.onlyPath !== undefined || targetChanges.length <= MAX_MATERIALIZED_DIFF_FILES;
	const truncated = options.onlyPath === undefined && !materializeContent;

	const numstatArgs =
		options.onlyPath !== undefined ? [...context.numstatBaseArgs, options.onlyPath] : context.numstatBaseArgs;
	const statsByPath = await readDiffStatsByPath(context.repoRoot, numstatArgs);

	const files = await mapWithConcurrency(targetChanges, GIT_DIFF_FILE_CONCURRENCY, async (entry) => {
		const oldText = materializeContent && oldTextApplies(entry) ? await context.readOldText(entry) : null;
		const newText = materializeContent && newTextApplies(entry) ? await context.readNewText(entry) : null;
		const stats = resolveStats(entry, statsByPath, oldText, newText);
		return {
			path: entry.path,
			previousPath: entry.previousPath,
			status: entry.status,
			additions: stats.additions,
			deletions: stats.deletions,
			oldText,
			newText,
		} satisfies RuntimeWorkspaceFileChange;
	});
	files.sort((left, right) => left.path.localeCompare(right.path));
	return { files, truncated };
}

export async function createEmptyWorkspaceChangesResponse(cwd: string): Promise<RuntimeWorkspaceChangesResponse> {
	const repoRoot = (await getGitStdout(["rev-parse", "--show-toplevel"], cwd)).trim();
	if (!repoRoot) {
		throw new Error("Could not resolve git repository root.");
	}
	return {
		repoRoot,
		generatedAt: Date.now(),
		files: [],
		truncated: false,
	};
}

export async function getWorkspaceChanges(
	cwd: string,
	options: WorkspaceChangesOptions = {},
): Promise<RuntimeWorkspaceChangesResponse> {
	const repoRoot = (await getGitStdout(["rev-parse", "--show-toplevel"], cwd)).trim();
	if (!repoRoot) {
		throw new Error("Could not resolve git repository root.");
	}

	const [trackedChangesOutput, untrackedOutput, headCommitOutput] = await Promise.all([
		getGitStdout(["diff", "--name-status", "HEAD", "--"], repoRoot),
		getGitStdout(["ls-files", "--others", "--exclude-standard"], repoRoot),
		getGitStdout(["rev-parse", "--verify", "HEAD"], repoRoot).catch(() => ""),
	]);
	const trackedChanges = parseTrackedChanges(trackedChangesOutput);
	const untrackedPaths = untrackedOutput
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	const trackedPaths = new Set(trackedChanges.map((entry) => entry.path));
	const allChanges: NameStatusEntry[] = [
		...trackedChanges,
		...untrackedPaths
			.filter((path) => !trackedPaths.has(path))
			.map((path) => ({
				path,
				status: "untracked" as const,
			})),
	];
	const fingerprintPaths = allChanges.flatMap((entry) => [entry.path, entry.previousPath].filter(Boolean) as string[]);
	const fingerprints = await buildFileFingerprints(repoRoot, fingerprintPaths);
	const scopeKey = repoRoot;
	const stateKey = [
		repoRoot,
		headCommitOutput.trim() || "no-head",
		trackedChangesOutput,
		untrackedOutput,
		fingerprintsToken(fingerprints),
	].join("\n--\n");

	if (options.onlyPath === undefined) {
		const cached = readCachedChanges(scopeKey, stateKey);
		if (cached) {
			return cached;
		}
	}

	const { files, truncated } = await materializeChanges(
		allChanges,
		{
			repoRoot,
			numstatBaseArgs: ["diff", "--numstat", "HEAD", "--"],
			readOldText: (entry) => readHeadFile(repoRoot, entry.previousPath ?? entry.path),
			readNewText: (entry) => readWorkingTreeFile(repoRoot, entry.path),
		},
		options,
	);
	const response: RuntimeWorkspaceChangesResponse = {
		repoRoot,
		generatedAt: Date.now(),
		files,
		truncated,
	};
	if (options.onlyPath === undefined) {
		writeCachedChanges(scopeKey, stateKey, response);
	}
	return response;
}

export async function getWorkspaceChangesBetweenRefs(
	input: ChangesBetweenRefsInput,
	options: WorkspaceChangesOptions = {},
): Promise<RuntimeWorkspaceChangesResponse> {
	const repoRoot = (await getGitStdout(["rev-parse", "--show-toplevel"], input.cwd)).trim();
	if (!repoRoot) {
		throw new Error("Could not resolve git repository root.");
	}

	const trackedChangesOutput = await getGitStdout(
		["diff", "--name-status", "--find-renames", input.fromRef, input.toRef, "--"],
		repoRoot,
	);
	const trackedChanges = parseTrackedChanges(trackedChangesOutput);
	if (trackedChanges.length === 0) {
		return {
			repoRoot,
			generatedAt: Date.now(),
			files: [],
			truncated: false,
		};
	}

	const scopeKey = `${repoRoot}\n--between--\n${input.fromRef}\n${input.toRef}`;
	const stateKey = trackedChangesOutput;
	if (options.onlyPath === undefined) {
		const cached = readCachedChanges(scopeKey, stateKey);
		if (cached) {
			return cached;
		}
	}

	const { files, truncated } = await materializeChanges(
		trackedChanges,
		{
			repoRoot,
			numstatBaseArgs: ["diff", "--numstat", input.fromRef, input.toRef, "--"],
			readOldText: (entry) => readFileAtRef(repoRoot, input.fromRef, entry.previousPath ?? entry.path),
			readNewText: (entry) => readFileAtRef(repoRoot, input.toRef, entry.path),
		},
		options,
	);
	const response: RuntimeWorkspaceChangesResponse = {
		repoRoot,
		generatedAt: Date.now(),
		files,
		truncated,
	};
	if (options.onlyPath === undefined) {
		writeCachedChanges(scopeKey, stateKey, response);
	}
	return response;
}

export async function getWorkspaceChangesFromRef(
	input: ChangesFromRefInput,
	options: WorkspaceChangesOptions = {},
): Promise<RuntimeWorkspaceChangesResponse> {
	const repoRoot = (await getGitStdout(["rev-parse", "--show-toplevel"], input.cwd)).trim();
	if (!repoRoot) {
		throw new Error("Could not resolve git repository root.");
	}

	const [trackedChangesOutput, untrackedOutput] = await Promise.all([
		getGitStdout(["diff", "--name-status", "--find-renames", input.fromRef, "--"], repoRoot),
		getGitStdout(["ls-files", "--others", "--exclude-standard"], repoRoot),
	]);
	const trackedChanges = parseTrackedChanges(trackedChangesOutput);
	const untrackedPaths = untrackedOutput
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const trackedPaths = new Set(trackedChanges.map((entry) => entry.path));
	const allChanges: NameStatusEntry[] = [
		...trackedChanges,
		...untrackedPaths
			.filter((path) => !trackedPaths.has(path))
			.map((path) => ({
				path,
				status: "untracked" as const,
			})),
	];

	if (allChanges.length === 0) {
		return {
			repoRoot,
			generatedAt: Date.now(),
			files: [],
			truncated: false,
		};
	}

	const fingerprintPaths = allChanges.flatMap((entry) => [entry.path, entry.previousPath].filter(Boolean) as string[]);
	const fingerprints = await buildFileFingerprints(repoRoot, fingerprintPaths);
	const scopeKey = `${repoRoot}\n--fromref--\n${input.fromRef}`;
	const stateKey = [input.fromRef, trackedChangesOutput, untrackedOutput, fingerprintsToken(fingerprints)].join(
		"\n--\n",
	);
	if (options.onlyPath === undefined) {
		const cached = readCachedChanges(scopeKey, stateKey);
		if (cached) {
			return cached;
		}
	}

	const { files, truncated } = await materializeChanges(
		allChanges,
		{
			repoRoot,
			numstatBaseArgs: ["diff", "--numstat", input.fromRef, "--"],
			readOldText: (entry) => readFileAtRef(repoRoot, input.fromRef, entry.previousPath ?? entry.path),
			readNewText: (entry) => readWorkingTreeFile(repoRoot, entry.path),
		},
		options,
	);
	const response: RuntimeWorkspaceChangesResponse = {
		repoRoot,
		generatedAt: Date.now(),
		files,
		truncated,
	};
	if (options.onlyPath === undefined) {
		writeCachedChanges(scopeKey, stateKey, response);
	}
	return response;
}
