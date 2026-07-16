// Post-borrow provisioning: after Jenkins finishes borrowing a machine and
// before it is marked ready, connect over SSH and set it up — install Claude
// Code, replicate the local AI-helpers repo (with .git so `ai-pull` works),
// copy the local .bashrc + its dependency, install the GitHub CLI, mirror the
// local `gh` + Claude logins so both are authenticated on the machine, and run
// `ai-pull`.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createSshConnection, type SshConnection } from "./ssh-connection-manager";

const execFileAsync = promisify(execFile);

// SSH details for a freshly-borrowed machine (see borrow-machine SKILL).
const DEFAULT_KEY_PATH = join(homedir(), ".ssh", "id_ed25519");

/** Per-pool SSH settings for reaching a freshly-borrowed machine. */
export interface BorrowSshConfig {
	username: string;
	password: string;
	/** Port to try password auth on (office: 2222; AWS: 22). */
	passwordPort: number;
	/** Try the hub's SSH agent/key on port 22 first before falling back to the password. */
	tryHubKey: boolean;
}

// Local artifacts to replicate on the borrowed machine (all under $HOME).
const AI_PRIVATE_REL = ".drivenets/cheetah/AI/v2/private";
// The cheetah dev-context profile to establish on a freshly-borrowed machine.
// `set-context.sh <profile>` links the profile's skills AND every private skill
// (e.g. pr-watchdog) into ~/cheetah/.claude/skills, and writes the state files
// (active_profile.txt / managed_files.txt) that `ai-pull` later re-applies.
// Without an initial profile there is nothing for `ai-pull` to re-apply, so the
// private skills never get linked on the machine. Overridable per borrow.
const DEV_CONTEXT_PROFILE = process.env.KANBAN_BORROW_DEV_PROFILE?.trim() || "routing";
// The cheetah checkout (provisioned by the borrow pipeline) that owns the
// set-context tooling and profile definitions.
const SET_CONTEXT_SCRIPT_REL = "cheetah/.ai/skills/common/set-dev-context/scripts/set-context.sh";
const BASHRC_FILES = [".bashrc", "recovered_bashrc"];
// Directories the bashrc files depend on (e.g. the git-aware-prompt sourced via
// $GITAWAREPROMPT in recovered_bashrc).
const BASHRC_DIRS = [".bash"];
const CLAUDE_INSTALL_CMD = "bash -lc 'curl -fsSL https://claude.ai/install.sh | bash'";
const CONNECT_RETRIES = 5;
const CONNECT_RETRY_DELAY_MS = 5000;

// Local logins mirrored onto the borrowed machine so `gh` and Claude Code are
// authenticated there. These are portable bearer credentials (OAuth tokens with
// refresh), so copying the files is enough — no interactive re-login needed.
const GH_CONFIG_DIR_REL = ".config/gh";
const GH_CONFIG_FILES = ["hosts.yml", "config.yml"];
const CLAUDE_CREDENTIALS_REL = ".claude/.credentials.json";
const CLAUDE_CONFIG_REL = ".claude.json";
// The org's server-pushed managed settings (telemetry env). Claude Code writes
// this file locally only after the user approves the one-time "managed settings
// require approval" prompt, and skips that prompt on later runs when the on-disk
// copy matches what the server pushes. Mirroring the hub's already-approved copy
// pre-seeds that approval so borrowed machines run unsupervised without the
// interactive trust prompt blocking the very first agent session.
const CLAUDE_REMOTE_SETTINGS_REL = ".claude/remote-settings.json";

// Auth/onboarding fields lifted from the hub's ~/.claude.json so Claude Code on
// the borrowed machine skips the login + onboarding flow. We deliberately do
// NOT copy the whole file: it also holds hub-specific `projects`, MCP wiring and
// large caches keyed to the hub's paths, which are noise (or actively harmful)
// on the remote. Just these fields + the copied `.credentials.json` token are
// enough for Claude to consider itself logged in.
const CLAUDE_CONFIG_KEEP_KEYS = [
	"hasCompletedOnboarding",
	"lastOnboardingVersion",
	"userID",
	"oauthAccount",
	"firstStartTime",
	"subscriptionNoticeCount",
	"hasAvailableSubscription",
	"isQualifiedForDataSharing",
	"hasOpusPlanDefault",
	"claudeCodeFirstTokenDate",
] as const;

