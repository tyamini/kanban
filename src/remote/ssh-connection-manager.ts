// Low-level SSH connection + TCP tunnel wrapper built on `ssh2`.
//
// A single SshConnection owns one authenticated SSH session to a remote host.
// It can run one-off commands (used by bootstrap/health checks) and open local
// TCP tunnels that forward `127.0.0.1:<localPort>` on the hub to a loopback
// port on the remote (used to reach the remote Kanban runtime).
import { readFile } from "node:fs/promises";
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";

import { Client, type ConnectConfig } from "ssh2";

import type { RuntimeMachineAuthMethod } from "../core/api-contract";

const DEFAULT_READY_TIMEOUT_MS = 20_000;
const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE_MAX_COUNT = 4;

export interface SshConnectionOptions {
	host: string;
	port: number;
	username: string;
	authMethod: RuntimeMachineAuthMethod;
	password?: string | null;
	privateKeyPath?: string | null;
	passphrase?: string | null;
	readyTimeoutMs?: number;
}

export interface SshExecResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

export interface SshTunnel {
	localPort: number;
	close: () => void;
}

export interface SshExecOptions {
	/**
	 * Hard ceiling for the command. Omit (the default) to wait indefinitely —
	 * required for genuinely long operations like remote `npm install`/build.
	 * Set a value for probe-class commands so a wedged/OOM'd remote surfaces an
	 * error instead of leaving a half-open channel that never emits `close`.
	 */
	timeoutMs?: number;
}

export interface SshConnection {
	connect: () => Promise<void>;
	exec: (command: string, options?: SshExecOptions) => Promise<SshExecResult>;
	uploadFile: (localPath: string, remotePath: string) => Promise<void>;
	openTunnel: (remotePort: number) => Promise<SshTunnel>;
	isConnected: () => boolean;
	onClose: (listener: (error: Error | null) => void) => () => void;
	dispose: () => void;
}

