/**
 * Crash-loop detection, kept free of I/O so it can be tested against
 * captured probe output.
 *
 * Two shapes of "stuck restarting" exist and look nothing alike:
 *  - compose and plain containers restart in place, so the same container's
 *    RestartCount climbs;
 *  - swarm replaces a failed task with a new one, so no container's count
 *    moves. Swarm records why each old task ended, and only `failed` and
 *    `rejected` are crashes; tasks replaced by a deploy end as `shutdown`.
 */

const CONTAINER_FORMAT = [
	"CTR",
	"{{.Id}}",
	"{{.Name}}",
	"{{.State.Status}}",
	"{{.RestartCount}}",
	"{{.State.ExitCode}}",
	'{{index .Config.Labels "com.docker.swarm.service.name"}}',
	'{{index .Config.Labels "com.docker.compose.project"}}',
	'{{index .Config.Labels "com.docker.compose.service"}}',
].join("|");

const TASK_FORMAT =
	"TASK|{{.ServiceID}}|{{.Status.State}}|{{.Status.Timestamp.Unix}}|{{if .Status.ContainerStatus}}{{.Status.ContainerStatus.ExitCode}}{{end}}|{{.Status.Err}}";

/**
 * One round trip per server. The swarm half only answers on a manager and is
 * silenced elsewhere; the trailing `true` keeps an empty host from reading as
 * a failed scan.
 */
export const PROBE_COMMAND = [
	`docker ps -aq --no-trunc | xargs -r docker inspect --format '${CONTAINER_FORMAT}'`,
	`S=$(docker service ls -q 2>/dev/null); [ -n "$S" ] && { docker service inspect --format 'SVC|{{.ID}}|{{.Spec.Name}}' $S 2>/dev/null; docker service ps -q --no-trunc --filter desired-state=shutdown $S 2>/dev/null | xargs -r docker inspect --format '${TASK_FORMAT}' 2>/dev/null; }`,
	"true",
].join("; ");

export interface ContainerSnapshot {
	id: string;
	name: string;
	status: string;
	restartCount: number;
	exitCode: number;
	swarmService: string;
	composeProject: string;
	composeService: string;
}

export interface TaskSnapshot {
	service: string;
	state: string;
	at: number | null;
	exitCode: number | null;
	error: string;
}

export interface Probe {
	containers: ContainerSnapshot[];
	tasks: TaskSnapshot[];
}

const label = (value: string | undefined) =>
	!value || value === "<no value>" ? "" : value;

