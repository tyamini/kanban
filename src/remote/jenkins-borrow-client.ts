// TypeScript port of the Jenkins `BorrowMachine` driver (borrow.py). Drives the
// Jenkins REST API to borrow / return / extend a CI machine and to list the
// machines currently borrowed by the user (from node labels). Kept close to the
// original script's logic, including the console-parsing regexes.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type BorrowPoolId = "office" | "aws";

const DEFAULT_BASE_URL = "https://jenkins.dev.drivenets.net";
const DEFAULT_JOB = "BorrowMachine";
export const CREDS_FILE = join(homedir(), ".config", "borrow-machine-jenkins.env");
// The username is effectively fixed for this deployment; the token is read from
// the environment or the creds file so it is never committed to the repo.
export const DEFAULT_JENKINS_USER = "tyamini";

export const BORROW_MACHINE_TYPES = [
	"tiny",
	"small",
	"medium",
	"large",
	"orm_builder",
	"j2",
	"j2_beta",
	"j2_beta_spirent",
	"j2_ncp3",
	"j2_ncpl",
	"j3ai",
	"q3d",
	"emux",
	"emux_s",
	"cluster",
	"cluster_beta",
	"baseos_tester",
	"ai3_tester",
	"ai_cluster",
] as const;

export type BorrowMachineType = (typeof BORROW_MACHINE_TYPES)[number];

// AWS BorrowMachineAI INSTANCE_TYPE choices (EC2 sizes; distinct from office).
export const AWS_INSTANCE_TYPES = [
	"tiny",
	"tiny-dn-kernel",
	"small",
	"small-dn-kernel",
	"medium",
	"medium-dn-kernel",
	"large",
	"large-dn-kernel",
] as const;

export type AwsInstanceType = (typeof AWS_INSTANCE_TYPES)[number];

export interface JenkinsCreds {
	user: string;
	token: string;
}

export interface BorrowedMachine {
	pool: BorrowPoolId;
	machine: string;
	/** SSH target (office: hostname; AWS: private IP). May differ from `machine`. */
	host: string | null;
	borrower: string | null;
	leaseEndEpoch: number | null;
	/**
	 * True when this row was reconstructed from a *failed* borrow build that
	 * launched an instance but never returned it (AWS only). Such instances keep
	 * running and are invisible to the normal successful-build scan, so they are
	 * surfaced here purely so the user can return/clean them up.
	 */
	orphaned: boolean;
}

export interface ParsedBorrowConsole {
	machine: string | null;
	borrower: string | null;
	leaseEndEpoch: number | null;
	leaseEnd: string | null;
	sshHint: string | null;
}

export interface ParsedAwsBorrowConsole {
	instanceId: string | null;
	ip: string | null;
}

export interface JenkinsBuildInfo {
	number: number;
	result: string | null;
	timestamp: number;
	parameters: Record<string, string>;
	causeUserIds: string[];
}

export type ProgressReporter = (message: string) => void;

