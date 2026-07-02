import { useCallback, useState } from "react";

import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";

export interface SquarePosition {
	x: number;
	y: number;
}

export type BacklogSquarePositions = Record<string, SquarePosition>;

function parsePositions(raw: string | null): BacklogSquarePositions {
	if (!raw) {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") {
			return {};
		}
		const result: BacklogSquarePositions = {};
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (value && typeof value === "object") {
				const { x, y } = value as { x?: unknown; y?: unknown };
				if (typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)) {
					result[key] = { x, y };
				}
			}
		}
		return result;
	} catch {
		return {};
	}
}

export function useBacklogSquarePositions(): {
	positions: BacklogSquarePositions;
	savePositions: (next: BacklogSquarePositions) => void;
} {
	const [positions, setPositions] = useState<BacklogSquarePositions>(() =>
		parsePositions(readLocalStorageItem(LocalStorageKey.BacklogSquareLayout)),
	);
	const savePositions = useCallback((next: BacklogSquarePositions) => {
		setPositions(next);
		writeLocalStorageItem(LocalStorageKey.BacklogSquareLayout, JSON.stringify(next));
	}, []);
	return { positions, savePositions };
}
