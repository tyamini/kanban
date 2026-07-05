import { useCallback } from "react";

import type { RuntimeBorrowPoolId } from "@/runtime/types";
import { useJsonLocalStorageValue } from "@/utils/react-use";

const STORAGE_KEY = "kanban.borrow.machineTags";

type TagMap = Record<string, string>;

function tagKey(pool: RuntimeBorrowPoolId, machine: string): string {
	return `${pool}:${machine}`;
}

/**
 * UI-only friendly names for borrowed machines. AWS instances have no
 * human-readable name (just an instance id), so users can label them here.
 * Stored in localStorage and never sent to Jenkins.
 */
export function useMachineTags(): {
	getTag: (pool: RuntimeBorrowPoolId, machine: string) => string | undefined;
	setTag: (pool: RuntimeBorrowPoolId, machine: string, name: string) => void;
} {
	const [tags, setTags] = useJsonLocalStorageValue<TagMap>(STORAGE_KEY, {});

	const getTag = useCallback(
		(pool: RuntimeBorrowPoolId, machine: string) => {
			const value = tags[tagKey(pool, machine)]?.trim();
			return value ? value : undefined;
		},
		[tags],
	);

	const setTag = useCallback(
		(pool: RuntimeBorrowPoolId, machine: string, name: string) => {
			const key = tagKey(pool, machine);
			setTags((current) => {
				const next = { ...current };
				const trimmed = name.trim();
				if (trimmed) {
					next[key] = trimmed;
				} else {
					delete next[key];
				}
				return next;
			});
		},
		[setTags],
	);

	return { getTag, setTag };
}