async function buildConnectConfig(options: SshConnectionOptions): Promise<ConnectConfig> {
	const base: ConnectConfig = {
		host: options.host,
		port: options.port,
		username: options.username,
		readyTimeout: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
		keepaliveInterval: KEEPALIVE_INTERVAL_MS,
		keepaliveCountMax: KEEPALIVE_MAX_COUNT,
	};

	if (options.authMethod === "password") {
		if (!options.password) {
			throw new Error("Password is required for password authentication.");
		}
		// `tryKeyboard` covers servers that present the password prompt as
		// keyboard-interactive rather than the `password` auth method.
		return {
			...base,
			password: options.password,
			tryKeyboard: true,
		};
	}

	if (options.authMethod === "key") {
		if (!options.privateKeyPath) {
			throw new Error("A private key path is required for key authentication.");
		}
		let privateKey: Buffer;
		try {
			privateKey = await readFile(options.privateKeyPath);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Could not read private key at ${options.privateKeyPath}: ${message}`);
		}
		return {
			...base,
			privateKey,
			...(options.passphrase ? { passphrase: options.passphrase } : {}),
		};
	}

	// agent
	const agentSock = process.env.SSH_AUTH_SOCK;
	if (!agentSock) {
		throw new Error("SSH agent authentication requested but SSH_AUTH_SOCK is not set.");
	}
	return {
		...base,
		agent: agentSock,
	};
}

export function createSshConnection(options: SshConnectionOptions): SshConnection {
	const client = new Client();
	const closeListeners = new Set<(error: Error | null) => void>();
	const openTunnelServers = new Set<Server>();
	let ready = false;
	let disposed = false;

	const notifyClose = (error: Error | null): void => {
		ready = false;
		for (const listener of closeListeners) {
			try {
				listener(error);
			} catch {
				// Ignore listener errors during close notification.
			}
		}
	};

	client.on("close", () => {
		notifyClose(null);
	});
	client.on("error", (error: Error) => {
		notifyClose(error);
	});
	// Some password-only servers negotiate keyboard-interactive; answer every
	// prompt with the configured password.
	client.on("keyboard-interactive", (_name, _instructions, _lang, _prompts, finish) => {
		finish(options.password ? [options.password] : []);
	});

	const connect = (): Promise<void> =>
		new Promise((resolveConnect, rejectConnect) => {
			let settled = false;
			const onReady = () => {
				if (settled) {
					return;
				}
				settled = true;
				ready = true;
				client.off("error", onError);
				resolveConnect();
			};
			const onError = (error: Error) => {
				if (settled) {
					return;
				}
				settled = true;
				client.off("ready", onReady);
				rejectConnect(error);
			};
			client.once("ready", onReady);
			client.once("error", onError);
			void buildConnectConfig(options)
				.then((config) => {
					client.connect(config);
				})
				.catch((error) => {
					onError(error instanceof Error ? error : new Error(String(error)));
				});
		});

	const exec = (command: string, options: SshExecOptions = {}): Promise<SshExecResult> =>
		new Promise((resolveExec, rejectExec) => {
			client.exec(command, (error, stream) => {
				if (error) {
					rejectExec(error);
					return;
				}
				let stdout = "";
				let stderr = "";
				let code: number | null = null;
				let settled = false;
				let timer: ReturnType<typeof setTimeout> | null = null;
				const cleanup = (): void => {
					if (timer) {
						clearTimeout(timer);
						timer = null;
					}
				};
				const settleResolve = (result: SshExecResult): void => {
					if (settled) {
						return;
					}
					settled = true;
					cleanup();
					resolveExec(result);
				};
				const settleReject = (streamError: Error): void => {
					if (settled) {
						return;
					}
					settled = true;
					cleanup();
					rejectExec(streamError);
				};
				if (options.timeoutMs && options.timeoutMs > 0) {
					timer = setTimeout(() => {
						// Force the channel down so we do not leak it, then reject. A
						// thrashing/OOM'd remote can keep a channel half-open forever
						// without ever emitting `close`, which is the exact hang we are
						// guarding against here.
						try {
							stream.close();
						} catch {
							// Ignore — best-effort teardown.
						}
						try {
							stream.destroy();
						} catch {
							// Ignore — best-effort teardown.
						}
						settleReject(
							new Error(`Remote command timed out after ${options.timeoutMs}ms: ${command.slice(0, 120)}`),
						);
					}, options.timeoutMs);
					timer.unref?.();
				}
				stream.on("data", (chunk: Buffer) => {
					stdout += chunk.toString("utf8");
				});
				stream.stderr.on("data", (chunk: Buffer) => {
					stderr += chunk.toString("utf8");
				});
				stream.on("exit", (exitCode: number | null) => {
					code = exitCode;
				});
				stream.on("close", () => {
					settleResolve({ code, stdout, stderr });
				});
				stream.on("error", (streamError: Error) => {
					settleReject(streamError);
				});
			});
		});

	const uploadFile = (localPath: string, remotePath: string): Promise<void> =>
		new Promise((resolveUpload, rejectUpload) => {
			client.sftp((error, sftp) => {
				if (error) {
					rejectUpload(error);
					return;
				}
				sftp.fastPut(localPath, remotePath, (putError) => {
					if (putError) {
						rejectUpload(putError);
						return;
					}
					resolveUpload();
				});
			});
		});

	const openTunnel = (remotePort: number): Promise<SshTunnel> =>
		new Promise((resolveTunnel, rejectTunnel) => {
			const tcpServer = createServer((socket: Socket) => {
				client.forwardOut(
					socket.remoteAddress ?? "127.0.0.1",
					socket.remotePort ?? 0,
					"127.0.0.1",
					remotePort,
					(error, stream) => {
						if (error) {
							socket.destroy();
							return;
						}
						socket.pipe(stream).pipe(socket);
						const destroyBoth = () => {
							socket.destroy();
							stream.destroy();
						};
						socket.on("error", destroyBoth);
						stream.on("error", destroyBoth);
					},
				);
			});
			tcpServer.on("error", (error) => {
				rejectTunnel(error);
			});
			tcpServer.listen(0, "127.0.0.1", () => {
				const address = tcpServer.address() as AddressInfo | null;
				if (!address) {
					tcpServer.close();
					rejectTunnel(new Error("Could not allocate a local tunnel port."));
					return;
				}
				openTunnelServers.add(tcpServer);
				resolveTunnel({
					localPort: address.port,
					close: () => {
						openTunnelServers.delete(tcpServer);
						tcpServer.close();
					},
				});
			});
		});

	return {
		connect,
		exec,
		uploadFile,
		openTunnel,
		isConnected: () => ready && !disposed,
		onClose: (listener) => {
			closeListeners.add(listener);
			return () => {
				closeListeners.delete(listener);
			};
		},
		dispose: () => {
			if (disposed) {
				return;
			}
			disposed = true;
			for (const tcpServer of openTunnelServers) {
				try {
					tcpServer.close();
				} catch {
					// Ignore tunnel close errors during dispose.
				}
			}
			openTunnelServers.clear();
			try {
				client.end();
			} catch {
				// Ignore client end errors during dispose.
			}
		},
	};
}
