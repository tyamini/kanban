// tRPC-facing handlers for borrowing CI machines from the Jenkins pools. Thin
// wrapper over the BorrowMachineManager; broadcasts a projects update so the
// Machines panel refreshes when borrow state changes.
import type {
	RuntimeBorrowDismissJobRequest,
	RuntimeBorrowDismissJobResponse,
	RuntimeBorrowExtendRequest,
	RuntimeBorrowJobStartedResponse,
	RuntimeBorrowPoolId,
	RuntimeBorrowRequest,
	RuntimeBorrowReturnRequest,
	RuntimeBorrowStateResponse,
} from "../core/api-contract";
import type { BorrowMachineManager } from "../remote/borrow-machine-manager";
import { BORROW_POOLS } from "../remote/jenkins-borrow-pools";

export interface BorrowApi {
	getState: () => Promise<RuntimeBorrowStateResponse>;
	borrow: (input: RuntimeBorrowRequest) => Promise<RuntimeBorrowJobStartedResponse>;
	extend: (input: RuntimeBorrowExtendRequest) => Promise<RuntimeBorrowJobStartedResponse>;
	return: (input: RuntimeBorrowReturnRequest) => Promise<RuntimeBorrowJobStartedResponse>;
	dismissJob: (input: RuntimeBorrowDismissJobRequest) => Promise<RuntimeBorrowDismissJobResponse>;
}

function assertBorrowType(pool: RuntimeBorrowPoolId, type: string): void {
	const poolConfig = BORROW_POOLS[pool];
	if (!(poolConfig.types as readonly string[]).includes(type)) {
		throw new Error(
			`Unknown machine type "${type}" for ${poolConfig.label}. Valid types: ${poolConfig.types.join(", ")}`,
		);
	}
}

export function createBorrowApi(deps: { borrowManager: BorrowMachineManager }): BorrowApi {
	const { borrowManager } = deps;
	return {
		getState: async () => borrowManager.getState(),
		borrow: async (input) => {
			assertBorrowType(input.pool, input.type);
			return borrowManager.startBorrow(input);
		},
		extend: async (input) => borrowManager.startExtend(input),
		return: async (input) => borrowManager.startReturn(input),
		dismissJob: async (input) => borrowManager.dismissJob(input.jobId),
	};
}

export function createUnavailableBorrowApi(): BorrowApi {
	const unavailable = () => {
		throw new Error("Machine borrowing is not enabled on this server.");
	};
	return {
		getState: async () => ({ pools: [], borrowed: [], jobs: [] }),
		borrow: unavailable,
		extend: unavailable,
		return: unavailable,
		dismissJob: async () => ({ ok: false }),
	};
}
