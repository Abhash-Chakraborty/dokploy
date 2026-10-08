import { formatDistanceToNow } from "date-fns";
import { ArrowRight, Server } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useMemo } from "react";
import { StatusPill, useLiveServices } from "@/components/shared/live-status";
import { PageHeader, SectionHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { extractServices } from "@/lib/services";
import { api } from "@/utils/api";
import { useRefreshInterval } from "@/utils/hooks/use-platform-defaults";

type DeploymentStatus = "idle" | "running" | "done" | "error";

const statusDotClass: Record<string, string> = {
	done: "bg-status-running",
	running: "bg-status-deploying",
	error: "bg-status-failed",
	idle: "bg-status-stopped",
};

function getServiceInfo(d: any) {
	const app = d.application;
	const comp = d.compose;
	const serverName: string =
		d.server?.name ?? app?.server?.name ?? comp?.server?.name ?? "Dokploy";
	if (app?.environment?.project && app.environment) {
		return {
			name: app.name as string,
			environment: app.environment.name as string,
			projectName: app.environment.project.name as string,
			serverName,
			href: `/dashboard/project/${app.environment.project.projectId}/environment/${app.environment.environmentId}/services/application/${app.applicationId}`,
		};
	}
	if (comp?.environment?.project && comp.environment) {
		return {
			name: comp.name as string,
			environment: comp.environment.name as string,
			projectName: comp.environment.project.name as string,
			serverName,
			href: `/dashboard/project/${comp.environment.project.projectId}/environment/${comp.environment.environmentId}/services/compose/${comp.composeId}`,
		};
	}
	return null;
}

function Stat({
	label,
	value,
	detail,
}: {
	label: string;
	value: ReactNode;
	detail?: ReactNode;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-1 py-1 sm:px-6 sm:first:pl-0 sm:[&+&]:border-l sm:[&+&]:border-border/60">
			<span className="text-xs text-muted-foreground">{label}</span>
			<span className="text-2xl font-semibold tracking-tight tabular-nums">
				{value}
			</span>
			{detail && (
				<span className="truncate text-xs text-muted-foreground">{detail}</span>
			)}
		</div>
	);
}

export const ShowHome = () => {
	const { data: auth } = api.user.get.useQuery();
	const { data: homeStats } = api.project.homeStats.useQuery();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const canReadDeployments = !!permissions?.deployment.read;
	const refreshMs = useRefreshInterval("listsSeconds");
	const { data: deployments } = api.deployment.allCentralized.useQuery(
		undefined,
		{
			enabled: canReadDeployments,
			refetchInterval: refreshMs,
		},
	);

	const firstName = auth?.user?.firstName?.trim();

	const totals = homeStats ?? {
		projects: 0,
		environments: 0,
		applications: 0,
		compose: 0,
		databases: 0,
		services: 0,
	};
	const { data: projects } = api.project.all.useQuery();
	const liveState = useLiveServices();
	const attention = useMemo(
		() =>
			(projects ?? []).flatMap((project) =>
				project.environments.flatMap((environment) =>
					extractServices(environment as never).map((service) => ({
						id: service.id,
						name: service.name,
						project: project.name,
						environment: environment.name,
						href: `/dashboard/project/${project.projectId}/environment/${environment.environmentId}/services/${service.type}/${service.id}`,
						state: liveState(service.appName, service.serverId, service.status),
					})),
				),
			),
		[projects, liveState],
	);
	const tally = {
		running: 0,
		restarting: 0,
		failed: 0,
		stopped: 0,
		deploying: 0,
	};
	for (const item of attention) tally[item.state.tone] += 1;

	const recentDeployments = useMemo(() => {
		if (!deployments) return [];
		return [...deployments]
			.sort(
				(a, b) =>
					new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
			)
			.slice(0, 10);
	}, [deployments]);

	const deployStats = useMemo(() => {
		const now = Date.now();
		const weekMs = 7 * 24 * 60 * 60 * 1000;
		const lastStart = now - weekMs;
		const prevStart = now - 2 * weekMs;

		const last: NonNullable<typeof deployments> = [];
		const prev: NonNullable<typeof deployments> = [];
		for (const d of deployments ?? []) {
			const t = new Date(d.createdAt).getTime();
			if (t >= lastStart) last.push(d);
			else if (t >= prevStart) prev.push(d);
		}

		const lastCount = last.length;
		const prevCount = prev.length;
		let delta: string | undefined;
		if (prevCount > 0) {
			const pct = Math.round(((lastCount - prevCount) / prevCount) * 100);
			delta = `${pct >= 0 ? "+" : ""}${pct}% vs prev 7d`;
		} else if (lastCount > 0) {
			delta = "no prior data";
		} else {
			delta = "no activity yet";
		}

		return { value: String(lastCount), delta };
	}, [deployments]);

	const unhealthy = attention.filter((item) =>
		["failed", "restarting"].includes(item.state.tone),
	);

	return (
		<div className="flex w-full flex-col gap-10">
			<PageHeader
				title={firstName ? `Welcome back, ${firstName}` : "Welcome back"}
				description={
					unhealthy.length > 0
						? `${unhealthy.length} ${unhealthy.length === 1 ? "service needs" : "services need"} attention`
						: "Everything you run is up."
				}
				actions={
					<Button asChild variant="secondary">
						<Link href="/dashboard/projects">
							Projects
							<ArrowRight className="size-4" />
						</Link>
					</Button>
				}
			/>

			<div className="grid grid-cols-2 gap-y-6 sm:flex sm:flex-wrap">
				<Stat
					label="Projects"
					value={totals.projects}
					detail={`${totals.environments} ${totals.environments === 1 ? "environment" : "environments"}`}
				/>
				<Stat
					label="Services"
					value={totals.services}
					detail={`${totals.applications} apps · ${totals.compose} compose · ${totals.databases} databases`}
				/>
				<Stat
					label="Deploys this week"
					value={deployStats.value}
					detail={deployStats.delta}
				/>
				<Stat
					label="Health"
					value={
						<span className="flex items-baseline gap-2">
							{tally.running}
							<span className="text-[13px] font-normal text-muted-foreground">
								running
							</span>
						</span>
					}
					detail={
						<span className="flex gap-3">
							{tally.failed + tally.restarting > 0 && (
								<span className="text-status-failed">
									{tally.failed + tally.restarting} down
								</span>
							)}
							<span>{tally.stopped} stopped</span>
						</span>
					}
				/>
			</div>

			{unhealthy.length > 0 && (
				<section className="flex flex-col gap-2">
					<SectionHeader title="Needs attention" />
					<ul>
						{unhealthy.map((item) => (
							<li key={item.id}>
								<Link
									href={item.href}
									className="flex items-center gap-4 border-b border-border/60 py-2.5 text-[13px] transition-colors hover:bg-muted/40"
								>
									<span className="min-w-0 flex-1 truncate">
										<span className="font-medium">{item.name}</span>
										<span className="ml-2 text-muted-foreground">
											{item.project} · {item.environment}
										</span>
									</span>
									<StatusPill state={item.state} />
								</Link>
							</li>
						))}
					</ul>
				</section>
			)}

			<section className="flex flex-col gap-2">
				<SectionHeader
					title="Recent deployments"
					actions={
						canReadDeployments ? (
							<Link
								href="/dashboard/deployments"
								className="text-xs text-muted-foreground transition-colors hover:text-foreground"
							>
								All deployments
							</Link>
						) : undefined
					}
				/>
				{!canReadDeployments ? (
					<p className="py-8 text-[13px] text-muted-foreground">
						You do not have permission to view deployments.
					</p>
				) : recentDeployments.length === 0 ? (
					<p className="py-8 text-[13px] text-muted-foreground">
						No deployments yet.
					</p>
				) : (
					<ul>
						{recentDeployments.map((d) => {
							const info = getServiceInfo(d);
							if (!info) return null;
							const status = (d.status ?? "idle") as DeploymentStatus;
							return (
								<li key={d.deploymentId}>
									<Link
										href={info.href}
										className="flex items-center gap-4 border-b border-border/60 py-2.5 text-[13px] transition-colors hover:bg-muted/40"
									>
										<span
											className={`size-1.5 shrink-0 rounded-full ${statusDotClass[status] ?? statusDotClass.idle}`}
											aria-hidden
										/>
										<span className="min-w-0 flex-1 truncate">
											<span className="font-medium">{info.name}</span>
											<span className="ml-2 text-muted-foreground">
												{info.projectName} · {info.environment}
											</span>
										</span>
										<span className="hidden w-40 items-center gap-1.5 truncate text-xs text-muted-foreground md:flex">
											<Server className="size-3 shrink-0" />
											<span className="truncate">{info.serverName}</span>
										</span>
										<span className="hidden w-20 text-right text-xs capitalize text-muted-foreground sm:inline">
											{status === "done" ? "deployed" : status}
										</span>
										<span className="hidden w-28 whitespace-nowrap text-right text-xs text-muted-foreground md:inline">
											{formatDistanceToNow(new Date(d.createdAt), {
												addSuffix: true,
											})}
										</span>
									</Link>
								</li>
							);
						})}
					</ul>
				)}
			</section>
		</div>
	);
};
