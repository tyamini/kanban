// Reverse-proxies HTTP (tRPC) and WebSocket (terminal) traffic for remote
// workspaces to the remote Kanban runtime through its SSH tunnel. The hub owns
// the browser connection; this module forwards the raw request while rewriting
// the hub-namespaced workspace id back to the remote's native id.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";

import httpProxy from "http-proxy";

export interface RemoteProxyTarget {
	/** Origin of the remote runtime as reached through the local tunnel, e.g. http://127.0.0.1:34123 */
	targetOrigin: string;
	/** Workspace id as known by the remote runtime (hub prefix stripped). */
	nativeWorkspaceId: string;
}

export interface RemoteRuntimeProxy {
	proxyHttp: (req: IncomingMessage, res: ServerResponse, target: RemoteProxyTarget) => void;
	proxyWebSocket: (req: IncomingMessage, socket: Socket, head: Buffer, target: RemoteProxyTarget) => void;
	close: () => void;
}

function rewriteWorkspaceIdInUrl(req: IncomingMessage, nativeWorkspaceId: string): void {
	try {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (url.searchParams.has("workspaceId")) {
			url.searchParams.set("workspaceId", nativeWorkspaceId);
			req.url = `${url.pathname}${url.search}`;
		}
	} catch {
		// Leave the URL untouched if it cannot be parsed.
	}
}

export function createRemoteRuntimeProxy(options: { warn?: (message: string) => void } = {}): RemoteRuntimeProxy {
	const warn = options.warn ?? (() => {});
	const proxy = httpProxy.createProxyServer({
		xfwd: false,
		changeOrigin: true,
		ws: true,
	});

	proxy.on("error", (error, _req, res) => {
		warn(`Remote runtime proxy error: ${error.message}`);
		const maybeResponse = res as ServerResponse | Socket | undefined;
		if (maybeResponse && "writeHead" in maybeResponse) {
			try {
				if (!maybeResponse.headersSent) {
					maybeResponse.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
				}
				maybeResponse.end(JSON.stringify({ error: "Remote machine is unreachable." }));
			} catch {
				// Ignore write failures on an already-broken response.
			}
			return;
		}
		if (maybeResponse && "destroy" in maybeResponse) {
			try {
				maybeResponse.destroy();
			} catch {
				// Ignore socket destroy errors.
			}
		}
	});

	return {
		proxyHttp: (req, res, target) => {
			// tRPC carries the workspace id in a header; rewrite it to the remote's
			// native id so the remote runtime resolves the correct workspace.
			req.headers["x-kanban-workspace-id"] = target.nativeWorkspaceId;
			rewriteWorkspaceIdInUrl(req, target.nativeWorkspaceId);
			proxy.web(req, res, { target: target.targetOrigin });
		},
		proxyWebSocket: (req, socket, head, target) => {
			rewriteWorkspaceIdInUrl(req, target.nativeWorkspaceId);
			if (req.headers["x-kanban-workspace-id"]) {
				req.headers["x-kanban-workspace-id"] = target.nativeWorkspaceId;
			}
			proxy.ws(req, socket, head, { target: target.targetOrigin });
		},
		close: () => {
			proxy.close();
		},
	};
}