/** Parse the borrow creds file into a raw key→value map (best-effort). */
export async function readJenkinsCredsFile(): Promise<Record<string, string>> {
	try {
		const raw = await readFile(CREDS_FILE, "utf8");
		const map: Record<string, string> = {};
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
				continue;
			}
			const [key, ...rest] = trimmed.split("=");
			const value = rest
				.join("=")
				.trim()
				.replace(/^["']|["']$/g, "");
			if (key?.trim()) {
				map[key.trim()] = value;
			}
		}
		return map;
	} catch {
		return {};
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export class JenkinsBorrowClient {
	private readonly base: string;
	private readonly authHeader: string;
	private crumbHeader: Record<string, string> | null = null;
	private readonly job: string;

	constructor(creds: JenkinsCreds, options: { baseUrl?: string; job?: string } = {}) {
		this.base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
		this.job = options.job ?? DEFAULT_JOB;
		this.authHeader = `Basic ${Buffer.from(`${creds.user}:${creds.token}`).toString("base64")}`;
	}

	private async fetch(url: string, init: RequestInit = {}): Promise<Response> {
		const fullUrl = url.startsWith("http") ? url : `${this.base}${url}`;
		return await fetch(fullUrl, {
			...init,
			headers: { Authorization: this.authHeader, ...(init.headers ?? {}) },
			redirect: "manual",
		});
	}

	private async getCrumb(): Promise<Record<string, string>> {
		if (this.crumbHeader === null) {
			try {
				const resp = await this.fetch("/crumbIssuer/api/json");
				if (resp.ok) {
					const body = (await resp.json()) as { crumbRequestField?: string; crumb?: string };
					this.crumbHeader = body.crumbRequestField && body.crumb ? { [body.crumbRequestField]: body.crumb } : {};
				} else {
					this.crumbHeader = {};
				}
			} catch {
				this.crumbHeader = {};
			}
		}
		return this.crumbHeader;
	}

	private async getJson<T>(pathOrUrl: string): Promise<T> {
		const resp = await this.fetch(pathOrUrl);
		if (!resp.ok) {
			throw new Error(`Jenkins request failed (HTTP ${resp.status}) for ${pathOrUrl}`);
		}
		return (await resp.json()) as T;
	}

	private async getText(pathOrUrl: string): Promise<string> {
		const resp = await this.fetch(pathOrUrl);
		return await resp.text();
	}

	/** POST buildWithParameters and return the queue-item URL. */
	async trigger(params: Record<string, string>): Promise<string> {
		const crumb = await this.getCrumb();
		const resp = await this.fetch(`/job/${encodeURIComponent(this.job)}/buildWithParameters`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", ...crumb },
			body: new URLSearchParams(params).toString(),
		});
		if (resp.status === 401 || resp.status === 403) {
			throw new Error(`Jenkins auth/permission error (HTTP ${resp.status}). Check the API token.`);
		}
		if (resp.status >= 400) {
			const detail = (await resp.text()).slice(0, 500);
			throw new Error(`Failed to trigger Jenkins build (HTTP ${resp.status}): ${detail}`);
		}
		const location = resp.headers.get("location");
		if (!location) {
			throw new Error("Jenkins accepted the build but returned no queue Location header.");
		}
		return location.replace(/\/+$/, "");
	}

	async waitForBuild(
		queueUrl: string,
		pollMs: number,
		timeoutMs: number,
		onProgress: ProgressReporter,
	): Promise<string> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const item = await this.getJson<{ cancelled?: boolean; executable?: { url?: string }; why?: string }>(
				`${queueUrl}/api/json`,
			);
			if (item.cancelled) {
				throw new Error("The build request was cancelled in the Jenkins queue.");
			}
			if (item.executable?.url) {
				return item.executable.url.replace(/\/+$/, "");
			}
			onProgress(`Waiting in queue: ${item.why ?? "queued"}`);
			await delay(pollMs);
		}
		throw new Error("Timed out waiting for the build to leave the Jenkins queue.");
	}

	async waitForResult(
		buildUrl: string,
		pollMs: number,
		timeoutMs: number,
		onProgress: ProgressReporter,
		onPoll?: () => Promise<void>,
	): Promise<{ result: string | null; number: number }> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const info = await this.getJson<{ building?: boolean; result?: string | null; number: number }>(
				`${buildUrl}/api/json?tree=building,result,number`,
			);
			if (!info.building && info.result != null) {
				return { result: info.result, number: info.number };
			}
			if (onPoll) {
				await onPoll();
			}
			onProgress("Build running on Jenkins...");
			await delay(pollMs);
		}
		throw new Error(`Timed out waiting for the build to finish. It may still be running: ${buildUrl}`);
	}

	async getConsole(buildUrl: string): Promise<string> {
		return await this.getText(`${buildUrl}/consoleText`);
	}

	async listBorrowed(): Promise<BorrowedMachine[]> {
		const data = await this.getJson<{
			computer?: Array<{ displayName?: string; assignedLabels?: Array<{ name?: string }> }>;
		}>("/computer/api/json?tree=computer[displayName,assignedLabels[name]]");
		const rows: BorrowedMachine[] = [];
		for (const comp of data.computer ?? []) {
			const name = comp.displayName;
			if (!name) {
				continue;
			}
			let borrower: string | null = null;
			let leaseEndEpoch: number | null = null;
			for (const label of comp.assignedLabels ?? []) {
				const value = label.name ?? "";
				if (value.startsWith("taken_by_") && value !== "taken_by_drivenets") {
					borrower = value.slice("taken_by_".length);
				} else if (value.startsWith("lease_end_")) {
					const parsed = Number.parseInt(value.slice("lease_end_".length), 10);
					if (Number.isFinite(parsed)) {
						leaseEndEpoch = parsed;
					}
				}
			}
			if (borrower || leaseEndEpoch) {
				rows.push({ pool: "office", machine: name, host: name, borrower, leaseEndEpoch, orphaned: false });
			}
		}
		return rows;
	}

	async getBuildConsole(buildNumber: number): Promise<string> {
		return await this.getText(`/job/${encodeURIComponent(this.job)}/${buildNumber}/consoleText`);
	}

	buildUrlForNumber(buildNumber: number): string {
		return `${this.base}/job/${encodeURIComponent(this.job)}/${buildNumber}/`;
	}

	/** Recent builds with their parameters and triggering user ids (newest first). */
	async listRecentBuilds(count: number): Promise<JenkinsBuildInfo[]> {
		const tree = `builds[number,result,timestamp,actions[parameters[name,value],causes[userId]]]{0,${count}}`;
		const data = await this.getJson<{
			builds?: Array<{
				number: number;
				result: string | null;
				timestamp: number;
				actions?: Array<{
					parameters?: Array<{ name?: string; value?: unknown }>;
					causes?: Array<{ userId?: string }>;
				}>;
			}>;
		}>(`/job/${encodeURIComponent(this.job)}/api/json?tree=${encodeURIComponent(tree)}`);
		return (data.builds ?? []).map((build) => {
			const parameters: Record<string, string> = {};
			const causeUserIds: string[] = [];
			for (const action of build.actions ?? []) {
				for (const param of action.parameters ?? []) {
					if (param.name != null && param.value != null) {
						parameters[param.name] = String(param.value);
					}
				}
				for (const cause of action.causes ?? []) {
					if (cause.userId) {
						causeUserIds.push(cause.userId);
					}
				}
			}
			return {
				number: build.number,
				result: build.result,
				timestamp: build.timestamp,
				parameters,
				causeUserIds,
			};
		});
	}
}

