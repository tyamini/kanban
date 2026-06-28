import type { RuntimeAgentId } from "../core/api-contract";
import { hasCodexWorkspaceTrustPrompt } from "./codex-workspace-trust";

// Cursor's interactive trust gate ("Do you trust the contents of this
// directory?") asks the same question Codex does and defaults to the
// "Trust this workspace" option, so the existing Enter-keypress confirmation
// applies unchanged. Reuse the Codex prompt detector to stay DRY.
export function hasCursorWorkspaceTrustPrompt(text: string): boolean {
	return hasCodexWorkspaceTrustPrompt(text);
}

export function shouldAutoConfirmCursorWorkspaceTrust(agentId: RuntimeAgentId, cwd: string): boolean {
	void cwd;
	return agentId === "cursor";
}
