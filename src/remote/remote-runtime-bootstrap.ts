// Detects and (re)launches a Kanban runtime on a remote host over SSH.
//
// Federation reuses a full Kanban runtime on the remote machine, so bootstrap's
// job is only to make sure such a runtime is running, bound to loopback, and
// reachable through the SSH tunnel. When no install is present it can perform a
// guided clone + build (native modules like node-pty must be built on the
// remote for the remote architecture, so we never copy the hub's build).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { SshConnection } from "./ssh-connection-manager";

const execFileAsync = promisify(execFile);

// Minimum Node the remote runtime is built against. This is a full semver, not
// just a major, because Kanban's build toolchain (rolldown / vite / vitest) has
// an engine floor of `^20.19.0 || >=22.12.0`. A bare major check (>=22) wrongly
// accepts versions like v22.11.0 that sit in the unsupported gap and fail the
// remote `npm install`/build with EBADENGINE.
const MIN_NODE_VERSION = { major: 22, minor: 12, patch: 0 } as const;
const MIN_NODE_VERSION_LABEL = `${MIN_NODE_VERSION.major}.${MIN_NODE_VERSION.minor}.${MIN_NODE_VERSION.patch}`;
const REMOTE_PORT_RANGE_START = 3500;
const REMOTE_PORT_RANGE_SIZE = 1000;
const DEFAULT_REMOTE_INSTALL_DIR = "~/.cline/kanban-remote";
const REMOTE_RUNTIME_LOG = "$HOME/.cline/kanban-remote-runtime.log";
const REMOTE_RUNTIME_PID_FILE = "$HOME/.cline/kanban-remote-runtime.pid";
const REMOTE_INSTALL_REPO_ENV = "KANBAN_REMOTE_INSTALL_REPO";
// Node.js version installed into the user's home when the remote has no
// suitable Node. Kept as a pinned LTS so downloads are reproducible; installing
// into $HOME avoids needing sudo/root on the remote host.
const MANAGED_NODE_VERSION = "v22.23.1";
const MANAGED_NODE_DIR = "$HOME/.cline/kanban-node";
// Records the content hash of the source last shipped + built on the remote, so
// the hub re-ships and rebuilds whenever its own source changes.
const REMOTE_BUILD_STAMP_FILE = ".kanban-hub-build";

// Probe-class commands (version checks, stamp reads, log tails, spawning the
// detached daemon) must finish quickly; a hang here means the remote is wedged,
// so we bound them and surface an error instead of blocking the connect flow
// forever on a half-open channel.
const REMOTE_PROBE_TIMEOUT_MS = 20_000;
const REMOTE_LAUNCH_TIMEOUT_MS = 60_000;
// Long operations (Node download/extract, `npm install` + build) are expected
// to take minutes on a fresh remote. We still apply a *generous* ceiling — far
// longer than any real build here — purely to kill the infinite-hang failure
// mode (thrashing/OOM box, dead channel). Overridable for slow hosts.
const DEFAULT_REMOTE_BUILD_TIMEOUT_MS = 30 * 60_000;
const REMOTE_BUILD_TIMEOUT_ENV = "KANBAN_REMOTE_BUILD_TIMEOUT_MS";

function getRemoteBuildTimeoutMs(): number {
	const raw = process.env[REMOTE_BUILD_TIMEOUT_ENV]?.trim();
	if (raw) {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed;
		}
	}
	return DEFAULT_REMOTE_BUILD_TIMEOUT_MS;
}

export interface RemoteEnvironmentReport {
	nodeVersion: string | null;
	nodeSatisfiesMinimum: boolean;
	kanbanRuntimeAvailable: boolean;
	resolvedInstallDir: string | null;
	globalKanbanBinary: string | null;
}

export interface EnsureRemoteRuntimeResult {
	remotePort: number;
	installDir: string | null;
	globalKanbanBinary: string | null;
	launched: boolean;
}

/** Reads the tail of the remote runtime log so failures can be surfaced to the user. */
export async function readRemoteRuntimeLogTail(connection: SshConnection, lines = 40): Promise<string> {
	try {
		const result = await connection.exec(`bash -lc 'tail -n ${lines} "${REMOTE_RUNTIME_LOG}" 2>/dev/null || true'`, {
			timeoutMs: REMOTE_PROBE_TIMEOUT_MS,
		});
		return result.stdout.trim();
	} catch {
		return "";
	}
}

export type BootstrapProgressReporter = (message: string) => void;

