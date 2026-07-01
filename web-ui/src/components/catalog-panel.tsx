import { ChevronLeft, Library, Pencil, Plus, Trash2 } from "lucide-react";
import { type ReactElement, useState } from "react";

import { type TaskBranchOption, TaskInlineCreateCard } from "@/components/task-inline-create-card";
import { Button } from "@/components/ui/button";
import type { RuntimeAgentId, RuntimeClineReasoningEffort, RuntimeTaskClineSettings } from "@/runtime/types";
import type { TaskDraft } from "@/state/board-state";
import { LocalStorageKey } from "@/storage/local-storage-store";
import type { BoardCatalogEntry, TaskAutoReviewMode, TaskImage } from "@/types";
import { useBooleanLocalStorageValue } from "@/utils/react-use";
import { normalizePromptForDisplay } from "@/utils/task-prompt";

interface CatalogEditorDefaults {
	workspaceId: string | null;
	branchOptions: TaskBranchOption[];
	defaultBranchRef: string;
	defaultAgentId: RuntimeAgentId | null;
	defaultProviderId: string | null;
	defaultModelId: string | null;
	defaultReasoningEffort: RuntimeClineReasoningEffort | null;
}

interface CatalogPanelProps extends CatalogEditorDefaults {
	catalog: BoardCatalogEntry[];
	onCreate: (draft: TaskDraft) => void;
	onUpdate: (catalogId: string, draft: TaskDraft) => void;
	onDelete: (catalogId: string) => void;
	onAddToBacklog: (catalogId: string) => void;
}

/** Editor for a single catalog entry; reuses the task editor without the "Start" action. */
function CatalogEntryEditor({
	initialEntry,
	defaults,
	mode,
	onSubmit,
	onCancel,
}: {
	initialEntry?: BoardCatalogEntry;
	defaults: CatalogEditorDefaults;
	mode: "create" | "edit";
	onSubmit: (draft: TaskDraft) => void;
	onCancel: () => void;
}): ReactElement {
	const [prompt, setPrompt] = useState(initialEntry?.prompt ?? "");
	const [images, setImages] = useState<TaskImage[]>(initialEntry?.images ?? []);
	const [startInPlanMode, setStartInPlanMode] = useState(initialEntry?.startInPlanMode ?? false);
	const [autoReviewEnabled, setAutoReviewEnabled] = useState(initialEntry?.autoReviewEnabled ?? true);
	const [autoReviewMode, setAutoReviewMode] = useState<TaskAutoReviewMode>(initialEntry?.autoReviewMode ?? "commit");
	const [branchRef, setBranchRef] = useState(initialEntry?.baseRef ?? defaults.defaultBranchRef);
	const [agentId, setAgentId] = useState<RuntimeAgentId | undefined>(initialEntry?.agentId);
	const [clineSettings, setClineSettings] = useState<RuntimeTaskClineSettings | undefined>(
		initialEntry?.clineSettings,
	);

	const handleSubmit = () => {
		if (!prompt.trim() || !branchRef.trim()) {
			return;
		}
		onSubmit({
			prompt,
			images,
			startInPlanMode,
			autoReviewEnabled,
			autoReviewMode,
			baseRef: branchRef,
			agentId,
			clineSettings,
		});
	};

	return (
		<TaskInlineCreateCard
			prompt={prompt}
			onPromptChange={setPrompt}
			images={images}
			onImagesChange={setImages}
			onCreate={handleSubmit}
			onCancel={onCancel}
			startInPlanMode={startInPlanMode}
			onStartInPlanModeChange={setStartInPlanMode}
			autoReviewEnabled={autoReviewEnabled}
			onAutoReviewEnabledChange={setAutoReviewEnabled}
			autoReviewMode={autoReviewMode}
			onAutoReviewModeChange={setAutoReviewMode}
			workspaceId={defaults.workspaceId}
			branchRef={branchRef}
			branchOptions={defaults.branchOptions}
			onBranchRefChange={setBranchRef}
			agentId={agentId}
			onAgentIdChange={setAgentId}
			clineSettings={clineSettings}
			onClineSettingsChange={setClineSettings}
			defaultAgentId={defaults.defaultAgentId}
			defaultProviderId={defaults.defaultProviderId}
			defaultModelId={defaults.defaultModelId}
			defaultReasoningEffort={defaults.defaultReasoningEffort}
			mode={mode}
			idPrefix={`catalog-${mode}-${initialEntry?.id ?? "new"}`}
		/>
	);
}

