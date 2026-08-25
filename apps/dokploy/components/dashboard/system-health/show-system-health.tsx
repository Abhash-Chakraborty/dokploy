import {
	AlertTriangle,
	CheckCircle2,
	HeartPulse,
	Loader2,
	RefreshCw,
	ServerIcon,
	Wrench,
	XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { useHealthCheckAfterMutation } from "@/hooks/use-health-check-after-mutation";
import { api } from "@/utils/api";
import { ResolveDockerDrift } from "./resolve-docker-drift";

type Verdict = "pass" | "warn" | "fail" | "unknown";

/**
 * The severity thresholds already used elsewhere in the panel (fleet overview
 * and the docker health network table): healthy under 70%, warning under 90%.
 */
const percentVerdict = (value: number | undefined): Verdict => {
	if (value === undefined || Number.isNaN(value)) return "unknown";
	if (value >= 90) return "fail";
	if (value >= 70) return "warn";
	return "pass";
};

const VERDICT_STYLES: Record<Verdict, string> = {
	pass: "text-emerald-500",
	warn: "text-amber-500",
	fail: "text-destructive",
	unknown: "text-muted-foreground",
};

const VerdictBadge = ({
	verdict,
	labels,
}: {
	verdict: Verdict;
	labels?: Partial<Record<Verdict, string>>;
}) => {
	const label =
		labels?.[verdict] ??
		{ pass: "OK", warn: "Warning", fail: "Problem", unknown: "Unknown" }[
			verdict
		];
	const variant =
		verdict === "pass"
			? "default"
			: verdict === "fail"
				? "destructive"
				: "secondary";
	return <Badge variant={variant}>{label}</Badge>;
};

/** A section that reports honestly when its query is loading or failed. */
const Section = ({
	title,
	description,
	isLoading,
	error,
	unavailableNote,
	children,
}: {
	title: string;
	description?: string;
	isLoading: boolean;
	error?: { message: string } | null;
	unavailableNote?: string;
	children: React.ReactNode;
}) => (
	<Card className="bg-background">
		<CardHeader>
			<CardTitle>{title}</CardTitle>
			{description ? (
				<span className="text-sm text-muted-foreground">{description}</span>
			) : null}
		</CardHeader>
		<CardContent>
			{isLoading ? (
				<div className="flex min-h-[6rem] items-center justify-center">
					<Loader2 className="size-5 animate-spin text-muted-foreground" />
				</div>
			) : error ? (
				<div className="flex min-h-[6rem] flex-col items-center justify-center gap-2 text-center">
					<AlertTriangle className="size-5 text-amber-500" />
					<span className="text-sm font-medium">Unavailable</span>
					<span className="max-w-md text-sm text-muted-foreground">
						{unavailableNote ?? error.message}
					</span>
				</div>
			) : (
				children
			)}
		</CardContent>
	</Card>
);

const StatusRow = ({
	label,
	verdict,
	detail,
	action,
}: {
	label: string;
	verdict: Verdict;
	detail?: string;
	/** A one-click fix, rendered next to the badge when the check can be fixed. */
	action?: React.ReactNode;
}) => (
	<div className="flex items-start justify-between gap-4 border-b py-3 last:border-b-0">
		<div className="flex flex-col gap-0.5">
			<span className="text-sm font-medium">{label}</span>
			{detail ? (
				<span className="text-sm text-muted-foreground">{detail}</span>
			) : null}
		</div>
		<div className="flex shrink-0 items-center gap-2">
			{action}
			<VerdictBadge verdict={verdict} />
		</div>
	</div>
);

const UsageBar = ({
	label,
	percent,
	detail,
}: {
	label: string;
	percent: number | undefined;
	detail?: string;
}) => {
	const verdict = percentVerdict(percent);
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center justify-between">
				<span className="text-sm font-medium">{label}</span>
				<span className={`text-sm font-medium ${VERDICT_STYLES[verdict]}`}>
					{percent === undefined ? "—" : `${percent.toFixed(0)}%`}
				</span>
			</div>
			<Progress value={percent ?? 0} className="h-2" />
			{detail ? (
				<span className="text-xs text-muted-foreground">{detail}</span>
			) : null}
		</div>
	);
};

