// Configuration for the Jenkins "pools" Kanban can borrow machines from. Each
// pool targets a different Jenkins instance + job with its own parameter schema,
// credentials, borrowed-list strategy and post-borrow SSH settings. Office uses
// the classic `BorrowMachine` job (machines are Jenkins nodes); AWS uses
// `BorrowMachineAI` (machines are EC2 instances reached by private IP).
import {
	AWS_INSTANCE_TYPES,
	BORROW_MACHINE_TYPES,
	type BorrowMachineType,
	type BorrowPoolId,
	buildBorrowParams,
	CREDS_FILE,
	DEFAULT_JENKINS_USER,
	type JenkinsCreds,
	readJenkinsCredsFile,
} from "./jenkins-borrow-client";

export type { BorrowPoolId } from "./jenkins-borrow-client";

// SSH settings for provisioning / connecting to a freshly-borrowed machine.
const SSH_USER = process.env.KANBAN_BORROW_SSH_USER ?? "dn";
const SSH_PASSWORD = process.env.KANBAN_BORROW_SSH_PASSWORD ?? "drivenets";
const OFFICE_SSH_PORT = Number.parseInt(process.env.KANBAN_BORROW_SSH_PORT ?? "2222", 10) || 2222;

export interface BorrowPoolSshConfig {
	username: string;
	password: string;
	/** Port to try password auth on (office: 2222 full-env; AWS: 22). */
	passwordPort: number;
	/** Try the hub's SSH agent/key on port 22 first (office). */
	tryHubKey: boolean;
	/** Whether a failed provisioning step should fail the borrow job. */
	provisionFailureFatal: boolean;
}

export interface BorrowPoolConfig {
	id: BorrowPoolId;
	label: string;
	baseUrl: string;
	job: string;
	/** Env var + creds-file key for this pool's API token. */
	tokenEnv: string;
	fileTokenKey: string;
	/** Env var + creds-file key for this pool's username (falls back to the shared user). */
	userEnv: string;
	fileUserKey: string;
	types: readonly string[];
	listStrategy: "nodeLabels" | "buildHistory";
	ssh: BorrowPoolSshConfig;
	buildBorrowParams: (input: { type: string; leaseHours: number }) => Record<string, string>;
	buildExtendParams: (machine: string, leaseHours: number) => Record<string, string>;
	buildReturnParams: (machine: string) => Record<string, string>;
}

export const BORROW_POOLS: Record<BorrowPoolId, BorrowPoolConfig> = {
	office: {
		id: "office",
		label: "Office",
		baseUrl: "https://jenkins.dev.drivenets.net",
		job: "BorrowMachine",
		tokenEnv: "JENKINS_API_TOKEN",
		fileTokenKey: "JENKINS_API_TOKEN",
		userEnv: "JENKINS_USER",
		fileUserKey: "JENKINS_USER",
		types: BORROW_MACHINE_TYPES,
		listStrategy: "nodeLabels",
		ssh: {
			username: SSH_USER,
			password: SSH_PASSWORD,
			passwordPort: OFFICE_SSH_PORT,
			tryHubKey: true,
			provisionFailureFatal: true,
		},
		buildBorrowParams: (input) =>
			buildBorrowParams({ type: input.type as BorrowMachineType, leaseHours: input.leaseHours }),
		buildExtendParams: (machine, leaseHours) => ({
			Action: "Extend",
			EXTEND_SLAVE: machine,
			NEW_LEASE_TIME: String(leaseHours),
		}),
		buildReturnParams: (machine) => ({ Action: "Return", RETURN_SLAVE: machine }),
	},
	aws: {
		id: "aws",
		label: "AWS",
		baseUrl: "https://jenkins-aws.dev.drivenets.net",
		job: "BorrowMachineAI",
		tokenEnv: "JENKINS_AWS_API_TOKEN",
		fileTokenKey: "JENKINS_AWS_API_TOKEN",
		// Same human/username as office; only the API token differs per instance.
		userEnv: "JENKINS_AWS_USER",
		fileUserKey: "JENKINS_AWS_USER",
		types: AWS_INSTANCE_TYPES,
		listStrategy: "buildHistory",
		ssh: {
			username: SSH_USER,
			password: SSH_PASSWORD,
			passwordPort: 22,
			tryHubKey: false,
			provisionFailureFatal: false,
		},
		buildBorrowParams: (input) => ({
			Action: "Borrow",
			INSTANCE_TYPE: input.type,
			NUM_MACHINES: "1",
			LEASE_TIME: String(input.leaseHours),
			REPOSITORY: "cheetah",
			GIT_BRANCH: "",
		}),
		buildExtendParams: (machine, leaseHours) => ({
			Action: "Extend",
			EXTEND_INSTANCE: machine,
			NEW_LEASE_TIME: String(leaseHours),
		}),
		buildReturnParams: (machine) => ({ Action: "Return", RETURN_INSTANCE: machine }),
	},
};

export function listBorrowPools(): BorrowPoolConfig[] {
	return Object.values(BORROW_POOLS);
}

/** Resolve credentials for a pool, preferring pool-specific values then shared ones. */
export async function loadPoolCreds(pool: BorrowPoolConfig): Promise<JenkinsCreds> {
	const fileMap = await readJenkinsCredsFile();
	const user =
		process.env[pool.userEnv]?.trim() ||
		process.env.JENKINS_USER?.trim() ||
		fileMap[pool.fileUserKey]?.trim() ||
		fileMap.JENKINS_USER?.trim() ||
		DEFAULT_JENKINS_USER;
	const token = process.env[pool.tokenEnv]?.trim() || fileMap[pool.fileTokenKey]?.trim();
	if (!token) {
		throw new Error(
			`Missing Jenkins API token for ${pool.label}. Set ${pool.tokenEnv} in the environment or ` +
				`${pool.fileTokenKey} in ${CREDS_FILE} (create one at ${pool.baseUrl}/me/configure).`,
		);
	}
	return { user, token };
}
