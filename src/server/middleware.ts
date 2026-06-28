import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import {
	getKanbanRuntimeHost,
	getKanbanRuntimeOrigin,
	getKanbanRuntimePort,
	isKanbanRemoteHost,
} from "../core/runtime-endpoint";

export type CorsDecision =
	| { kind: "allow"; origin: string | null }
	| { kind: "preflight"; origin: string }
	| { kind: "reject"; origin: string };

export interface CorsGateInput {
	method: string | undefined;
	originHeader: string | undefined;
	allowedOrigin: string;
	additionalAllowedOrigins?: ReadonlySet<string>;
}

const isDev = process.env.NODE_ENV === "development";

export function evaluateCors(input: CorsGateInput): CorsDecision {
	const origin = input.originHeader || null;
	const isPreflight = input.method === "OPTIONS";

	if (origin === null) {
		return { kind: "allow", origin: null };
	}

	const isDevServer = isDev && (origin === "http://localhost:4173" || origin === "http://127.0.0.1:4173");
	const isConfiguredOrigin = input.additionalAllowedOrigins?.has(origin) ?? false;

	if (origin !== input.allowedOrigin && !isConfiguredOrigin && !isDevServer) {
		return { kind: "reject", origin };
	}

	if (isPreflight) {
		return { kind: "preflight", origin };
	}

	return { kind: "allow", origin };
}

export interface HostGateInput {
	hostHeader: string | undefined;
	allowedHosts: ReadonlySet<string>;
}

export type HostDecision = { kind: "allow" } | { kind: "reject"; host: string | null };

export function evaluateHost(input: HostGateInput): HostDecision {
	if (!input.hostHeader) {
		return { kind: "reject", host: null };
	}

	if (!input.allowedHosts.has(input.hostHeader.toLowerCase())) {
		return { kind: "reject", host: input.hostHeader };
	}

	return { kind: "allow" };
}

function parseConfiguredAllowedHostPorts(): string[] {
	const raw = process.env.KANBAN_ALLOWED_HOSTS?.trim();
	if (!raw) {
		return [];
	}
	const port = getKanbanRuntimePort();
	const result: string[] = [];
	for (const part of raw.split(",")) {
		const host = part.trim().toLowerCase();
		if (!host) {
			continue;
		}
		result.push(host.includes(":") ? host : `${host}:${port}`);
	}
	return result;
}

function getConfiguredAllowedOrigins(): ReadonlySet<string> {
	const scheme = getKanbanRuntimeOrigin().split("://", 1)[0];
	const origins = new Set<string>();
	for (const hostPort of parseConfiguredAllowedHostPorts()) {
		origins.add(`${scheme}://${hostPort}`);
	}
	return origins;
}

export function getAllowedHostHeaders(): ReadonlySet<string> {
	const port = getKanbanRuntimePort();
	const boundHost = getKanbanRuntimeHost().toLowerCase();
	const allowed = new Set<string>();
	const addHostPort = (host: string) => {
		allowed.add(`${host}:${port}`);
	};

	for (const hostPort of parseConfiguredAllowedHostPorts()) {
		allowed.add(hostPort);
	}

	// Always allow loopback so local CLI subcommands and the port probe keep
	// working even when the server is bound to a remote interface.
	addHostPort("localhost");
	addHostPort("127.0.0.1");

	if (isKanbanRemoteHost()) {
		addHostPort(boundHost);
		return allowed;
	}

	if (isDev) {
		// Vite's default dev server host:port
		allowed.add("localhost:4173");
		allowed.add("127.0.0.1:4173");
	}
	return allowed;
}

const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].join(", ");
const ALLOWED_HEADERS = ["Authorization", "Content-Type", "X-Kanban-Workspace-Id"].join(", ");
const PREFLIGHT_MAX_AGE_SECONDS = "600";

function applyAllowedOriginHeaders(res: ServerResponse, origin: string): void {
	res.setHeader("Access-Control-Allow-Origin", origin);
	res.setHeader("Vary", "Origin");
	res.setHeader("Access-Control-Allow-Credentials", "true");
}

function rejectRequest(res: ServerResponse, message: string): { end: boolean } {
	res.writeHead(403, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});
	res.end(JSON.stringify({ error: message }));
	return { end: true };
}

function rejectSocket(socket: Duplex): { end: boolean } {
	socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
	socket.destroy();
	return { end: true };
}

export function handleHttpRequest(req: IncomingMessage, res: ServerResponse): { end: boolean } {
	const hostDecision = evaluateHost({
		hostHeader: req.headers.host,
		allowedHosts: getAllowedHostHeaders(),
	});
	if (hostDecision.kind === "reject") {
		return rejectRequest(res, "Host not allowed.");
	}

	const corsDecision = evaluateCors({
		method: req.method,
		originHeader: req.headers.origin,
		allowedOrigin: getKanbanRuntimeOrigin(),
		additionalAllowedOrigins: getConfiguredAllowedOrigins(),
	});

	switch (corsDecision.kind) {
		case "allow": {
			if (corsDecision.origin !== null) {
				applyAllowedOriginHeaders(res, corsDecision.origin);
			}
			return { end: false };
		}
		case "preflight": {
			applyAllowedOriginHeaders(res, corsDecision.origin);
			res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
			res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
			res.setHeader("Access-Control-Max-Age", PREFLIGHT_MAX_AGE_SECONDS);
			res.writeHead(204);
			res.end();
			return { end: true };
		}
		case "reject": {
			return rejectRequest(res, "Origin not allowed.");
		}
	}
}

export function handleSocketUpgrade(request: IncomingMessage, socket: Duplex): { end: boolean } {
	const hostDecision = evaluateHost({
		hostHeader: request.headers.host,
		allowedHosts: getAllowedHostHeaders(),
	});
	if (hostDecision.kind === "reject") {
		return rejectSocket(socket);
	}

	const corsDecision = evaluateCors({
		method: request.method,
		originHeader: request.headers.origin,
		allowedOrigin: getKanbanRuntimeOrigin(),
		additionalAllowedOrigins: getConfiguredAllowedOrigins(),
	});
	if (corsDecision.kind === "reject") {
		return rejectSocket(socket);
	}

	return { end: false };
}
