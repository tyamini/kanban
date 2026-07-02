// tRPC-facing handlers for borrowing CI machines from the Jenkins pool. Thin
// wrapper over the BorrowMachineManager; broadcasts a projects update so the
// Machines panel refreshes when borrow state changes.
import type {
	RuntimeBorrowDismissJobRequest,
	RuntimeBorrowDismissJobResponse,
	RuntimeBorrowExtendRequest,
	RuntimeBorrowJobStartedResponse,
	RuntimeBorrowRequest,
	RuntimeBorrowReturnRequest,
	RuntimeBorrowStateResponse,
} from "../core/api-contract";
import type { BorrowMachineManager } from "../remote/borrow-machine-manager";
import { BORROW_MACHINE_TYPES, type BorrowMachineType } from "../remote/jenkins-borrow-client";

export interface BorrowApi {
	getState: () => Promise<RuntimeBorrowStateResponse>;
	borrow: (input: RuntimeBorrowRequest) => Promise<RuntimeBorrowJobStartedResponse>;
	extend: (input: RuntimeBorrowExtendRequest) => Promise<RuntimeBorrowJobStartedResponse>;
	return: (input: RuntimeBorrowReturnRequest) => Promise<RuntimeBorrowJobStartedResponse>;
	dismissJob: (input: RuntimeBorrowDismissJobRequest) => Promise<RuntimeBorrowDismissJobResponse>;
}

function assertBorrowType(type: string): BorrowMachineType {
	if ((BORROW_MACHINE_TYPES as readonly string[]).includes(type)) {
		return type as BorrowMachineType;
	}
	throw new Error(`Unknown machine type "${type}". Valid types: ${BORROW_MACHINE_TYPES.join(", ")}`);
}

export function createBorrowApi(deps: { borrowManager: BorrowMachineManager }): BorrowApi {
	const { borrowManager } = deps;
	return {
		getState: async () => borrowManager.getState(),
		borrow: async (input) =>
			borrowManager.startBorrow({ type: assertBorrowType(input.type), leaseHours: input.leaseHours }),
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
		getState: async () => ({ types: [], borrowed: [], jobs: [], credentialsError: "Borrowing is not enabled." }),
		borrow: unavailable,
		extend: unavailable,
		return: unavailable,
		dismissJob: async () => ({ ok: false }),
	};
}
