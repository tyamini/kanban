// Orchestrates remote-machine federation on the hub: persistence, SSH
// connections + tunnels, runtime bootstrap, project federation, and
// state-stream forwarding. This is the single object the runtime server, tRPC
// machines API, workspace registry, and state hub all talk to.
import type {
	RuntimeDirectoryListResponse,
	RuntimeMachineConnectionInput,
	RuntimeMachineConnectionStatus,
	RuntimeMachineProjectAddRequest,
	RuntimeMachineSummary,
	RuntimeMachineTestConnectionResponse,
	RuntimeProjectAddResponse,
	RuntimeProjectSummary,
	RuntimeStateStreamMessage,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { buildRemoteWorkspaceId, isRemoteWorkspaceId, parseRemoteWorkspaceId } from "../state/workspace-state";
import { createRemoteMachineStore, type RemoteMachineStore, type StoredRemoteMachine } from "./remote-machine-store";
import { detectRemoteEnvironment, ensureRemoteRuntime, readRemoteRuntimeLogTail } from "./remote-runtime-bootstrap";
import { createRemoteRuntimeClient, type RemoteRuntimeClient } from "./remote-runtime-client";
import type { RemoteProxyTarget } from "./remote-runtime-proxy";
import { createSshConnection, type SshConnection, type SshTunnel } from "./ssh-connection-manager";

const HEALTH_POLL_INTERVAL_MS = 1500;
const HEALTH_POLL_TIMEOUT_MS = 120_000;
const AUTO_RECONNECT_DELAY_MS = 3000;

interface MachineSecret {
	password?: string;
	passphrase?: string;
}

interface MachineRuntimeState {
	stored: StoredRemoteMachine;
	secret: MachineSecret | null;
	connection: SshConnection | null;
	tunnel: SshTunnel | null;
	client: RemoteRuntimeClient | null;
	status: RuntimeMachineConnectionStatus;
	statusMessage: string | null;
	statusLog: string[];
	projectSummaries: RuntimeProjectSummary[];
	lastConnectedAt: number | null;
	connectPromise: Promise<void> | null;
}

const MAX_STATUS_LOG_LINES = 200;

export interface RemoteWorkspaceStreamHandlers {
	onMessage: (message: RuntimeStateStreamMessage) => void;
	onClose: () => void;
}

export interface RemoteMachineManager {
	initialize: () => Promise<void>;
	close: () => Promise<void>;
	onChange: (listener: () => void) => () => void;

	listMachineSummaries: () => RuntimeMachineSummary[];
	addMachine: (
		input: RuntimeMachineConnectionInput,
	) => Promise<{ machine: RuntimeMachineSummary | null; error?: string }>;
	testConnection: (input: RuntimeMachineConnectionInput) => Promise<RuntimeMachineTestConnectionResponse>;
	connectMachine: (
		machineId: string,
		secret?: { password?: string; passphrase?: string } | null,
	) => Promise<{ machine: RuntimeMachineSummary | null; error?: string }>;
	disconnectMachine: (machineId: string) => Promise<{ machine: RuntimeMachineSummary | null; error?: string }>;
	removeMachine: (machineId: string) => Promise<{ ok: boolean; error?: string }>;

	listMachineDirectoryContents: (machineId: string, path: string | undefined) => Promise<RuntimeDirectoryListResponse>;
	addMachineProject: (input: RuntimeMachineProjectAddRequest) => Promise<RuntimeProjectAddResponse>;

	// Federation surface used by the workspace registry / state hub / server.
	isRemoteWorkspaceId: (workspaceId: string) => boolean;
	listRemoteProjectSummaries: () => RuntimeProjectSummary[];
	resolveProxyTarget: (hubWorkspaceId: string) => RemoteProxyTarget | null;
	getWorkspaceState: (hubWorkspaceId: string) => Promise<RuntimeWorkspaceStateResponse | null>;
	subscribeWorkspaceStream: (hubWorkspaceId: string, handlers: RemoteWorkspaceStreamHandlers) => (() => void) | null;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => {
		setTimeout(resolveDelay, ms);
	});
}

