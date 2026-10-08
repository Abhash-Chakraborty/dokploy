import copy from "copy-to-clipboard";
import {
	Activity,
	KeyIcon,
	Pencil,
	RotateCcw,
	ServerIcon,
	Settings2,
	Terminal,
	Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/router";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { PageContainer, PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { api, type RouterOutputs } from "@/utils/api";
import { TerminalModal } from "../web-server/terminal-modal";
import { ShowServerActions } from "./actions/show-server-actions";
import { DeleteServerModal } from "./delete-server-modal";
import { DriftWarning, formatMb, Usage } from "./fleet-cells";
import { HandleServers } from "./handle-servers";
import { SetupServer } from "./setup-server";
import { ShowMonitoringModal } from "./show-monitoring-modal";
import { WelcomeSubscription } from "./welcome-stripe/welcome-subscription";

type FleetRow = RouterOutputs["server"]["fleetOverview"]["servers"][number];
type ServerRecord = RouterOutputs["server"]["all"][number];

const RowAction = ({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) => (
	<Tooltip>
		<TooltipTrigger asChild>{children}</TooltipTrigger>
		<TooltipContent>{label}</TooltipContent>
	</Tooltip>
);

const iconButton = "size-8 text-muted-foreground hover:text-foreground";

// Every row reserves the same slots, so each action lines up in a column even
// when a row does not offer it.
const Slot = ({ children }: { children?: ReactNode }) =>
	children ? <>{children}</> : <span aria-hidden className="size-8" />;

export const ShowServers = () => {
	const router = useRouter();
	const query = router.query;
	const { data, isPending } = api.server.all.useQuery();
	const { data: sshKeys } = api.sshKey.all.useQuery();
	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { data: permissions } = api.user.getPermissions.useQuery();
	// Probing runs SSH against every server, so the rows render from the
	// database first and the live columns fill in when the probe returns.
	const {
		data: probe,
		isPending: isProbing,
		isFetching: isReprobing,
		refetch: reprobe,
	} = api.server.fleetOverview.useQuery(undefined, {
		refetchOnWindowFocus: false,
	});
	// Stored facts, refreshed on a schedule, so this costs no SSH round trip.
	// Members cannot read them, hence retry: false and the optional handling.
	const { data: fleet } = api.fleet.list.useQuery(undefined, { retry: false });
	const provisioned = new Map<string, boolean>(
		(fleet?.servers ?? []).map((row) => [
			row.serverId,
			!!row.meta?.facts?.dockerVersion && row.meta?.facts?.swarm === "active",
		]),
	);

	const live = new Map<string | null, FleetRow>(
		(probe?.servers ?? []).map((row) => [row.serverId, row]),
	);
	const hostRow = live.get(null);
	const servers = data ?? [];
	const dockerDrift = (probe?.drift.dockerVersions.length ?? 0) > 1;
	const traefikDrift = (probe?.drift.traefikVersions.length ?? 0) > 1;
	const unreachable = (probe?.servers ?? []).filter((row) => !row.reachable);

	const summary = [
		`${servers.length + (isCloud ? 0 : 1)} server${servers.length + (isCloud ? 0 : 1) === 1 ? "" : "s"}`,
		unreachable.length > 0 ? `${unreachable.length} unreachable` : null,
		dockerDrift ? "Docker versions differ" : null,
		traefikDrift ? "Traefik versions differ" : null,
	]
		.filter(Boolean)
		.join(" · ");

	const liveCells = (row: FleetRow | undefined) => {
		if (!row) {
			return Array.from({ length: 6 }, (_, index) => (
				<TableCell key={index} className={index >= 3 ? "text-right" : ""}>
					{isProbing ? (
						<span className="inline-block h-3 w-10 animate-pulse rounded bg-muted" />
					) : (
						<span className="text-muted-foreground">—</span>
					)}
				</TableCell>
			));
		}
		return [
			<TableCell key="docker">
				<span className="flex items-center gap-1.5 font-mono text-xs">
					{row.dockerVersion ?? "—"}
					{dockerDrift && row.dockerVersion && (
						<DriftWarning
							what="Docker"
							versions={probe?.drift.dockerVersions ?? []}
						/>
					)}
				</span>
			</TableCell>,
			<TableCell key="swarm" className="text-xs">
				{row.swarmState === "active" ? (
					<span className="text-muted-foreground">
						{row.swarmRole ?? "active"}
					</span>
				) : row.reachable ? (
					<Link
						href="/dashboard/command-center"
						className="text-amber-500 underline underline-offset-2"
						title="Apply the baseline from Command centre"
					>
						{row.swarmState || "not in swarm"}
					</Link>
				) : (
					<span className="text-muted-foreground">—</span>
				)}
			</TableCell>,
			<TableCell key="traefik">
				<span className="flex items-center gap-1.5 font-mono text-xs">
					{row.traefikVersion ?? "—"}
					{traefikDrift && row.traefikVersion && (
						<DriftWarning
							what="Traefik"
							versions={probe?.drift.traefikVersions ?? []}
						/>
					)}
				</span>
			</TableCell>,
			<TableCell key="containers" className="text-right tabular-nums">
				{row.containersRunning === undefined ? (
					<span className="text-muted-foreground">—</span>
				) : (
					<>
						{row.containersRunning}
						<span className="text-muted-foreground">
							{" / "}
							{row.containersTotal ?? 0}
						</span>
					</>
				)}
			</TableCell>,
			<TableCell key="disk" className="text-right">
				<Usage percent={row.diskUsedPercent} />
			</TableCell>,
			<TableCell key="memory" className="text-right">
				<Usage percent={row.memUsedPercent} />
			</TableCell>,
		];
	};

	const nameCell = (
		name: string,
		row: FleetRow | undefined,
		detail: ReactNode,
		badge?: ReactNode,
	) => (
		// max-w-0 with a width makes an auto-layout table truncate this cell
		// instead of letting a long probe error push the other columns away.
		<TableCell className="w-[34%] max-w-0 py-3">
			<div className="flex min-w-0 items-center gap-2.5">
				<span
					className={cn(
						"size-2 shrink-0 rounded-full",
						!row
							? "bg-muted-foreground/40"
							: row.reachable
								? "bg-status-running"
								: "bg-status-failed",
					)}
					title={!row ? "Probing" : row.reachable ? "Reachable" : row.error}
				/>
				<div className="flex min-w-0 flex-col">
					<span className="flex min-w-0 items-center gap-2">
						<span className="truncate font-medium">{name}</span>
						{badge}
					</span>
					<span
						className={cn(
							"truncate text-xs",
							row && !row.reachable
								? "text-status-failed"
								: "text-muted-foreground",
						)}
						title={row && !row.reachable ? row.error : undefined}
					>
						{row && !row.reachable ? row.error : detail}
					</span>
				</div>
			</div>
		</TableCell>
	);

	const capacity = (row: FleetRow | undefined) =>
		row?.cpuCores === undefined
			? null
			: [
					`${row.cpuCores} vCPU`,
					row.memoryTotalMb ? formatMb(row.memoryTotalMb) : null,
					row.diskTotalMb ? `${formatMb(row.diskTotalMb)} disk` : null,
				]
					.filter(Boolean)
					.join(" · ");

	const serverActions = (server: ServerRecord) => {
		const isBuildServer = server.serverType === "build";
		if (server.serverStatus !== "active") return null;
		return (
			<>
				<Slot>
					<RowAction
						label={
							provisioned.get(server.serverId)
								? "Re-run setup"
								: "Set up server"
						}
					>
						<span>
							<SetupServer
								serverId={server.serverId}
								alreadyProvisioned={provisioned.get(server.serverId) ?? false}
							>
								<Button variant="ghost" size="icon" className={iconButton}>
									<Settings2 className="size-4" />
								</Button>
							</SetupServer>
						</span>
					</RowAction>
				</Slot>
				<Slot>
					{server.sshKeyId && permissions?.server.terminal && (
						<RowAction label="Terminal">
							<span>
								<TerminalModal serverId={server.serverId} asButton>
									<Button variant="ghost" size="icon" className={iconButton}>
										<Terminal className="size-4" />
									</Button>
								</TerminalModal>
							</span>
						</RowAction>
					)}
				</Slot>
				<Slot>
					<RowAction label="Edit">
						<span>
							<HandleServers serverId={server.serverId}>
								<Button variant="ghost" size="icon" className={iconButton}>
									<Pencil className="size-4" />
								</Button>
							</HandleServers>
						</span>
					</RowAction>
				</Slot>
				<Slot>
					{server.sshKeyId && !isBuildServer && (
						<RowAction label="Web server actions">
							<span>
								<ShowServerActions serverId={server.serverId}>
									<Button variant="ghost" size="icon" className={iconButton}>
										<Activity className="size-4" />
									</Button>
								</ShowServerActions>
							</span>
						</RowAction>
					)}
				</Slot>
				{isCloud && server.sshKeyId && !isBuildServer && (
					<ShowMonitoringModal
						url={`http://${server.ipAddress}:${server?.metricsConfig?.server?.port}/metrics`}
						token={server?.metricsConfig?.server?.token}
					/>
				)}
				<Slot>
					{permissions?.server.delete && (
						<RowAction label="Delete">
							<span>
								<DeleteServerModal
									serverId={server.serverId}
									serverName={server.name}
								>
									<Button
										variant="ghost"
										size="icon"
										className={cn(iconButton, "hover:text-destructive")}
									>
										<Trash2 className="size-4" />
									</Button>
								</DeleteServerModal>
							</span>
						</RowAction>
					)}
				</Slot>
			</>
		);
	};

	const noKeys = sshKeys?.length === 0 && servers.length === 0;

	return (
		<PageContainer>
			{query?.success && isCloud && <WelcomeSubscription />}
			<PageHeader
				title="Servers"
				description={isPending ? "Loading…" : summary}
				actions={
					<>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => reprobe()}
							isLoading={isReprobing}
						>
							<RotateCcw className="size-4" />
							Re-probe
						</Button>
						{permissions?.server.create && !noKeys && <HandleServers />}
					</>
				}
			/>
			{isCloud && (
				<button
					type="button"
					className="w-fit text-left text-sm text-muted-foreground underline underline-offset-2"
					onClick={() => {
						router.push("/dashboard/settings/servers?success=true");
					}}
				>
					Reset onboarding
				</button>
			)}
			<TooltipProvider delayDuration={200}>
				<div className="w-full overflow-x-auto">
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
								<TableHead className="w-0" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{!isCloud && (
								<TableRow>
									{nameCell(
										"Dokploy host",
										hostRow,
										[
											"this machine",
											capacity(hostRow),
											hostRow?.uptime ? `up ${hostRow.uptime}` : null,
										]
											.filter(Boolean)
											.join(" · "),
									)}
									{liveCells(hostRow)}
									<TableCell>
										<div className="flex justify-end gap-0.5">
											<Slot />
											<Slot>
												{permissions?.server.terminal && (
													<RowAction label="Terminal">
														<Button
															variant="ghost"
															size="icon"
															className={iconButton}
															asChild
														>
															<Link href="/dashboard/terminals">
																<Terminal className="size-4" />
															</Link>
														</Button>
													</RowAction>
												)}
											</Slot>
											<Slot />
											<Slot />
											<Slot />
										</div>
									</TableCell>
								</TableRow>
							)}
							{servers.map((server) => {
								const row = live.get(server.serverId);
								return (
									<TableRow key={server.serverId}>
										{nameCell(
											server.name,
											row,
											<>
												<button
													type="button"
													className="font-mono hover:text-foreground"
													title="Copy address"
													onClick={() => {
														copy(server.ipAddress);
														toast.success("Address copied");
													}}
												>
													{server.username}@{server.ipAddress}:{server.port}
												</button>
												{capacity(row) ? ` · ${capacity(row)}` : ""}
												{!server.sshKeyId ? " · no SSH key" : ""}
											</>,
											<>
												{server.serverType === "build" && (
													<Badge variant="secondary" className="text-[10px]">
														build
													</Badge>
												)}
												{isCloud && server.serverStatus !== "active" && (
													<Badge
														variant="destructive"
														className="text-[10px]"
														title="Deactivated for an unpaid invoice. Pay it to reactivate the server."
													>
														{server.serverStatus}
													</Badge>
												)}
											</>,
										)}
										{liveCells(row)}
										<TableCell>
											<div className="flex justify-end gap-0.5">
												{serverActions(server)}
											</div>
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				</div>
			</TooltipProvider>
			{!isPending && servers.length === 0 && (
				<div className="flex flex-col items-start gap-2 py-2 text-sm text-muted-foreground">
					{noKeys ? (
						<span className="flex items-center gap-2">
							<KeyIcon className="size-4" />
							Add an SSH key first, then add servers to deploy to them.
							<Link
								href="/dashboard/settings/ssh-keys"
								className="text-foreground underline underline-offset-2"
							>
								Add SSH key
							</Link>
						</span>
					) : (
						<span className="flex items-center gap-2">
							<ServerIcon className="size-4" />
							Add a server to deploy applications to it.
						</span>
					)}
				</div>
			)}
		</PageContainer>
	);
};