/** Deterministic loopback port per machine so reconnects reuse the same runtime. */
export function getStableRemoteRuntimePort(machineId: string): number {
	const hash = createHash("sha256").update(machineId).digest();
	const offset = hash.readUInt16BE(0) % REMOTE_PORT_RANGE_SIZE;
	return REMOTE_PORT_RANGE_START + offset;
}

function parseNodeVersion(versionOutput: string): { major: number; minor: number; patch: number } | null {
	const match = versionOutput.trim().match(/v?(\d+)\.(\d+)\.(\d+)/);
	if (!match) {
		return null;
	}
	const major = Number.parseInt(match[1] ?? "", 10);
	const minor = Number.parseInt(match[2] ?? "", 10);
	const patch = Number.parseInt(match[3] ?? "", 10);
	if (![major, minor, patch].every(Number.isFinite)) {
		return null;
	}
	return { major, minor, patch };
}

/** True when `node --version` output is >= MIN_NODE_VERSION (full semver compare). */
function nodeSatisfiesMinimumVersion(versionOutput: string | null): boolean {
	if (!versionOutput) {
		return false;
	}
	const version = parseNodeVersion(versionOutput);
	if (!version) {
		return false;
	}
	if (version.major !== MIN_NODE_VERSION.major) {
		return version.major > MIN_NODE_VERSION.major;
	}
	if (version.minor !== MIN_NODE_VERSION.minor) {
		return version.minor > MIN_NODE_VERSION.minor;
	}
	return version.patch >= MIN_NODE_VERSION.patch;
}

async function firstNonEmptyLine(connection: SshConnection, command: string): Promise<string | null> {
	const result = await connection.exec(command, { timeoutMs: REMOTE_PROBE_TIMEOUT_MS });
	const value = result.stdout.trim();
	return value.length > 0 ? value : null;
}

export async function detectRemoteEnvironment(
	connection: SshConnection,
	options: { remoteInstallDir?: string | null } = {},
): Promise<RemoteEnvironmentReport> {
	const nodeVersion = await firstNonEmptyLine(connection, "node --version 2>/dev/null || true");
	const nodeSatisfiesMinimum = nodeSatisfiesMinimumVersion(nodeVersion);

	const globalKanbanBinary = await firstNonEmptyLine(connection, "command -v kanban 2>/dev/null || true");

	const installDir = options.remoteInstallDir ?? DEFAULT_REMOTE_INSTALL_DIR;
	const installedProbe = await connection.exec(`test -f ${installDir}/dist/cli.js && echo yes || true`, {
		timeoutMs: REMOTE_PROBE_TIMEOUT_MS,
	});
	const hasLocalInstall = installedProbe.stdout.trim() === "yes";

	return {
		nodeVersion,
		nodeSatisfiesMinimum,
		kanbanRuntimeAvailable: Boolean(globalKanbanBinary) || hasLocalInstall,
		resolvedInstallDir: hasLocalInstall ? installDir : null,
		globalKanbanBinary,
	};
}

/**
 * Ensures the remote host has a usable Node.js >= MIN_NODE_VERSION and returns a
 * shell `export PATH=...;` prefix that makes that Node the default `node`/`npm`
 * for subsequent commands. If the system Node is too old or missing, a pinned
 * Node is downloaded into `$HOME/.cline/kanban-node` (no sudo required).
 */
