import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import type { RuntimeAgentId, RuntimeAgentSkill, RuntimeAgentSkillSource } from "../core/api-contract";

interface SkillDirectory {
	/** Directory relative to the workspace root, e.g. ".claude/skills". */
	relativeDir: string;
	source: RuntimeAgentSkillSource;
}

/**
 * Per-agent skill directories. Each directory is scanned for both layouts:
 * - `<name>/SKILL.md` subdirectories (Agent Skills convention)
 * - flat `*.md` files (command/prompt convention)
 * so we tolerate whichever layout a given repo actually uses.
 */
const CLAUDE_SKILL_DIRECTORIES: SkillDirectory[] = [
	{ relativeDir: ".claude/skills", source: "skill" },
	{ relativeDir: ".claude/commands", source: "command" },
];

// The user convention for the Cursor agent is `.agents/skills`; `.cursor/*` is
// also scanned since some repos keep skills/commands there.
const CURSOR_SKILL_DIRECTORIES: SkillDirectory[] = [
	{ relativeDir: ".agents/skills", source: "skill" },
	{ relativeDir: ".cursor/skills", source: "skill" },
	{ relativeDir: ".cursor/commands", source: "command" },
];

const AGENT_SKILL_DIRECTORIES: Partial<Record<RuntimeAgentId, SkillDirectory[]>> = {
	claude: CLAUDE_SKILL_DIRECTORIES,
	cursor: CURSOR_SKILL_DIRECTORIES,
};

/** Agents without a dedicated convention fall back to scanning every known skill directory. */
const DEFAULT_SKILL_DIRECTORIES: SkillDirectory[] = dedupeDirectories([
	...CLAUDE_SKILL_DIRECTORIES,
	...CURSOR_SKILL_DIRECTORIES,
]);

const CACHE_TTL_MS = 10_000;

interface CachedSkills {
	expiresAt: number;
	skills: RuntimeAgentSkill[];
}

const skillsCache = new Map<string, CachedSkills>();

function dedupeDirectories(directories: SkillDirectory[]): SkillDirectory[] {
	const seen = new Set<string>();
	const result: SkillDirectory[] = [];
	for (const directory of directories) {
		if (seen.has(directory.relativeDir)) {
			continue;
		}
		seen.add(directory.relativeDir);
		result.push(directory);
	}
	return result;
}

function resolveSkillDirectories(agentId: RuntimeAgentId | undefined): SkillDirectory[] {
	if (agentId && AGENT_SKILL_DIRECTORIES[agentId]) {
		return AGENT_SKILL_DIRECTORIES[agentId];
	}
	return DEFAULT_SKILL_DIRECTORIES;
}

function parseFrontmatter(content: string): Record<string, unknown> {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (!match || !match[1]) {
		return {};
	}
	try {
		const parsed = parseYaml(match[1]) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function toOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

async function readSkillMarkdown(filePath: string): Promise<{ name?: string; description?: string }> {
	try {
		const content = await readFile(filePath, "utf8");
		const frontmatter = parseFrontmatter(content);
		return {
			name: toOptionalString(frontmatter.name),
			description: toOptionalString(frontmatter.description),
		};
	} catch {
		return {};
	}
}

async function collectSkillsFromDirectory(
	absoluteDir: string,
	source: RuntimeAgentSkillSource,
): Promise<RuntimeAgentSkill[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(absoluteDir, { withFileTypes: true });
	} catch {
		return [];
	}

	const skills: RuntimeAgentSkill[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".")) {
			continue;
		}
		const entryPath = path.join(absoluteDir, entry.name);
		// Resolve symlinks (skills are frequently symlinked into `.claude/skills`)
		// since `Dirent.isDirectory()`/`isFile()` report false for symlinks.
		let isDir = entry.isDirectory();
		let isFile = entry.isFile();
		if (entry.isSymbolicLink()) {
			try {
				const resolved = await stat(entryPath);
				isDir = resolved.isDirectory();
				isFile = resolved.isFile();
			} catch {
				continue;
			}
		}
		if (isDir) {
			// `<name>/SKILL.md` convention.
			const meta = await readSkillMarkdown(path.join(entryPath, "SKILL.md"));
			skills.push({ name: meta.name ?? entry.name, description: meta.description, source });
			continue;
		}
		if (isFile && entry.name.toLowerCase().endsWith(".md")) {
			// Flat `*.md` file convention.
			const baseName = entry.name.slice(0, -".md".length);
			if (!baseName || baseName.toLowerCase() === "readme") {
				continue;
			}
			const meta = await readSkillMarkdown(entryPath);
			skills.push({ name: meta.name ?? baseName, description: meta.description, source });
		}
	}
	return skills;
}

/**
 * Lists the agent "skills" available in a workspace by scanning the on-disk
 * conventions for the effective agent (`.claude/*`, `.agents/skills`,
 * `.cursor/*`). Skills are read straight from the filesystem, so this works for
 * any agent without booting an agent harness.
 */
export async function listAgentSkills(
	workspacePath: string,
	agentId: RuntimeAgentId | undefined,
): Promise<RuntimeAgentSkill[]> {
	const cacheKey = `${workspacePath}::${agentId ?? "__default__"}`;
	const cached = skillsCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.skills;
	}

	const directories = resolveSkillDirectories(agentId);
	const results = await Promise.all(
		directories.map((directory) =>
			collectSkillsFromDirectory(path.join(workspacePath, directory.relativeDir), directory.source),
		),
	);

	// Dedupe by name, preferring the first source in directory order.
	const byName = new Map<string, RuntimeAgentSkill>();
	for (const skill of results.flat()) {
		if (!byName.has(skill.name)) {
			byName.set(skill.name, skill);
		}
	}
	const skills = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));

	skillsCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, skills });
	return skills;
}
