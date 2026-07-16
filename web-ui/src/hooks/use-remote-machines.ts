import { useCallback, useEffect, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeDirectoryListResponse,
	RuntimeMachineActionResponse,
	RuntimeMachineAddResponse,
	RuntimeMachineConnectionInput,
	RuntimeMachineSummary,
	RuntimeMachineTestConnectionResponse,
	RuntimeProjectAddResponse,
} from "@/runtime/types";

/**
 * Remote machine control-plane hook. All machine calls go through the unscoped
 * (local) tRPC client so they are never reverse-proxied to a remote runtime.
 */
export function useRemoteMachines(): {
	machines: RuntimeMachineSummary[];
	isLoading: boolean;
	refresh: () => Promise<void>;
	testConnection: (input: RuntimeMachineConnectionInput) => Promise<RuntimeMachineTestConnectionResponse>;
	addMachine: (input: RuntimeMachineConnectionInput) => Promise<RuntimeMachineAddResponse>;
	connectMachine: (
		machineId: string,
		secret?: { password?: string; passphrase?: string },
	) => Promise<RuntimeMachineActionResponse>;
	disconnectMachine: (machineId: string) => Promise<RuntimeMachineActionResponse>;
	removeMachine: (machineId: string) => Promise<{ ok: boolean; error?: string }>;
	listDirectory: (machineId: string, path: string | undefined) => Promise<RuntimeDirectoryListResponse>;
	addProject: (input: {
		machineId: string;
		path?: string;
		gitUrl?: string;
		initializeGit?: boolean;
	}) => Promise<RuntimeProjectAddResponse>;
} {
	const [machines, setMachines] = useState<RuntimeMachineSummary[]>([]);
	const [isLoading, setIsLoading] = useState(false);

	const client = getRuntimeTrpcClient(null);

	const load = useCallback(
		async (options: { silent: boolean }) => {
			if (!options.silent) {
				setIsLoading(true);
			}
			try {
				const response = await client.machines.list.query();
				setMachines(response.machines);
			} catch {
				// Best-effort; keep the previous list on transient failure.
			} finally {
				if (!options.silent) {
					setIsLoading(false);
				}
			}
		},
		[client],
	);

	const refresh = useCallback(async () => {
		await load({ silent: true });
	}, [load]);

	// Poll while mounted so connection progress (connecting → bootstrapping →
	// connected) and error messages surface live without a manual refresh.
	useEffect(() => {
		void load({ silent: false });
		const interval = window.setInterval(() => {
			void load({ silent: true });
		}, 2500);
		return () => {
			window.clearInterval(interval);
		};
	}, [load]);

	return {
		machines,
		isLoading,
		refresh,
		testConnection: useCallback((input) => client.machines.testConnection.mutate(input), [client]),
		addMachine: useCallback(
			async (input) => {
				const result = await client.machines.add.mutate(input);
				await refresh();
				return result;
			},
			[client, refresh],
		),
		connectMachine: useCallback(
			async (machineId, secret) => {
				const result = await client.machines.connect.mutate({
					machineId,
					password: secret?.password,
					passphrase: secret?.passphrase,
				});
				await refresh();
				return result;
			},
			[client, refresh],
		),
		disconnectMachine: useCallback(
			async (machineId) => {
				const result = await client.machines.disconnect.mutate({ machineId });
				await refresh();
				return result;
			},
			[client, refresh],
		),
		removeMachine: useCallback(
			async (machineId) => {
				const result = await client.machines.remove.mutate({ machineId });
				await refresh();
				return result;
			},
			[client, refresh],
		),
		listDirectory: useCallback(
			(machineId, path) => client.machines.listDirectoryContents.query({ machineId, path }),
			[client],
		),
		addProject: useCallback((input) => client.machines.addProject.mutate(input), [client]),
	};
}
