import Link from "next/link";
import { useCallback } from "react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";

type Tone = "running" | "deploying" | "restarting" | "failed" | "stopped";

interface Task {
	name: string;
	state: string;
	currentState: string;
	error: string;
}

export interface LiveState {
	tone: Tone;
	label: string;
	detail?: string;
}

const RECENT_SECONDS = 10 * 60;

/** "Failed 2 minutes ago" -> seconds since; Infinity when it cannot tell. */
export const ageInSeconds = (currentState: string) => {
	if (/less than a second/.test(currentState)) return 0;
	const match = currentState.match(
		/(\d+|an?|about an?) (second|minute|hour|day|week|month)s? ago/,
	);
	if (!match) return Number.POSITIVE_INFINITY;
	const amount = /\d/.test(match[1] ?? "") ? Number(match[1]) : 1;
	const unit: Record<string, number> = {
		second: 1,
		minute: 60,
		hour: 3600,
		day: 86_400,
		week: 604_800,
		month: 2_592_000,
	};
	return amount * (unit[match[2] ?? "second"] ?? 1);
};

const stateWord = (currentState: string) =>
	(currentState.split(" ")[0] ?? "").toLowerCase();

/**
 * Turns `docker service ps` rows into what a person needs to know. The stored
 * status only says the last deploy went through; a crash loop still reads
 * "done" there, so the live tasks decide.
 */
export const deriveLiveState = (
	tasks: Task[],
	storedStatus?: string | null,
): LiveState => {
	if (storedStatus === "running")
		return { tone: "deploying", label: "Deploying" };
	// Superseded tasks keep a desired state of "shutdown"; the rest are the
	// slots Swarm is trying to keep alive right now.
	const current = tasks.filter((task) => task.state !== "shutdown");
	const history = tasks.filter((task) => task.state === "shutdown");
	if (current.length === 0) {
		if (storedStatus === "error") return { tone: "failed", label: "Failed" };
		return { tone: "stopped", label: "Stopped" };
	}
	const running = current.filter(
		(task) => stateWord(task.currentState) === "running",
	);
	const recentCrashes = history.filter(
		(task) =>
			["failed", "rejected"].includes(stateWord(task.currentState)) &&
			ageInSeconds(task.currentState) <= RECENT_SECONDS,
	);
	const lastError = recentCrashes[0]?.error.replace(/^"|"$/g, "") || undefined;
	const crashes = `${recentCrashes.length} ${recentCrashes.length === 1 ? "crash" : "crashes"} in 10 min`;

	if (running.length === current.length) {
		const justStarted = running.some(
			(task) => ageInSeconds(task.currentState) < 60,
		);
		if (recentCrashes.length > 1 && justStarted) {
			return {
				tone: "restarting",
				label: `Restarting · ${crashes}`,
				detail: lastError,
			};
		}
		return {
			tone: "running",
			label:
				current.length > 1
					? `Running · ${running.length}/${current.length}`
					: "Running",
		};
	}
	if (recentCrashes.length > 0) {
		return {
			tone: "restarting",
			label: `Restarting · ${crashes}`,
			detail: lastError,
		};
	}
	return { tone: "deploying", label: "Starting" };
};

const toneClasses: Record<Tone, { pill: string; dot: string }> = {
	running: { pill: "text-foreground", dot: "bg-status-running" },
	deploying: {
		pill: "text-foreground",
		dot: "bg-status-deploying animate-pulse",
	},
	restarting: {
		pill: "bg-status-restarting/12 text-status-restarting",
		dot: "bg-status-restarting",
	},
	failed: {
		pill: "bg-status-failed/12 text-status-failed",
		dot: "bg-status-failed",
	},
	stopped: { pill: "text-muted-foreground", dot: "bg-status-stopped" },
};

