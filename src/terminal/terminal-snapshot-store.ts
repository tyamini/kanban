// Disk-backed persistence for terminal scrollback snapshots.
//
// CLI/PTY agents (Claude, Codex, Gemini, ...) have no server-side transcript
// store: their transcript is the live terminal, which only exists in the
// in-memory `TerminalStateMirror`. When the runtime restarts (for example on a
// redeploy) or the session is stopped, that mirror is gone, so reopening a Done
// task shows an empty terminal. Persisting the serialized snapshot lets us
// restore the transcript across restarts and after the live session ends.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getRuntimeHomePath } from "../state/workspace-state";
import type { TerminalRestoreSnapshot } from "./terminal-state-mirror";

const SNAPSHOT_DIR_NAME = "terminal-snapshots";
const SNAPSHOT_FILE_VERSION = 1 as const;
const DEFAULT_SNAPSHOT_COLS = 120;
const DEFAULT_SNAPSHOT_ROWS = 40;

interface PersistedTerminalSnapshotFile extends TerminalRestoreSnapshot {
	version: typeof SNAPSHOT_FILE_VERSION;
	taskId: string;
	updatedAt: number;
}

function getSnapshotDir(): string {
	return join(getRuntimeHomePath(), SNAPSHOT_DIR_NAME);
}

// Task IDs are generally uuid-like, but sanitize defensively so a hostile or
// unusual id can never escape the snapshot directory.
function sanitizeTaskId(taskId: string): string {
	return taskId.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function getSnapshotPath(taskId: string): string {
	return join(getSnapshotDir(), `${sanitizeTaskId(taskId)}.json`);
}

/**
 * Best-effort persistence of a terminal snapshot to disk. Empty snapshots are
 * ignored so we never clobber a real transcript with a blank one, and all
 * errors are swallowed since snapshot persistence must never break a session.
 */
export async function persistTerminalSnapshot(taskId: string, snapshot: TerminalRestoreSnapshot): Promise<void> {
	if (!snapshot.snapshot || snapshot.snapshot.length === 0) {
		return;
	}
	try {
		await mkdir(getSnapshotDir(), { recursive: true });
		const filePath = getSnapshotPath(taskId);
		const tmpPath = `${filePath}.${process.pid}.tmp`;
		const payload: PersistedTerminalSnapshotFile = {
			version: SNAPSHOT_FILE_VERSION,
			taskId,
			updatedAt: Date.now(),
			snapshot: snapshot.snapshot,
			cols: snapshot.cols > 0 ? snapshot.cols : DEFAULT_SNAPSHOT_COLS,
			rows: snapshot.rows > 0 ? snapshot.rows : DEFAULT_SNAPSHOT_ROWS,
		};
		await writeFile(tmpPath, JSON.stringify(payload), "utf8");
		await rename(tmpPath, filePath);
	} catch {
		// Persistence is best-effort; a missing snapshot only degrades the Done
		// transcript to what a live session can show.
	}
}

export async function readPersistedTerminalSnapshot(taskId: string): Promise<TerminalRestoreSnapshot | null> {
	try {
		const raw = await readFile(getSnapshotPath(taskId), "utf8");
		const parsed = JSON.parse(raw) as Partial<PersistedTerminalSnapshotFile>;
		if (typeof parsed?.snapshot !== "string" || parsed.snapshot.length === 0) {
			return null;
		}
		const cols = typeof parsed.cols === "number" && parsed.cols > 0 ? parsed.cols : DEFAULT_SNAPSHOT_COLS;
		const rows = typeof parsed.rows === "number" && parsed.rows > 0 ? parsed.rows : DEFAULT_SNAPSHOT_ROWS;
		return { snapshot: parsed.snapshot, cols, rows };
	} catch {
		return null;
	}
}

export async function deletePersistedTerminalSnapshot(taskId: string): Promise<void> {
	try {
		await rm(getSnapshotPath(taskId), { force: true });
	} catch {
		// Ignore: nothing to clean up or the file is already gone.
	}
}
