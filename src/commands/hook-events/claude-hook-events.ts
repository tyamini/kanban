import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { RuntimeHookEvent, RuntimeTaskHookActivity } from "../../core/api-contract";
import { asRecord, normalizeWhitespace, readStringField } from "./hook-utils";

const CLAUDE_TRANSCRIPT_TAIL_SCAN_BYTES = 2 * 1024 * 1024;

function parseJsonObject(value: string): Record<string, unknown> | null {
	try {
		return asRecord(JSON.parse(value));
	} catch {
		return null;
	}
}

function readTranscriptPathFromPayload(payload: Record<string, unknown> | null): string | null {
	return payload ? (readStringField(payload, "transcript_path") ?? readStringField(payload, "transcriptPath")) : null;
}

/**
 * Claude Code transcript lines carry the assistant turn under
 * `message: { role: "assistant", content: [...] }`. We only collect `text`
 * blocks (thinking/tool_use blocks are ignored) to reconstruct the final
 * assistant message.
 */
function extractAssistantTextFromClaudeLine(lineRecord: Record<string, unknown>): string | null {
	const messageRecord = asRecord(lineRecord.message);
	if (!messageRecord || readStringField(messageRecord, "role") !== "assistant") {
		return null;
	}
	const content = messageRecord.content;
	if (typeof content === "string") {
		return normalizeWhitespace(content);
	}
	if (!Array.isArray(content)) {
		return null;
	}
	const textSegments: string[] = [];
	for (const item of content) {
		const itemRecord = asRecord(item);
		if (!itemRecord) {
			continue;
		}
		if (readStringField(itemRecord, "type") === "text") {
			const itemText = readStringField(itemRecord, "text");
			if (itemText) {
				textSegments.push(itemText);
			}
		}
	}
	if (textSegments.length === 0) {
		return null;
	}
	return normalizeWhitespace(textSegments.join("\n"));
}

export function resolveClaudeFinalMessageFromTranscriptText(transcriptText: string): string | null {
	const lines = transcriptText.split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index]?.trim();
		if (!line) {
			continue;
		}
		const lineRecord = parseJsonObject(line);
		if (!lineRecord) {
			continue;
		}
		const assistantText = extractAssistantTextFromClaudeLine(lineRecord);
		if (assistantText) {
			return assistantText;
		}
	}
	return null;
}

async function readFileTail(filePath: string, maxBytes: number): Promise<string | null> {
	try {
		const fileStat = await stat(filePath);
		if (!fileStat.isFile() || fileStat.size <= 0 || maxBytes <= 0) {
			return null;
		}
		const byteLength = Math.min(fileStat.size, maxBytes);
		const start = Math.max(0, fileStat.size - byteLength);
		let handle: Awaited<ReturnType<typeof open>> | null = null;
		try {
			handle = await open(filePath, "r");
			const buffer = Buffer.alloc(byteLength);
			const readResult = await handle.read(buffer, 0, byteLength, start);
			return buffer.subarray(0, readResult.bytesRead).toString("utf8");
		} finally {
			await handle?.close();
		}
	} catch {
		return null;
	}
}

/**
 * Claude Code stores per-project transcripts under
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, where the directory name
 * is the working directory with `/` and `.` replaced by `-`. Given a working
 * directory (e.g. a task worktree), find the newest transcript and read the last
 * assistant message from it.
 *
 * This is the fallback used to recover a task's final message when it completes
 * itself mid-turn via `kanban task done` (the kanban-task-done skill): at that
 * moment no Stop/to_review hook has fired yet, so the persisted session summary
 * has no `finalMessage` for the downstream handoff to pick up.
 */
export async function resolveClaudeFinalMessageForCwd(cwd: string): Promise<string | null> {
	const normalizedCwd = cwd.trim();
	if (!normalizedCwd) {
		return null;
	}
	const encoded = normalizedCwd.replace(/[/.]/g, "-");
	const projectDir = join(homedir(), ".claude", "projects", encoded);
	let entries: string[];
	try {
		entries = (await readdir(projectDir)).filter((name) => name.endsWith(".jsonl"));
	} catch {
		return null;
	}
	if (entries.length === 0) {
		return null;
	}
	const withMtime = await Promise.all(
		entries.map(async (name) => {
			const filePath = join(projectDir, name);
			try {
				return { filePath, mtimeMs: (await stat(filePath)).mtimeMs };
			} catch {
				return { filePath, mtimeMs: 0 };
			}
		}),
	);
	withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const transcriptTail = await readFileTail(withMtime[0].filePath, CLAUDE_TRANSCRIPT_TAIL_SCAN_BYTES);
	if (!transcriptTail) {
		return null;
	}
	return resolveClaudeFinalMessageFromTranscriptText(transcriptTail);
}

async function resolveClaudeReviewFinalMessageFromPayload(
	payload: Record<string, unknown> | null,
): Promise<string | null> {
	const transcriptPath = readTranscriptPathFromPayload(payload);
	if (!transcriptPath) {
		return null;
	}
	const transcriptTail = await readFileTail(transcriptPath, CLAUDE_TRANSCRIPT_TAIL_SCAN_BYTES);
	if (!transcriptTail) {
		return null;
	}
	return resolveClaudeFinalMessageFromTranscriptText(transcriptTail);
}

/**
 * Claude's Stop hook payload does not include the assistant's final text (only a
 * `transcript_path`). Without it, an end-of-turn question is indistinguishable
 * from genuine completion, so auto-review can wrongly move a task to Done. This
 * enriches `to_review` events for the Claude agent with the final assistant
 * message read from the transcript, mirroring the droid enricher.
 */
export async function enrichClaudeReviewMetadata<
	T extends {
		event: RuntimeHookEvent;
		metadata?: Partial<RuntimeTaskHookActivity>;
		payload?: Record<string, unknown> | null;
	},
>(args: T): Promise<T> {
	if (args.event !== "to_review") {
		return args;
	}
	const metadata = args.metadata ?? {};
	const source = metadata.source?.toLowerCase();
	if (source !== "claude") {
		return args;
	}
	const existingFinalMessage =
		typeof metadata.finalMessage === "string" && metadata.finalMessage.trim().length > 0
			? metadata.finalMessage
			: null;
	if (existingFinalMessage) {
		return {
			...args,
			metadata: {
				...metadata,
				activityText: metadata.activityText ?? `Final: ${existingFinalMessage}`,
			},
		};
	}

	const fallbackFinalMessage = await resolveClaudeReviewFinalMessageFromPayload(args.payload ?? null);
	if (!fallbackFinalMessage) {
		return args;
	}

	return {
		...args,
		metadata: {
			...metadata,
			finalMessage: fallbackFinalMessage,
			activityText: metadata.activityText ?? `Final: ${fallbackFinalMessage}`,
		},
	};
}