export const ShowSystemHealth = ({ serverId }: { serverId?: string }) => {
	const utils = api.useUtils();
	const serverArg: { serverId?: string } = serverId ? { serverId } : {};

	const { data: auth } = api.user.get.useQuery();
	const isAdmin = auth?.role === "owner" || auth?.role === "admin";

	const capabilities = api.settings.getHostCapabilities.useQuery(serverArg);
	const infrastructure = api.settings.checkInfrastructureHealth.useQuery();
	const fleet = api.server.fleetOverview.useQuery();
	const diskUsage = api.dockerDiskUsage.getDiskUsage.useQuery(serverArg);
	const version = api.settings.getDokployVersion.useQuery();

	const queries = [
		capabilities,
		infrastructure,
		fleet,
		diskUsage,
		version,
	] as const;
	const anyLoading = queries.some((query) => query.isLoading);

	const { mutateAsync: toggleDashboard, isPending: isTogglingDashboard } =
		api.settings.toggleDashboard.useMutation();

	// Publishing the port recreates the Traefik container, so the panel can go
	// briefly unreachable behind it; wait for /api/health before re-probing.
	const { execute: publishPortWithHealthCheck, isExecuting: isPublishingPort } =
		useHealthCheckAfterMutation({
			initialDelay: 5000,
			pollInterval: 4000,
			successMessage: "Traefik dashboard port published",
			onSuccess: () => {
				void utils.settings.getHostCapabilities.invalidate();
				void utils.settings.haveTraefikDashboardPortEnabled.invalidate();
			},
		});

	const publishTraefikDashboardPort = async () => {
		try {
			await publishPortWithHealthCheck(() =>
				toggleDashboard({ enableDashboard: true, serverId }),
			);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to publish the Traefik dashboard port.",
			);
		}
	};

	/** The one-click fix for a capability, when the panel has one. */
	const remediationFor = (
		remediation: string | undefined | null,
	): React.ReactNode => {
		if (remediation !== "publish-traefik-dashboard-port" || !isAdmin) {
			return null;
		}
		return (
			<DialogAction
				title="Publish the Traefik dashboard port"
				description={
					<div className="space-y-4">
						<AlertBlock type="warning">
							The Traefik container will be recreated. It is deleted and created
							again, which can briefly interrupt traffic to your applications.
						</AlertBlock>
						<p>
							This publishes port 8080 on this host. If something else is
							already listening there the change is rejected and nothing is
							recreated.
						</p>
					</div>
				}
				type="default"
				disabled={isTogglingDashboard || isPublishingPort}
				onClick={publishTraefikDashboardPort}
			>
				<Button
					variant="outline"
					size="sm"
					className="gap-1.5"
					disabled={isTogglingDashboard || isPublishingPort}
				>
					{isTogglingDashboard || isPublishingPort ? (
						<Loader2 className="size-3.5 animate-spin" />
					) : (
						<Wrench className="size-3.5" />
					)}
					Publish &amp; retry
				</Button>
			</DialogAction>
		);
	};

	const refreshAll = async () => {
		await Promise.all([
			utils.settings.getHostCapabilities.invalidate(),
			utils.settings.checkInfrastructureHealth.invalidate(),
			utils.server.fleetOverview.invalidate(),
			utils.dockerDiskUsage.getDiskUsage.invalidate(),
			utils.settings.getDokployVersion.invalidate(),
		]);
	};

	// Only count checks that actually resolved. A loading or failed query is
	// reported as unknown rather than silently treated as healthy.
	const capabilityEntries = capabilities.data
		? Object.entries(capabilities.data)
		: [];
	const infraEntries = infrastructure.data
		? Object.entries(infrastructure.data)
		: [];

	const passing =
		capabilityEntries.filter(([, value]) => value.available).length +
		infraEntries.filter(([, value]) => value.status === "healthy").length;
	const failing =
		capabilityEntries.filter(([, value]) => !value.available).length +
		infraEntries.filter(([, value]) => value.status !== "healthy").length;
	const unreachableServers = (fleet.data?.servers ?? []).filter(
		(row) => !row.reachable,
	).length;

	const overall: Verdict = anyLoading
		? "unknown"
		: failing > 0
			? "fail"
			: unreachableServers > 0
				? "warn"
				: "pass";

	return (
		<div className="flex w-full flex-col gap-6">
			<Card className="bg-background">
				<CardContent className="flex flex-col gap-4 py-6 sm:flex-row sm:items-center sm:justify-between">
					<div className="flex items-center gap-3">
						{overall === "pass" ? (
							<CheckCircle2 className="size-8 text-emerald-500" />
						) : overall === "fail" ? (
							<XCircle className="size-8 text-destructive" />
						) : overall === "warn" ? (
							<AlertTriangle className="size-8 text-amber-500" />
						) : (
							<HeartPulse className="size-8 text-muted-foreground" />
						)}
						<div className="flex flex-col">
							<span className="text-lg font-semibold">
								{overall === "pass"
									? "All checks passing"
									: overall === "fail"
										? `${failing} ${failing === 1 ? "check needs" : "checks need"} attention`
										: overall === "warn"
											? `${unreachableServers} ${unreachableServers === 1 ? "server is" : "servers are"} unreachable`
											: "Running checks…"}
							</span>
							<span className="text-sm text-muted-foreground">
								{passing} passing · {failing} failing · Dokploy{" "}
								{version.data ?? "—"}
							</span>
						</div>
					</div>
					<Button
						variant="outline"
						onClick={refreshAll}
						disabled={anyLoading}
						className="gap-2"
					>
						{anyLoading ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							<RefreshCw className="size-4" />
						)}
						Refresh
					</Button>
				</CardContent>
			</Card>

			<Section
				title="Core services"
				description="Postgres and Traefik, probed inside their running containers."
				isLoading={infrastructure.isLoading}
				error={infrastructure.error}
				unavailableNote="Infrastructure health is restricted to organization admins."
			>
				<div className="flex flex-col">
					{infraEntries.map(([name, value]) => (
						<StatusRow
							key={name}
							label={name === "postgres" ? "Postgres" : "Traefik"}
							verdict={value.status === "healthy" ? "pass" : "fail"}
							detail={"message" in value ? value.message : undefined}
						/>
					))}
				</div>
			</Section>

			<Section
				title="Host capabilities"
				description="What the panel can reach on this host."
				isLoading={capabilities.isLoading}
				error={capabilities.error}
			>
				<div className="flex flex-col">
					{capabilityEntries.map(([name, value]) => (
						<StatusRow
							key={name}
							label={
								{
									docker: "Docker daemon",
									swarm: "Swarm",
									traefik: "Traefik container",
									traefikDashboard: "Traefik dashboard port",
									traefikConfig: "Traefik config directory",
								}[name] ?? name
							}
							verdict={value.available ? "pass" : "fail"}
							detail={value.detail || undefined}
							action={remediationFor(value.remediation)}
						/>
					))}
				</div>
			</Section>

			<Section
				title="Fleet"
				description="Reachability and headroom for every server in this organization."
				isLoading={fleet.isLoading}
				error={fleet.error}
			>
				{(fleet.data?.servers ?? []).length === 0 ? (
					<span className="text-sm text-muted-foreground">
						No servers registered.
					</span>
				) : (
					<div className="flex flex-col gap-4">
						{fleet.data?.drift?.dockerVersions &&
						fleet.data.drift.dockerVersions.length > 1 ? (
							<div className="flex flex-col gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 sm:flex-row sm:items-center sm:justify-between">
								<div className="flex items-center gap-2">
									<AlertTriangle className="size-4 shrink-0 text-amber-500" />
									<span className="text-sm">
										Docker version drift across servers:{" "}
										{fleet.data.drift.dockerVersions.join(", ")}
									</span>
								</div>
								{isAdmin ? (
									<ResolveDockerDrift
										servers={fleet.data.servers}
										onUpgraded={() => utils.server.fleetOverview.invalidate()}
									>
										<Button
											variant="outline"
											size="sm"
											className="shrink-0 gap-1.5"
										>
											<Wrench className="size-3.5" />
											Resolve drift
										</Button>
									</ResolveDockerDrift>
								) : null}
							</div>
						) : null}
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Server</TableHead>
									<TableHead>Status</TableHead>
									<TableHead>Docker</TableHead>
									<TableHead>Containers</TableHead>
									<TableHead>Disk</TableHead>
									<TableHead>Memory</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{(fleet.data?.servers ?? []).map((row) => (
									<TableRow key={row.serverId ?? "dokploy-host"}>
										<TableCell>
											<div className="flex items-center gap-2">
												<ServerIcon className="size-4 text-muted-foreground" />
												<span className="font-medium">{row.name}</span>
											</div>
										</TableCell>
										<TableCell>
											{row.reachable ? (
												<VerdictBadge
													verdict="pass"
													labels={{ pass: "Reachable" }}
												/>
											) : (
												<div className="flex flex-col gap-1">
													<VerdictBadge
														verdict="fail"
														labels={{ fail: "Unreachable" }}
													/>
													{row.error ? (
														<span className="text-xs text-muted-foreground">
															{row.error}
														</span>
													) : null}
												</div>
											)}
										</TableCell>
										<TableCell className="text-sm">
											{row.dockerVersion ?? "—"}
										</TableCell>
										<TableCell className="text-sm">
											{row.containersRunning ?? "—"}
											{row.containersTotal !== undefined
												? ` / ${row.containersTotal}`
												: ""}
										</TableCell>
										<TableCell
											className={`text-sm font-medium ${VERDICT_STYLES[percentVerdict(row.diskUsedPercent)]}`}
										>
											{row.diskUsedPercent === undefined
												? "—"
												: `${row.diskUsedPercent.toFixed(0)}%`}
										</TableCell>
										<TableCell
											className={`text-sm font-medium ${VERDICT_STYLES[percentVerdict(row.memUsedPercent)]}`}
										>
											{row.memUsedPercent === undefined
												? "—"
												: `${row.memUsedPercent.toFixed(0)}%`}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				)}
			</Section>

			<Section
				title="Docker disk usage"
				description="Space held by images, containers, volumes and build cache."
				isLoading={diskUsage.isLoading}
				error={diskUsage.error}
			>
				{(diskUsage.data ?? []).length === 0 ? (
					<span className="text-sm text-muted-foreground">
						No disk usage reported.
					</span>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Type</TableHead>
								<TableHead className="text-right">Total</TableHead>
								<TableHead className="text-right">Active</TableHead>
								<TableHead className="text-right">Size</TableHead>
								<TableHead className="text-right">Reclaimable</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{(diskUsage.data ?? []).map((item) => (
								<TableRow key={item.type}>
									<TableCell className="font-medium">{item.type}</TableCell>
									<TableCell className="text-right">
										{item.totalCount}
									</TableCell>
									<TableCell className="text-right">{item.active}</TableCell>
									<TableCell className="text-right">{item.size}</TableCell>
									<TableCell className="text-right text-muted-foreground">
										{item.reclaimable}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</Section>
		</div>
	);
};

export { UsageBar };
