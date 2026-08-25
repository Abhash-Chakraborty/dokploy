import {
	AlertTriangle,
	CheckCircle2,
	Copy,
	Loader2,
	ServerIcon,
	XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api, type RouterOutputs } from "@/utils/api";

type FleetServer = RouterOutputs["server"]["fleetOverview"]["servers"][number];

type UpgradeState =
	| { status: "pending" }
	| { status: "running" }
	| { status: "done"; version?: string }
	| { status: "failed"; message: string };

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * Component-wise numeric compare. Docker Engine versions are plain
 * `major.minor.patch`, and string comparison gets them wrong (`29.10.0` would
 * sort below `29.6.1`).
 */
const compareVersions = (a: string, b: string): number => {
	const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
	const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const diff = (left[index] ?? 0) - (right[index] ?? 0);
		if (diff !== 0) return diff > 0 ? 1 : -1;
	}
	return 0;
};

/** The newest version in the fleet — what every other server aligns to. */
export const resolveDriftTarget = (servers: FleetServer[]) =>
	servers
		.filter((row) => row.reachable && row.dockerVersion)
		.map((row) => row.dockerVersion as string)
		.filter((version) => VERSION_PATTERN.test(version))
		.sort(compareVersions)
		.pop();

const StateBadge = ({ state }: { state: UpgradeState }) => {
	if (state.status === "running") {
		return (
			<Badge variant="secondary" className="gap-1.5">
				<Loader2 className="size-3 animate-spin" />
				Upgrading
			</Badge>
		);
	}
	if (state.status === "done") {
		return (
			<Badge variant="default" className="gap-1.5">
				<CheckCircle2 className="size-3" />
				{state.version ?? "Done"}
			</Badge>
		);
	}
	if (state.status === "failed") {
		return (
			<Badge variant="destructive" className="gap-1.5">
				<XCircle className="size-3" />
				Failed
			</Badge>
		);
	}
	return <Badge variant="secondary">Queued</Badge>;
};

interface Props {
	servers: FleetServer[];
	/** Re-probe the fleet once anything actually changed. */
	onUpgraded: () => void | Promise<void>;
	children: React.ReactNode;
}

/**
 * Brings every reachable server up to the newest Docker Engine already running
 * in the fleet.
 *
 * Upgrades run one server at a time on purpose. The installer restarts the
 * Docker daemon, so running them concurrently would bounce the whole fleet at
 * once; sequentially, a failure also stops the run before it spreads.
 */
