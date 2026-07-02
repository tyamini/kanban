// Post-borrow provisioning: after Jenkins finishes borrowing a machine and
// before it is marked ready, connect over SSH and set it up — install Claude
// Code, replicate the local AI-helpers repo (with .git so `ai-pull` works),
// copy the local .bashrc + its dependency, and run `ai-pull`.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createSshConnection, type SshConnection } from "./ssh-connection-manager";

const execFileAsync = promisify(execFile);

// SSH details for a freshly-borrowed machine (see borrow-machine SKILL).
const BORROW_SSH_PORT = Number.parseInt(process.env.KANBAN_BORROW_SSH_PORT ?? "2222", 10) || 2222;
const BORROW_SSH_USER = process.env.KANBAN_BORROW_SSH_USER ?? "dn";
const BORROW_SSH_PASSWORD = process.env.KANBAN_BORROW_SSH_PASSWORD ?? "drivenets";
const DEFAULT_KEY_PATH = join(homedir(), ".ssh", "id_ed25519");

// Local artifacts to replicate on the borrowed machine (all under $HOME).
const AI_PRIVATE_REL = ".drivenets/cheetah/AI/v2/private";
const BASHRC_FILES = [".bashrc", "recovered_bashrc"];
// Directories the bashrc files depend on (e.g. the git-aware-prompt sourced via
// $GITAWAREPROMPT in recovered_bashrc).
const BASHRC_DIRS = [".bash"];
const CLAUDE_INSTALL_CMD = "bash -lc 'curl -fsSL https://claude.ai/install.sh | bash'";
const CONNECT_RETRIES = 5;
const CONNECT_RETRY_DELAY_MS = 5000;

export type SetupProgressReporter = (message: string) => void;

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

interface SshCandidate {
	label: string;
	port: number;
	authMethod: "password" | "agent" | "key";
	password?: string;
	privateKeyPath?: string;
}

function buildSshCandidates(): SshCandidate[] {
	// Borrowed machines are reachable from the hub without a password via the
	// hub's SSH key/agent on port 22, so prefer that. Fall back to the shared
	// password on 2222 for full-env borrows that expose SSH there.
	const candidates: SshCandidate[] = [];
	if (process.env.SSH_AUTH_SOCK) {
		candidates.push({ label: "port 22 (agent)", port: 22, authMethod: "agent" });
	}
	if (existsSync(DEFAULT_KEY_PATH)) {
		candidates.push({ label: "port 22 (key)", port: 22, authMethod: "key", privateKeyPath: DEFAULT_KEY_PATH });
	}
	candidates.push({
		label: `port ${BORROW_SSH_PORT} (password)`,
		port: BORROW_SSH_PORT,
		authMethod: "password",
		password: BORROW_SSH_PASSWORD,
	});
	return candidates;
}

