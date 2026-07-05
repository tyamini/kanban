// Tracks borrow/return/extend operations against the Jenkins borrow pools
// (office `BorrowMachine` + AWS `BorrowMachineAI`). Each operation is a
// long-running (1-10+ min) async job whose progress log the UI polls, mirroring
// how remote-machine connections surface progress. Also exposes the list of
// machines currently borrowed by the user for each pool.
import { randomUUID } from "node:crypto";
import { provisionBorrowedMachine } from "./borrow-machine-setup";
import {
	type BorrowedMachine,
	type BorrowPoolId,
	JenkinsBorrowClient,
	type JenkinsCreds,
	parseAwsBorrowConsole,
	parseBorrowConsole,
} from "./jenkins-borrow-client";
import { BORROW_POOLS, type BorrowPoolConfig, listBorrowPools, loadPoolCreds } from "./jenkins-borrow-pools";

const POLL_INTERVAL_MS = 15_000;
const QUEUE_TIMEOUT_MS = 10 * 60_000;
const BORROW_RESULT_TIMEOUT_MS = 20 * 60_000;
const ACTION_RESULT_TIMEOUT_MS = 8 * 60_000;
const NODE_LIST_CACHE_TTL_MS = 10_000;
// The AWS list scans build history (heavier), so refresh it less often.
const BUILD_LIST_CACHE_TTL_MS = 60_000;
const AWS_BUILD_SCAN_COUNT = 60;
const MAX_JOB_LOG_LINES = 200;
const MAX_RETAINED_JOBS = 20;

export type BorrowJobAction = "borrow" | "return" | "extend";
export type BorrowJobStatus = "running" | "succeeded" | "failed";