// Pinned GitHub CLI version to install on borrowed machines. We install a fixed
// version instead of querying `api.github.com/.../releases/latest` because some
// borrow networks (notably the AWS pool) return HTTP 403 for the GitHub API even
// though the release-asset download host is reachable. Overridable for bumps.
const GH_VERSION = process.env.KANBAN_BORROW_GH_VERSION?.trim() || "2.62.0";

// Installs the GitHub CLI into ~/.local/bin (no root) if it isn't already on the
// machine. Uploaded as a script and run with `bash` to avoid nested-quote hell.
const GH_INSTALL_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
if command -v gh >/dev/null 2>&1; then
  echo "gh already installed: $(command -v gh)"
  exit 0
fi
# Version is pinned by the hub (GH_VERSION) rather than discovered from the
# GitHub API, which is blocked (HTTP 403) on some borrow networks.
ver="\${GH_VERSION:-2.62.0}"
mkdir -p "$HOME/.local/bin"
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) arch=amd64 ;;
esac
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://github.com/cli/cli/releases/download/v\${ver}/gh_\${ver}_linux_\${arch}.tar.gz" -o "$tmp/gh.tgz"
tar -xzf "$tmp/gh.tgz" -C "$tmp"
install -m 0755 "$tmp/gh_\${ver}_linux_\${arch}/bin/gh" "$HOME/.local/bin/gh"
echo "installed gh \${ver} to $HOME/.local/bin/gh"
`;

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

function buildSshCandidates(ssh: BorrowSshConfig): SshCandidate[] {
	// Office borrows are reachable from the hub without a password via the hub's
	// SSH key/agent on port 22, so prefer that when enabled. AWS instances need
	// the shared password (on port 22). Always end with the password fallback.
	const candidates: SshCandidate[] = [];
	if (ssh.tryHubKey) {
		if (process.env.SSH_AUTH_SOCK) {
			candidates.push({ label: "port 22 (agent)", port: 22, authMethod: "agent" });
		}
		if (existsSync(DEFAULT_KEY_PATH)) {
			candidates.push({ label: "port 22 (key)", port: 22, authMethod: "key", privateKeyPath: DEFAULT_KEY_PATH });
		}
	}
	candidates.push({
		label: `port ${ssh.passwordPort} (password)`,
		port: ssh.passwordPort,
		authMethod: "password",
		password: ssh.password,
	});
	return candidates;
}

async function connectWithRetries(
	machine: string,
	ssh: BorrowSshConfig,
	report: SetupProgressReporter,
): Promise<SshConnection> {
	const candidates = buildSshCandidates(ssh);
	let lastError: unknown;
	for (let attempt = 1; attempt <= CONNECT_RETRIES; attempt += 1) {
		for (const candidate of candidates) {
			const connection = createSshConnection({
				host: machine,
				port: candidate.port,
				username: ssh.username,
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
		`Could not SSH into ${machine} as ${ssh.username} (tried ${candidates
			.map((c) => c.label)
			.join(", ")}): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
	);
}