async function connectWithRetries(machine: string, report: SetupProgressReporter): Promise<SshConnection> {
	const candidates = buildSshCandidates();
	let lastError: unknown;
	for (let attempt = 1; attempt <= CONNECT_RETRIES; attempt += 1) {
		for (const candidate of candidates) {
			const connection = createSshConnection({
				host: machine,
				port: candidate.port,
				username: BORROW_SSH_USER,
				authMethod: candidate.authMethod,
				password: candidate.password,
				privateKeyPath: candidate.privateKeyPath,
			});
			try {
				await connection.connect();
				report(`Connected over SSH (${candidate.label}).`);
				return connection;
			} catch (error) {
				lastError = error;
				connection.dispose();
			}
		}
		report(`SSH not ready yet (attempt ${attempt}/${CONNECT_RETRIES})...`);
		await delay(CONNECT_RETRY_DELAY_MS);
	}
	throw new Error(
		`Could not SSH into ${machine} as ${BORROW_SSH_USER} (tried ${candidates
			.map((c) => c.label)
			.join(", ")}): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
	);
}

async function resolveRemoteHome(connection: SshConnection): Promise<string> {
	const result = await connection.exec("bash -lc 'echo $HOME'");
	return result.stdout.trim() || `/home/${BORROW_SSH_USER}`;
}

/** Run one best-effort setup step, reporting success/failure without aborting the rest. */
async function runStep(report: SetupProgressReporter, label: string, step: () => Promise<void>): Promise<void> {
	report(`${label}...`);
	try {
		await step();
		report(`${label}: done.`);
	} catch (error) {
		report(`${label}: FAILED — ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function installClaude(connection: SshConnection, report: SetupProgressReporter): Promise<void> {
	await runStep(report, "Installing Claude Code", async () => {
		const result = await connection.exec(CLAUDE_INSTALL_CMD);
		if (result.code !== 0) {
			throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`);
		}
	});
}

async function replicatePrivateRepo(
	connection: SshConnection,
	remoteHome: string,
	report: SetupProgressReporter,
): Promise<void> {
	const localRepo = join(homedir(), AI_PRIVATE_REL);
	if (!existsSync(join(localRepo, ".git"))) {
		report(`Skipping AI-helpers repo: ${localRepo} is not a git repo on the hub.`);
		return;
	}
	await runStep(report, "Replicating AI-helpers repo", async () => {
		const tarball = join(tmpdir(), `ai-private-${process.pid}-${Date.now()}.tgz`);
		// Include .git so the remote copy has origin + history and `ai-pull` (git pull) works.
		await execFileAsync("tar", ["-czf", tarball, "-C", localRepo, "."]);
		try {
			const remoteRepo = `${remoteHome}/${AI_PRIVATE_REL}`;
			await connection.exec(`bash -lc 'mkdir -p "${remoteRepo}"'`);
			const remoteTarball = `${remoteRepo}/.kanban-transfer.tgz`;
			await connection.uploadFile(tarball, remoteTarball);
			const result = await connection.exec(
				`bash -lc 'cd "${remoteRepo}" && tar -xzf .kanban-transfer.tgz && rm -f .kanban-transfer.tgz'`,
			);
			if (result.code !== 0) {
				throw new Error(result.stderr.trim() || `extract failed (exit ${result.code})`);
			}
		} finally {
			await rm(tarball, { force: true });
		}
	});
}

async function copyBashrc(connection: SshConnection, remoteHome: string, report: SetupProgressReporter): Promise<void> {
	for (const file of BASHRC_FILES) {
		const localPath = join(homedir(), file);
		if (!existsSync(localPath)) {
			continue;
		}
		await runStep(report, `Copying ~/${file}`, async () => {
			await connection.uploadFile(localPath, `${remoteHome}/${file}`);
		});
	}
	for (const dir of BASHRC_DIRS) {
		await copyLocalDir(connection, remoteHome, dir, report);
	}
}

/** Replicate a local $HOME-relative directory to the same path on the remote. */
async function copyLocalDir(
	connection: SshConnection,
	remoteHome: string,
	rel: string,
	report: SetupProgressReporter,
): Promise<void> {
	const localDir = join(homedir(), rel);
	if (!existsSync(localDir)) {
		return;
	}
	await runStep(report, `Copying ~/${rel}`, async () => {
		const tarball = join(tmpdir(), `dir-${process.pid}-${Date.now()}.tgz`);
		// Archive relative to $HOME so the entry path is `<rel>/...`.
		await execFileAsync("tar", ["-czf", tarball, "-C", homedir(), rel]);
		try {
			await connection.exec(`bash -lc 'mkdir -p "${remoteHome}"'`);
			const remoteTarball = `${remoteHome}/.kanban-dir-transfer.tgz`;
			await connection.uploadFile(tarball, remoteTarball);
			const result = await connection.exec(
				`bash -lc 'cd "${remoteHome}" && tar -xzf .kanban-dir-transfer.tgz && rm -f .kanban-dir-transfer.tgz'`,
			);
			if (result.code !== 0) {
				throw new Error(result.stderr.trim() || `extract failed (exit ${result.code})`);
			}
		} finally {
			await rm(tarball, { force: true });
		}
	});
}

async function ensureClaudeOnPath(
	connection: SshConnection,
	remoteHome: string,
	report: SetupProgressReporter,
): Promise<void> {
	// The installer drops claude in ~/.local/bin, but we overwrite ~/.bashrc with
	// the hub's copy afterwards (which only adds ~/.npm-global/bin). Append a
	// guarded PATH line so `claude` is on PATH for interactive shells.
	await runStep(report, "Adding ~/.local/bin to PATH", async () => {
		const marker = "kanban-borrow: claude PATH";
		const result = await connection.exec(
			`bash -lc 'grep -q "${marker}" "${remoteHome}/.bashrc" 2>/dev/null || ` +
				`printf "\\n# ${marker}\\nexport PATH=\\"\\$HOME/.local/bin:\\$PATH\\"\\n" >> "${remoteHome}/.bashrc"'`,
		);
		if (result.code !== 0) {
			throw new Error(result.stderr.trim() || `exit ${result.code}`);
		}
	});
}

async function runAiPull(connection: SshConnection, report: SetupProgressReporter): Promise<void> {
	await runStep(report, "Running ai-pull", async () => {
		// `.bashrc` early-returns for non-interactive shells (so `ai-pull` isn't
		// defined under `bash -lc`); source the helpers script directly instead.
		// It self-defaults _AI_PRIVATE_REPO / _AI_APPLY_SCRIPT.
		const result = await connection.exec(
			`bash -lc 'source "$HOME/${AI_PRIVATE_REL}/scripts/ai-helpers.sh" && ai-pull'`,
		);
		const tail = (result.stdout || result.stderr).trim().split("\n").slice(-5).join("\n");
		if (tail) {
			report(tail);
		}
		if (result.code !== 0) {
			throw new Error(result.stderr.trim().split("\n").slice(-3).join("\n") || `exit ${result.code}`);
		}
	});
}

/**
 * Provision a freshly-borrowed machine. Steps are best-effort and reported to
 * the borrow job log; only a total SSH-connect failure aborts provisioning.
 */
export async function provisionBorrowedMachine(machine: string, report: SetupProgressReporter): Promise<void> {
	report(`Connecting to ${machine} to run setup...`);
	const connection = await connectWithRetries(machine, report);
	try {
		const remoteHome = await resolveRemoteHome(connection);
		await installClaude(connection, report);
		await replicatePrivateRepo(connection, remoteHome, report);
		await copyBashrc(connection, remoteHome, report);
		await ensureClaudeOnPath(connection, remoteHome, report);
		await runAiPull(connection, report);
		report("Setup complete.");
	} finally {
		connection.dispose();
	}
}
