import { describe, expect, it } from "vitest";

import { resolveClaudeFinalMessageFromTranscriptText } from "../../src/commands/hook-events/claude-hook-events";

describe("resolveClaudeFinalMessageFromTranscriptText", () => {
	it("extracts the last assistant text message from a Claude transcript", () => {
		const transcript = [
			JSON.stringify({ type: "user", message: { role: "user", content: "do the thing" } }),
			JSON.stringify({
				type: "assistant",
				message: { role: "assistant", content: [{ type: "text", text: "Working on it." }] },
			}),
			JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Which database should I use, Postgres or SQLite?" }],
				},
			}),
		].join("\n");

		expect(resolveClaudeFinalMessageFromTranscriptText(transcript)).toBe(
			"Which database should I use, Postgres or SQLite?",
		);
	});

	it("ignores thinking and tool_use blocks, keeping only text", () => {
		const transcript = JSON.stringify({
			type: "assistant",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "internal reasoning" },
					{ type: "tool_use", name: "Bash", input: { command: "ls" } },
					{ type: "text", text: "Done." },
				],
			},
		});

		expect(resolveClaudeFinalMessageFromTranscriptText(transcript)).toBe("Done.");
	});

	it("skips trailing non-assistant lines to find the final assistant message", () => {
		const transcript = [
			JSON.stringify({
				type: "assistant",
				message: { role: "assistant", content: [{ type: "text", text: "All set?" }] },
			}),
			JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
		].join("\n");

		expect(resolveClaudeFinalMessageFromTranscriptText(transcript)).toBe("All set?");
	});

	it("returns null when there is no assistant text", () => {
		const transcript = JSON.stringify({ type: "user", message: { role: "user", content: "hi" } });
		expect(resolveClaudeFinalMessageFromTranscriptText(transcript)).toBeNull();
	});
});
