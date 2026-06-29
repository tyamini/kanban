import { CornerDownLeft } from "lucide-react";
import { type ReactElement, useCallback, useState } from "react";

import { Button } from "@/components/ui/button";

interface DoneTaskRepromptComposerProps {
	onSubmit: (prompt: string) => void | Promise<void>;
	disabled?: boolean;
}

/**
 * Composer shown at the bottom of a Done task's detail view. Submitting a prompt
 * sends the task back to In Progress and resumes the agent, continuing the
 * existing conversation with the new prompt.
 */
export function DoneTaskRepromptComposer({ onSubmit, disabled = false }: DoneTaskRepromptComposerProps): ReactElement {
	const [prompt, setPrompt] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const trimmed = prompt.trim();
	const canSubmit = trimmed.length > 0 && !disabled && !isSubmitting;

	const handleSubmit = useCallback(async () => {
		if (trimmed.length === 0 || disabled || isSubmitting) {
			return;
		}
		setIsSubmitting(true);
		try {
			await onSubmit(trimmed);
			setPrompt("");
		} finally {
			setIsSubmitting(false);
		}
	}, [disabled, isSubmitting, onSubmit, trimmed]);

	return (
		<div className="border-t border-border bg-surface-1 px-3 py-2.5">
			<p className="mb-1.5 text-[11px] text-text-tertiary">
				This task is in Done. Add a prompt to send it back to In Progress and continue the agent from where it left
				off.
			</p>
			<textarea
				value={prompt}
				onChange={(event) => setPrompt(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
						event.preventDefault();
						void handleSubmit();
					}
				}}
				rows={3}
				disabled={disabled || isSubmitting}
				placeholder="Continue this task… (e.g. now also handle the error case)"
				className="w-full resize-y rounded-md border border-border bg-surface-2 px-2 py-1.5 text-[12px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-border-focus disabled:opacity-60"
			/>
			<div className="mt-2 flex justify-end">
				<Button
					variant="primary"
					size="sm"
					disabled={!canSubmit}
					onClick={() => void handleSubmit()}
					icon={<CornerDownLeft size={14} />}
				>
					{isSubmitting ? "Resuming…" : "Send to In Progress"}
				</Button>
			</div>
		</div>
	);
}