async function resolveRemoteHome(connection: SshConnection, username: string): Promise<string> {
	const result = await connection.exec("bash -lc 'echo $HOME'");
	return result.stdout.trim() || `/home/${username}`;
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
 * Establish the cheetah dev context so the profile's skills and all private
 * skills (pr-watchdog etc.) are linked into ~/cheetah/.claude/skills. This also
 * seeds ~/.drivenets/cheetah/AI/v2/state/active_profile.txt, which `ai-pull`
 * needs before it will re-apply the context on later pulls. Best-effort: skipped
 * cleanly if the cheetah checkout / set-context tooling isn't present.
 */
async function setDevContext(
	connection: SshConnection,
	remoteHome: string,
	report: SetupProgressReporter,
): Promise<void> {
	await runStep(report, `Setting cheetah dev context (${DEV_CONTEXT_PROFILE})`, async () => {
		const script = `${remoteHome}/${SET_CONTEXT_SCRIPT_REL}`;
		const check = await connection.exec(`bash -lc 'test -f "${script}" && echo yes || true'`);
		if (check.stdout.trim() !== "yes") {
			throw new Error(`set-context.sh not found at ${script} (cheetah checkout missing?)`);
		}
		const result = await connection.exec(`bash -lc '"${script}" ${DEV_CONTEXT_PROFILE}'`);
		const tail = (result.stdout || result.stderr).trim().split("\n").slice(-3).join("\n");
		if (tail) {
			report(tail);
		}
		if (result.code !== 0) {
			throw new Error(result.stderr.trim().split("\n").slice(-3).join("\n") || `exit ${result.code}`);
		}
	});
}

async function installGh(connection: SshConnection, remoteHome: string, report: SetupProgressReporter): Promise<void> {
	await runStep(report, "Installing GitHub CLI", async () => {
		const scriptPath = join(tmpdir(), `gh-install-${process.pid}-${Date.now()}.sh`);
		await writeFile(scriptPath, GH_INSTALL_SCRIPT, { mode: 0o700 });
		try {
			const remoteScript = `${remoteHome}/.kanban-install-gh.sh`;
			await connection.uploadFile(scriptPath, remoteScript);
			const result = await connection.exec(`GH_VERSION=${GH_VERSION} bash "${remoteScript}"`);
			// Clean up the uploaded script separately so the script's own exit code survives.
			await connection.exec(`rm -f "${remoteScript}"`);
			const tail = (result.stdout || result.stderr).trim().split("\n").slice(-3).join("\n");
			if (tail) {
				report(tail);
			}
			if (result.code !== 0) {
				throw new Error(result.stderr.trim().split("\n").slice(-3).join("\n") || `exit ${result.code}`);
			}
		} finally {
			await rm(scriptPath, { force: true });
		}
	});
}

/** Create a remote directory (best-effort mkdir -p) with private (700) permissions. */
async function ensureRemoteDir(connection: SshConnection, remoteDir: string): Promise<void> {
	const result = await connection.exec(`bash -lc 'mkdir -p "${remoteDir}" && chmod 700 "${remoteDir}"'`);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || `could not create ${remoteDir} (exit ${result.code})`);
	}
}

// Mirror the hub's `gh` and Claude logins so both are authenticated on the
// borrowed machine. The credential files are copied with tight (600) perms.
async function copyAuthCredentials(
	connection: SshConnection,
	remoteHome: string,
	report: SetupProgressReporter,
): Promise<void> {
	await runStep(report, "Authenticating gh from hub login", async () => {
		const localGhDir = join(homedir(), GH_CONFIG_DIR_REL);
		const present = GH_CONFIG_FILES.filter((file) => existsSync(join(localGhDir, file)));
		if (!present.includes("hosts.yml")) {
			throw new Error("no local gh login found; run `gh auth login` on the hub");
		}
		const remoteGhDir = `${remoteHome}/${GH_CONFIG_DIR_REL}`;
		await ensureRemoteDir(connection, remoteGhDir);
		for (const file of present) {
			const remoteFile = `${remoteGhDir}/${file}`;
			await connection.uploadFile(join(localGhDir, file), remoteFile);
			await connection.exec(`bash -lc 'chmod 600 "${remoteFile}"'`);
		}
	});

	await runStep(report, "Authenticating Claude from hub login", async () => {
		const localCreds = join(homedir(), CLAUDE_CREDENTIALS_REL);
		if (!existsSync(localCreds)) {
			throw new Error("no local ~/.claude/.credentials.json; run `claude` and log in on the hub");
		}
		const remoteClaudeDir = `${remoteHome}/.claude`;
		await ensureRemoteDir(connection, remoteClaudeDir);
		const remoteCreds = `${remoteHome}/${CLAUDE_CREDENTIALS_REL}`;
		await connection.uploadFile(localCreds, remoteCreds);
		await connection.exec(`bash -lc 'chmod 600 "${remoteCreds}"'`);

		// The token alone isn't enough: without the onboarding/account state in
		// ~/.claude.json, Claude Code re-runs the login/onboarding flow. Mirror a
		// sanitized copy so it starts up already logged in.
		const claudeConfig = await buildSanitizedClaudeConfig();
		if (!claudeConfig) {
			return;
		}
		const configPath = join(tmpdir(), `claude-config-${process.pid}-${Date.now()}.json`);
		await writeFile(configPath, claudeConfig, { mode: 0o600 });
		try {
			const remoteConfig = `${remoteHome}/${CLAUDE_CONFIG_REL}`;
			await connection.uploadFile(configPath, remoteConfig);
			await connection.exec(`bash -lc 'chmod 600 "${remoteConfig}"'`);
		} finally {
			await rm(configPath, { force: true });
		}

		// Pre-approve the org's managed telemetry settings so the one-time
		// "managed settings require approval" prompt never blocks an unsupervised
		// session. The remote and hub fetch identical settings from the same
		// server, so the hub's approved copy matches and suppresses the prompt.
		const localRemoteSettings = join(homedir(), CLAUDE_REMOTE_SETTINGS_REL);
		if (existsSync(localRemoteSettings)) {
			const remoteRemoteSettings = `${remoteHome}/${CLAUDE_REMOTE_SETTINGS_REL}`;
			await connection.uploadFile(localRemoteSettings, remoteRemoteSettings);
			await connection.exec(`bash -lc 'chmod 600 "${remoteRemoteSettings}"'`);
		}
	});
}

