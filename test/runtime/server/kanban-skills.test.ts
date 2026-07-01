import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureProjectSkillLinks, getKanbanSkillsSourceDir } from "../../../src/server/kanban-skills";

describe("kanban skills linking", () => {
	let repoDir: string;

	beforeEach(async () => {
		repoDir = await mkdtemp(join(tmpdir(), "kanban-skill-test-"));
	});

	afterEach(async () => {
		await rm(repoDir, { recursive: true, force: true });
	});

	it("resolves the canonical skills source dir with skill manifests", () => {
		const skillsDir = getKanbanSkillsSourceDir();
		expect(skillsDir).not.toBeNull();
		expect(existsSync(join(skillsDir as string, "kanban-create-task", "SKILL.md"))).toBe(true);
		expect(existsSync(join(skillsDir as string, "kanban-link-tasks", "SKILL.md"))).toBe(true);
	});

	it("symlinks each skill into the project's .claude/skills (idempotent)", async () => {
		const skillsDir = getKanbanSkillsSourceDir() as string;

		await ensureProjectSkillLinks(repoDir);

		const dest = join(repoDir, ".claude", "skills", "kanban-create-task");
		const stat = await lstat(dest);
		expect(stat.isSymbolicLink()).toBe(true);
		expect(await readlink(dest)).toBe(join(skillsDir, "kanban-create-task"));

		// Running again is a no-op (no throw, still linked).
		await ensureProjectSkillLinks(repoDir);
		expect((await lstat(dest)).isSymbolicLink()).toBe(true);
	});

	it("does not clobber a real (non-symlink) skill folder", async () => {
		const destSkillsDir = join(repoDir, ".claude", "skills");
		const realSkill = join(destSkillsDir, "kanban-create-task");
		await mkdir(realSkill, { recursive: true });
		await writeFile(join(realSkill, "SKILL.md"), "custom");

		await ensureProjectSkillLinks(repoDir);

		// The user's real folder is preserved (not replaced by a symlink).
		expect((await lstat(realSkill)).isSymbolicLink()).toBe(false);
		// A different skill is still linked.
		expect((await lstat(join(destSkillsDir, "kanban-link-tasks"))).isSymbolicLink()).toBe(true);
	});
});
