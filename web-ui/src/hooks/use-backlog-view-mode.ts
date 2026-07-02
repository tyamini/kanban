import type { Dispatch, SetStateAction } from "react";
import { useCallback } from "react";

import { LocalStorageKey } from "@/storage/local-storage-store";
import { useRawLocalStorageValue } from "@/utils/react-use";

export type BacklogViewMode = "classic" | "square";

const DEFAULT_BACKLOG_VIEW_MODE: BacklogViewMode = "classic";

function normalizeBacklogViewMode(value: string): BacklogViewMode | null {
	return value === "classic" || value === "square" ? value : null;
}

export function useBacklogViewMode(): {
	viewMode: BacklogViewMode;
	setViewMode: Dispatch<SetStateAction<BacklogViewMode>>;
	toggleViewMode: () => void;
} {
	const [viewMode, setViewMode] = useRawLocalStorageValue<BacklogViewMode>(
		LocalStorageKey.BacklogViewMode,
		DEFAULT_BACKLOG_VIEW_MODE,
		normalizeBacklogViewMode,
	);
	const toggleViewMode = useCallback(() => {
		setViewMode(viewMode === "classic" ? "square" : "classic");
	}, [setViewMode, viewMode]);
	return { viewMode, setViewMode, toggleViewMode };
}