export interface BorrowJob {
	id: string;
	pool: BorrowPoolId;
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

export interface BorrowPoolInfo {
	id: BorrowPoolId;
	label: string;
	types: string[];
	credentialsError: string | null;
}

export interface BorrowManagerState {
	pools: BorrowPoolInfo[];
	borrowed: BorrowedMachine[];
	jobs: BorrowJob[];
}

export interface BorrowMachineManager {
	getState: () => Promise<BorrowManagerState>;
	startBorrow: (input: { pool: BorrowPoolId; type: string; leaseHours: number }) => { jobId: string };
	startExtend: (input: { pool: BorrowPoolId; machine: string; leaseHours: number }) => { jobId: string };
	startReturn: (input: { pool: BorrowPoolId; machine: string }) => { jobId: string };
	dismissJob: (jobId: string) => { ok: boolean };
	onChange: (listener: () => void) => () => void;
}

interface PoolRuntimeState {
	borrowed: BorrowedMachine[];
	borrowedAt: number;
	credentialsError: string | null;
}

export function createBorrowMachineManager(options: { warn?: (message: string) => void } = {}): BorrowMachineManager {
	const warn = options.warn ?? (() => {});
	const jobs = new Map<string, BorrowJob>();
	const changeListeners = new Set<() => void>();
	const credsPromises = new Map<BorrowPoolId, Promise<JenkinsCreds>>();
	const poolStates = new Map<BorrowPoolId, PoolRuntimeState>();
	// AWS-only: instances borrowed via this Kanban instance, kept until a Return
	// succeeds (covers the gap before the build-history scan picks them up).
	const awsLocal = new Map<string, BorrowedMachine>();
	// AWS-only: parsed console per (immutable) finished build number.
	const awsConsoleCache = new Map<number, { instanceId: string | null; ip: string | null }>();

	const notifyChange = (): void => {
		for (const listener of changeListeners) {
			try {
				listener();
			} catch {
				// Ignore listener errors.
			}
		}
	};

	const poolState = (id: BorrowPoolId): PoolRuntimeState => {
		let state = poolStates.get(id);
		if (!state) {
			state = { borrowed: [], borrowedAt: 0, credentialsError: null };
			poolStates.set(id, state);
		}
		return state;
	};

	const getCreds = (pool: BorrowPoolConfig): Promise<JenkinsCreds> => {
		let promise = credsPromises.get(pool.id);
		if (!promise) {
			// Drop the cached promise on failure so a later token fix is picked up
			// without restarting the server.
			promise = loadPoolCreds(pool).catch((error) => {
				credsPromises.delete(pool.id);
				throw error;
			});
			credsPromises.set(pool.id, promise);
		}
		return promise;
	};

	const clientFor = async (pool: BorrowPoolConfig): Promise<{ client: JenkinsBorrowClient; creds: JenkinsCreds }> => {
		const creds = await getCreds(pool);
		return { client: new JenkinsBorrowClient(creds, { baseUrl: pool.baseUrl, job: pool.job }), creds };
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

	const getAwsBuildInstance = async (
		client: JenkinsBorrowClient,
		buildNumber: number,
	): Promise<{ instanceId: string | null; ip: string | null }> => {
		const cached = awsConsoleCache.get(buildNumber);
		if (cached) {
			return cached;
		}
		try {
			const parsed = parseAwsBorrowConsole(await client.getBuildConsole(buildNumber));
			awsConsoleCache.set(buildNumber, parsed);
			return parsed;
		} catch {
			return { instanceId: null, ip: null };
		}
	};

	// Reconstruct the user's active AWS instances from build history: successful
	// Borrow builds they triggered, minus any that were later Returned/Stopped,
	// with lease end derived from the build time + LEASE_TIME (bumped by Extends).
	const listAwsBorrowed = async (client: JenkinsBorrowClient, user: string): Promise<BorrowedMachine[]> => {
		const builds = await client.listRecentBuilds(AWS_BUILD_SCAN_COUNT);
		const gone = new Set<string>();
		const extendedUntil = new Map<string, number>();
		for (const build of builds) {
			if (build.result !== "SUCCESS") {
				continue;
			}
			const action = build.parameters.Action;
			if (action === "Return" && build.parameters.RETURN_INSTANCE) {
				gone.add(build.parameters.RETURN_INSTANCE);
			} else if (action === "Stop" && build.parameters.STOP_INSTANCE) {
				gone.add(build.parameters.STOP_INSTANCE);
			} else if (action === "Extend" && build.parameters.EXTEND_INSTANCE) {
				const hours = Number.parseInt(build.parameters.NEW_LEASE_TIME ?? "", 10);
				if (Number.isFinite(hours)) {
					const until = Math.floor(build.timestamp / 1000) + hours * 3600;
					const prev = extendedUntil.get(build.parameters.EXTEND_INSTANCE);
					if (prev === undefined || until > prev) {
						extendedUntil.set(build.parameters.EXTEND_INSTANCE, until);
					}
				}
			}
		}

		const result = new Map<string, BorrowedMachine>();
		// Builds are newest-first, so the first Borrow we see for an instance wins.
		for (const build of builds) {
			if (build.result !== "SUCCESS" || build.parameters.Action !== "Borrow") {
				continue;
			}
			const mine = build.causeUserIds.includes(user) || build.parameters.on_behalf === user;
			if (!mine) {
				continue;
			}
			const parsed = await getAwsBuildInstance(client, build.number);
			if (!parsed.instanceId || gone.has(parsed.instanceId) || result.has(parsed.instanceId)) {
				continue;
			}
			const leaseHours = Number.parseInt(build.parameters.LEASE_TIME ?? "", 10);
			let leaseEndEpoch = Number.isFinite(leaseHours)
				? Math.floor(build.timestamp / 1000) + leaseHours * 3600
				: null;
			const extended = extendedUntil.get(parsed.instanceId);
			if (extended !== undefined) {
				leaseEndEpoch = extended;
			}
			result.set(parsed.instanceId, {
				pool: "aws",
				machine: parsed.instanceId,
				host: parsed.ip,
				borrower: user,
				leaseEndEpoch,
			});
		}

		// Merge locally-tracked borrows not yet reflected in (or already dropped by) the scan.
		for (const [instanceId, record] of awsLocal) {
			if (gone.has(instanceId)) {
				awsLocal.delete(instanceId);
				continue;
			}
			if (!result.has(instanceId)) {
				result.set(instanceId, record);
			}
		}
		return [...result.values()];
	};

	const refreshPoolBorrowed = async (pool: BorrowPoolConfig, force: boolean): Promise<BorrowedMachine[]> => {
		const state = poolState(pool.id);
		const ttl = pool.listStrategy === "buildHistory" ? BUILD_LIST_CACHE_TTL_MS : NODE_LIST_CACHE_TTL_MS;
		if (!force && Date.now() - state.borrowedAt < ttl) {
			return state.borrowed;
		}
		try {
			const { client, creds } = await clientFor(pool);
			state.borrowed =
				pool.listStrategy === "buildHistory"
					? await listAwsBorrowed(client, creds.user)
					: (await client.listBorrowed()).filter((row) => row.borrower === creds.user);
			state.borrowedAt = Date.now();
			state.credentialsError = null;
		} catch (error) {
			state.credentialsError = error instanceof Error ? error.message : String(error);
			warn(`Failed to list borrowed machines (${pool.label}): ${state.credentialsError}`);
		}
		return state.borrowed;
	};

	const createJob = (pool: BorrowPoolId, action: BorrowJobAction, label: string): BorrowJob => {
		const job: BorrowJob = {
			id: randomUUID(),
			pool,
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

	const runJob = async (
		job: BorrowJob,
		pool: BorrowPoolConfig,
		run: (client: JenkinsBorrowClient, report: (message: string) => void) => Promise<string | null>,
	): Promise<void> => {
		const report = (message: string) => appendJobLog(job, message);
		try {
			const { client } = await clientFor(pool);
			job.resultMachine = await run(client, report);
			job.status = "succeeded";
			report("Done.");
		} catch (error) {
			job.status = "failed";
			job.error = error instanceof Error ? error.message : String(error);
			appendJobLog(job, `Error: ${job.error}`);
		} finally {
			job.finishedAt = Date.now();
			pruneJobs();
			await refreshPoolBorrowed(pool, true);
			notifyChange();
		}
	};

	const runBuildAction = async (
		job: BorrowJob,
		pool: BorrowPoolConfig,
		client: JenkinsBorrowClient,
		report: (message: string) => void,
		params: Record<string, string>,
		resultTimeoutMs: number,
		buildOptions: { detectReserved?: boolean } = {},
	): Promise<string> => {
		report("Triggering Jenkins build...");
		const queueUrl = await client.trigger(params);
		report("Queued on Jenkins.");
		const buildUrl = await client.waitForBuild(queueUrl, POLL_INTERVAL_MS, QUEUE_TIMEOUT_MS, report);
		job.buildUrl = buildUrl;
		report(`Build started: ${buildUrl}`);
		// For borrows, poll the console mid-build to detect the machine Jenkins
		// reserved so the UI can mark that row as "in setup" before completion.
		const onPoll = buildOptions.detectReserved
			? async () => {
					try {
						const partial = await client.getConsole(buildUrl);
						const reserved =
							pool.listStrategy === "buildHistory"
								? parseAwsBorrowConsole(partial).instanceId
								: parseBorrowConsole(partial).machine;
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

	const runBorrow = async (
		job: BorrowJob,
		pool: BorrowPoolConfig,
		client: JenkinsBorrowClient,
		report: (message: string) => void,
		leaseHours: number,
		type: string,
	): Promise<string | null> => {
		const console = await runBuildAction(
			job,
			pool,
			client,
			report,
			pool.buildBorrowParams({ type, leaseHours }),
			BORROW_RESULT_TIMEOUT_MS,
			{ detectReserved: true },
		);

		if (pool.listStrategy === "buildHistory") {
			const parsed = parseAwsBorrowConsole(console);
			if (!parsed.instanceId) {
				report("Build succeeded but the instance id could not be parsed from the console.");
				return null;
			}
			const { creds } = await clientFor(pool);
			awsLocal.set(parsed.instanceId, {
				pool: pool.id,
				machine: parsed.instanceId,
				host: parsed.ip,
				borrower: creds.user,
				leaseEndEpoch: Math.floor(Date.now() / 1000) + leaseHours * 3600,
			});
			job.reservedMachine = parsed.instanceId;
			report(`Borrowed ${parsed.instanceId}${parsed.ip ? ` (${parsed.ip})` : ""}.`);
			if (parsed.ip) {
				report("Running post-borrow setup...");
				try {
					await provisionBorrowedMachine(parsed.ip, report, pool.ssh);
				} catch (error) {
					// The instance is genuinely borrowed; a setup failure must not fail the borrow.
					report(`Post-borrow setup failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			return parsed.instanceId;
		}

		const parsed = parseBorrowConsole(console);
		if (parsed.machine) {
			report(`Borrowed ${parsed.machine}${parsed.leaseEnd ? ` (lease until ${parsed.leaseEnd})` : ""}.`);
			// Keep the row "in setup" while we provision the machine.
			job.reservedMachine = parsed.machine;
			report("Running post-borrow setup...");
			await provisionBorrowedMachine(parsed.machine, report, pool.ssh);
		} else {
			report("Build succeeded but the machine name could not be parsed from the console.");
		}
		return parsed.machine;
	};

	return {
		getState: async () => {
			const pools = listBorrowPools();
			await Promise.all(pools.map((pool) => refreshPoolBorrowed(pool, false)));
			return {
				pools: pools.map((pool) => ({
					id: pool.id,
					label: pool.label,
					types: [...pool.types],
					credentialsError: poolState(pool.id).credentialsError,
				})),
				borrowed: pools.flatMap((pool) => poolState(pool.id).borrowed),
				jobs: [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt),
			};
		},

		startBorrow: ({ pool, type, leaseHours }) => {
			const poolConfig = BORROW_POOLS[pool];
			const job = createJob(pool, "borrow", `Borrow ${poolConfig.label} ${type} (${leaseHours}h)`);
			void runJob(job, poolConfig, (client, report) => runBorrow(job, poolConfig, client, report, leaseHours, type));
			return { jobId: job.id };
		},

		startExtend: ({ pool, machine, leaseHours }) => {
			const poolConfig = BORROW_POOLS[pool];
			const job = createJob(pool, "extend", `Extend ${machine} (+${leaseHours}h)`);
			void runJob(job, poolConfig, async (client, report) => {
				await runBuildAction(
					job,
					poolConfig,
					client,
					report,
					poolConfig.buildExtendParams(machine, leaseHours),
					ACTION_RESULT_TIMEOUT_MS,
				);
				report(`Extended ${machine}.`);
				return machine;
			});
			return { jobId: job.id };
		},

		startReturn: ({ pool, machine }) => {
			const poolConfig = BORROW_POOLS[pool];
			const job = createJob(pool, "return", `Return ${machine}`);
			void runJob(job, poolConfig, async (client, report) => {
				await runBuildAction(
					job,
					poolConfig,
					client,
					report,
					poolConfig.buildReturnParams(machine),
					ACTION_RESULT_TIMEOUT_MS,
				);
				awsLocal.delete(machine);
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