async function ensureRemoteNode(
	connection: SshConnection,
	reportProgress: BootstrapProgressReporter,
): Promise<{ pathPrefix: string }> {
	const systemVersion = await firstNonEmptyLine(connection, "bash -lc 'node --version 2>/dev/null || true'");
	if (nodeSatisfiesMinimumVersion(systemVersion)) {
		return { pathPrefix: "" };
	}

	const managedPathPrefix = `export PATH="${MANAGED_NODE_DIR}/bin:$PATH"; `;
	const managed = await connection.exec(`bash -lc '"${MANAGED_NODE_DIR}/bin/node" --version 2>/dev/null || true'`, {
		timeoutMs: REMOTE_PROBE_TIMEOUT_MS,
	});
	if (nodeSatisfiesMinimumVersion(managed.stdout)) {
		return { pathPrefix: managedPathPrefix };
	}

	reportProgress(`Installing Node.js ${MANAGED_NODE_VERSION} on the remote host...`);
	const osRaw = (await connection.exec("uname -s", { timeoutMs: REMOTE_PROBE_TIMEOUT_MS })).stdout
		.trim()
		.toLowerCase();
	const archRaw = (await connection.exec("uname -m", { timeoutMs: REMOTE_PROBE_TIMEOUT_MS })).stdout
		.trim()
		.toLowerCase();
	const os = osRaw.includes("darwin") ? "darwin" : "linux";
	const arch =
		archRaw === "x86_64" || archRaw === "amd64"
			? "x64"
			: archRaw === "aarch64" || archRaw === "arm64"
				? "arm64"
				: archRaw === "armv7l" || archRaw === "armv6l"
					? "armv7l"
					: null;
	if (!arch) {
		throw new Error(`Cannot auto-install Node.js: unsupported remote architecture "${archRaw}".`);
	}
	const tarball = `node-${MANAGED_NODE_VERSION}-${os}-${arch}.tar.gz`;
	const url = `https://nodejs.org/dist/${MANAGED_NODE_VERSION}/${tarball}`;
	const install = await connection.exec(
		`bash -lc 'set -e; DIR="${MANAGED_NODE_DIR}"; rm -rf "$DIR"; mkdir -p "$DIR"; cd "$DIR"; ` +
			`if command -v curl >/dev/null 2>&1; then curl -fsSL "${url}" -o node.tar.gz; ` +
			`elif command -v wget >/dev/null 2>&1; then wget -qO node.tar.gz "${url}"; ` +
			`else echo "NO_DOWNLOADER" >&2; exit 3; fi; ` +
			`tar -xzf node.tar.gz --strip-components=1; rm -f node.tar.gz; "$DIR/bin/node" --version'`,
		{ timeoutMs: getRemoteBuildTimeoutMs() },
	);
	if (install.code !== 0) {
		if (install.stderr.includes("NO_DOWNLOADER")) {
			throw new Error("Cannot auto-install Node.js: neither curl nor wget is available on the remote host.");
		}
		throw new Error(`Failed to auto-install Node.js on the remote host: ${install.stderr || install.stdout}`);
	}
	if (!nodeSatisfiesMinimumVersion(install.stdout)) {
		throw new Error(
			`Node.js auto-install on the remote host did not report a supported version (needs >= ${MIN_NODE_VERSION_LABEL}).`,
		);
	}
	return { pathPrefix: managedPathPrefix };
}

function buildLaunchCommand(input: {
	remotePort: number;
	installDir: string | null;
	globalKanbanBinary: string | null;
	pathPrefix: string;
	forceRestart: boolean;
}): string {
	const runtimeBinary = input.installDir ? "node dist/cli.js" : `${input.globalKanbanBinary ?? "kanban"}`;
	const runtimeArgs = `--host 127.0.0.1 --port ${input.remotePort} --no-passcode --no-open`;
	// KANBAN_TRUST_TUNNEL relaxes host/CORS checks so the hub can reach this
	// loopback runtime through an SSH tunnel whose local port differs from the
	// runtime's own port. setsid + detached stdin fully detaches the daemon from
	// the SSH exec channel so it is not killed with SIGHUP when the channel closes.
	const runtimeEnv = "KANBAN_RUNTIME_HOST=127.0.0.1 KANBAN_TRUST_TUNNEL=1";
	// A dedicated PID file lets us restart precisely the previous instance without
	// a `pkill -f` pattern that would also match (and kill) this launcher and the
	// freshly-spawned daemon.
	const launchLines = [
		`${input.pathPrefix.trim()}`,
		// User-installed agent CLIs (claude, etc.) live in these dirs, which are
		// not on a non-interactive login PATH. Add them so the runtime's agent
		// discovery finds them and PTY-spawned agents can run.
		`export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"`,
		`PIDFILE="${REMOTE_RUNTIME_PID_FILE}"`,
		input.forceRestart
			? `[ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; command -v fuser >/dev/null 2>&1 && fuser -k ${input.remotePort}/tcp 2>/dev/null; sleep 2`
			: `if (exec 3<>/dev/tcp/127.0.0.1/${input.remotePort}) 2>/dev/null; then echo RUNNING; exit 0; fi`,
		input.installDir ? `cd ${input.installDir}` : ":",
		`if command -v setsid >/dev/null 2>&1; then ${runtimeEnv} setsid nohup ${runtimeBinary} ${runtimeArgs} < /dev/null >> ${REMOTE_RUNTIME_LOG} 2>&1 & else ${runtimeEnv} nohup ${runtimeBinary} ${runtimeArgs} < /dev/null >> ${REMOTE_RUNTIME_LOG} 2>&1 & fi`,
		`echo $! > "$PIDFILE"`,
		`echo LAUNCHED`,
	];
	return `bash -lc '${launchLines.join("\n")}'`;
}