export function parseBorrowConsole(text: string): ParsedBorrowConsole {
	let machine: string | null = null;
	const m1 = text.match(/dn@([A-Za-z0-9][A-Za-z0-9._-]+)'/);
	if (m1) {
		machine = m1[1] ?? null;
	}
	if (!machine) {
		const m2 = text.match(/\b([A-Za-z0-9][A-Za-z0-9._-]{3,}) is reserved, proceeding/);
		if (m2) {
			machine = m2[1] ?? null;
		}
	}
	const borrowers = [...text.matchAll(/taken_by_([A-Za-z0-9._-]+)/g)]
		.map((match) => match[1])
		.filter((value): value is string => value !== undefined && value !== "drivenets");
	const leaseEnds = [...text.matchAll(/lease_end_(\d+)/g)].map((match) => match[1]);
	const lastLease = leaseEnds.at(-1);
	const leaseEndEpoch = lastLease ? Number.parseInt(lastLease, 10) : null;
	const sshHintMatch = text.match(/Now try logging into the machine, with:\s*"(.+?)"/);
	return {
		machine,
		borrower: borrowers.at(-1) ?? null,
		leaseEndEpoch: leaseEndEpoch && Number.isFinite(leaseEndEpoch) ? leaseEndEpoch : null,
		leaseEnd:
			leaseEndEpoch && Number.isFinite(leaseEndEpoch)
				? new Date(leaseEndEpoch * 1000).toISOString().replace("T", " ").slice(0, 19)
				: null,
		sshHint: sshHintMatch?.[1] ?? null,
	};
}

// AWS BorrowMachineAI console prints `Instance ready — id: i-..., ip: 172.30.x.x`.
export function parseAwsBorrowConsole(text: string): ParsedAwsBorrowConsole {
	const ready = text.match(/Instance ready\s*[—-]\s*id:\s*(i-[0-9a-f]+),\s*ip:\s*([0-9.]+)/i);
	if (ready) {
		return { instanceId: ready[1] ?? null, ip: ready[2] ?? null };
	}
	const launched = text.match(/Instance launched:\s*(i-[0-9a-f]+)/i);
	return { instanceId: launched?.[1] ?? null, ip: null };
}

export interface BorrowParams {
	type: BorrowMachineType;
	leaseHours: number;
	machine?: string;
	repository?: string;
	skipBaseos?: boolean;
	joinQueue?: boolean;
	/** Allow borrowing even when the user already holds a machine. On by default. */
	allowMultiple?: boolean;
}

export function buildBorrowParams(params: BorrowParams): Record<string, string> {
	return {
		Action: "Borrow",
		MACHINE_TYPE: params.type,
		SPECIFIC_MACHINE: params.machine ?? "",
		LEASE_TIME: String(params.leaseHours),
		REPOSITORY: params.repository ?? "cheetah",
		join_the_queue: params.joinQueue ? "true" : "false",
		SKIP_BASEOS_REPLACEMENT: params.skipBaseos === false ? "false" : "true",
		start_env: "false",
		allow_multiple_borrow: params.allowMultiple === false ? "false" : "true",
		GIT_BRANCH: "",
		JENKINS_JOB: "",
	};
}
