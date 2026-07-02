// HTTP + WebSocket client for a remote Kanban runtime reached through an SSH
// tunnel. The remote runs the same RuntimeAppRouter, so we reuse the tRPC proxy
// client pointed at the loopback tunnel port and speak the same state-stream
// protocol back to the hub.
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { WebSocket } from "ws";

import type {
	RuntimeDirectoryListRequest,
	RuntimeDirectoryListResponse,
	RuntimeProjectAddRequest,
	RuntimeProjectAddResponse,
	RuntimeProjectsResponse,
	RuntimeStateStreamMessage,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { runtimeStateStreamMessageSchema } from "../core/api-contract";
import type { RuntimeAppRouter } from "../trpc/app-router";

type RemoteTrpcClient = ReturnType<typeof createTRPCProxyClient<RuntimeAppRouter>>;

export interface RemoteStateStreamHandlers {
	onMessage: (message: RuntimeStateStreamMessage) => void;
	onClose: () => void;
	onError: (error: Error) => void;
}

export interface RemoteStateStreamSubscription {
	close: () => void;
}

export interface RemoteRuntimeClient {
	baseUrl: string;
	checkHealth: () => Promise<boolean>;
	listProjects: () => Promise<RuntimeProjectsResponse>;
	listDirectoryContents: (input: RuntimeDirectoryListRequest) => Promise<RuntimeDirectoryListResponse>;
	addProject: (input: RuntimeProjectAddRequest) => Promise<RuntimeProjectAddResponse>;
	removeProject: (nativeWorkspaceId: string) => Promise<{ ok: boolean; error?: string }>;
	getWorkspaceState: (nativeWorkspaceId: string) => Promise<RuntimeWorkspaceStateResponse>;
	openStateStream: (nativeWorkspaceId: string, handlers: RemoteStateStreamHandlers) => RemoteStateStreamSubscription;
}

function createScopedTrpcClient(baseUrl: string, workspaceId: string | null): RemoteTrpcClient {
	return createTRPCProxyClient<RuntimeAppRouter>({
		links: [
			httpBatchLink({
				url: `${baseUrl}/api/trpc`,
				headers: () => (workspaceId ? { "x-kanban-workspace-id": workspaceId } : {}),
			}),
		],
	});
}

export function createRemoteRuntimeClient(baseUrl: string): RemoteRuntimeClient {
	const wsBaseUrl = baseUrl.replace(/^http/, "ws");
	const unscopedClient = createScopedTrpcClient(baseUrl, null);
	const scopedClientCache = new Map<string, RemoteTrpcClient>();
	const getScopedClient = (workspaceId: string): RemoteTrpcClient => {
		const existing = scopedClientCache.get(workspaceId);
		if (existing) {
			return existing;
		}
		const created = createScopedTrpcClient(baseUrl, workspaceId);
		scopedClientCache.set(workspaceId, created);
		return created;
	};

	return {
		baseUrl,
		checkHealth: async () => {
			try {
				const response = await fetch(`${baseUrl}/api/passcode/status`, {
					headers: { "Cache-Control": "no-store" },
				});
				return response.ok;
			} catch {
				return false;
			}
		},
		listProjects: async () => unscopedClient.projects.list.query(),
		listDirectoryContents: async (input) =>
			// Directory browsing is not workspace-scoped on the remote runtime.
			getScopedClient(input.path ?? "__root__").projects.listDirectoryContents.query(input),
		addProject: async (input) => unscopedClient.projects.add.mutate(input),
		removeProject: async (nativeWorkspaceId) =>
			unscopedClient.projects.remove.mutate({ projectId: nativeWorkspaceId }),
		getWorkspaceState: async (nativeWorkspaceId) => getScopedClient(nativeWorkspaceId).workspace.getState.query(),
		openStateStream: (nativeWorkspaceId, handlers) => {
			const url = new URL(`${wsBaseUrl}/api/runtime/ws`);
			url.searchParams.set("workspaceId", nativeWorkspaceId);
			const socket = new WebSocket(url.toString());
			let closed = false;
			socket.on("message", (data) => {
				try {
					const text = typeof data === "string" ? data : data.toString();
					const parsed = runtimeStateStreamMessageSchema.parse(JSON.parse(text));
					handlers.onMessage(parsed);
				} catch {
					// Ignore malformed frames from the remote runtime.
				}
			});
			socket.on("close", () => {
				if (!closed) {
					handlers.onClose();
				}
			});
			socket.on("error", (error: Error) => {
				handlers.onError(error);
			});
			return {
				close: () => {
					closed = true;
					try {
						socket.close();
					} catch {
						// Ignore close errors.
					}
				},
			};
		},
	};
}
