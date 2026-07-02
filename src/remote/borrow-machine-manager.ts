// Tracks borrow/return/extend operations against the Jenkins BorrowMachine pool.
// Each operation is a long-running (1-10+ min) async job whose progress log the
// UI polls, mirroring how remote-machine connections surface progress. Also
// exposes the list of machines currently borrowed by the user.
import { randomUUID } from "node:crypto";
import { provisionBorrowedMachine } from "./borrow-machine-setup";
import {
	BORROW_MACHINE_TYPES,
	type BorrowedMachine,
	type BorrowMachineType,
	buildBorrowParams,
	JenkinsBorrowClient,
	type JenkinsCreds,
	loadJenkinsCreds,
	parseBorrowConsole,
} from "./jenkins-borrow-client";

const POLL_INTERVAL_MS = 15_000;
const QUEUE_TIMEOUT_MS = 10 * 60_000;
const BORROW_RESULT_TIMEOUT_MS = 20 * 60_000;
const ACTION_RESULT_TIMEOUT_MS = 8 * 60_000;
const BORROWED_CACHE_TTL_MS = 10_000;
const MAX_JOB_LOG_LINES = 200;
const MAX_RETAINED_JOBS = 20;

export type BorrowJobAction = "borrow" | "return" | "extend";
export type BorrowJobStatus = "running" | "succeeded" | "failed";

export interface BorrowJob {
	id: string;
	action: BorrowJobAction;
	label: string;
	status: BorrowJobStatus;
	statusLog: string[];
	buildUrl: string | null;
	/** Machine the build reserved, detected mid-build; the row is "in setup" until done. */
	reservedMachine: string | null;
	resultMachine: string | null;
	error: string | null;
	startedAt: number;
	finishedAt: number | null;
}

export interface BorrowManagerState {
	types: string[];
	borrowed: BorrowedMachine[];
	jobs: BorrowJob[];
	credentialsError: string | null;
}

export interface BorrowMachineManager {
	getState: () => Promise<BorrowManagerState>;
	startBorrow: (input: { type: BorrowMachineType; leaseHours: number }) => { jobId: string };
	startExtend: (input: { machine: string; leaseHours: number }) => { jobId: string };
	startReturn: (input: { machine: string }) => { jobId: string };
	dismissJob: (jobId: string) => { ok: boolean };
	onChange: (listener: () => void) => () => void;
}

