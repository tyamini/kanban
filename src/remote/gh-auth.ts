// Resolves Jenkins borrow credentials from the authenticated GitHub CLI (`gh`)
// instead of a per-user Jenkins API token. Both DriveNets Jenkins instances use
// the GitHub OAuth security realm, so a GitHub token (with `read:org` scope)
// authenticates against their REST API via HTTP basic auth — the username is the
// GitHub login and the password is the token. This lets any developer who is
// already logged in with `gh` borrow machines with zero extra setup, and there
// is no long-lived Jenkins secret to store or rotate.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { JenkinsCreds } from "./jenkins-borrow-client";

const execFileAsync = promisify(execFile);

// The Jenkins OAuth realm authenticates against github.com (not GH Enterprise).
const GH_HOSTNAME = "github.com";
const GH_HOSTS_FILE = join(homedir(), ".config", "gh", "hosts.yml");
// gho_ (OAuth), ghp_ (classic PAT), ghu_/ghs_ (user/server), github_pat_ (fine-grained).
const TOKEN_RE = /\b(gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+)\b/;
const EXEC_OPTIONS = { timeout: 15_000, windowsHide: true } as const;

class GithubCliError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GithubCliError";
	}
}

function isMissingGhBinary(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

// Read the token `gh` would use for github.com. Prefers `gh auth token` (gh
// >= 2.16); falls back to `gh auth status --show-token` and finally to parsing
// hosts.yml so this keeps working on older `gh` builds that lack the subcommand.
async function readGithubToken(): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("gh", ["auth", "token", "--hostname", GH_HOSTNAME], EXEC_OPTIONS);
		const token = stdout.trim();
		if (token) {
			return token;
		}
	} catch (error) {
		if (isMissingGhBinary(error)) {
			throw new GithubCliError(
				"GitHub CLI (gh) was not found on PATH. Install it and run `gh auth login` to borrow machines.",
			);
		}
	}

	try {
		const { stdout, stderr } = await execFileAsync(
			"gh",
			["auth", "status", "--hostname", GH_HOSTNAME, "--show-token"],
			EXEC_OPTIONS,
		);
		const match = `${stdout}\n${stderr}`.match(TOKEN_RE);
		if (match) {
			return match[0];
		}
	} catch {
		// Ignore; fall through to the hosts.yml fallback.
	}

	try {
		const raw = await readFile(GH_HOSTS_FILE, "utf8");
		// Minimal parse: find the github.com block, then its `oauth_token:` value.
		const hostIndex = raw.indexOf(`${GH_HOSTNAME}:`);
		const scope = hostIndex === -1 ? raw : raw.slice(hostIndex);
		const match = scope.match(/oauth_token:\s*(\S+)/);
		if (match?.[1]) {
			return match[1].replace(/^["']|["']$/g, "");
		}
	} catch {
		// Ignore; treated as "not authenticated" below.
	}

	return null;
}

// Resolve the GitHub login the token belongs to (this becomes the Jenkins
// username). Prefers `gh api user`; falls back to parsing `gh auth status`.
async function readGithubLogin(): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync(
			"gh",
			["api", "user", "--hostname", GH_HOSTNAME, "--jq", ".login"],
			EXEC_OPTIONS,
		);
		const login = stdout.trim();
		if (login) {
			return login;
		}
	} catch {
		// Ignore; fall through to the status fallback.
	}

	try {
		const { stdout, stderr } = await execFileAsync("gh", ["auth", "status", "--hostname", GH_HOSTNAME], EXEC_OPTIONS);
		const match = `${stdout}\n${stderr}`.match(/Logged in to \S+ as (\S+)/i);
		if (match?.[1]) {
			return match[1];
		}
	} catch {
		// Ignore; treated as "not authenticated" below.
	}

	return null;
}

async function resolve(): Promise<JenkinsCreds> {
	const [token, user] = await Promise.all([readGithubToken(), readGithubLogin()]);
	if (!token) {
		throw new GithubCliError(
			"Not authenticated with the GitHub CLI. Run `gh auth login` (with the `read:org` scope) to borrow machines.",
		);
	}
	if (!user) {
		throw new GithubCliError(
			"Could not determine your GitHub login from `gh`. Run `gh auth status` to check the CLI is authenticated.",
		);
	}
	return { user, token };
}

let cached: Promise<JenkinsCreds> | null = null;

/**
 * Resolve Jenkins borrow credentials from the authenticated `gh` CLI. The result
 * is memoized after the first success; a failure clears the cache so a later
 * `gh auth login` is picked up without restarting the server.
 */
export function resolveGithubCliCreds(): Promise<JenkinsCreds> {
	if (!cached) {
		cached = resolve().catch((error) => {
			cached = null;
			throw error;
		});
	}
	return cached;
}

/** Drop the cached credentials (e.g. after an auth failure) so they are re-resolved. */
export function resetGithubCliCreds(): void {
	cached = null;
}
