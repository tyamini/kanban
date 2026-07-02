// Pure helpers for merging local and remote project summaries into the single
// federated list shown in the unified project sidebar.
import type { RuntimeProjectSummary } from "../core/api-contract";

/**
 * Merge local project summaries with federated remote ones. Local projects come
 * first, then remote projects grouped by machine name, then project name. Remote
 * ids are already hub-namespaced by the machine manager, so there is no id
 * collision with local projects.
 */
export function mergeFederatedProjectSummaries(
	localProjects: RuntimeProjectSummary[],
	remoteProjects: RuntimeProjectSummary[],
): RuntimeProjectSummary[] {
	const seen = new Set<string>();
	const merged: RuntimeProjectSummary[] = [];
	for (const project of localProjects) {
		if (seen.has(project.id)) {
			continue;
		}
		seen.add(project.id);
		merged.push(project);
	}
	const sortedRemote = [...remoteProjects].sort((left, right) => {
		const machineCompare = (left.machineName ?? "").localeCompare(right.machineName ?? "");
		if (machineCompare !== 0) {
			return machineCompare;
		}
		return left.name.localeCompare(right.name);
	});
	for (const project of sortedRemote) {
		if (seen.has(project.id)) {
			continue;
		}
		seen.add(project.id);
		merged.push(project);
	}
	return merged;
}
