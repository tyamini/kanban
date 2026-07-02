import { Droppable } from "@hello-pangea/dnd";
import { LayoutGrid, LayoutList, Play, Plus, Trash2, Workflow } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useState } from "react";

import { BacklogSquareGrid } from "@/components/backlog-square-grid";
import { BoardCard } from "@/components/board-card";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { ColumnIndicator } from "@/components/ui/column-indicator";
import type { BacklogViewMode } from "@/hooks/use-backlog-view-mode";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { isCardDropDisabled, type ProgrammaticCardMoveInFlight } from "@/state/drag-rules";
import type {
	BoardCard as BoardCardModel,
	BoardColumnId,
	BoardColumn as BoardColumnModel,
	BoardDependency,
} from "@/types";

export function BoardColumn({
	column,
	taskSessions,
	onCreateTask,
	onStartTask,
	onStartAllTasks,
	onClearTrash,
	onClearBacklog,
	dependencies,
	backlogViewMode = "classic",
	onToggleBacklogViewMode,
	editingTaskId,
	inlineTaskEditor,
	onEditTask,
	onSaveTitle,
	onCommitTask,
	onOpenPrTask,
	onCancelAutomaticTaskAction,
	onMoveToTrashTask,
	onRestoreFromTrashTask,
	commitTaskLoadingById,
	openPrTaskLoadingById,
	moveToTrashLoadingById,
	onCardClick,
	activeDragTaskId,
	activeDragSourceColumnId,
	programmaticCardMoveInFlight,
	onDependencyPointerDown,
	onDependencyPointerEnter,
	dependencySourceTaskId,
	dependencyTargetTaskId,
	isDependencyLinking,
	workspacePath,
	defaultClineModelId,
}: {
	column: BoardColumnModel;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	onCreateTask?: () => void;
	onStartTask?: (taskId: string) => void;
	onStartAllTasks?: () => void;
	onClearTrash?: () => void;
	onClearBacklog?: () => void;
	dependencies?: BoardDependency[];
	backlogViewMode?: BacklogViewMode;
	onToggleBacklogViewMode?: () => void;
	editingTaskId?: string | null;
	inlineTaskEditor?: ReactNode;
	onEditTask?: (card: BoardCardModel) => void;
	onSaveTitle?: (taskId: string, title: string) => void;
	onCommitTask?: (taskId: string) => void;
	onOpenPrTask?: (taskId: string) => void;
	onCancelAutomaticTaskAction?: (taskId: string) => void;
	onMoveToTrashTask?: (taskId: string) => void;
	onRestoreFromTrashTask?: (taskId: string) => void;
	commitTaskLoadingById?: Record<string, boolean>;
	openPrTaskLoadingById?: Record<string, boolean>;
	moveToTrashLoadingById?: Record<string, boolean>;
	onCardClick?: (card: BoardCardModel) => void;
	activeDragTaskId?: string | null;
	activeDragSourceColumnId?: BoardColumnId | null;
	programmaticCardMoveInFlight?: ProgrammaticCardMoveInFlight | null;
	onDependencyPointerDown?: (taskId: string, event: ReactMouseEvent<HTMLElement>) => void;
	onDependencyPointerEnter?: (taskId: string) => void;
	dependencySourceTaskId?: string | null;
	dependencyTargetTaskId?: string | null;
	isDependencyLinking?: boolean;
	workspacePath?: string | null;
	defaultClineModelId?: string | null;
}): React.ReactElement {
	const [arrangeNonce, setArrangeNonce] = useState(0);
	const isBacklog = column.id === "backlog";
	const isSquareView = isBacklog && backlogViewMode === "square";
	const canCreate = isBacklog && onCreateTask;
	const canStartAllTasks = isBacklog && onStartAllTasks;
	const canClearBacklog = isBacklog && onClearBacklog;
	const canClearTrash = column.id === "trash" && onClearTrash;
	const cardDropType = "CARD";
	const isDropDisabled = isCardDropDisabled(column.id, activeDragSourceColumnId ?? null, {
		activeDragTaskId,
		programmaticCardMoveInFlight,
	});
	const createTaskButtonText = (
		<span className="inline-flex items-center gap-1.5">
			<span>Create task</span>
			<span aria-hidden className="text-text-secondary">
				(c)
			</span>
		</span>
	);

	const renderClassicCards = (): ReactNode[] => {
		const items: ReactNode[] = [];
		let draggableIndex = 0;
		for (const card of column.cards) {
			if (column.id === "backlog" && editingTaskId === card.id) {
				items.push(
					<div key={card.id} data-task-id={card.id} data-column-id={column.id} style={{ marginBottom: 6 }}>
						{inlineTaskEditor}
					</div>,
				);
				continue;
			}
			items.push(
				<BoardCard
					key={card.id}
					card={card}
					index={draggableIndex}
					columnId={column.id}
					sessionSummary={taskSessions[card.id]}
					onStart={onStartTask}
					onMoveToTrash={onMoveToTrashTask}
					onRestoreFromTrash={onRestoreFromTrashTask}
					onCommit={onCommitTask}
					onOpenPr={onOpenPrTask}
					onCancelAutomaticAction={onCancelAutomaticTaskAction}
					isCommitLoading={commitTaskLoadingById?.[card.id] ?? false}
					isOpenPrLoading={openPrTaskLoadingById?.[card.id] ?? false}
					isMoveToTrashLoading={moveToTrashLoadingById?.[card.id] ?? false}
					onDependencyPointerDown={onDependencyPointerDown}
					onDependencyPointerEnter={onDependencyPointerEnter}
					isDependencySource={dependencySourceTaskId === card.id}
					isDependencyTarget={dependencyTargetTaskId === card.id}
					isDependencyLinking={isDependencyLinking}
					workspacePath={workspacePath}
					defaultClineModelId={defaultClineModelId}
					onSaveTitle={onSaveTitle}
					onClick={() => {
						if (column.id === "backlog") {
							onEditTask?.(card);
							return;
						}
						onCardClick?.(card);
					}}
				/>,
			);
			draggableIndex += 1;
		}
		return items;
	};

	return (
		<section
			data-column-id={column.id}
			className="flex flex-col min-w-0 min-h-0 bg-surface-1 rounded-lg overflow-hidden border border-border"
			style={{
				flex: "1 1 0",
			}}
		>
			<div className="flex flex-col min-h-0" style={{ flex: "1 1 0" }}>
				<div
					className="flex items-center justify-between"
					style={{
						height: 40,
						padding: "0 12px",
					}}
				>
					<div className="flex items-center gap-2">
						<ColumnIndicator columnId={column.id} />
						<span className="font-semibold text-sm">{column.title}</span>
						<span className="text-text-secondary text-xs">{column.cards.length}</span>
					</div>
					<div className="flex items-center gap-0.5">
						{isSquareView ? (
							<Button
								icon={<Workflow size={14} />}
								variant="ghost"
								size="sm"
								onClick={() => setArrangeNonce((nonce) => nonce + 1)}
								disabled={column.cards.length === 0}
								aria-label="Auto-arrange by links"
								title={column.cards.length > 0 ? "Auto-arrange by links" : "Backlog is empty"}
							/>
						) : null}
						{isBacklog ? (
							<Button
								icon={isSquareView ? <LayoutList size={14} /> : <LayoutGrid size={14} />}
								variant="ghost"
								size="sm"
								onClick={onToggleBacklogViewMode}
								aria-label={isSquareView ? "Switch to classic view" : "Switch to square view"}
								title={isSquareView ? "Classic view" : "Square view"}
							/>
						) : null}
						{canStartAllTasks ? (
							<Button
								icon={<Play size={14} />}
								variant="ghost"
								size="sm"
								onClick={onStartAllTasks}
								disabled={column.cards.length === 0}
								aria-label="Start all backlog tasks"
								title={column.cards.length > 0 ? "Start all backlog tasks" : "Backlog is empty"}
							/>
						) : null}
						{canClearBacklog ? (
							<Button
								icon={<Trash2 size={14} />}
								variant="ghost"
								size="sm"
								className="text-status-red hover:text-status-red"
								onClick={onClearBacklog}
								disabled={column.cards.length === 0}
								aria-label="Clear all backlog tasks"
								title={column.cards.length > 0 ? "Clear all backlog tasks" : "Backlog is empty"}
							/>
						) : null}
						{canClearTrash ? (
							<Button
								icon={<Trash2 size={14} />}
								variant="ghost"
								size="sm"
								className="text-status-red hover:text-status-red"
								onClick={onClearTrash}
								disabled={column.cards.length === 0}
								aria-label="Clear done"
								title={column.cards.length > 0 ? "Clear done items permanently" : "Done is empty"}
							/>
						) : null}
					</div>
				</div>

				<Droppable droppableId={column.id} type={cardDropType} isDropDisabled={isDropDisabled}>
					{(cardProvided) => (
						<div ref={cardProvided.innerRef} {...cardProvided.droppableProps} className="kb-column-cards">
							{canCreate ? (
								<Button
									icon={<Plus size={14} />}
									aria-label="Create task"
									fill
									onClick={onCreateTask}
									style={{ marginBottom: 6, flexShrink: 0 }}
								>
									{createTaskButtonText}
								</Button>
							) : null}

							{isBacklog ? (
								<>
									<div className={cn(isSquareView && "hidden")} aria-hidden={isSquareView}>
										{renderClassicCards()}
									</div>
									<div className={cn(!isSquareView && "hidden")} aria-hidden={!isSquareView}>
										<BacklogSquareGrid
											cards={column.cards}
											dependencies={dependencies}
											arrangeNonce={arrangeNonce}
											isVisible={isSquareView}
											onCardClick={onCardClick}
											onStart={onStartTask}
										/>
									</div>
								</>
							) : (
								renderClassicCards()
							)}
							{cardProvided.placeholder}
						</div>
					)}
				</Droppable>
			</div>
		</section>
	);
}
