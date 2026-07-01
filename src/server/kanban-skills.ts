import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readlink, symlink, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { listWorkspaceIndexEntries } from "../state/workspace-state";

const SKILL_MANIFEST_FILENAME = "SKILL.md";
const PROJECT_SKILLS_RELATIVE_DIR = join(".claude", "skills");

/**
 * Resolves the canonical Kanban skills directory that ships with the package
 * (kanban-src/skills). Mirrors getWebUiDir: works for the bundled dist build,
 * a tsc build, and running from the repo. Returns null if not found.
 */
export function getKanbanSkillsSourceDir(): string | null {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		resolve(here, "..", "skills"), // dist/cli.js -> <pkg>/skills (repo or node_modules/kanban)
		resolve(here, "..", "..", "skills"), // dist/server/kanban-skills.js -> <pkg>/skills
		resolve(here, "skills"), // dist/skills (if ever copied alongside)
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return null;
}

async function listSkillNames(skillsDir: string): Promise<string[]> {
	const entries = await readdir(skillsDir, { withFileTypes: true });
	const names: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		if (existsSync(join(skillsDir, entry.name, SKILL_MANIFEST_FILENAME))) {
			names.push(entry.name);
		}
	}
	return names;
}

async function linkSkill(sourceSkillDir: string, destSkillPath: string): Promise<void> {
	let existing: Awaited<ReturnType<typeof lstat>> | null = null;
	try {
		existing = await lstat(destSkillPath);
	} catch {
		existing = null;
	}

	if (existing?.isSymbolicLink()) {
		const currentTarget = await readlink(destSkillPath).catch(() => null);
		if (currentTarget === sourceSkillDir) {
			return; // already linked to the canonical skill
		}
		// A stale/relocated Kanban symlink — repoint it to the canonical source.
		await unlink(destSkillPath);
	} else if (existing) {
		// A real file/dir already occupies this name (e.g. a user's own skill) — do not clobber it.
		return;
	}

	await symlink(sourceSkillDir, destSkillPath, "dir");
}

/**
 * Symlinks each canonical Kanban skill into a project repo's .claude/skills so
 * agents running on that project's tasks can opt into them. Best-effort and
 * idempotent: never throws, never clobbers a real (non-symlink) skill folder.
 */
export async function ensureProjectSkillLinks(repoPath: string): Promise<void> {
	try {
		const skillsSrc = getKanbanSkillsSourceDir();
		if (!skillsSrc) {
			return;
		}
		const skillNames = await listSkillNames(skillsSrc);
		if (skillNames.length === 0) {
			return;
		}
		const destSkillsDir = join(repoPath, PROJECT_SKILLS_RELATIVE_DIR);
		await mkdir(destSkillsDir, { recursive: true });
		for (const skillName of skillNames) {
			try {
				await linkSkill(join(skillsSrc, skillName), join(destSkillsDir, skillName));
			} catch {
				// Best effort per skill.
			}
		}
	} catch {
		// Best effort: skill linking must never block project creation.
	}
}

/**
 * Links the canonical skills into every known project. Runs once at startup so
 * projects added before this feature also get the skills.
 */
export async function backfillProjectSkillLinks(): Promise<void> {
	try {
		if (!getKanbanSkillsSourceDir()) {
			return;
		}
		const entries = await listWorkspaceIndexEntries();
		await Promise.all(entries.map((entry) => ensureProjectSkillLinks(entry.repoPath)));
	} catch {
		// Best effort.
	}
}
