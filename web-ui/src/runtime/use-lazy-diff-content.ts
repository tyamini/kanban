import { useCallback, useEffect, useRef, useState } from "react";

import type { RuntimeWorkspaceFileChange } from "@/runtime/types";

/**
 * When a workspace-changes response is `truncated`, its file entries carry
 * metadata (path, status, +/- counts) but `oldText`/`newText` are null. This
 * hook lazily fetches the full content for individual files on demand (e.g.
 * when the user expands a file section), caching results per file and de-duping
 * in-flight requests. The cache resets whenever `scopeKey` changes.
 */
export function useLazyDiffContent(params: {
	scopeKey: string;
	fetchFileContent: (path: string) => Promise<RuntimeWorkspaceFileChange | null>;
}): {
	contentByPath: Record<string, RuntimeWorkspaceFileChange>;
	requestFileContent: (path: string) => void;
} {
	const { scopeKey, fetchFileContent } = params;
	const [contentByPath, setContentByPath] = useState<Record<string, RuntimeWorkspaceFileChange>>({});
	const requestedPathsRef = useRef<Set<string>>(new Set());
	const fetchFileContentRef = useRef(fetchFileContent);
	fetchFileContentRef.current = fetchFileContent;

	useEffect(() => {
		requestedPathsRef.current = new Set();
		setContentByPath({});
	}, [scopeKey]);

	const requestFileContent = useCallback((path: string) => {
		if (requestedPathsRef.current.has(path)) {
			return;
		}
		requestedPathsRef.current.add(path);
		void (async () => {
			try {
				const file = await fetchFileContentRef.current(path);
				if (file) {
					setContentByPath((previous) => ({ ...previous, [path]: file }));
				} else {
					requestedPathsRef.current.delete(path);
				}
			} catch {
				requestedPathsRef.current.delete(path);
			}
		})();
	}, []);

	return { contentByPath, requestFileContent };
}

/**
 * Merge lazily-loaded per-file content back into a file-change list, replacing
 * entries whose content has been fetched. Returns the original array when
 * nothing has been loaded to preserve referential stability.
 */
export function mergeLazyFileContent(
	files: RuntimeWorkspaceFileChange[],
	contentByPath: Record<string, RuntimeWorkspaceFileChange>,
): RuntimeWorkspaceFileChange[] {
	if (Object.keys(contentByPath).length === 0) {
		return files;
	}
	return files.map((file) => {
		const loaded = contentByPath[file.path];
		if (!loaded) {
			return file;
		}
		return {
			...file,
			oldText: loaded.oldText,
			newText: loaded.newText,
			additions: loaded.additions,
			deletions: loaded.deletions,
		};
	});
}