export const parseProbe = (stdout: string): Probe => {
	const services = new Map<string, string>();
	const containers: ContainerSnapshot[] = [];
	const rawTasks: string[][] = [];

	for (const line of stdout.split("\n")) {
		const fields = line.trim().split("|");
		if (fields[0] === "SVC" && fields.length >= 3) {
			services.set(fields[1] as string, fields[2] as string);
		} else if (fields[0] === "TASK" && fields.length >= 6) {
			rawTasks.push(fields);
		} else if (fields[0] === "CTR" && fields.length === 9) {
			const [, id, name, status, restarts, exit, swarm, project, service] =
				fields;
			containers.push({
				id: id as string,
				name: (name as string).replace(/^\//, ""),
				status: status as string,
				restartCount: Number(restarts) || 0,
				exitCode: Number(exit) || 0,
				swarmService: label(swarm),
				composeProject: label(project),
				composeService: label(service),
			});
		}
	}

	const tasks = rawTasks.map(([, serviceId, state, at, exit, ...error]) => {
		const seconds = Number(at);
		return {
			service: services.get(serviceId as string) ?? (serviceId as string),
			state: state as string,
			at: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
			exitCode: exit ? Number(exit) : null,
			// The error text can itself contain the separator.
			error: error.join("|"),
		};
	});
	return { containers, tasks };
};

export interface GroupRef {
	key: string;
	kind: "swarm" | "compose" | "container";
	/** Candidate Dokploy appNames, most specific first. */
	appNames: string[];
	label: string;
}

const swarmGroup = (service: string): GroupRef => {
	// A stack service is "<stack>_<service>" and the stack is the appName.
	const stack = service.includes("_") ? (service.split("_")[0] as string) : "";
	return {
		key: `swarm:${service}`,
		kind: "swarm",
		appNames: stack ? [service, stack] : [service],
		label: service,
	};
};

export const groupOf = (container: ContainerSnapshot): GroupRef => {
	if (container.swarmService) return swarmGroup(container.swarmService);
	if (container.composeProject) {
		return {
			key: `compose:${container.composeProject}/${container.composeService}`,
			kind: "compose",
			appNames: [container.composeProject],
			label: `${container.composeProject}/${container.composeService}`,
		};
	}
	return {
		key: `container:${container.name}`,
		kind: "container",
		appNames: [container.name],
		label: container.name,
	};
};

export interface WatchState {
	/** Per container: the restart count at the start of the current window. */
	baselines: Record<string, { count: number; at: number }>;
	/** Per group: when it was last reported, for the cooldown. */
	alerted: Record<string, number>;
}

export const emptyState = (): WatchState => ({ baselines: {}, alerted: {} });

export interface CrashLoop {
	group: GroupRef;
	failures: number;
	exitCode: number | null;
	detail: string;
}

export const WINDOW_MS = 15 * 60_000;
export const COOLDOWN_MS = 60 * 60_000;
export const FAILURE_THRESHOLD = 3;

const FAILED_TASK_STATES = new Set(["failed", "rejected"]);

export const detectCrashLoops = (
	probe: Probe,
	previous: WatchState,
	now: number,
): { loops: CrashLoop[]; state: WatchState } => {
	const state: WatchState = { baselines: {}, alerted: {} };
	const loops = new Map<string, CrashLoop>();
	const minutes = WINDOW_MS / 60_000;

	for (const container of probe.containers) {
		if (container.swarmService) continue;
		const group = groupOf(container);
		const before = previous.baselines[container.id];
		// A window starts from the count seen now, so restarts from last week,
		// or from before the watcher first saw the container, are never
		// reported; a real loop shows up within the next scan or two.
		const baseline =
			before && now - before.at <= WINDOW_MS
				? before
				: { count: container.restartCount, at: now };
		state.baselines[container.id] = baseline;

		const restarts = container.restartCount - baseline.count;
		if (restarts < FAILURE_THRESHOLD) continue;
		const existing = loops.get(group.key);
		if (existing) {
			existing.failures += restarts;
			continue;
		}
		loops.set(group.key, {
			group,
			failures: restarts,
			exitCode: container.exitCode,
			detail: `${container.name} restarted ${restarts} times in ${minutes} minutes (last exit code ${container.exitCode})`,
		});
	}

	const failed = new Map<string, TaskSnapshot[]>();
	for (const task of probe.tasks) {
		if (!FAILED_TASK_STATES.has(task.state)) continue;
		if (task.at === null || now - task.at > WINDOW_MS) continue;
		const list = failed.get(task.service) ?? [];
		list.push(task);
		failed.set(task.service, list);
	}
	for (const [service, tasks] of failed) {
		if (tasks.length < FAILURE_THRESHOLD) continue;
		const latest = tasks.reduce((a, b) => ((b.at ?? 0) > (a.at ?? 0) ? b : a));
		loops.set(`swarm:${service}`, {
			group: swarmGroup(service),
			failures: tasks.length,
			exitCode: latest.exitCode,
			detail: `${tasks.length} tasks failed in ${minutes} minutes${latest.error ? `: ${latest.error}` : ""}`,
		});
	}

	for (const [key, at] of Object.entries(previous.alerted)) {
		if (now - at < COOLDOWN_MS) state.alerted[key] = at;
	}

	const fresh: CrashLoop[] = [];
	for (const loop of loops.values()) {
		if (state.alerted[loop.group.key]) continue;
		state.alerted[loop.group.key] = now;
		fresh.push(loop);
	}
	return { loops: fresh, state };
};
