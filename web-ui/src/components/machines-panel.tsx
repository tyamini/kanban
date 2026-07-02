import {
	Cable,
	Check,
	Clock,
	HardDriveDownload,
	MonitorSmartphone,
	Plus,
	Server,
	Trash2,
	Undo2,
	X,
} from "lucide-react";
import { type ReactElement, useCallback, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { useBorrowMachines } from "@/hooks/use-borrow-machines";
import { useRemoteMachines } from "@/hooks/use-remote-machines";
import type {
	RuntimeBorrowedMachine,
	RuntimeBorrowJob,
	RuntimeMachineConnectionStatus,
	RuntimeMachineSummary,
} from "@/runtime/types";

const STATUS_LABELS: Record<RuntimeMachineConnectionStatus, string> = {
	connected: "Connected",
	connecting: "Connecting…",
	bootstrapping: "Preparing runtime…",
	disconnected: "Disconnected",
	error: "Error",
};

const STATUS_DOT_CLASS: Record<RuntimeMachineConnectionStatus, string> = {
	connected: "bg-status-green",
	connecting: "bg-status-orange",
	bootstrapping: "bg-status-orange",
	disconnected: "bg-text-tertiary",
	error: "bg-status-red",
};

const inputClass =
	"w-full h-8 px-2.5 text-[13px] rounded-md border border-border bg-surface-2 text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent";

const sectionLabelClass = "px-1 text-[11px] font-medium uppercase tracking-wide text-text-tertiary";

interface AddMachineInitial {
	name?: string;
	host?: string;
	port?: number;
	username?: string;
	password?: string;
}

export function MachinesPanel(): ReactElement {
	const { machines, connectMachine, disconnectMachine, removeMachine } = useRemoteMachines();
	const [addForm, setAddForm] = useState<AddMachineInitial | null>(null);
	const [busyMachineId, setBusyMachineId] = useState<string | null>(null);

	const handleConnect = useCallback(
		async (machineId: string) => {
			setBusyMachineId(machineId);
			try {
				const result = await connectMachine(machineId);
				if (!result.ok) {
					showAppToast({
						intent: "danger",
						icon: "warning-sign",
						message: result.error ?? "Could not connect.",
						timeout: 7000,
					});
				}
			} finally {
				setBusyMachineId(null);
			}
		},
		[connectMachine],
	);

	const handleDisconnect = useCallback(
		async (machineId: string) => {
			setBusyMachineId(machineId);
			try {
				await disconnectMachine(machineId);
			} finally {
				setBusyMachineId(null);
			}
		},
		[disconnectMachine],
	);

	const handleRemove = useCallback(
		async (machineId: string) => {
			setBusyMachineId(machineId);
			try {
				await removeMachine(machineId);
			} finally {
				setBusyMachineId(null);
			}
		},
		[removeMachine],
	);

	return (
		<div
			className="flex-1 min-h-0 overflow-y-auto overscroll-contain flex flex-col gap-2"
			style={{ padding: "8px 12px" }}
		>
			<BorrowSection onConnectToKanban={(initial) => setAddForm(initial)} />

			<div className="my-1 border-t border-border" />
			<span className={sectionLabelClass}>Kanban connections</span>

			<LocalMachineRow />

			{machines.map((machine) => (
				<RemoteMachineRow
					key={machine.id}
					machine={machine}
					isBusy={busyMachineId === machine.id}
					onConnect={() => void handleConnect(machine.id)}
					onDisconnect={() => void handleDisconnect(machine.id)}
					onRemove={() => void handleRemove(machine.id)}
				/>
			))}

			{addForm ? (
				<AddMachineForm key={addForm.name ?? "new"} initial={addForm} onClose={() => setAddForm(null)} />
			) : (
				<button
					type="button"
					className="kb-project-row flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-text-secondary hover:text-text-primary"
					onClick={() => setAddForm({})}
				>
					<Plus size={14} className="shrink-0" />
					<span className="text-sm">Add Machine</span>
				</button>
			)}
		</div>
	);
}

// ── Borrow (Jenkins pool) ───────────────────────────────────────────────────

function formatRemaining(leaseEndEpoch: number | null): string {
	if (!leaseEndEpoch) {
		return "";
	}
	const remainingMs = leaseEndEpoch * 1000 - Date.now();
	if (remainingMs <= 0) {
		return "expired";
	}
	const hours = Math.floor(remainingMs / 3_600_000);
	const minutes = Math.floor((remainingMs % 3_600_000) / 60_000);
	return `${hours}h${minutes}m left`;
}

function BorrowSection({
	onConnectToKanban,
}: {
	onConnectToKanban: (initial: AddMachineInitial) => void;
}): ReactElement {
	const { state, borrow, extend, returnMachine, dismissJob } = useBorrowMachines();
	const [type, setType] = useState<string>("");
	const [lease, setLease] = useState("2");
	const [isSubmitting, setIsSubmitting] = useState(false);

	const effectiveType = type || state.types[0] || "";
	const activeJobs = state.jobs.filter((job) => job.status === "running");
	const recentJobs = state.jobs.filter((job) => job.status !== "running").slice(0, 3);
	// Machines a still-running borrow reserved show up in `mine` before setup
	// finishes; mark them "in setup" and hold back the ready actions.
	const settingUpMachines = new Set(
		activeJobs.map((job) => job.reservedMachine).filter((name): name is string => Boolean(name)),
	);

	const handleBorrow = useCallback(async () => {
		if (!effectiveType) {
			return;
		}
		setIsSubmitting(true);
		try {
			await borrow({ type: effectiveType, leaseHours: Number.parseInt(lease, 10) || 2 });
			showAppToast({
				intent: "success",
				message: `Borrowing a ${effectiveType} machine — this can take a few minutes.`,
				timeout: 5000,
			});
		} catch (error) {
			showAppToast({
				intent: "danger",
				icon: "warning-sign",
				message: error instanceof Error ? error.message : String(error),
				timeout: 7000,
			});
		} finally {
			setIsSubmitting(false);
		}
	}, [borrow, effectiveType, lease]);

	return (
		<div className="flex flex-col gap-2">
			<span className={sectionLabelClass}>Borrowed machines</span>

			{state.credentialsError ? (
				<p className="px-1 text-[11px] text-status-red break-words">{state.credentialsError}</p>
			) : null}

			<div className="flex items-end gap-2">
				<div className="flex-1">
					<span className="block text-[11px] text-text-secondary mb-1">Type</span>
					<select
						value={effectiveType}
						onChange={(event) => setType(event.target.value)}
						disabled={isSubmitting || state.types.length === 0}
						className={inputClass}
					>
						{state.types.map((option) => (
							<option key={option} value={option}>
								{option}
							</option>
						))}
					</select>
				</div>
				<div className="w-16">
					<span className="block text-[11px] text-text-secondary mb-1">Hours</span>
					<input
						type="number"
						min={1}
						value={lease}
						onChange={(event) => setLease(event.target.value)}
						disabled={isSubmitting}
						className={inputClass}
					/>
				</div>
				<Button
					variant="primary"
					size="sm"
					onClick={() => void handleBorrow()}
					disabled={isSubmitting || !effectiveType}
					icon={isSubmitting ? <Spinner size={12} /> : <HardDriveDownload size={13} />}
				>
					Borrow
				</Button>
			</div>

			{[...activeJobs, ...recentJobs].map((job) => (
				<BorrowJobCard key={job.id} job={job} onDismiss={() => void dismissJob(job.id)} />
			))}

			{state.borrowed.length === 0 ? (
				<p className="px-1 text-[11px] text-text-tertiary">No machines borrowed.</p>
			) : (
				state.borrowed.map((machine) => (
					<BorrowedMachineRow
						key={machine.machine}
						machine={machine}
						isSettingUp={settingUpMachines.has(machine.machine)}
						onExtend={(hours) => extend({ machine: machine.machine, leaseHours: hours })}
						onReturn={() => returnMachine(machine.machine)}
						onConnect={() =>
							// Borrowed machines are key/agent reachable on port 22 without a
							// password; leave password empty so auth falls back to the hub's key.
							onConnectToKanban({
								name: machine.machine,
								host: machine.machine,
								port: 22,
								username: "dn",
							})
						}
					/>
				))
			)}
		</div>
	);
}

function BorrowJobCard({ job, onDismiss }: { job: RuntimeBorrowJob; onDismiss: () => void }): ReactElement {
	const isRunning = job.status === "running";
	return (
		<div
			className={cn(
				"flex flex-col gap-1 rounded-md border px-2.5 py-2",
				job.status === "failed" ? "border-status-red/40 bg-status-red/5" : "border-border bg-surface-2",
			)}
		>
			<div className="flex items-center gap-1.5 text-[12px] text-text-primary">
				{isRunning ? (
					<Spinner size={12} />
				) : job.status === "failed" ? (
					<X size={13} className="text-status-red" />
				) : (
					<Check size={13} className="text-status-green" />
				)}
				<span className="font-medium flex-1 truncate">{job.label}</span>
				{!isRunning ? (
					<button
						type="button"
						onClick={onDismiss}
						aria-label="Dismiss"
						className="shrink-0 text-text-tertiary hover:text-text-primary"
					>
						<X size={13} />
					</button>
				) : null}
			</div>
			{job.statusLog.length > 0 ? (
				<pre
					className={cn(
						"max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-snug",
						job.status === "failed" ? "text-status-red" : "text-text-secondary",
					)}
				>
					{job.statusLog.slice(-8).join("\n")}
				</pre>
			) : null}
			{job.buildUrl ? (
				<a
					href={job.buildUrl}
					target="_blank"
					rel="noreferrer"
					className="text-[10.5px] text-accent hover:underline truncate"
				>
					Build log
				</a>
			) : null}
		</div>
	);
}

function BorrowedMachineRow({
	machine,
	isSettingUp,
	onExtend,
	onReturn,
	onConnect,
}: {
	machine: RuntimeBorrowedMachine;
	isSettingUp: boolean;
	onExtend: (hours: number) => Promise<void>;
	onReturn: () => Promise<void>;
	onConnect: () => void;
}): ReactElement {
	const [isBusy, setIsBusy] = useState(false);
	const remaining = formatRemaining(machine.leaseEndEpoch);

	const run = useCallback(async (action: () => Promise<void>) => {
		setIsBusy(true);
		try {
			await action();
		} catch (error) {
			showAppToast({
				intent: "danger",
				icon: "warning-sign",
				message: error instanceof Error ? error.message : String(error),
				timeout: 7000,
			});
		} finally {
			setIsBusy(false);
		}
	}, []);

	return (
		<div className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-2 px-2.5 py-2">
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-2 min-w-0">
					<Server size={15} className="text-text-secondary shrink-0" />
					<span className="truncate font-mono text-[12px] text-text-primary">{machine.machine}</span>
				</div>
				{isSettingUp ? (
					<span className="inline-flex items-center gap-1.5 text-[11px] text-status-orange shrink-0">
						<Spinner size={11} />
						Setting up…
					</span>
				) : remaining ? (
					<span className="inline-flex items-center gap-1 text-[11px] text-text-secondary shrink-0">
						<Clock size={11} />
						{remaining}
					</span>
				) : null}
			</div>
			{isSettingUp ? (
				<p className="text-[11px] text-text-tertiary">
					Still being borrowed — actions become available once setup finishes.
				</p>
			) : (
				<div className="flex items-center gap-1.5">
					<Button variant="primary" size="sm" icon={<Cable size={12} />} onClick={onConnect} disabled={isBusy}>
						Connect to Kanban
					</Button>
					<Button variant="default" size="sm" onClick={() => void run(() => onExtend(2))} disabled={isBusy}>
						+2h
					</Button>
					<Button
						variant="ghost"
						size="sm"
						icon={<Undo2 size={13} />}
						onClick={() => void run(onReturn)}
						disabled={isBusy}
						aria-label={`Return ${machine.machine}`}
					>
						Return
					</Button>
				</div>
			)}
		</div>
	);
}

// ── Kanban connections ──────────────────────────────────────────────────────

function StatusBadge({ status }: { status: RuntimeMachineConnectionStatus }): ReactElement {
	return (
		<span className="inline-flex items-center gap-1.5 text-[11px] text-text-secondary">
			<span className={cn("inline-block h-2 w-2 rounded-full", STATUS_DOT_CLASS[status])} />
			{STATUS_LABELS[status]}
		</span>
	);
}

function LocalMachineRow(): ReactElement {
	return (
		<div className="flex items-center justify-between rounded-md border border-border bg-surface-2 px-2.5 py-2">
			<div className="flex items-center gap-2">
				<MonitorSmartphone size={15} className="text-text-secondary" />
				<div className="flex flex-col">
					<span className="text-[13px] text-text-primary">This machine</span>
					<span className="font-mono text-[11px] text-text-tertiary">local</span>
				</div>
			</div>
			<span className="inline-flex items-center gap-1.5 text-[11px] text-text-secondary">
				<span className="inline-block h-2 w-2 rounded-full bg-status-green" />
				Local
			</span>
		</div>
	);
}

function RemoteMachineRow({
	machine,
	isBusy,
	onConnect,
	onDisconnect,
	onRemove,
}: {
	machine: RuntimeMachineSummary;
	isBusy: boolean;
	onConnect: () => void;
	onDisconnect: () => void;
	onRemove: () => void;
}): ReactElement {
	const isConnected = machine.connectionStatus === "connected";
	const isTransitioning = machine.connectionStatus === "connecting" || machine.connectionStatus === "bootstrapping";
	return (
		<div className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-2 px-2.5 py-2">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2 min-w-0">
					<Server size={15} className="text-text-secondary shrink-0" />
					<div className="flex flex-col min-w-0">
						<span className="truncate text-[13px] text-text-primary">{machine.name}</span>
						<span className="truncate font-mono text-[11px] text-text-tertiary">
							{machine.username}@{machine.host}:{machine.port}
						</span>
					</div>
				</div>
				<StatusBadge status={machine.connectionStatus} />
			</div>

			{isTransitioning && machine.statusMessage ? (
				<p className="text-[11px] break-words text-text-secondary">{machine.statusMessage}</p>
			) : null}

			{(isTransitioning || machine.connectionStatus === "error") && machine.statusLog.length > 0 ? (
				<pre
					className={cn(
						"max-h-40 overflow-auto rounded-sm border border-border bg-surface-0 px-2 py-1.5",
						"whitespace-pre-wrap break-words font-mono text-[10.5px] leading-snug",
						machine.connectionStatus === "error" ? "text-status-red" : "text-text-secondary",
					)}
				>
					{machine.statusLog.join("\n")}
				</pre>
			) : null}

			<div className="flex items-center gap-1.5">
				{isConnected ? (
					<Button variant="default" size="sm" onClick={onDisconnect} disabled={isBusy}>
						Disconnect
					</Button>
				) : (
					<Button
						variant="primary"
						size="sm"
						onClick={onConnect}
						disabled={isBusy || isTransitioning}
						icon={isBusy || isTransitioning ? <Spinner size={12} /> : undefined}
					>
						Connect
					</Button>
				)}
				<Button
					variant="ghost"
					size="sm"
					icon={<Trash2 size={13} />}
					onClick={onRemove}
					disabled={isBusy}
					aria-label={`Remove ${machine.name}`}
				/>
			</div>
		</div>
	);
}

function AddMachineForm({ initial, onClose }: { initial: AddMachineInitial; onClose: () => void }): ReactElement {
	const { addMachine } = useRemoteMachines();
	const [name, setName] = useState(initial.name ?? "");
	const [host, setHost] = useState(initial.host ?? "");
	const [port, setPort] = useState(String(initial.port ?? 22));
	const [username, setUsername] = useState(initial.username ?? "");
	const [password, setPassword] = useState(initial.password ?? "");
	const [privateKeyPath, setPrivateKeyPath] = useState("");
	const [passphrase, setPassphrase] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);

	const handleSubmit = useCallback(async () => {
		if (!name.trim() || !host.trim() || !username.trim()) {
			showAppToast({ intent: "warning", message: "Name, host and username are required.", timeout: 5000 });
			return;
		}
		setIsSubmitting(true);
		try {
			// Auth method is inferred from what's provided (password → key → agent).
			const result = await addMachine({
				name: name.trim(),
				host: host.trim(),
				port: Number.parseInt(port, 10) || 22,
				username: username.trim(),
				password: password || undefined,
				privateKeyPath: privateKeyPath.trim() || undefined,
				passphrase: passphrase || undefined,
				rememberSecret: true,
			});
			if (!result.ok) {
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: result.error ?? "Could not connect to the machine.",
					timeout: 8000,
				});
			}
			onClose();
		} finally {
			setIsSubmitting(false);
		}
	}, [addMachine, host, name, onClose, passphrase, password, port, privateKeyPath, username]);

	return (
		<div className="flex flex-col gap-2 rounded-md border border-border-bright bg-surface-1 p-2.5">
			<div className="flex items-center justify-between">
				<span className="text-[12px] font-medium text-text-primary">Connect a machine</span>
				<button type="button" onClick={onClose} className="text-text-tertiary hover:text-text-primary">
					<X size={14} />
				</button>
			</div>
			<div className="grid grid-cols-2 gap-2">
				<input
					type="text"
					value={name}
					onChange={(event) => setName(event.target.value)}
					placeholder="Name"
					className={inputClass}
					disabled={isSubmitting}
				/>
				<input
					type="text"
					value={username}
					onChange={(event) => setUsername(event.target.value)}
					placeholder="SSH username"
					className={inputClass}
					disabled={isSubmitting}
				/>
			</div>
			<div className="grid grid-cols-[1fr_72px] gap-2">
				<input
					type="text"
					value={host}
					onChange={(event) => setHost(event.target.value)}
					placeholder="Host or IP"
					className={cn(inputClass, "font-mono")}
					disabled={isSubmitting}
				/>
				<input
					type="number"
					value={port}
					onChange={(event) => setPort(event.target.value)}
					placeholder="Port"
					className={inputClass}
					disabled={isSubmitting}
				/>
			</div>
			<input
				type="password"
				value={password}
				onChange={(event) => setPassword(event.target.value)}
				placeholder="Password (blank = use key / agent)"
				className={inputClass}
				disabled={isSubmitting}
				autoComplete="off"
			/>
			<div className="grid grid-cols-2 gap-2">
				<input
					type="text"
					value={privateKeyPath}
					onChange={(event) => setPrivateKeyPath(event.target.value)}
					placeholder="Private key path (optional)"
					className={cn(inputClass, "font-mono")}
					disabled={isSubmitting}
				/>
				<input
					type="password"
					value={passphrase}
					onChange={(event) => setPassphrase(event.target.value)}
					placeholder="Key passphrase (optional)"
					className={inputClass}
					disabled={isSubmitting}
					autoComplete="off"
				/>
			</div>
			<Button
				variant="primary"
				size="sm"
				onClick={() => void handleSubmit()}
				disabled={isSubmitting}
				icon={isSubmitting ? <Spinner size={12} /> : <Check size={13} />}
				className="self-start"
			>
				Connect &amp; Save
			</Button>
			<p className="text-[11px] text-text-tertiary">
				The hub connects over SSH and installs a Kanban runtime on the remote automatically (Node.js is installed if
				missing). Progress and errors appear on the machine below.
			</p>
		</div>
	);
}