/**
 * Locate the hub's own Kanban source tree so we can ship it to the remote and
 * build it there (VS Code Server style). Works both when running the bundled
 * `dist/cli.js` and under tsx during development.
 */
function findHubSourceRoot(): string | null {
	let current = dirname(fileURLToPath(import.meta.url));
	for (let depth = 0; depth < 6; depth += 1) {
		const packageJsonPath = join(current, "package.json");
		if (existsSync(packageJsonPath) && existsSync(join(current, "scripts", "build.mjs"))) {
			try {
				const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string };
				if (parsed.name === "kanban") {
					return current;
				}
			} catch {
				// Keep walking up on malformed package.json.
			}
		}
		const parent = dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	return null;
}

async function createHubSourceTarball(sourceRoot: string): Promise<string> {
	const tarballPath = join(tmpdir(), `kanban-src-${process.pid}-${Date.now()}.tar.gz`);
	await execFileAsync("tar", [
		"-czf",
		tarballPath,
		"-C",
		sourceRoot,
		"--exclude=./node_modules",
		"--exclude=./.git",
		"--exclude=./dist",
		"--exclude=./coverage",
		"--exclude=./web-ui/node_modules",
		"--exclude=./web-ui/dist",
		"--exclude=./packages/desktop/node_modules",
		".",
	]);
	return tarballPath;
}

function hashFile(path: string): Promise<string> {
	return new Promise((resolveHash, rejectHash) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", () => resolveHash(hash.digest("hex").slice(0, 32)));
		stream.on("error", rejectHash);
	});
}

async function readRemoteBuildStamp(connection: SshConnection, installDir: string): Promise<string | null> {
	const result = await connection.exec(
		`bash -lc 'cat "${installDir}/${REMOTE_BUILD_STAMP_FILE}" 2>/dev/null || true'`,
		{ timeoutMs: REMOTE_PROBE_TIMEOUT_MS },
	);
	const value = result.stdout.trim();
	return value.length > 0 ? value : null;
}

async function resolveRemoteAbsoluteDir(connection: SshConnection, dir: string): Promise<string> {
	if (!dir.startsWith("~")) {
		return dir;
	}
	const home = (await connection.exec("bash -lc 'echo $HOME'", { timeoutMs: REMOTE_PROBE_TIMEOUT_MS })).stdout.trim();
	return dir.replace(/^~/, home || "");
}

/**
 * Ships the hub's own source to the remote over SFTP, then installs + builds it
 * there. Native modules (node-pty) build for the remote architecture. Requires a
 * C/C++ build toolchain on the remote for node-pty; that failure is surfaced.
 */
async function transferAndBuildHubSource(
	connection: SshConnection,
	installDir: string,
	pathPrefix: string,
	tarballPath: string,
	buildId: string,
	reportProgress: BootstrapProgressReporter,
): Promise<void> {
	const absoluteInstallDir = await resolveRemoteAbsoluteDir(connection, installDir);
	await connection.exec(`bash -lc 'mkdir -p "${absoluteInstallDir}"'`, { timeoutMs: REMOTE_PROBE_TIMEOUT_MS });
	reportProgress("Uploading Kanban to the remote host...");
	const remoteTarball = `${absoluteInstallDir}/kanban-src.tar.gz`;
	await connection.uploadFile(tarballPath, remoteTarball);
	reportProgress("Installing dependencies and building on the remote host (this can take several minutes)...");
	// `npm install` (not `ci`) reuses existing node_modules so rebuilds after a
	// code-only change are fast and do not recompile native modules (node-pty).
	const build = await connection.exec(
		`bash -lc '${pathPrefix}set -e; cd "${absoluteInstallDir}"; ` +
			`tar -xzf kanban-src.tar.gz; rm -f kanban-src.tar.gz; ` +
			`npm install --no-audit --no-fund; (cd web-ui && npm install --no-audit --no-fund); npm run build; ` +
			`printf "%s" "${buildId}" > "${REMOTE_BUILD_STAMP_FILE}"'`,
		{ timeoutMs: getRemoteBuildTimeoutMs() },
	);
	if (build.code !== 0) {
		throw new Error(`Failed to build Kanban on the remote host: ${build.stderr || build.stdout}`);
	}
}

