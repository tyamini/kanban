import { GripVertical, Play } from "lucide-react";
import type { MouseEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import GridLayout, { type Layout } from "react-grid-layout";

import "react-grid-layout/css/styles.css";

import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import { type BacklogSquarePositions, useBacklogSquarePositions } from "@/hooks/use-backlog-square-positions";
import type { BoardCard as BoardCardModel, BoardDependency } from "@/types";
import { useMeasure } from "@/utils/react-use";
import { normalizePromptForDisplay, truncateTaskPromptLabel } from "@/utils/task-prompt";

const TARGET_CELL_PX = 84;
const GRID_MARGIN_PX = 6;

function buildLayout(cardIds: string[], cols: number, positions: BacklogSquarePositions): Layout[] {
	const occupied = new Set<string>();
	const cellKey = (x: number, y: number) => `${x},${y}`;
	const findFreeCell = (preferX?: number, preferY?: number): { x: number; y: number } => {
		if (preferX != null && preferY != null && preferY >= 0) {
			const clampedX = Math.min(Math.max(0, Math.round(preferX)), Math.max(0, cols - 1));
			const clampedY = Math.max(0, Math.round(preferY));
			if (!occupied.has(cellKey(clampedX, clampedY))) {
				return { x: clampedX, y: clampedY };
			}
		}
		for (let y = 0; ; y += 1) {
			for (let x = 0; x < cols; x += 1) {
				if (!occupied.has(cellKey(x, y))) {
					return { x, y };
				}
			}
		}
	};

	const layout: Layout[] = [];
	for (const id of cardIds) {
		const stored = positions[id];
		const cell = findFreeCell(stored?.x, stored?.y);
		occupied.add(cellKey(cell.x, cell.y));
		layout.push({ i: id, x: cell.x, y: cell.y, w: 1, h: 1, static: false });
	}
	return layout;
}

function layoutToPositions(layout: Layout[]): BacklogSquarePositions {
	const positions: BacklogSquarePositions = {};
	for (const item of layout) {
		positions[item.i] = { x: item.x, y: item.y };
	}
	return positions;
}

/**
 * Lay tasks out level-by-level following the dependency links. A dependency
 * stores the task that runs first as `toTaskId` (upstream) and the task that
 * runs second as `fromTaskId` (downstream), so downstream tasks sit one row
 * below their upstream tasks. Isolated / root tasks occupy the top rows.
 */
function computeDependencyLayout(
	cardIds: string[],
	dependencies: BoardDependency[],
	cols: number,
): BacklogSquarePositions {
	const idSet = new Set(cardIds);
	const parentsByChild = new Map<string, string[]>();
	for (const dependency of dependencies) {
		if (idSet.has(dependency.toTaskId) && idSet.has(dependency.fromTaskId)) {
			const parents = parentsByChild.get(dependency.fromTaskId) ?? [];
			parents.push(dependency.toTaskId);
			parentsByChild.set(dependency.fromTaskId, parents);
		}
	}

	const levelById = new Map<string, number>();
	const visiting = new Set<string>();
	const computeLevel = (id: string): number => {
		const cached = levelById.get(id);
		if (cached != null) {
			return cached;
		}
		if (visiting.has(id)) {
			return 0;
		}
		visiting.add(id);
		let level = 0;
		for (const parent of parentsByChild.get(id) ?? []) {
			level = Math.max(level, computeLevel(parent) + 1);
		}
		visiting.delete(id);
		levelById.set(id, level);
		return level;
	};
	for (const id of cardIds) {
		computeLevel(id);
	}

	const idsByLevel = new Map<number, string[]>();
	for (const id of cardIds) {
		const level = levelById.get(id) ?? 0;
		const ids = idsByLevel.get(level) ?? [];
		ids.push(id);
		idsByLevel.set(level, ids);
	}

	const positions: BacklogSquarePositions = {};
	const safeCols = Math.max(1, cols);
	let row = 0;
	for (const level of [...idsByLevel.keys()].sort((a, b) => a - b)) {
		let col = 0;
		for (const id of idsByLevel.get(level) ?? []) {
			if (col >= safeCols) {
				col = 0;
				row += 1;
			}
			positions[id] = { x: col, y: row };
			col += 1;
		}
		row += 1;
	}
	return positions;
}

export function BacklogSquareGrid({
	cards,
	dependencies = [],
	arrangeNonce = 0,
	isVisible = true,
	onCardClick,
	onStart,
}: {
	cards: BoardCardModel[];
	dependencies?: BoardDependency[];
	arrangeNonce?: number;
	isVisible?: boolean;
	onCardClick?: (card: BoardCardModel) => void;
	onStart?: (taskId: string) => void;
}): React.ReactElement {
	const [measureRef, rect] = useMeasure<HTMLDivElement>();
	const { positions, savePositions } = useBacklogSquarePositions();

	const width = isVisible ? rect.width : 0;
	const cols = width > 0 ? Math.max(2, Math.floor((width + GRID_MARGIN_PX) / (TARGET_CELL_PX + GRID_MARGIN_PX))) : 4;
	const rowHeight = width > 0 ? Math.max(48, (width - GRID_MARGIN_PX * (cols - 1)) / cols) : TARGET_CELL_PX;

	const cardIds = useMemo(() => cards.map((card) => card.id), [cards]);
	const savedLayout = useMemo(() => buildLayout(cardIds, cols, positions), [cardIds, cols, positions]);
	const [layout, setLayout] = useState<Layout[]>(savedLayout);
	const isDraggingRef = useRef(false);

	useEffect(() => {
		if (!isDraggingRef.current) {
			setLayout(savedLayout);
		}
	}, [savedLayout]);

	const arrangeInputRef = useRef({ cardIds, dependencies, cols });
	arrangeInputRef.current = { cardIds, dependencies, cols };
	const hasHandledInitialArrangeRef = useRef(false);
	useEffect(() => {
		if (!hasHandledInitialArrangeRef.current) {
			hasHandledInitialArrangeRef.current = true;
			return;
		}
		const current = arrangeInputRef.current;
		savePositions(computeDependencyLayout(current.cardIds, current.dependencies, current.cols));
	}, [arrangeNonce, savePositions]);

	const handleLayoutChange = (nextLayout: Layout[]) => {
		setLayout(nextLayout);
	};

	const handleDragStop = (nextLayout: Layout[]) => {
		isDraggingRef.current = false;
		setLayout(nextLayout);
		savePositions(layoutToPositions(nextLayout));
	};

	const stopEvent = (event: MouseEvent<HTMLElement>) => {
		event.preventDefault();
		event.stopPropagation();
	};

	return (
		<div ref={measureRef} className="w-full">
			{isVisible && width > 0 ? (
				<GridLayout
					className="kb-backlog-square-grid"
					layout={layout}
					cols={cols}
					rowHeight={rowHeight}
					width={width}
					margin={[GRID_MARGIN_PX, GRID_MARGIN_PX]}
					containerPadding={[0, 0]}
					isResizable={false}
					isDraggable
					compactType={null}
					preventCollision
					draggableHandle=".kb-square-drag-handle"
					draggableCancel=".kb-square-cancel"
					onLayoutChange={handleLayoutChange}
					onDragStart={() => {
						isDraggingRef.current = true;
					}}
					onDragStop={handleDragStop}
				>
					{cards.map((card) => {
						const displayTitle = normalizePromptForDisplay(card.title) || truncateTaskPromptLabel(card.prompt);
						return (
							<div key={card.id} data-task-id={card.id} data-column-id="backlog">
								<div
									className={cn(
										"group relative flex h-full w-full cursor-pointer items-center justify-center",
										"overflow-hidden rounded-md border border-border-bright bg-surface-2 p-1.5 text-center",
										"hover:bg-surface-3",
									)}
									onClick={() => {
										if (isDraggingRef.current) {
											return;
										}
										onCardClick?.(card);
									}}
								>
									<button
										type="button"
										aria-label="Drag task"
										className="kb-square-drag-handle absolute bottom-1 left-1 z-10 inline-flex cursor-grab items-center justify-center rounded-sm p-0.5 text-text-tertiary hover:text-text-primary active:cursor-grabbing"
										onClick={stopEvent}
									>
										<GripVertical size={12} />
									</button>
									<Tooltip content={displayTitle} side="bottom">
										<span className="line-clamp-3 px-3 text-xs font-medium leading-tight text-text-primary">
											{displayTitle}
										</span>
									</Tooltip>
									{onStart ? (
										<button
											type="button"
											aria-label="Start task"
											className="kb-square-cancel absolute right-1 top-1 z-10 inline-flex items-center justify-center rounded-sm p-0.5 text-text-secondary opacity-0 hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent group-hover:opacity-100"
											onMouseDown={stopEvent}
											onClick={(event) => {
												stopEvent(event);
												onStart(card.id);
											}}
										>
											<Play size={12} />
										</button>
									) : null}
								</div>
							</div>
						);
					})}
				</GridLayout>
			) : null}
		</div>
	);
}
