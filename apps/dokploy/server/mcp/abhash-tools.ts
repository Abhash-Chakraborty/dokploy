import type { McpTool } from "./tools";

const str = (value: unknown, name: string) => {
	if (typeof value !== "string" || !value) {
		throw new Error(`\`${name}\` is required and must be a string`);
	}
	return value;
};

const optionalStr = (value: unknown) =>
	typeof value === "string" && value ? value : undefined;

const bool = (value: unknown, fallback: boolean) =>
	typeof value === "boolean" ? value : fallback;

const strings = (value: unknown, name: string) => {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`\`${name}\` must be an array of strings`);
	}
	return value as string[];
};

/** How a queued job or a pending approval is reported back to the agent. */
const queued = (result: { jobId: string | null; approvalId: string | null }) =>
	result.approvalId
		? {
				status: "approval_required",
				approvalId: result.approvalId,
				hint: "A person must approve this. Poll wait_for_approval with this id.",
			}
		: { status: "running", jobId: result.jobId };

/**
 * The tools that change things. Everything goes through the same tRPC
 * caller as the dashboard, so an agent has exactly its key's permissions,
 * responses are stripped of credentials, and destructive work becomes an
 * approval when the key says so.
 */
export const ABHASH_TOOLS: McpTool[] = [
	{
		name: "deploy_application",
		description:
			"Deploy an application. Returns immediately; follow the deployment with list_deployments.",
		annotations: { destructiveHint: false, idempotentHint: false },
		inputSchema: {
			type: "object",
			properties: {
				applicationId: {
					type: "string",
					description: "Application to deploy.",
				},
			},
			required: ["applicationId"],
		},
		run: async (caller, args) =>
			caller.application.deploy({
				applicationId: str(args.applicationId, "applicationId"),
			}),
	},
	{
		name: "set_environment_variables",
		description:
			"Replace an application's environment variables. Use ${{secret.NAME}} to reference a vault secret instead of writing a value; values you write are stored encrypted and never readable by an agent.",
		annotations: { destructiveHint: true, idempotentHint: true },
		inputSchema: {
			type: "object",
			properties: {
				applicationId: { type: "string" },
				env: {
					type: "string",
					description: "The whole KEY=value block, one per line.",
				},
			},
			required: ["applicationId", "env"],
		},
		run: async (caller, args) =>
			caller.application.saveEnvironment({
				applicationId: str(args.applicationId, "applicationId"),
				env: str(args.env, "env"),
				buildArgs: null,
				buildSecrets: null,
				createEnvFile: false,
			} as never),
	},
	{
		name: "list_secrets",
		description:
			"List the vault secrets this key can use: names, descriptions and scope. Values are never returned to an agent; reference them as ${{secret.NAME}}.",
		annotations: { readOnlyHint: true },
		inputSchema: { type: "object", properties: {} },
		run: async (caller) => {
			const secrets = await caller.vault.list();
			return secrets.map((secret) => ({
				name: secret.name,
				description: secret.description,
				scope: secret.scopeLabel,
				lastUsedAt: secret.lastUsedAt,
			}));
		},
	},
	{
		name: "create_secret",
		description:
			"Put a new secret in the vault. Write-only: neither you nor anyone but the owner can read it back.",
		annotations: { destructiveHint: false, idempotentHint: false },
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string", description: "UPPER_SNAKE_CASE." },
				value: { type: "string" },
				description: { type: "string" },
				scopeType: {
					type: "string",
					enum: ["organization", "project", "environment"],
				},
				scopeId: { type: "string" },
			},
			required: ["name", "value"],
		},
		run: async (caller, args) =>
			caller.vault.create({
				name: str(args.name, "name"),
				value: str(args.value, "value"),
				description: optionalStr(args.description) ?? "",
				tags: [],
				expiresAt: null,
				rotateEveryDays: null,
				scopeType:
					(optionalStr(args.scopeType) as "organization") ?? "organization",
				scopeId: optionalStr(args.scopeId),
			}),
	},
	{
		name: "list_jobs",
		description:
			"Background jobs, newest first: fleet commands, backups, drills, firewall applies and Ansible runs.",
		annotations: { readOnlyHint: true },
		inputSchema: {
			type: "object",
			properties: {
				status: {
					type: "array",
					items: { type: "string" },
					description: "queued, running, succeeded, failed, cancelled.",
				},
				limit: { type: "number" },
			},
		},
		run: async (caller, args) =>
			caller.abhashJobs.list({
				status: Array.isArray(args.status)
					? (args.status as ("queued" | "running")[])
					: undefined,
				limit: typeof args.limit === "number" ? args.limit : 20,
			}),
	},
	{
		name: "get_job",
		description: "One job with its status, result and error.",
		annotations: { readOnlyHint: true },
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
		},
		run: async (caller, args) =>
			caller.abhashJobs.get({ id: str(args.id, "id") }),
	},
	{
		name: "get_job_log",
		description: "A job's log from an offset, for following a long run.",
		annotations: { readOnlyHint: true },
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" }, offset: { type: "number" } },
			required: ["id"],
		},
		run: async (caller, args) =>
			caller.abhashJobs.log({
				id: str(args.id, "id"),
				offset: typeof args.offset === "number" ? args.offset : 0,
			}),
	},
	{
		name: "wait_for_approval",
		description:
			"Waits (up to 60 seconds) for a person to decide a pending approval, and reports the outcome. Poll again while it is still pending.",
		annotations: { readOnlyHint: true },
		inputSchema: {
			type: "object",
			properties: { approvalId: { type: "string" } },
			required: ["approvalId"],
		},
		run: async (caller, args) => {
			const id = str(args.approvalId, "approvalId");
			const deadline = Date.now() + 60_000;
			let approval = await caller.agents.approvals.get({ id });
			while (approval.status === "pending" && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 2_000));
				approval = await caller.agents.approvals.get({ id });
			}
			return {
				status: approval.status,
				jobId: approval.jobId,
				reason: approval.reason,
			};
		},
	},
	{
		name: "list_fleet",
		description:
			"Every server with its health, facts, tags and firewall state.",
		annotations: { readOnlyHint: true },
		inputSchema: { type: "object", properties: {} },
		run: async (caller) => caller.fleet.list(),
	},
	{
		name: "run_on_servers",
		description:
			"Run a shell command on one or more servers. Destructive: this usually needs a person's approval, and the reply tells you which.",
		annotations: { destructiveHint: true, idempotentHint: false },
		inputSchema: {
			type: "object",
			properties: {
				serverIds: { type: "array", items: { type: "string" } },
				command: { type: "string" },
				mode: { type: "string", enum: ["parallel", "rolling", "serial"] },
				stopOnFailure: { type: "boolean" },
			},
			required: ["serverIds", "command"],
		},
		run: async (caller, args) =>
			queued(
				await caller.fleet.run({
					action: "exec",
					serverIds: strings(args.serverIds, "serverIds"),
					command: str(args.command, "command"),
					mode: (optionalStr(args.mode) as "rolling") ?? "rolling",
					batchSize: 5,
					stopOnFailure: bool(args.stopOnFailure, true),
				}),
			),
	},
	{
		name: "plan_firewall",
		description:
			"The firewall rules that would be applied to a server, and why each one is there. This is the dry run for apply_firewall.",
		annotations: { readOnlyHint: true },
		inputSchema: {
			type: "object",
			properties: { serverId: { type: "string" } },
			required: ["serverId"],
		},
		run: async (caller, args) =>
			caller.firewall.plan({ serverId: str(args.serverId, "serverId") }),
	},
	{
		name: "apply_firewall",
		description:
			"Apply the firewall to servers. Refused if it would cut Dokploy's own access, and the server rolls back on its own if it cannot be reached afterwards.",
		annotations: { destructiveHint: true, idempotentHint: true },
		inputSchema: {
			type: "object",
			properties: { serverIds: { type: "array", items: { type: "string" } } },
			required: ["serverIds"],
		},
		run: async (caller, args) =>
			queued(
				await caller.firewall.applyNow({
					serverIds: strings(args.serverIds, "serverIds"),
				}),
			),
	},
	{
		name: "mesh_status",
		description:
			"The secure network: the active provider and which servers are on it.",
		annotations: { readOnlyHint: true },
		inputSchema: { type: "object", properties: {} },
		run: async (caller) => caller.mesh.list(),
	},
	{
		name: "backup_health",
		description:
			"Every backup with its age, whether it is out of date, and what the last restore drill found.",
		annotations: { readOnlyHint: true },
		inputSchema: { type: "object", properties: {} },
		run: async (caller) => {
			const overview = await caller.abhashBackups.overview();
			return overview.policies.map((policy) => ({
				id: policy.id,
				name: policy.name,
				target: `${policy.targetKind}:${policy.target}`,
				stale: policy.stale,
				ageHours: policy.ageHours,
				lastStatus: policy.lastRun?.status ?? null,
				lastError: policy.lastRun?.error ?? null,
				lastDrill: policy.lastDrill
					? {
							status: policy.lastDrill.status,
							rtoSeconds: policy.lastDrill.rtoSeconds,
						}
					: null,
			}));
		},
	},
	{
		name: "run_backup",
		description: "Back up now, outside the schedule.",
		annotations: { destructiveHint: false, idempotentHint: false },
		inputSchema: {
			type: "object",
			properties: { policyId: { type: "string" } },
			required: ["policyId"],
		},
		run: async (caller, args) =>
			queued(
				await caller.abhashBackups.runNow({
					policyId: str(args.policyId, "policyId"),
				}),
			),
	},
	{
		name: "run_restore_drill",
		description:
			"Restore the latest snapshot into an isolated copy and check it. This is how you prove a backup would actually restore.",
		annotations: { destructiveHint: false, idempotentHint: false },
		inputSchema: {
			type: "object",
			properties: { drillPolicyId: { type: "string" } },
			required: ["drillPolicyId"],
		},
		run: async (caller, args) =>
			queued(
				await caller.abhashBackups.runDrill({
					drillPolicyId: str(args.drillPolicyId, "drillPolicyId"),
				}),
			),
	},
	{
		name: "list_playbooks",
		description: "The Ansible runs that are set up, with their targets.",
		annotations: { readOnlyHint: true },
		inputSchema: { type: "object", properties: {} },
		run: async (caller) => caller.ansible.templates(),
	},
	{
		name: "run_playbook",
		description:
			"Run a playbook. Check mode (the default) changes nothing and needs no approval; an apply usually does.",
		annotations: { destructiveHint: true, idempotentHint: true },
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				checkMode: { type: "boolean" },
			},
			required: ["id"],
		},
		run: async (caller, args) =>
			queued(
				await caller.ansible.run({
					id: str(args.id, "id"),
					checkMode: bool(args.checkMode, true),
					limit: null,
				}),
			),
	},
];