function CatalogEntryCard({
	entry,
	onAddToBacklog,
	onEdit,
	onDelete,
}: {
	entry: BoardCatalogEntry;
	onAddToBacklog: () => void;
	onEdit: () => void;
	onDelete: () => void;
}): ReactElement {
	const displayTitle = normalizePromptForDisplay(entry.title) || normalizePromptForDisplay(entry.prompt);
	return (
		<div className="rounded-md border border-border-bright bg-surface-2 p-2.5" style={{ marginBottom: 6 }}>
			<p className="line-clamp-2 text-[12px] text-text-primary" title={entry.prompt}>
				{displayTitle || "Untitled task"}
			</p>
			<div className="mt-2 flex items-center justify-between gap-1">
				<Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={onAddToBacklog}>
					Add to Backlog
				</Button>
				<div className="flex items-center gap-1">
					<Button
						size="sm"
						variant="ghost"
						icon={<Pencil size={14} />}
						aria-label="Edit catalog task"
						onClick={onEdit}
					/>
					<Button
						size="sm"
						variant="ghost"
						className="text-status-red hover:text-status-red"
						icon={<Trash2 size={14} />}
						aria-label="Delete catalog task"
						onClick={onDelete}
					/>
				</div>
			</div>
		</div>
	);
}

export function CatalogPanel({
	catalog,
	onCreate,
	onUpdate,
	onDelete,
	onAddToBacklog,
	...defaults
}: CatalogPanelProps): ReactElement {
	const [collapsed, setCollapsed] = useBooleanLocalStorageValue(LocalStorageKey.CatalogPanelCollapsed, true);
	const [isCreating, setIsCreating] = useState(false);
	const [editingId, setEditingId] = useState<string | null>(null);

	if (collapsed) {
		return (
			<button
				type="button"
				onClick={() => setCollapsed(false)}
				className="flex w-9 shrink-0 flex-col items-center gap-2 rounded-lg border border-border bg-surface-1 py-3 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
				aria-label="Open task catalog"
				title="Open task catalog"
			>
				<Library size={16} />
				<span className="text-[11px] font-medium tracking-wide [writing-mode:vertical-rl]">
					Catalog{catalog.length > 0 ? ` (${catalog.length})` : ""}
				</span>
			</button>
		);
	}

	const startCreate = () => {
		setEditingId(null);
		setIsCreating(true);
	};

	return (
		<section
			className="flex w-[300px] shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-surface-1"
			aria-label="Task catalog"
		>
			<div className="flex items-center justify-between px-3" style={{ height: 40 }}>
				<div className="flex items-center gap-2">
					<Library size={14} className="text-text-secondary" />
					<span className="text-sm font-semibold">Catalog</span>
					<span className="text-xs text-text-secondary">{catalog.length}</span>
				</div>
				<div className="flex items-center gap-1">
					<Button
						size="sm"
						variant="ghost"
						icon={<Plus size={14} />}
						aria-label="New catalog task"
						title="New catalog task"
						onClick={startCreate}
					/>
					<Button
						size="sm"
						variant="ghost"
						icon={<ChevronLeft size={14} />}
						aria-label="Collapse catalog"
						title="Collapse catalog"
						onClick={() => setCollapsed(true)}
					/>
				</div>
			</div>

			<div className="kb-column-cards">
				{isCreating ? (
					<div style={{ marginBottom: 6 }}>
						<CatalogEntryEditor
							defaults={defaults}
							mode="create"
							onSubmit={(draft) => {
								onCreate(draft);
								setIsCreating(false);
							}}
							onCancel={() => setIsCreating(false)}
						/>
					</div>
				) : null}

				{catalog.length === 0 && !isCreating ? (
					<p className="px-1 py-2 text-[11px] text-text-tertiary">
						No catalog tasks yet. Add reusable tasks here, then add them to the backlog when needed.
					</p>
				) : null}

				{catalog.map((entry) =>
					editingId === entry.id ? (
						<div key={entry.id} style={{ marginBottom: 6 }}>
							<CatalogEntryEditor
								initialEntry={entry}
								defaults={defaults}
								mode="edit"
								onSubmit={(draft) => {
									onUpdate(entry.id, draft);
									setEditingId(null);
								}}
								onCancel={() => setEditingId(null)}
							/>
						</div>
					) : (
						<CatalogEntryCard
							key={entry.id}
							entry={entry}
							onAddToBacklog={() => onAddToBacklog(entry.id)}
							onEdit={() => {
								setIsCreating(false);
								setEditingId(entry.id);
							}}
							onDelete={() => onDelete(entry.id)}
						/>
					),
				)}
			</div>
		</section>
	);
}
