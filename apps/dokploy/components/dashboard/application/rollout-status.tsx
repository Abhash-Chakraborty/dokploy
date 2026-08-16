import {
	CircleAlert,
	CircleCheck,
	Loader2,
	RotateCcw,
	Undo2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/utils/api";

interface Props {
	applicationId: string;
}

const TONE = {
	healthy: { badge: "green" as const, Icon: CircleCheck, label: "Healthy" },
	converging: {
		badge: "secondary" as const,
		Icon: Loader2,
		label: "Converging",
	},
	rolled_back: {
		badge: "destructive" as const,
		Icon: Undo2,
		label: "Rolled back",
	},
	failing: {
		badge: "destructive" as const,
		Icon: CircleAlert,
		label: "Failing",
	},
	missing: {
		badge: "secondary" as const,
		Icon: CircleAlert,
		label: "Not running",
	},
	unknown: { badge: "secondary" as const, Icon: CircleAlert, label: "Unknown" },
};

/**
 * Surfaces what Swarm did with the last deploy. Without this a rollback is
 * invisible: the deploy log ends in success, and the old version is quietly
 * still serving.
 */
export const RolloutStatus = ({ applicationId }: Props) => {
	const { data, isPending, isFetching, refetch } =
		api.application.rolloutStatus.useQuery(
			{ applicationId },
			{ refetchOnWindowFocus: false },
		);

	const tone = TONE[data?.verdict ?? "unknown"];
	const { Icon } = tone;

	return (
		<div className="flex flex-col gap-3 rounded-lg border p-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<Icon
						className={`size-4 text-muted-foreground ${
							data?.verdict === "converging" ? "animate-spin" : ""
						}`}
					/>
					<span className="text-sm font-medium">Rollout</span>
					{!isPending && <Badge variant={tone.badge}>{tone.label}</Badge>}
					{data && data.desiredReplicas > 0 && (
						<span className="text-xs text-muted-foreground tabular-nums">
							{data.runningReplicas}/{data.desiredReplicas} replicas
						</span>
					)}
				</div>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => refetch()}
					isLoading={isFetching}
				>
					<RotateCcw className="size-3.5" />
					Re-check
				</Button>
			</div>

			<p className="text-sm text-muted-foreground">
				{isPending ? "Checking the service…" : data?.detail}
			</p>

			{data && data.recentFailures.length > 0 && (
				<ul className="flex flex-col gap-1 rounded-md bg-muted/50 p-2 font-mono text-xs">
					{data.recentFailures.map((failure) => (
						<li
							key={`${failure.task}-${failure.state}`}
							className="flex flex-wrap gap-x-2 text-muted-foreground"
						>
							<span className="text-foreground">{failure.task}</span>
							<span>{failure.state}</span>
							<span className="text-red-500">{failure.error}</span>
						</li>
					))}
				</ul>
			)}
		</div>
	);
};