async function cloneAndBuild(
	connection: SshConnection,
	installDir: string,
	pathPrefix: string,
	reportProgress: BootstrapProgressReporter,
): Promise<void> {
	const repoUrl = process.env[REMOTE_INSTALL_REPO_ENV]?.trim();
	if (!repoUrl) {
		throw new Error("KANBAN_REMOTE_INSTALL_REPO is not set.");
	}
	reportProgress(`Cloning ${repoUrl} into ${installDir} on the remote host...`);
	const clone = await connection.exec(
		`bash -lc '${pathPrefix}set -e; mkdir -p ${installDir}; if [ ! -d ${installDir}/.git ]; then git clone ${repoUrl} ${installDir}; else (cd ${installDir} && git pull --ff-only); fi'`,
		{ timeoutMs: getRemoteBuildTimeoutMs() },
	);
	if (clone.code !== 0) {
		throw new Error(`Failed to clone Kanban on the remote host: ${clone.stderr || clone.stdout}`);
	}
	reportProgress("Installing dependencies and building on the remote host (this can take several minutes)...");
	const build = await connection.exec(
		`bash -lc '${pathPrefix}set -e; cd ${installDir}; npm ci && npm run build && (cd web-ui && npm ci) || true'`,
		{ timeoutMs: getRemoteBuildTimeoutMs() },
	);
	if (build.code !== 0) {
		throw new Error(`Failed to build Kanban on the remote host: ${build.stderr || build.stdout}`);
	}
}

export async function ensureRemoteRuntime(
	connection: SshConnection,
	options: {
		machineId: string;
		remoteInstallDir?: string | null;
		reportProgress?: BootstrapProgressReporter;
	},
): Promise<EnsureRemoteRuntimeResult> {
	const reportProgress = options.reportProgress ?? (() => {});
	reportProgress("Checking remote Node.js runtime...");
	// Auto-install a suitable Node into $HOME when the system Node is missing/old.
	const { pathPrefix } = await ensureRemoteNode(connection, reportProgress);
	const environment = await detectRemoteEnvironment(connection, { remoteInstallDir: options.remoteInstallDir });

	let installDir = environment.resolvedInstallDir;
	let globalKanbanBinary = environment.globalKanbanBinary;
	let didRebuild = false;
	const targetInstallDir = options.remoteInstallDir ?? DEFAULT_REMOTE_INSTALL_DIR;
	const customRepoUrl = process.env[REMOTE_INSTALL_REPO_ENV]?.trim();
	const sourceRoot = customRepoUrl ? null : findHubSourceRoot();

	if (sourceRoot) {
		// Self-install path: ship the hub's own source and keep the remote in sync
		// by comparing a content hash of the shipped tarball against a stamp file.
		reportProgress("Packaging Kanban to send to the remote host...");
		const tarballPath = await createHubSourceTarball(sourceRoot);
		try {
			const buildId = await hashFile(tarballPath);
			const remoteStamp = await readRemoteBuildStamp(connection, targetInstallDir);
			const upToDate = environment.resolvedInstallDir === targetInstallDir && remoteStamp === buildId;
			if (!upToDate) {
				await transferAndBuildHubSource(
					connection,
					targetInstallDir,
					pathPrefix,
					tarballPath,
					buildId,
					reportProgress,
				);
				didRebuild = true;
			}
			installDir = targetInstallDir;
			globalKanbanBinary = null;
		} finally {
			await rm(tarballPath, { force: true });
		}
	} else if (!environment.kanbanRuntimeAvailable) {
		if (!customRepoUrl) {
			throw new Error(
				"No Kanban runtime found on the remote host and the hub has no source to ship. " +
					"Install Kanban on the remote host, or set KANBAN_REMOTE_INSTALL_REPO to a git URL.",
			);
		}
		await cloneAndBuild(connection, targetInstallDir, pathPrefix, reportProgress);
		installDir = targetInstallDir;
		globalKanbanBinary = null;
		didRebuild = true;
	}

	const remotePort = getStableRemoteRuntimePort(options.machineId);
	reportProgress("Starting the remote Kanban runtime...");
	const launch = await connection.exec(
		buildLaunchCommand({ remotePort, installDir, globalKanbanBinary, pathPrefix, forceRestart: didRebuild }),
		{ timeoutMs: REMOTE_LAUNCH_TIMEOUT_MS },
	);
	const launched = launch.stdout.includes("LAUNCHED");

	return {
		remotePort,
		installDir,
		globalKanbanBinary,
		launched,
	};
}
