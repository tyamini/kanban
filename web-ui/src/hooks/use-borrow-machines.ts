import { useCallback, useEffect, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeBorrowStateResponse } from "@/runtime/types";

const EMPTY_STATE: RuntimeBorrowStateResponse = {
	types: [],
	borrowed: [],
	jobs: [],
	credentialsError: null,
};

/**
 * Borrow-machine (Jenkins pool) hook. Polls borrow state so long-running
 * borrow/return/extend jobs surface their progress live. Uses the unscoped
 * (local) tRPC client so calls stay on the hub.
 */
export function useBorrowMachines(): {
	state: RuntimeBorrowStateResponse;
	refresh: () => Promise<void>;
	borrow: (input: { type: string; leaseHours: number }) => Promise<void>;
	extend: (input: { machine: string; leaseHours: number }) => Promise<void>;
	returnMachine: (machine: string) => Promise<void>;
	dismissJob: (jobId: string) => Promise<void>;
} {
	const [state, setState] = useState<RuntimeBorrowStateResponse>(EMPTY_STATE);
	const client = getRuntimeTrpcClient(null);

	const refresh = useCallback(async () => {
		try {
			const next = await client.borrow.getState.query();
			setState(next);
		} catch {
			// Keep previous state on transient failures.
		}
	}, [client]);

	useEffect(() => {
		void refresh();
		const interval = window.setInterval(() => {
			void refresh();
		}, 4000);
		return () => {
			window.clearInterval(interval);
		};
	}, [refresh]);

	return {
		state,
		refresh,
		borrow: useCallback(
			async (input) => {
				await client.borrow.borrow.mutate(input);
				await refresh();
			},
			[client, refresh],
		),
		extend: useCallback(
			async (input) => {
				await client.borrow.extend.mutate(input);
				await refresh();
			},
			[client, refresh],
		),
		returnMachine: useCallback(
			async (machine) => {
				await client.borrow.return.mutate({ machine });
				await refresh();
			},
			[client, refresh],
		),
		dismissJob: useCallback(
			async (jobId) => {
				await client.borrow.dismissJob.mutate({ jobId });
				await refresh();
			},
			[client, refresh],
		),
	};
}