export const ResolveDockerDrift = ({
	servers,
	onUpgraded,
	children,
}: Props) => {
	const [open, setOpen] = useState(false);
	const [states, setStates] = useState<Record<string, UpgradeState>>({});
	const [isRunning, setIsRunning] = useState(false);

	const { mutateAsync: upgradeDocker } = api.server.upgradeDocker.useMutation();

	const target = useMemo(() => resolveDriftTarget(servers), [servers]);

	const outdated = useMemo(
		() =>
			target
				? servers.filter(
						(row) =>
							row.reachable &&
							row.dockerVersion &&
							compareVersions(row.dockerVersion, target) < 0,
					)
				: [],
		[servers, target],
	);

	// The panel runs in a container with only the Docker socket mounted: it can
	// talk to the host's daemon but has no shell on the host to install with.
	const upgradableRemotely = outdated.filter((row) => row.serverId);
	const localHost = outdated.find((row) => !row.serverId);

	const manualCommand = target
		? `curl -fsSL https://get.docker.com | sh -s -- --version ${target}`
		: "";

	const runAll = async () => {
		if (!target) return;
		setIsRunning(true);
		setStates(
			Object.fromEntries(
				upgradableRemotely.map((row) => [
					row.serverId as string,
					{ status: "pending" } as UpgradeState,
				]),
			),
		);

		let upgraded = 0;
		for (const row of upgradableRemotely) {
			const serverId = row.serverId as string;
			setStates((previous) => ({
				...previous,
				[serverId]: { status: "running" },
			}));
			try {
				const result = await upgradeDocker({ serverId, targetVersion: target });
				upgraded += 1;
				setStates((previous) => ({
					...previous,
					[serverId]: { status: "done", version: result.currentVersion },
				}));
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: "Upgrade failed on this server.";
				setStates((previous) => ({
					...previous,
					[serverId]: { status: "failed", message },
				}));
				toast.error(`${row.name}: ${message}`);
				// Stop rather than march through the rest of the fleet with a
				// known-broken upgrade path.
				break;
			}
		}

		setIsRunning(false);
		if (upgraded > 0) {
			toast.success(
				`Docker upgraded on ${upgraded} ${upgraded === 1 ? "server" : "servers"}.`,
			);
			await onUpgraded();
		}
	};

	return (
		<Dialog open={open} onOpenChange={(next) => !isRunning && setOpen(next)}>
			<DialogTrigger asChild>{children}</DialogTrigger>
			<DialogContent className="max-h-[85vh] sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Resolve Docker version drift</DialogTitle>
					<DialogDescription>
						Aligns every server on {target ?? "the newest version"}, the newest
						Docker Engine already running in this fleet.
					</DialogDescription>
				</DialogHeader>

				<ScrollArea className="max-h-[52vh] pr-3">
					<div className="flex flex-col gap-4">
						<AlertBlock type="warning">
							Upgrading restarts the Docker daemon on that server. Containers
							with a restart policy and Swarm tasks come back on their own;
							anything without one will not. Servers are upgraded one at a time,
							and the run stops at the first failure.
						</AlertBlock>

						{upgradableRemotely.length > 0 ? (
							<div className="flex flex-col gap-2">
								<span className="text-sm font-medium">
									Servers this panel can upgrade
								</span>
								{upgradableRemotely.map((row) => {
									const state = states[row.serverId as string] ?? {
										status: "pending" as const,
									};
									return (
										<div
											key={row.serverId}
											className="flex flex-col gap-1 rounded-md border p-3"
										>
											<div className="flex items-center justify-between gap-3">
												<div className="flex min-w-0 items-center gap-2">
													<ServerIcon className="size-4 shrink-0 text-muted-foreground" />
													<span className="truncate text-sm font-medium">
														{row.name}
													</span>
													<span className="shrink-0 text-sm text-muted-foreground">
														{row.dockerVersion} → {target}
													</span>
												</div>
												<StateBadge state={state} />
											</div>
											{state.status === "failed" ? (
												<span className="text-xs text-destructive">
													{state.message}
												</span>
											) : null}
										</div>
									);
								})}
							</div>
						) : null}

						{localHost ? (
							<div className="flex flex-col gap-2 rounded-md border p-3">
								<div className="flex items-center gap-2">
									<AlertTriangle className="size-4 text-amber-500" />
									<span className="text-sm font-medium">
										{localHost.name} ({localHost.dockerVersion} → {target})
									</span>
								</div>
								<span className="text-sm text-muted-foreground">
									Dokploy runs in a container with only the Docker socket
									mounted, so it can talk to this host's daemon but cannot
									install packages on it. Run this on the host over SSH:
								</span>
								<div className="flex items-center gap-2">
									<code className="min-w-0 flex-1 overflow-x-auto rounded bg-muted px-2 py-1.5 text-xs">
										{manualCommand}
									</code>
									<Button
										variant="outline"
										size="icon"
										onClick={() => {
											navigator.clipboard.writeText(manualCommand);
											toast.success("Command copied");
										}}
									>
										<Copy className="size-4" />
									</Button>
								</div>
							</div>
						) : null}

						{outdated.length === 0 ? (
							<span className="text-sm text-muted-foreground">
								Every reachable server is already on {target}. Nothing to do.
							</span>
						) : null}
					</div>
				</ScrollArea>

				<DialogFooter>
					<Button
						variant="secondary"
						onClick={() => setOpen(false)}
						disabled={isRunning}
					>
						Close
					</Button>
					{/* With nothing the panel can upgrade itself, an "Upgrade 0 servers"
					    button is just noise — the manual command above is the action. */}
					{upgradableRemotely.length > 0 && target ? (
						<Button onClick={runAll} disabled={isRunning} className="gap-2">
							{isRunning ? <Loader2 className="size-4 animate-spin" /> : null}
							{isRunning
								? "Upgrading…"
								: `Upgrade ${upgradableRemotely.length} ${
										upgradableRemotely.length === 1 ? "server" : "servers"
									}`}
						</Button>
					) : null}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
