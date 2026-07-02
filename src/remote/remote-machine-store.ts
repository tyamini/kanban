// Persists non-secret metadata for remote machines that host federated Kanban
// runtimes. Secrets (passwords / passphrases) are NEVER written here; they live
// only in memory inside the connection manager. Only connection descriptors are
// stored so the hub can reconnect on restart.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { runtimeMachineAuthMethodSchema } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/workspace-state";

const MACHINES_FILENAME = "machines.json";
const STORE_VERSION = 1;
const MACHINE_ID_COLLISION_SUFFIX_LENGTH = 4;
const DEFAULT_SSH_PORT = 22;

export interface StoredRemoteMachine {
	id: string;
	name: string;
	host: string;
	port: number;
	username: string;
	authMethod: z.infer<typeof runtimeMachineAuthMethodSchema>;
	/** Absolute path to a private key on the hub machine (key auth only). */
	privateKeyPath: string | null;
	/** Directory on the remote host where the Kanban fork is installed/built. */
	remoteInstallDir: string | null;
	createdAt: number;
	lastConnectedAt: number | null;
}

const storedRemoteMachineSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	host: z.string().min(1),
	port: z.number().int().positive(),
	username: z.string().min(1),
	authMethod: runtimeMachineAuthMethodSchema,
	privateKeyPath: z.string().nullable().default(null),
	remoteInstallDir: z.string().nullable().default(null),
	createdAt: z.number(),
	lastConnectedAt: z.number().nullable().default(null),
});

const machinesFileSchema = z.object({
	version: z.literal(STORE_VERSION),
	machines: z.record(z.string(), storedRemoteMachineSchema),
});

type MachinesFile = z.infer<typeof machinesFileSchema>;

function getMachinesFilePath(): string {
	return join(getRuntimeHomePath(), MACHINES_FILENAME);
}

function createEmptyMachinesFile(): MachinesFile {
	return { version: STORE_VERSION, machines: {} };
}

function slugifyMachineName(name: string): string {
	const normalized = name
		.normalize("NFKD")
		.toLowerCase()
		// `::` is the remote workspace id separator, so machine ids must exclude it.
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || "machine";
}

function createCollisionSuffix(length: number): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	let suffix = "";
	while (suffix.length < length) {
		for (const byte of randomBytes(length)) {
			suffix += alphabet[byte % alphabet.length] ?? "";
			if (suffix.length === length) {
				break;
			}
		}
	}
	return suffix;
}

async function readMachinesFile(): Promise<MachinesFile> {
	let raw: string;
	try {
		raw = await readFile(getMachinesFilePath(), "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT") {
			return createEmptyMachinesFile();
		}
		throw error;
	}
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw);
	} catch {
		return createEmptyMachinesFile();
	}
	const parsed = machinesFileSchema.safeParse(parsedJson);
	if (!parsed.success) {
		return createEmptyMachinesFile();
	}
	return parsed.data;
}

async function writeMachinesFile(file: MachinesFile): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(getMachinesFilePath(), file, { lock: null });
}

export interface RemoteMachineStore {
	list: () => Promise<StoredRemoteMachine[]>;
	get: (machineId: string) => Promise<StoredRemoteMachine | null>;
	add: (input: {
		name: string;
		host: string;
		port?: number;
		username: string;
		authMethod: StoredRemoteMachine["authMethod"];
		privateKeyPath?: string | null;
		remoteInstallDir?: string | null;
	}) => Promise<StoredRemoteMachine>;
	update: (
		machineId: string,
		patch: Partial<Omit<StoredRemoteMachine, "id" | "createdAt">>,
	) => Promise<StoredRemoteMachine | null>;
	remove: (machineId: string) => Promise<boolean>;
}

export function createRemoteMachineStore(): RemoteMachineStore {
	const createMachineId = (file: MachinesFile, name: string): string => {
		const base = slugifyMachineName(name);
		if (!file.machines[base]) {
			return base;
		}
		for (let attempt = 0; attempt < 256; attempt += 1) {
			const candidate = `${base}-${createCollisionSuffix(MACHINE_ID_COLLISION_SUFFIX_LENGTH)}`;
			if (!file.machines[candidate]) {
				return candidate;
			}
		}
		throw new Error(`Could not generate a unique machine id for "${name}".`);
	};

	return {
		list: async () => {
			const file = await readMachinesFile();
			return Object.values(file.machines).sort((left, right) => left.name.localeCompare(right.name));
		},
		get: async (machineId) => {
			const file = await readMachinesFile();
			return file.machines[machineId] ?? null;
		},
		add: async (input) => {
			const file = await readMachinesFile();
			const id = createMachineId(file, input.name);
			const machine: StoredRemoteMachine = {
				id,
				name: input.name,
				host: input.host,
				port: input.port ?? DEFAULT_SSH_PORT,
				username: input.username,
				authMethod: input.authMethod,
				privateKeyPath: input.privateKeyPath ?? null,
				remoteInstallDir: input.remoteInstallDir ?? null,
				createdAt: Date.now(),
				lastConnectedAt: null,
			};
			file.machines[id] = machine;
			await writeMachinesFile(file);
			return machine;
		},
		update: async (machineId, patch) => {
			const file = await readMachinesFile();
			const existing = file.machines[machineId];
			if (!existing) {
				return null;
			}
			const next: StoredRemoteMachine = { ...existing, ...patch, id: existing.id, createdAt: existing.createdAt };
			file.machines[machineId] = next;
			await writeMachinesFile(file);
			return next;
		},
		remove: async (machineId) => {
			const file = await readMachinesFile();
			if (!file.machines[machineId]) {
				return false;
			}
			delete file.machines[machineId];
			await writeMachinesFile(file);
			return true;
		},
	};
}