export const StatusPill = ({
	state,
	href,
	className,
}: {
	state: LiveState;
	href?: string;
	className?: string;
}) => {
	const tone = toneClasses[state.tone];
	const pill = (
		<span
			className={cn(
				"inline-flex h-6 items-center gap-1.5 rounded-full bg-secondary px-2.5 text-xs font-medium",
				tone.pill,
				className,
			)}
		>
			<span className={cn("size-1.5 rounded-full", tone.dot)} />
			{state.label}
		</span>
	);
	const body = href ? (
		<Link href={href} className="rounded-full focus-visible:ring-2">
			{pill}
		</Link>
	) : (
		pill
	);
	if (!state.detail) return body;
	return (
		<Tooltip>
			<TooltipTrigger asChild>{body}</TooltipTrigger>
			<TooltipContent className="max-w-sm">
				<span className="font-mono">{state.detail}</span>
				{href ? " · open the logs for the full error" : ""}
			</TooltipContent>
		</Tooltip>
	);
};

/** For things with no single Swarm service to ask, e.g. compose stacks. */
export const storedState = (status?: string | null): LiveState =>
	status === "running"
		? { tone: "deploying", label: "Deploying" }
		: status === "error"
			? { tone: "failed", label: "Failed" }
			: status === "done"
				? { tone: "running", label: "Deployed" }
				: { tone: "stopped", label: "Not deployed" };

interface LiveStatusProps {
	appName?: string;
	serverId?: string | null;
	storedStatus?: string | null;
	logsHref?: string;
	className?: string;
}

/** Status of a single Swarm service (applications and databases). */
export const LiveStatus = ({
	appName,
	serverId,
	storedStatus,
	logsHref,
	className,
}: LiveStatusProps) => {
	const { data: permissions } = api.user.getPermissions.useQuery();
	const canRead = !!permissions?.docker.read;
	const { data: tasks, isLoading } =
		api.docker.getServiceContainersByAppName.useQuery(
			{ appName: appName ?? "", serverId: serverId ?? undefined },
			{ enabled: !!appName && canRead, refetchInterval: 10_000 },
		);
	if (!appName) return null;
	if (!canRead || (isLoading && !tasks)) {
		return (
			<StatusPill state={storedState(storedStatus)} className={className} />
		);
	}
	const state = deriveLiveState(tasks ?? [], storedStatus);
	return (
		<StatusPill
			state={state}
			href={state.detail ? logsHref : undefined}
			className={className}
		/>
	);
};

interface LiveCount {
	running: number;
	desired: number;
	restarting: number;
}

export const stateFromCount = (
	count: LiveCount | undefined,
	storedStatus?: string | null,
): LiveState => {
	if (storedStatus === "running")
		return { tone: "deploying", label: "Deploying" };
	if (!count) return storedState(storedStatus);
	if (count.desired === 0) return { tone: "stopped", label: "Stopped" };
	if (count.running >= count.desired && count.restarting === 0) {
		return {
			tone: "running",
			label:
				count.desired > 1
					? `Running · ${count.running}/${count.desired}`
					: "Running",
		};
	}
	return {
		tone: count.running === 0 ? "failed" : "restarting",
		label: `${count.running}/${count.desired} running`,
	};
};

/**
 * Live replica counts for every service the caller can see, refreshed in the
 * background. Lists use it so a crash loop shows up before anyone opens the
 * service; without Docker access they fall back to the stored status.
 */
export const useLiveServices = () => {
	const { data: permissions } = api.user.getPermissions.useQuery();
	const { data } = api.live.services.useQuery(undefined, {
		enabled: !!permissions?.docker.read,
		refetchInterval: 15_000,
	});
	return useCallback(
		(
			appName?: string,
			serverId?: string | null,
			storedStatus?: string | null,
		): LiveState => {
			const server = data?.[serverId || "local"];
			if (!server || !appName) return storedState(storedStatus);
			return stateFromCount(server[appName], storedStatus);
		},
		[data],
	);
};
