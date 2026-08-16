import { Loader2, RotateCcw, ServerIcon, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";

/** Headroom colouring: green under 70%, amber to 90%, red beyond. */
const usageTone = (percent?: number) => {
	if (percent === undefined) return "text-muted-foreground";
	if (percent >= 90) return "text-red-500";
	if (percent >= 70) return "text-amber-500";
	return "text-emerald-500";
};

const Usage = ({ percent }: { percent?: number }) =>
	percent === undefined ? (
		<span className="text-muted-foreground">—</span>
	) : (
		<span className={cn("tabular-nums font-medium", usageTone(percent))}>
			{Math.round(percent)}%
		</span>
	);

/**
 * Every server in the organization in one grid, probed in parallel. The point
 * is comparison: version drift and headroom are invisible when you can only
 * look at one server page at a time.
 */
export const FleetOverview = () => {
	const { data, isPending, isFetching, refetch } =
		api.server.fleetOverview.useQuery(undefined, {
			refetchOnWindowFocus: false,
		});

	const servers = data?.servers ?? [];
	const unreachable = servers.filter((server) => !server.reachable).length;
	const dockerDrift = (data?.drift.dockerVersions.length ?? 0) > 1;
	const traefikDrift = (data?.drift.traefikVersions.length ?? 0) > 1;

	const summary = isPending
		? "Probing every server…"
		: servers.length === 0
			? "No servers yet."
			: [
					`${servers.length} server${servers.length === 1 ? "" : "s"}`,
					unreachable > 0 ? `${unreachable} unreachable` : null,
					dockerDrift ? "Docker versions differ" : null,
					traefikDrift ? "Traefik versions differ" : null,
				]
					.filter(Boolean)
					.join(" · ");

	return (
		<Card className="h-full bg-sidebar p-2.5 rounded-xl w-full">
			<div className="rounded-xl bg-background shadow-md">
				<CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
					<div className="flex flex-col gap-1.5">
						<CardTitle className="text-xl flex flex-row gap-2">
							<ServerIcon className="size-6 text-muted-foreground self-center" />
							Fleet
						</CardTitle>
						<CardDescription>{summary}</CardDescription>
					</div>
					<Button
						variant="outline"
						size="sm"
						onClick={() => refetch()}
						isLoading={isFetching}
					>
						<RotateCcw className="size-4" />
						Re-probe
					</Button>
				</CardHeader>
				<CardContent className="border-t p-0">
					{isPending ? (
						<div className="flex min-h-[25vh] flex-row items-center justify-center gap-2 text-sm text-muted-foreground">
							<span>Probing every server…</span>
							<Loader2 className="size-4 animate-spin" />
						</div>
					) : servers.length === 0 ? (
						<div className="flex min-h-[25vh] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
							<ServerIcon className="size-8 opacity-40" />
							<span>No servers to show yet.</span>
						</div>
					) : (
						<div className="w-full overflow-x-auto">
							<TooltipProvider delayDuration={100}>
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Server</TableHead>
											<TableHead>Docker</TableHead>
											<TableHead>Swarm</TableHead>
											<TableHead>Traefik</TableHead>
											<TableHead className="text-right">Containers</TableHead>
											<TableHead className="text-right">Disk</TableHead>
											<TableHead className="text-right">Memory</TableHead>
											<TableHead className="text-right">Load/core</TableHead>
											<TableHead>Uptime</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{servers.map((server) => {
											const key = server.serverId ?? "dokploy-host";
											const driftedDocker =
												dockerDrift && Boolean(server.dockerVersion);
											const driftedTraefik =
												traefikDrift && Boolean(server.traefikVersion);

											return (
												<TableRow key={key}>
													<TableCell>
														<div className="flex flex-col gap-0.5">
															<div className="flex items-center gap-2">
																<span
																	className={cn(
																		"size-2 shrink-0 rounded-full",
																		server.reachable
																			? "bg-emerald-500"
																			: "bg-red-500",
																	)}
																	aria-hidden
																/>
																<span className="font-medium">
																	{server.name}
																</span>
																<Badge
																	variant="secondary"
																	className="text-[10px] uppercase"
																>
																	{server.serverType}
																</Badge>
															</div>
															<span className="text-xs text-muted-foreground">
																{server.reachable
																	? (server.ipAddress ?? "local")
																	: server.error}
															</span>
														</div>
													</TableCell>
													<TableCell>
														<span className="flex items-center gap-1.5 font-mono text-xs">
															{server.dockerVersion ?? "—"}
															{driftedDocker && (
																<Tooltip>
																	<TooltipTrigger asChild>
																		<TriangleAlert className="size-3.5 text-amber-500" />
																	</TooltipTrigger>
																	<TooltipContent>
																		<p>
																			Fleet runs{" "}
																			{data?.drift.dockerVersions.join(", ")}
																		</p>
																	</TooltipContent>
																</Tooltip>
															)}
														</span>
													</TableCell>
													<TableCell>
														{server.swarmState === "active" ? (
															<Badge variant="green" className="text-[10px]">
																{server.swarmRole ?? "active"}
															</Badge>
														) : (
															<span className="text-xs text-muted-foreground">
																{server.swarmState || "—"}
															</span>
														)}
													</TableCell>
													<TableCell>
														<span className="flex items-center gap-1.5 font-mono text-xs">
															{server.traefikVersion ?? "—"}
															{driftedTraefik && (
																<Tooltip>
																	<TooltipTrigger asChild>
																		<TriangleAlert className="size-3.5 text-amber-500" />
																	</TooltipTrigger>
																	<TooltipContent>
																		<p>
																			Fleet runs{" "}
																			{data?.drift.traefikVersions.join(", ")}
																		</p>
																	</TooltipContent>
																</Tooltip>
															)}
														</span>
													</TableCell>
													<TableCell className="text-right tabular-nums text-sm">
														{server.containersRunning === undefined ? (
															<span className="text-muted-foreground">—</span>
														) : (
															<span>
																{server.containersRunning}
																<span className="text-muted-foreground">
																	{" / "}
																	{server.containersTotal ?? 0}
																</span>
															</span>
														)}
													</TableCell>
													<TableCell className="text-right text-sm">
														<Usage percent={server.diskUsedPercent} />
													</TableCell>
													<TableCell className="text-right text-sm">
														<Usage percent={server.memUsedPercent} />
													</TableCell>
													<TableCell className="text-right tabular-nums text-sm text-muted-foreground">
														{server.loadPerCore ?? "—"}
													</TableCell>
													<TableCell className="text-xs text-muted-foreground">
														{server.uptime ?? "—"}
													</TableCell>
												</TableRow>
											);
										})}
									</TableBody>
								</Table>
							</TooltipProvider>
						</div>
					)}
				</CardContent>
			</div>
		</Card>
	);
};
