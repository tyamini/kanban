import { useCallback } from "react";

import type { RuntimeBorrowPoolId } from "@/runtime/types";
import { useJsonLocalStorageValue } from "@/utils/react-use";

const STORAGE_KEY = "kanban.borrow.hiddenMachines";

type HiddenMap = Record<string, true>;

function hiddenKey(pool: RuntimeBorrowPoolId, machine: string): string {
	return `${pool}:${machine}`;
}

/**
 * UI-only dismissal for borrowed machines. Orphaned rows are re-derived from
 * Jenkins build history on every refresh, so when a machine no longer exists
 * anywhere (e.g. it was cleaned up out-of-band) the user needs a way to stop
 * seeing it. Stored in localStorage and never sent to Jenkins.
 */
export function useHiddenMachines(): {
	isHidden: (pool: RuntimeBorrowPoolId, machine: string) => boolean;
	hide: (pool: RuntimeBorrowPoolId, machine: string) => void;
	unhide: (pool: RuntimeBorrowPoolId, machine: string) => void;
} {
	const [hidden, setHidden] = useJsonLocalStorageValue<HiddenMap>(STORAGE_KEY, {});

	const isHidden = useCallback(
		(pool: RuntimeBorrowPoolId, machine: string) => hidden[hiddenKey(pool, machine)] === true,
		[hidden],
	);

	const hide = useCallback(
		(pool: RuntimeBorrowPoolId, machine: string) => {
			const key = hiddenKey(pool, machine);
			setHidden((current) => ({ ...current, [key]: true }));
		},
		[setHidden],
	);

	const unhide = useCallback(
		(pool: RuntimeBorrowPoolId, machine: string) => {
			const key = hiddenKey(pool, machine);
			setHidden((current) => {
				const next = { ...current };
				delete next[key];
				return next;
			});
		},
		[setHidden],
	);

	return { isHidden, hide, unhide };
}