export function createBorrowMachineManager(options: { warn?: (message: string) => void } = {}): BorrowMachineManager {
	const warn = options.warn ?? (() => {});
	const jobs = new Map<string, BorrowJob>();
	const changeListeners = new Set<() => void>();
	let credsPromise: Promise<JenkinsCreds> | null = null;
	let cachedBorrowed: BorrowedMachine[] = [];
	let cachedBorrowedAt = 0;
	let credentialsError: string | null = null;

	const notifyChange = (): void => {
		for (const listener of changeListeners) {
			try {
				listener();
			} catch {
				// Ignore listener errors.
			}
		}
	};

	const getCreds = (): Promise<JenkinsCreds> => {
		if (!credsPromise) {
			credsPromise = loadJenkinsCreds();
		}
		return credsPromise;
	};

	const appendJobLog = (job: BorrowJob, message: string): void => {
		const trimmed = message.trim();
		if (!trimmed || job.statusLog[job.statusLog.length - 1] === trimmed) {
			return;
		}
		job.statusLog.push(trimmed);
		if (job.statusLog.length > MAX_JOB_LOG_LINES) {
			job.statusLog.splice(0, job.statusLog.length - MAX_JOB_LOG_LINES);
		}
		notifyChange();
	};

	const pruneJobs = (): void => {
		const all = [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
		const finished = all.filter((job) => job.status !== "running");
		while (finished.length > MAX_RETAINED_JOBS) {
			const oldest = finished.shift();
			if (oldest) {
				jobs.delete(oldest.id);
			}
		}
	};

	const refreshBorrowed = async (force: boolean): Promise<BorrowedMachine[]> => {
		if (!force && Date.now() - cachedBorrowedAt < BORROWED_CACHE_TTL_MS) {
			return cachedBorrowed;
		}
		try {
			const creds = await getCreds();
			const client = new JenkinsBorrowClient(creds);
			const all = await client.listBorrowed();
			// "His available machines" = machines borrowed by this user.
			cachedBorrowed = all.filter((row) => row.borrower === creds.user);
			cachedBorrowedAt = Date.now();
			credentialsError = null;
		} catch (error) {
			credentialsError = error instanceof Error ? error.message : String(error);
			warn(`Failed to list borrowed machines: ${credentialsError}`);
		}
		return cachedBorrowed;
	};

	const runJob = async (
		job: BorrowJob,
		run: (client: JenkinsBorrowClient, report: (message: string) => void) => Promise<string | null>,
	): Promise<void> => {
		const report = (message: string) => appendJobLog(job, message);
		try {
			const creds = await getCreds();
			const client = new JenkinsBorrowClient(creds);
			const resultMachine = await run(client, report);
			job.resultMachine = resultMachine;
			job.status = "succeeded";
			report("Done.");
		} catch (error) {
			job.status = "failed";
			job.error = error instanceof Error ? error.message : String(error);
			appendJobLog(job, `Error: ${job.error}`);
		} finally {
			job.finishedAt = Date.now();
			pruneJobs();
			await refreshBorrowed(true);
			notifyChange();
		}
	};

	const createJob = (action: BorrowJobAction, label: string): BorrowJob => {
		const job: BorrowJob = {
			id: randomUUID(),
			action,
			label,
			status: "running",
			statusLog: [],
			buildUrl: null,
			reservedMachine: null,
			resultMachine: null,
			error: null,
			startedAt: Date.now(),
			finishedAt: null,
		};
		jobs.set(job.id, job);
		notifyChange();
		return job;
	};

	const runBuildAction = async (
		job: BorrowJob,
		client: JenkinsBorrowClient,
		report: (message: string) => void,
		params: Record<string, string>,
		resultTimeoutMs: number,
		options: { detectReserved?: boolean } = {},
	): Promise<string> => {
		report("Triggering Jenkins build...");
		const queueUrl = await client.trigger(params);
		report("Queued on Jenkins.");
		const buildUrl = await client.waitForBuild(queueUrl, POLL_INTERVAL_MS, QUEUE_TIMEOUT_MS, report);
		job.buildUrl = buildUrl;
		report(`Build started: ${buildUrl}`);
		// For borrows, poll the console mid-build to detect the machine Jenkins
		// reserved so the UI can mark that row as "in setup" before completion.
		const onPoll = options.detectReserved
			? async () => {
					try {
						const partial = await client.getConsole(buildUrl);
						const reserved = parseBorrowConsole(partial).machine;
						if (reserved && job.reservedMachine !== reserved) {
							job.reservedMachine = reserved;
							report(`Reserved ${reserved}, setting it up...`);
						}
					} catch {
						// Ignore transient console fetch failures.
					}
				}
			: undefined;
		const { result } = await client.waitForResult(buildUrl, POLL_INTERVAL_MS, resultTimeoutMs, report, onPoll);
		const console = await client.getConsole(buildUrl);
		if (result !== "SUCCESS") {
			const tail = console.split("\n").slice(-15).join("\n");
			throw new Error(`Jenkins build finished with result=${result}. Last lines:\n${tail}`);
		}
		return console;
	};

	return {
		getState: async () => {
			const borrowed = await refreshBorrowed(false);
			return {
				types: [...BORROW_MACHINE_TYPES],
				borrowed,
				jobs: [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt),
				credentialsError,
			};
		},

		startBorrow: ({ type, leaseHours }) => {
			const job = createJob("borrow", `Borrow ${type} (${leaseHours}h)`);
			void runJob(job, async (client, report) => {
				const console = await runBuildAction(
					job,
					client,
					report,
					buildBorrowParams({ type, leaseHours }),
					BORROW_RESULT_TIMEOUT_MS,
					{ detectReserved: true },
				);
				const parsed = parseBorrowConsole(console);
				if (parsed.machine) {
					report(`Borrowed ${parsed.machine}${parsed.leaseEnd ? ` (lease until ${parsed.leaseEnd})` : ""}.`);
					// Keep the row "in setup" while we provision the machine.
					job.reservedMachine = parsed.machine;
					report("Running post-borrow setup...");
					await provisionBorrowedMachine(parsed.machine, report);
				} else {
					report("Build succeeded but the machine name could not be parsed from the console.");
				}
				return parsed.machine;
			});
			return { jobId: job.id };
		},

		startExtend: ({ machine, leaseHours }) => {
			const job = createJob("extend", `Extend ${machine} (+${leaseHours}h)`);
			void runJob(job, async (client, report) => {
				await runBuildAction(
					job,
					client,
					report,
					{ Action: "Extend", EXTEND_SLAVE: machine, NEW_LEASE_TIME: String(leaseHours) },
					ACTION_RESULT_TIMEOUT_MS,
				);
				report(`Extended ${machine}.`);
				return machine;
			});
			return { jobId: job.id };
		},

		startReturn: ({ machine }) => {
			const job = createJob("return", `Return ${machine}`);
			void runJob(job, async (client, report) => {
				await runBuildAction(
					job,
					client,
					report,
					{ Action: "Return", RETURN_SLAVE: machine },
					ACTION_RESULT_TIMEOUT_MS,
				);
				report(`Returned ${machine}.`);
				return machine;
			});
			return { jobId: job.id };
		},

		dismissJob: (jobId) => {
			const job = jobs.get(jobId);
			// Only finished jobs can be dismissed; running jobs stay until they end.
			if (!job || job.status === "running") {
				return { ok: false };
			}
			jobs.delete(jobId);
			notifyChange();
			return { ok: true };
		},

		onChange: (listener) => {
			changeListeners.add(listener);
			return () => {
				changeListeners.delete(listener);
			};
		},
	};
}
