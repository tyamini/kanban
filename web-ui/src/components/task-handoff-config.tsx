import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { cn } from "@/components/ui/cn";
import { HANDOFF_VARIABLE_DESCRIPTORS } from "@/handoff/build-handoff-variables";
import { resolveHandoffPrompt } from "@/handoff/resolve-handoff-prompt";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { getTaskWorkspaceSnapshot } from "@/stores/workspace-metadata-store";
import {
	type BoardCard,
	type BoardDependency,
	resolveTaskHandoffMode,
	type TaskHandoff,
	type TaskHandoffMode,
} from "@/types";

const MODE_OPTIONS: Array<{ value: TaskHandoffMode; label: string; hint: string }> = [
	{ value: "summary", label: "Append summary", hint: "Prepend the upstream agent's final message." },
	{ value: "template", label: "Custom template", hint: "Write your own prompt with {{from.*}} variables." },
	{ value: "none", label: "None", hint: "Start with this task's own prompt only." },
];

const DEFAULT_TEMPLATE = "Review the upstream result:\n{{from.summary}}\n\nPR: {{from.pr_url}}";

interface TaskHandoffConfigProps {
	dependency: BoardDependency;
	upstreamTask: BoardCard;
	downstreamTask: BoardCard;
	upstreamSummary: RuntimeTaskSessionSummary | undefined;
	onChange: (dependencyId: string, handoff: TaskHandoff | undefined) => void;
}

export function TaskHandoffConfig({
	dependency,
	upstreamTask,
	downstreamTask,
	upstreamSummary,
	onChange,
}: TaskHandoffConfigProps): React.ReactElement {
	const mode = resolveTaskHandoffMode(dependency.handoff?.mode);
	const template = dependency.handoff?.template ?? "";
	const [showPreview, setShowPreview] = useState(false);

	const upstreamWorkspace = getTaskWorkspaceSnapshot(upstreamTask.id);
	const resolvedPrompt = resolveHandoffPrompt({
		downstream: downstreamTask,
		upstream: upstreamTask,
		handoff: dependency.handoff,
		upstreamSummary,
		upstreamWorkspace,
	});

	const setMode = (nextMode: TaskHandoffMode) => {
		if (nextMode === "summary") {
			// summary is the default; omit the field entirely to keep board state tidy
			onChange(dependency.id, undefined);
			return;
		}
		onChange(dependency.id, {
			mode: nextMode,
			...(nextMode === "template" ? { template: template || DEFAULT_TEMPLATE } : {}),
		});
	};

	const setTemplate = (nextTemplate: string) => {
		onChange(dependency.id, { mode: "template", template: nextTemplate });
	};

	const insertVariable = (token: string) => {
		setTemplate(`${template}${template && !template.endsWith(" ") && !template.endsWith("\n") ? " " : ""}${token}`);
	};

	return (
		<div className="border-b border-border bg-surface-1 px-3 py-2 text-xs">
			<div className="mb-2 flex items-center gap-1.5 text-text-secondary">
				<span className="font-medium text-text-primary">Input from</span>
				<span className="truncate text-text-secondary">{upstreamTask.title || "Untitled task"}</span>
				<ArrowRight size={12} className="shrink-0 text-text-tertiary" />
				<span className="truncate text-text-secondary">{downstreamTask.title || "this task"}</span>
			</div>

			<div className="flex flex-wrap gap-1">
				{MODE_OPTIONS.map((option) => (
					<button
						key={option.value}
						type="button"
						title={option.hint}
						onClick={() => setMode(option.value)}
						className={cn(
							"rounded-md border px-2 py-1 transition-colors",
							mode === option.value
								? "border-accent bg-accent/10 text-text-primary"
								: "border-border bg-surface-2 text-text-secondary hover:bg-surface-3",
						)}
					>
						{option.label}
					</button>
				))}
			</div>

			{mode === "template" ? (
				<div className="mt-2 flex flex-col gap-1.5">
					<textarea
						value={template}
						onChange={(event) => setTemplate(event.target.value)}
						rows={4}
						spellCheck={false}
						className="w-full resize-y rounded-md border border-border bg-surface-2 px-2 py-1.5 font-mono text-text-primary outline-none focus:border-border-focus"
						placeholder={DEFAULT_TEMPLATE}
					/>
					<div className="flex flex-wrap gap-1">
						{HANDOFF_VARIABLE_DESCRIPTORS.map((descriptor) => (
							<button
								key={descriptor.token}
								type="button"
								title={descriptor.description}
								onClick={() => insertVariable(descriptor.token)}
								className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-text-secondary hover:bg-surface-3"
							>
								{descriptor.token}
							</button>
						))}
					</div>
				</div>
			) : null}

			{mode !== "none" ? (
				<div className="mt-2">
					<button
						type="button"
						onClick={() => setShowPreview((current) => !current)}
						className="text-text-tertiary hover:text-text-secondary"
					>
						{showPreview ? "Hide" : "Show"} resolved prompt
					</button>
					{showPreview ? (
						<pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-0 p-2 font-mono text-text-secondary">
							{resolvedPrompt || "(empty — upstream has not produced a result yet)"}
						</pre>
					) : null}
				</div>
			) : null}
		</div>
	);
}
