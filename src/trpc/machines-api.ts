// tRPC-facing handlers for remote machine management. Thin wrapper around the
// RemoteMachineManager; broadcasts a projects update whenever the federated
// machine/project set changes so the sidebar stays live.
import type {
	RuntimeDirectoryListResponse,
	RuntimeMachineActionResponse,
	RuntimeMachineAddResponse,
	RuntimeMachineConnectionInput,
	RuntimeMachineConnectRequest,
	RuntimeMachineDirectoryListRequest,
	RuntimeMachineIdRequest,
	RuntimeMachineListResponse,
	RuntimeMachineProjectAddRequest,
	RuntimeMachineRemoveResponse,
	RuntimeMachineTestConnectionResponse,
	RuntimeProjectAddResponse,
} from "../core/api-contract";
import type { RemoteMachineManager } from "../remote/remote-machine-manager";

export interface MachinesApi {
	list: () => Promise<RuntimeMachineListResponse>;
	add: (input: RuntimeMachineConnectionInput) => Promise<RuntimeMachineAddResponse>;
	testConnection: (input: RuntimeMachineConnectionInput) => Promise<RuntimeMachineTestConnectionResponse>;
	connect: (input: RuntimeMachineConnectRequest) => Promise<RuntimeMachineActionResponse>;
	disconnect: (input: RuntimeMachineIdRequest) => Promise<RuntimeMachineActionResponse>;
	remove: (input: RuntimeMachineIdRequest) => Promise<RuntimeMachineRemoveResponse>;
	listDirectoryContents: (input: RuntimeMachineDirectoryListRequest) => Promise<RuntimeDirectoryListResponse>;
	addProject: (input: RuntimeMachineProjectAddRequest) => Promise<RuntimeProjectAddResponse>;
}

export interface CreateMachinesApiDependencies {
	machineManager: RemoteMachineManager;
	broadcastRuntimeProjectsUpdated: (preferredCurrentProjectId: string | null) => Promise<void>;
}

export function createMachinesApi(deps: CreateMachinesApiDependencies): MachinesApi {
	const { machineManager } = deps;
	const broadcastProjects = () => {
		void deps.broadcastRuntimeProjectsUpdated(null);
	};

	return {
		list: async () => ({ machines: machineManager.listMachineSummaries() }),
		add: async (input) => {
			const result = await machineManager.addMachine(input);
			broadcastProjects();
			return { ok: !result.error, machine: result.machine, error: result.error };
		},
		testConnection: async (input) => machineManager.testConnection(input),
		connect: async (input) => {
			const result = await machineManager.connectMachine(input.machineId, {
				password: input.password,
				passphrase: input.passphrase,
			});
			broadcastProjects();
			return { ok: !result.error, machine: result.machine, error: result.error };
		},
		disconnect: async (input) => {
			const result = await machineManager.disconnectMachine(input.machineId);
			broadcastProjects();
			return { ok: !result.error, machine: result.machine, error: result.error };
		},
		remove: async (input) => {
			const result = await machineManager.removeMachine(input.machineId);
			broadcastProjects();
			return result;
		},
		listDirectoryContents: async (input) => machineManager.listMachineDirectoryContents(input.machineId, input.path),
		addProject: async (input) => {
			const response = await machineManager.addMachineProject(input);
			broadcastProjects();
			return response;
		},
	};
}