export function createRemoteMachineManager(
	options: { store?: RemoteMachineStore; warn?: (message: string) => void } = {},
): RemoteMachineManager {
	const store = options.store ?? createRemoteMachineStore();
	const warn = options.warn ?? (() => {});
	const machineStates = new Map<string, MachineRuntimeState>();
	const changeListeners = new Set<() => void>();

	const notifyChange = (): void => {
		for (const listener of changeListeners) {
			try {
				listener();
			} catch {
				// Ignore listener errors.
			}
		}
	};

	const toMachineSummary = (state: MachineRuntimeState): RuntimeMachineSummary => ({
		id: state.stored.id,
		name: state.stored.name,
		host: state.stored.host,
		port: state.stored.port,
		username: state.stored.username,
		authMethod: state.stored.authMethod,
		connectionStatus: state.status,
		statusMessage: state.statusMessage,
		statusLog: state.statusLog,
		projectCount: state.projectSummaries.length,
		hasStoredSecret: state.secret !== null,
		lastConnectedAt: state.lastConnectedAt,
	});

	const appendLog = (state: MachineRuntimeState, line: string): void => {
		for (const rawLine of line.split("\n")) {
			const trimmed = rawLine.trimEnd();
			if (!trimmed) {
				continue;
			}
			if (state.statusLog[state.statusLog.length - 1] === trimmed) {
				continue;
			}
			state.statusLog.push(trimmed);
		}
		if (state.statusLog.length > MAX_STATUS_LOG_LINES) {
			state.statusLog.splice(0, state.statusLog.length - MAX_STATUS_LOG_LINES);
		}
	};

	const setStatus = (
		state: MachineRuntimeState,
		status: RuntimeMachineConnectionStatus,
		statusMessage: string | null,
	): void => {
		state.status = status;
		state.statusMessage = statusMessage;
		if (statusMessage) {
			appendLog(state, statusMessage);
		}
		notifyChange();
	};

	const buildProjectSummaries = (
		state: MachineRuntimeState,
		projects: RuntimeProjectSummary[],
	): RuntimeProjectSummary[] =>
		projects.map((project) => ({
			...project,
			id: buildRemoteWorkspaceId(state.stored.id, project.id),
			machineId: state.stored.id,
			machineName: state.stored.name,
			isRemote: true,
			connectionStatus: state.status,
		}));

	const refreshMachineProjects = async (state: MachineRuntimeState): Promise<void> => {
		if (!state.client) {
			return;
		}
		try {
			const response = await state.client.listProjects();
			state.projectSummaries = buildProjectSummaries(state, response.projects);
			notifyChange();
		} catch (error) {
			warn(`Failed to list projects on remote machine ${state.stored.name}: ${String(error)}`);
		}
	};

	const teardownConnection = (state: MachineRuntimeState): void => {
		state.tunnel?.close();
		state.tunnel = null;
		state.connection?.dispose();
		state.connection = null;
		state.client = null;
	};

	const buildSshConnection = (state: MachineRuntimeState): SshConnection =>
		createSshConnection({
			host: state.stored.host,
			port: state.stored.port,
			username: state.stored.username,
			authMethod: state.stored.authMethod,
			password: state.secret?.password ?? null,
			privateKeyPath: state.stored.privateKeyPath,
			passphrase: state.secret?.passphrase ?? null,
		});

	const waitForRemoteHealth = async (client: RemoteRuntimeClient): Promise<boolean> => {
		const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (await client.checkHealth()) {
				return true;
			}
			await delay(HEALTH_POLL_INTERVAL_MS);
		}
		return false;
	};

	const performConnect = async (state: MachineRuntimeState): Promise<void> => {
		teardownConnection(state);
		state.statusLog = [];
		setStatus(state, "connecting", "Connecting over SSH...");
		const connection = buildSshConnection(state);
		await connection.connect();
		state.connection = connection;
		connection.onClose((error) => {
			if (state.connection !== connection) {
				return;
			}
			teardownConnection(state);
			state.projectSummaries = [];
			setStatus(state, "disconnected", error ? `Connection lost: ${error.message}` : "Disconnected");
			// Best-effort single auto-reconnect when we can authenticate without an
			// interactive prompt (key/agent, or a password we still hold in memory).
			const canAutoReconnect = state.stored.authMethod !== "password" || Boolean(state.secret?.password);
			if (canAutoReconnect) {
				setTimeout(() => {
					if (state.status === "disconnected" && !state.connectPromise) {
						void connectMachine(state.stored.id).catch(() => {});
					}
				}, AUTO_RECONNECT_DELAY_MS);
			}
		});

		setStatus(state, "bootstrapping", "Preparing the remote Kanban runtime...");
		const runtime = await ensureRemoteRuntime(connection, {
			machineId: state.stored.id,
			remoteInstallDir: state.stored.remoteInstallDir,
			reportProgress: (message) => {
				setStatus(state, "bootstrapping", message);
			},
		});
		if (runtime.installDir && runtime.installDir !== state.stored.remoteInstallDir) {
			const updated = await store.update(state.stored.id, { remoteInstallDir: runtime.installDir });
			if (updated) {
				state.stored = updated;
			}
		}

		const tunnel = await connection.openTunnel(runtime.remotePort);
		state.tunnel = tunnel;
		const client = createRemoteRuntimeClient(`http://127.0.0.1:${tunnel.localPort}`);
		state.client = client;

		setStatus(state, "connecting", "Waiting for the remote runtime to become ready...");
		const healthy = await waitForRemoteHealth(client);
		if (!healthy) {
			const logTail = await readRemoteRuntimeLogTail(connection);
			teardownConnection(state);
			const detail = logTail ? ` Remote runtime log:\n${logTail}` : "";
			throw new Error(`Remote Kanban runtime did not become ready in time.${detail}`);
		}

		state.lastConnectedAt = Date.now();
		const updated = await store.update(state.stored.id, { lastConnectedAt: state.lastConnectedAt });
		if (updated) {
			state.stored = updated;
		}
		setStatus(state, "connected", null);
		await refreshMachineProjects(state);
	};

	const connectMachine = async (
		machineId: string,
		secret?: MachineSecret | null,
	): Promise<{ machine: RuntimeMachineSummary | null; error?: string }> => {
		const state = machineStates.get(machineId);
		if (!state) {
			return { machine: null, error: `Unknown machine: ${machineId}` };
		}
		// A caller-supplied secret (e.g. the user re-entering a password after a hub
		// restart wiped the in-memory copy) takes over so the machine can reconnect
		// without being removed and re-added.
		if (secret && (secret.password || secret.passphrase)) {
			state.secret = { password: secret.password, passphrase: secret.passphrase };
		}
		if (state.connectPromise) {
			await state.connectPromise.catch(() => {});
			return { machine: toMachineSummary(state) };
		}
		const connectPromise = performConnect(state);
		state.connectPromise = connectPromise;
		try {
			await connectPromise;
			return { machine: toMachineSummary(state) };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			teardownConnection(state);
			appendLog(state, message);
			setStatus(state, "error", message);
			return { machine: toMachineSummary(state), error: message };
		} finally {
			state.connectPromise = null;
		}
	};

	const registerStoredMachine = (stored: StoredRemoteMachine, secret: MachineSecret | null): MachineRuntimeState => {
		const state: MachineRuntimeState = {
			stored,
			secret,
			connection: null,
			tunnel: null,
			client: null,
			status: "disconnected",
			statusMessage: null,
			statusLog: [],
			projectSummaries: [],
			lastConnectedAt: stored.lastConnectedAt,
			connectPromise: null,
		};
		machineStates.set(stored.id, state);
		return state;
	};

	const disconnectMachine = async (
		machineId: string,
	): Promise<{ machine: RuntimeMachineSummary | null; error?: string }> => {
		const state = machineStates.get(machineId);
		if (!state) {
			return { machine: null, error: `Unknown machine: ${machineId}` };
		}
		teardownConnection(state);
		state.projectSummaries = [];
		setStatus(state, "disconnected", null);
		return { machine: toMachineSummary(state) };
	};

	return {
		initialize: async () => {
			const stored = await store.list();
			for (const machine of stored) {
				registerStoredMachine(machine, null);
			}
			// Auto-reconnect machines that do not need an interactive secret.
			for (const machine of stored) {
				if (machine.authMethod === "key" || machine.authMethod === "agent") {
					void connectMachine(machine.id).catch(() => {});
				}
			}
		},
		close: async () => {
			for (const state of machineStates.values()) {
				teardownConnection(state);
			}
			machineStates.clear();
		},
		onChange: (listener) => {
			changeListeners.add(listener);
			return () => {
				changeListeners.delete(listener);
			};
		},

		listMachineSummaries: () => Array.from(machineStates.values()).map(toMachineSummary),

		addMachine: async (input) => {
			const authMethod = input.authMethod ?? (input.password ? "password" : input.privateKeyPath ? "key" : "agent");
			const stored = await store.add({
				name: input.name,
				host: input.host,
				port: input.port,
				username: input.username,
				authMethod,
				privateKeyPath: input.privateKeyPath ?? null,
			});
			const secret: MachineSecret | null =
				input.rememberSecret === false
					? null
					: input.password || input.passphrase
						? { password: input.password, passphrase: input.passphrase }
						: null;
			registerStoredMachine(stored, secret);
			const result = await connectMachine(stored.id);
			return result;
		},

		testConnection: async (input) => {
			const authMethod = input.authMethod ?? (input.password ? "password" : input.privateKeyPath ? "key" : "agent");
			const connection = createSshConnection({
				host: input.host,
				port: input.port ?? 22,
				username: input.username,
				authMethod,
				password: input.password ?? null,
				privateKeyPath: input.privateKeyPath ?? null,
				passphrase: input.passphrase ?? null,
			});
			try {
				await connection.connect();
				const environment = await detectRemoteEnvironment(connection);
				return {
					ok: true,
					nodeVersion: environment.nodeVersion,
					nodeSatisfiesMinimum: environment.nodeSatisfiesMinimum,
					kanbanRuntimeAvailable: environment.kanbanRuntimeAvailable,
				};
			} catch (error) {
				return {
					ok: false,
					nodeVersion: null,
					nodeSatisfiesMinimum: false,
					kanbanRuntimeAvailable: false,
					error: error instanceof Error ? error.message : String(error),
				};
			} finally {
				connection.dispose();
			}
		},

		connectMachine,
		disconnectMachine,

		removeMachine: async (machineId) => {
			const state = machineStates.get(machineId);
			if (state) {
				teardownConnection(state);
				machineStates.delete(machineId);
			}
			const removed = await store.remove(machineId);
			notifyChange();
			return { ok: removed };
		},

		listMachineDirectoryContents: async (machineId, path) => {
			const state = machineStates.get(machineId);
			if (!state?.client) {
				throw new Error("Machine is not connected.");
			}
			return await state.client.listDirectoryContents({ path });
		},

		addMachineProject: async (input) => {
			const state = machineStates.get(input.machineId);
			if (!state?.client) {
				return { ok: false, project: null, error: "Machine is not connected." };
			}
			const response = await state.client.addProject({
				path: input.path,
				gitUrl: input.gitUrl,
				initializeGit: input.initializeGit,
			});
			await refreshMachineProjects(state);
			if (response.ok && response.project) {
				return {
					...response,
					project: {
						...response.project,
						id: buildRemoteWorkspaceId(state.stored.id, response.project.id),
						machineId: state.stored.id,
						machineName: state.stored.name,
						isRemote: true,
						connectionStatus: state.status,
					},
				};
			}
			return response;
		},

		isRemoteWorkspaceId,
		listRemoteProjectSummaries: () => {
			const summaries: RuntimeProjectSummary[] = [];
			for (const state of machineStates.values()) {
				summaries.push(...state.projectSummaries);
			}
			return summaries;
		},
		resolveProxyTarget: (hubWorkspaceId) => {
			const parsed = parseRemoteWorkspaceId(hubWorkspaceId);
			if (!parsed) {
				return null;
			}
			const state = machineStates.get(parsed.machineId);
			if (!state?.client) {
				return null;
			}
			return {
				targetOrigin: state.client.baseUrl,
				nativeWorkspaceId: parsed.nativeWorkspaceId,
			};
		},
		getWorkspaceState: async (hubWorkspaceId) => {
			const parsed = parseRemoteWorkspaceId(hubWorkspaceId);
			if (!parsed) {
				return null;
			}
			const state = machineStates.get(parsed.machineId);
			if (!state?.client) {
				return null;
			}
			try {
				return await state.client.getWorkspaceState(parsed.nativeWorkspaceId);
			} catch (error) {
				warn(`Failed to load remote workspace state for ${hubWorkspaceId}: ${String(error)}`);
				return null;
			}
		},
		subscribeWorkspaceStream: (hubWorkspaceId, handlers) => {
			const parsed = parseRemoteWorkspaceId(hubWorkspaceId);
			if (!parsed) {
				return null;
			}
			const state = machineStates.get(parsed.machineId);
			if (!state?.client) {
				return null;
			}
			const subscription = state.client.openStateStream(parsed.nativeWorkspaceId, {
				onMessage: (message) => {
					const translated = translateRemoteMessage(message, parsed.nativeWorkspaceId, hubWorkspaceId);
					if (translated) {
						handlers.onMessage(translated);
					}
				},
				onClose: handlers.onClose,
				onError: (error) => {
					warn(`Remote state stream error for ${hubWorkspaceId}: ${error.message}`);
				},
			});
			return () => {
				subscription.close();
			};
		},
	};
}

/**
 * Rewrites the native remote workspace id inside a state-stream delta to the
 * hub-namespaced id, and drops messages the hub already owns (snapshot /
 * projects — the hub builds a federated version of those itself).
 */
function translateRemoteMessage(
	message: RuntimeStateStreamMessage,
	nativeWorkspaceId: string,
	hubWorkspaceId: string,
): RuntimeStateStreamMessage | null {
	switch (message.type) {
		case "snapshot":
		case "projects_updated":
			return null;
		case "workspace_state_updated":
		case "task_sessions_updated":
		case "workspace_metadata_updated":
		case "task_ready_for_review":
		case "task_chat_message":
		case "task_chat_cleared":
			if (message.workspaceId !== nativeWorkspaceId) {
				return null;
			}
			return { ...message, workspaceId: hubWorkspaceId };
		default:
			return message;
	}
}
