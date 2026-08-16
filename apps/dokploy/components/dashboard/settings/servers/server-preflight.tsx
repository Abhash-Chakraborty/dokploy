import {
	CheckCircle2,
	Loader2,
	RotateCcw,
	Stethoscope,
	XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { api } from "@/utils/api";

interface Props {
	serverId?: string;
}

const CHECKS = [
	{
		key: "docker",
		label: "Docker daemon",
		blurb: "Required for every container, image and volume view.",
	},
	{
		key: "swarm",
		label: "Swarm active",
		blurb: "Required to deploy services and run multi-node clusters.",
	},
	{
		key: "traefik",
		label: "Traefik managed by Dokploy",
		blurb: "Required for domains, certificates and routing.",
	},
	{
		key: "traefikDashboard",
		label: "Traefik dashboard port",
		blurb: "Optional. Exposes the Traefik dashboard on port 8080.",
	},
	{
		key: "traefikConfig",
		label: "Traefik configuration files",
		blurb: "Required to edit routing rules from the file system page.",
	},
] as const;

/**
 * One place that answers "what can this host actually do right now" — the
 * checks that were previously spread across the Traefik, Monitoring and Web
 * Server pages, each failing in its own way.
 */
export const ServerPreflight = ({ serverId }: Props) => {
	const { data, isPending, isFetching, refetch } =
		api.settings.getHostCapabilities.useQuery({ serverId });

	const failing = data
		? CHECKS.filter((check) => !data[check.key].available).length
		: 0;

	return (
		<Card className="h-full bg-sidebar p-2.5 rounded-xl w-full">
			<div className="rounded-xl bg-background shadow-md">
				<CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
					<div className="flex flex-col gap-1.5">
						<CardTitle className="text-xl flex flex-row gap-2">
							<Stethoscope className="size-6 text-muted-foreground self-center" />
							Preflight
						</CardTitle>
						<CardDescription>
							{isPending
								? "Checking what this host can do…"
								: failing === 0
									? "Everything this panel needs is available on this host."
									: `${failing} of ${CHECKS.length} checks need attention.`}
						</CardDescription>
					</div>
					<Button
						variant="outline"
						size="sm"
						onClick={() => refetch()}
						isLoading={isFetching}
					>
						<RotateCcw className="size-4" />
						Re-run
					</Button>
				</CardHeader>
				<CardContent className="py-6 border-t">
					{isPending ? (
						<div className="flex flex-row items-center justify-center gap-2 text-sm text-muted-foreground min-h-[20vh]">
							<span>Running checks…</span>
							<Loader2 className="animate-spin size-4" />
						</div>
					) : (
						<ul className="flex flex-col divide-y">
							{CHECKS.map((check) => {
								const result = data?.[check.key];
								const passed = result?.available ?? false;
								return (
									<li
										key={check.key}
										className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
									>
										{passed ? (
											<CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
										) : (
											<XCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
										)}
										<div className="flex min-w-0 flex-col gap-0.5">
											<span className="text-sm font-medium">{check.label}</span>
											<span className="text-sm text-muted-foreground">
												{passed ? check.blurb : result?.detail || check.blurb}
											</span>
										</div>
									</li>
								);
							})}
						</ul>
					)}
				</CardContent>
			</div>
		</Card>
	);
};
