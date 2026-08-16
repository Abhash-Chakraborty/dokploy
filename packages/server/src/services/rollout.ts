import { execAsync, execAsyncRemote } from "../utils/process/execAsync";

export interface RolloutTaskFailure {
	task: string;
	state: string;
	error: string;
}

export type RolloutVerdict =
	| "healthy"
	| "converging"
	| "rolled_back"
	| "failing"
	| "missing"
	| "unknown";

export interface RolloutStatus {
	serviceName: string;
	verdict: RolloutVerdict;
	/** One line the reader can act on. */
	detail: string;
	runningReplicas: number;
	desiredReplicas: number;
	/** Swarm's own UpdateStatus.State — only set during and after an update. */
	updateState?: string;
	updateMessage?: string;
	/** Most recent task failures, newest first. */
	recentFailures: RolloutTaskFailure[];
}

/**
 * Swarm rolls a bad deploy back on its own, and says nothing about it.
 *
 * `docker service update` returns as soon as the orchestrator accepts the
 * change, so a deploy "succeeds" while the new tasks are still crash-looping
 * on a failing health check. This gathers the three signals that together tell
 * the real story: replica convergence, Swarm's UpdateStatus, and why individual
 * tasks died.
 */
const buildProbe = (serviceName: string) =>
	[
		`replicas=$(docker service ls --filter name=${serviceName} --format "{{.Replicas}}" 2>/dev/null | head -1)`,
		`update=$(docker service inspect --format "{{json .UpdateStatus}}" ${serviceName} 2>/dev/null || echo "null")`,
		`tasks=$(docker service ps ${serviceName} --no-trunc --format "{{json .}}" 2>/dev/null | head -20)`,
		'printf \'{"replicas":"%s","update":%s,"tasks":"%s"}\' "$replicas" "${update:-null}" "$(echo "$tasks" | base64 | tr -d "\\n")"',
	].join("\n");

interface RawTask {
	Name?: string;
	CurrentState?: string;
	DesiredState?: string;
	Error?: string;
}

interface RawUpdateStatus {
	State?: string;
	Message?: string;
}

/** "2/3" -> [2, 3]; Swarm also emits "1/1 (max 2 per node)". */
const parseReplicas = (value: string): [number, number] => {
	const match = /^(\d+)\/(\d+)/.exec(value.trim());
	if (!match) return [0, 0];
	return [Number(match[1]), Number(match[2])];
};

export const parseRolloutStatus = (
	serviceName: string,
	stdout: string,
): RolloutStatus => {
	const base: RolloutStatus = {
		serviceName,
		verdict: "unknown",
		detail: "Could not read the service's state.",
		runningReplicas: 0,
		desiredReplicas: 0,
		recentFailures: [],
	};

	let parsed: {
		replicas?: string;
		update?: RawUpdateStatus | null;
		tasks?: string;
	};
	try {
		parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
	} catch {
		return base;
	}

	if (!parsed.replicas) {
		return {
			...base,
			verdict: "missing",
			detail: `No Swarm service named ${serviceName} on this host.`,
		};
	}

	const [running, desired] = parseReplicas(parsed.replicas);

	let tasks: RawTask[] = [];
	try {
		const decoded = Buffer.from(parsed.tasks ?? "", "base64").toString("utf8");
		tasks = decoded
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as RawTask);
	} catch {
		tasks = [];
	}

	const recentFailures = tasks
		.filter(
			(task) =>
				task.Error?.trim() ||
				task.CurrentState?.toLowerCase().startsWith("failed"),
		)
		.slice(0, 5)
		.map((task) => ({
			task: task.Name ?? "task",
			state: task.CurrentState ?? "unknown",
			// Docker double-quotes the error inside the JSON field.
			error: (task.Error ?? "").replace(/^"|"$/g, "").trim() || "no detail",
		}));

	const updateState = parsed.update?.State;
	const updateMessage = parsed.update?.Message;

	const withCommon = (
		verdict: RolloutVerdict,
		detail: string,
	): RolloutStatus => ({
		serviceName,
		verdict,
		detail,
		runningReplicas: running,
		desiredReplicas: desired,
		updateState,
		updateMessage,
		recentFailures,
	});

	if (updateState === "rollback_completed") {
		return withCommon(
			"rolled_back",
			"Swarm rolled this service back — the new tasks never became healthy.",
		);
	}
	if (updateState === "rollback_started" || updateState === "rollback_paused") {
		return withCommon("rolled_back", "Swarm is rolling this service back.");
	}
	if (updateState === "paused") {
		return withCommon(
			"failing",
			updateMessage?.trim() ||
				"Swarm paused the update after repeated task failures.",
		);
	}
	if (updateState === "updating") {
		return withCommon(
			"converging",
			`Update in progress — ${running}/${desired} replicas running.`,
		);
	}

	if (desired === 0) {
		return withCommon("missing", "The service is scaled to zero replicas.");
	}
	if (running === desired && recentFailures.length === 0) {
		return withCommon(
			"healthy",
			`All ${desired} replica${desired === 1 ? "" : "s"} running.`,
		);
	}
	if (running === desired) {
		return withCommon(
			"healthy",
			`All ${desired} replica${desired === 1 ? "" : "s"} running, after ${recentFailures.length} earlier task failure${recentFailures.length === 1 ? "" : "s"}.`,
		);
	}
	if (recentFailures.length > 0) {
		return withCommon(
			"failing",
			`Only ${running}/${desired} replicas running. Last failure: ${recentFailures[0]?.error}`,
		);
	}
	return withCommon("converging", `${running}/${desired} replicas running.`);
};

export const getRolloutStatus = async (
	serviceName: string,
	serverId?: string | null,
): Promise<RolloutStatus> => {
	const command = buildProbe(serviceName);
	try {
		const { stdout } = serverId
			? await execAsyncRemote(serverId, command)
			: await execAsync(command);
		return parseRolloutStatus(serviceName, stdout);
	} catch (error) {
		return {
			serviceName,
			verdict: "unknown",
			detail:
				error instanceof Error
					? error.message
					: "Could not reach the host to check the rollout.",
			runningReplicas: 0,
			desiredReplicas: 0,
			recentFailures: [],
		};
	}
};