/**
 * Read the hub's ~/.claude.json and keep only the auth/onboarding fields
 * (see CLAUDE_CONFIG_KEEP_KEYS). Returns a JSON string, or null when the hub has
 * no config or it can't be parsed.
 */
async function buildSanitizedClaudeConfig(): Promise<string | null> {
	const localConfig = join(homedir(), CLAUDE_CONFIG_REL);
	if (!existsSync(localConfig)) {
		return null;
	}
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(await readFile(localConfig, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
	const sanitized: Record<string, unknown> = {};
	for (const key of CLAUDE_CONFIG_KEEP_KEYS) {
		if (parsed[key] !== undefined) {
			sanitized[key] = parsed[key];
		}
	}
	if (sanitized.hasCompletedOnboarding === undefined && sanitized.oauthAccount === undefined) {
		return null;
	}
	// Pre-accept the one-time Bypass Permissions disclaimer. Kanban launches the
	// agent with --dangerously-skip-permissions, and on a fresh machine Claude
	// otherwise blocks on a "Yes, I accept" prompt before the first session. This
	// flag is exactly what accepting that dialog persists. (The complementary
	// folder-trust prompt is suppressed via CLAUDE_CODE_SANDBOXED in the remote
	// runtime env — see remote-runtime-bootstrap.ts.)
	sanitized.bypassPermissionsModeAccepted = true;
	return JSON.stringify(sanitized, null, 2);
}

/**
 * Provision a freshly-borrowed machine. Steps are best-effort and reported to
 * the borrow job log; only a total SSH-connect failure aborts provisioning.
 */
export async function provisionBorrowedMachine(
	machine: string,
	report: SetupProgressReporter,
	ssh: BorrowSshConfig,
): Promise<void> {
	report(`Connecting to ${machine} to run setup...`);
	const connection = await connectWithRetries(machine, ssh, report);
	try {
		const remoteHome = await resolveRemoteHome(connection, ssh.username);
		await installClaude(connection, report);
		await replicatePrivateRepo(connection, remoteHome, report);
		await copyBashrc(connection, remoteHome, report);
		await ensureClaudeOnPath(connection, remoteHome, report);
		await installGh(connection, remoteHome, report);
		await copyAuthCredentials(connection, remoteHome, report);
		await setDevContext(connection, remoteHome, report);
		await runAiPull(connection, report);
		report("Setup complete.");
	} finally {
		connection.dispose();
	}
}
