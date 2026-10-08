import { validateRequest } from "@dokploy/server/lib/auth";
import { createServerSideHelpers } from "@trpc/react-query/server";
import { ServerOff } from "lucide-react";
import type {
	GetServerSidePropsContext,
	InferGetServerSidePropsType,
} from "next";
import dynamic from "next/dynamic";
import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { type ReactElement, useEffect, useState } from "react";
import superjson from "superjson";
import { ShowIconSettings } from "@/components/dashboard/application/icon/show-icon-settings";
import { AddCommandCompose } from "@/components/dashboard/compose/advanced/add-command";
import { IsolatedDeploymentTab } from "@/components/dashboard/compose/advanced/add-isolation";
import { FreshVolumes } from "@/components/dashboard/compose/advanced/fresh-volumes";
import { ComposeServiceActions } from "@/components/dashboard/compose/containers/compose-service-actions";
import { DeleteService } from "@/components/dashboard/compose/delete-service";
import { ShowGeneralCompose } from "@/components/dashboard/compose/general/show";
import { UpdateCompose } from "@/components/dashboard/compose/update-compose";
import { AssignComposeNetworks } from "@/components/dashboard/networks/assign-compose-networks";
import { TransferService } from "@/components/dashboard/shared/transfer-service";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { AdvanceBreadcrumb } from "@/components/shared/advance-breadcrumb";
import { StatusPill, storedState } from "@/components/shared/live-status";
import { ServiceHeader } from "@/components/shared/service-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UseKeyboardNav } from "@/hooks/use-keyboard-nav";
import { appRouter } from "@/server/api/root";
import { api } from "@/utils/api";
import { useWhitelabeling } from "@/utils/hooks/use-whitelabeling";

// Tabs load on demand: only one is visible, and together they pull in
// the editor, terminal and chart libraries.
const ShowImport = dynamic(() =>
	import("@/components/dashboard/application/advanced/import/show-import").then(
		(m) => m.ShowImport,
	),
);
const ShowVolumes = dynamic(() =>
	import(
		"@/components/dashboard/application/advanced/volumes/show-volumes"
	).then((m) => m.ShowVolumes),
);
const ShowDeployments = dynamic(() =>
	import(
		"@/components/dashboard/application/deployments/show-deployments"
	).then((m) => m.ShowDeployments),
);
const ShowDomains = dynamic(() =>
	import("@/components/dashboard/application/domains/show-domains").then(
		(m) => m.ShowDomains,
	),
);
const ShowEnvironment = dynamic(() =>
	import(
		"@/components/dashboard/application/environment/show-environment"
	).then((m) => m.ShowEnvironment),
);
const ShowPatches = dynamic(() =>
	import("@/components/dashboard/application/patches/show-patches").then(
		(m) => m.ShowPatches,
	),
);
const ShowSchedules = dynamic(() =>
	import("@/components/dashboard/application/schedules/show-schedules").then(
		(m) => m.ShowSchedules,
	),
);
const ShowVolumeBackups = dynamic(() =>
	import(
		"@/components/dashboard/application/volume-backups/show-volume-backups"
	).then((m) => m.ShowVolumeBackups),
);
const ShowComposeContainers = dynamic(() =>
	import(
		"@/components/dashboard/compose/containers/show-compose-containers"
	).then((m) => m.ShowComposeContainers),
);
const ShowDockerLogsCompose = dynamic(() =>
	import("@/components/dashboard/compose/logs/show").then(
		(m) => m.ShowDockerLogsCompose,
	),
);
const ShowDockerLogsStack = dynamic(() =>
	import("@/components/dashboard/compose/logs/show-stack").then(
		(m) => m.ShowDockerLogsStack,
	),
);
const ShowBackups = dynamic(() =>
	import("@/components/dashboard/database/backups/show-backups").then(
		(m) => m.ShowBackups,
	),
);
const ComposeFreeMonitoring = dynamic(() =>
	import(
		"@/components/dashboard/monitoring/free/container/show-free-compose-monitoring"
	).then((m) => m.ComposeFreeMonitoring),
);
const ComposePaidMonitoring = dynamic(() =>
	import(
		"@/components/dashboard/monitoring/paid/container/show-paid-compose-monitoring"
	).then((m) => m.ComposePaidMonitoring),
);

type TabState =
	| "projects"
	| "settings"
	| "advanced"
	| "deployments"
	| "domains"
	| "containers"
	| "monitoring"
	| "volumeBackups";

const Service = (
	props: InferGetServerSidePropsType<typeof getServerSideProps>,
) => {
	const [_toggleMonitoring, _setToggleMonitoring] = useState(false);
	const { composeId, activeTab } = props;
	const router = useRouter();
	const { projectId, environmentId } = router.query;
	// Volume backups live on the Backups tab now; old links still land there.
	const normalizeTab = (value: string) =>
		(value === "volumeBackups" ? "backups" : value) as TabState;
	const [tab, setTab] = useState<TabState>(normalizeTab(activeTab));

	useEffect(() => {
		if (router.query.tab) {
			setTab(normalizeTab(router.query.tab as string));
		}
	}, [router.query.tab]);

	const { data } = api.compose.one.useQuery({ composeId });

	const { data: auth } = api.user.get.useQuery();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { data: serverIp } = api.settings.getIp.useQuery();
	const { data: environments } = api.environment.byProjectId.useQuery({
		projectId: data?.environment?.projectId || "",
	});
	const { config: whitelabeling } = useWhitelabeling();
	const appName = whitelabeling?.appName || "Dokploy";
	const environmentDropdownItems =
		environments?.map((env) => ({
			name: env.name,
			href: `/dashboard/project/${projectId}/environment/${env.environmentId}`,
		})) || [];

	return (
		<div className="pb-10">
			<UseKeyboardNav forPage="compose" />
			<AdvanceBreadcrumb />
			<Head>
				<title>
					Compose: {data?.name} - {data?.environment?.project?.name} | {appName}
				</title>
			</Head>
			<div className="w-full">
				<div className="flex w-full flex-col">
					<div className="flex flex-col gap-4">
						<ServiceHeader
							icon={
								<ShowIconSettings
									serviceId={composeId}
									serviceType="compose"
									icon={data?.icon}
								/>
							}
							name={data?.name}
							description={data?.description}
							appName={data?.appName}
							storedStatus={data?.composeStatus}
							status={<StatusPill state={storedState(data?.composeStatus)} />}
							serverId={data?.serverId}
							server={data?.server}
							logsHref={`/dashboard/project/${projectId}/environment/${environmentId}/services/compose/${composeId}?tab=logs`}
							actions={
								<>
									{permissions?.service.create && (
										<UpdateCompose composeId={composeId} />
									)}

									{permissions?.service.create && (
										<TransferService
											id={composeId}
											type="compose"
											serverId={data?.serverId}
										/>
									)}
									{permissions?.service.delete && (
										<DeleteService id={composeId} type="compose" />
									)}
								</>
							}
						/>
					</div>
					<div className="pt-2">
						{data?.server?.serverStatus === "inactive" ? (
							<div className="flex h-[55vh] py-10">
								<div className="max-w-3xl mx-auto flex flex-col items-center justify-center self-center gap-3">
									<ServerOff className="size-10 text-muted-foreground self-center" />
									<span className="text-center text-base text-muted-foreground">
										This service is hosted on the server {data.server.name}, but
										this server has been disabled because your current plan
										doesn't include enough servers. Please purchase more servers
										to regain access to this application.
									</span>
									<span className="text-center text-base text-muted-foreground">
										Go to{" "}
										<Link
											href="/dashboard/settings/billing"
											className="text-primary"
										>
											Billing
										</Link>
									</span>
								</div>
							</div>
						) : (
							<Tabs
								value={tab}
								defaultValue="general"
								className="w-full"
								onValueChange={(e) => {
									setTab(e as TabState);
									const newPath = `/dashboard/project/${projectId}/environment/${environmentId}/services/compose/${composeId}?tab=${e}`;
									router.push(newPath);
								}}
							>
								<div className="flex flex-row items-center w-full">
									<TabsList>
										<TabsTrigger value="general">General</TabsTrigger>
										{permissions?.envVars.read && (
											<TabsTrigger value="environment">Environment</TabsTrigger>
										)}
										{permissions?.domain.read && (
											<TabsTrigger value="domains">Domains</TabsTrigger>
										)}
										{permissions?.deployment.read && (
											<TabsTrigger value="deployments">Deployments</TabsTrigger>
										)}
										{permissions?.service.read && (
											<TabsTrigger value="containers">Containers</TabsTrigger>
										)}
										{(permissions?.service.create ||
											permissions?.volumeBackup.read) && (
											<TabsTrigger value="backups">Backups</TabsTrigger>
										)}
										{permissions?.schedule.read && (
											<TabsTrigger value="schedules">Schedules</TabsTrigger>
										)}
										{permissions?.logs.read && (
											<TabsTrigger value="logs">Logs</TabsTrigger>
										)}
										{data?.sourceType !== "raw" && (
											<TabsTrigger value="patches">Patches</TabsTrigger>
										)}
										{permissions?.monitoring.read &&
											((data?.serverId && isCloud) || !data?.server) && (
												<TabsTrigger value="monitoring">Monitoring</TabsTrigger>
											)}
										{permissions?.service.create && (
											<TabsTrigger value="advanced">Advanced</TabsTrigger>
										)}
									</TabsList>
								</div>

								<TabsContent value="general">
									<div className="flex flex-col gap-4 pt-2.5">
										<ShowGeneralCompose composeId={composeId} />
									</div>
								</TabsContent>
								{permissions?.envVars.read && (
									<TabsContent value="environment">
										<div className="flex flex-col gap-4 pt-2.5">
											<ShowEnvironment id={composeId} type="compose" />
										</div>
									</TabsContent>
								)}
								{(permissions?.service.create ||
									permissions?.volumeBackup.read) && (
									<TabsContent value="backups">
										<div className="flex flex-col pt-2.5">
											{permissions?.service.create && (
												<ShowBackups id={composeId} backupType="compose" />
											)}
											{permissions?.volumeBackup.read && (
												<ShowVolumeBackups
													id={composeId}
													type="compose"
													serverId={data?.serverId || ""}
												/>
											)}
										</div>
									</TabsContent>
								)}

								{permissions?.schedule.read && (
									<TabsContent value="schedules">
										<div className="flex flex-col gap-4 pt-2.5">
											<ShowSchedules id={composeId} scheduleType="compose" />
										</div>
									</TabsContent>
								)}
								{permissions?.service.read && (
									<TabsContent value="containers">
										<div className="flex flex-col gap-4 pt-2.5">
											<ComposeServiceActions
												composeId={composeId}
												appType={data?.composeType || "docker-compose"}
											/>
											<ShowComposeContainers
												serverId={data?.serverId || undefined}
												appName={data?.appName || ""}
												appType={data?.composeType || "docker-compose"}
												serviceId={data?.composeId}
											/>
										</div>
									</TabsContent>
								)}

								{permissions?.monitoring.read && (
									<TabsContent value="monitoring">
										<div className="pt-2.5">
											<div className="flex flex-col rounded-lg bg-muted/40">
												{data?.serverId && isCloud ? (
													<ComposePaidMonitoring
														serverId={data?.serverId || ""}
														baseUrl={`${data?.serverId ? `http://${data?.server?.ipAddress}:${data?.server?.metricsConfig?.server?.port}` : "http://localhost:4500"}`}
														appName={data?.appName || ""}
														token={
															data?.server?.metricsConfig?.server?.token || ""
														}
														appType={data?.composeType || "docker-compose"}
													/>
												) : (
													<>
														{/* {monitoring?.enabledFeatures &&
															isCloud &&
															data?.serverId && (
																<div className="flex flex-row w-fit p-4 rounded-lg items-center gap-2 m-4 bg-muted/40">
																	<Label className="text-muted-foreground">
																		Change Monitoring
																	</Label>
																	<Switch
																		checked={toggleMonitoring}
																		onCheckedChange={setToggleMonitoring}
																	/>
																</div>
															)}

														{toggleMonitoring ? (
															<ComposePaidMonitoring
																appName={data?.appName || ""}
																baseUrl={`http://${monitoring?.serverIp}:${monitoring?.metricsConfig?.server?.port}`}
																token={
																	monitoring?.metricsConfig?.server?.token || ""
																}
																appType={data?.composeType || "docker-compose"}
															/>
														) : ( */}
														{/* <div> */}
														<ComposeFreeMonitoring
															serverId={data?.serverId || ""}
															appName={data?.appName || ""}
															appType={data?.composeType || "docker-compose"}
														/>
														{/* </div> */}
														{/* )} */}
													</>
												)}
											</div>
										</div>
									</TabsContent>
								)}

								{permissions?.logs.read && (
									<TabsContent value="logs">
										<div className="flex flex-col gap-4 pt-2.5">
											{data?.composeType === "docker-compose" ? (
												<ShowDockerLogsCompose
													serverId={data?.serverId || ""}
													appName={data?.appName || ""}
													appType={data?.composeType || "docker-compose"}
													serviceId={data?.composeId}
												/>
											) : (
												<ShowDockerLogsStack
													serverId={data?.serverId || ""}
													appName={data?.appName || ""}
													serviceId={data?.composeId}
												/>
											)}
										</div>
									</TabsContent>
								)}

								{permissions?.deployment.read && (
									<TabsContent value="deployments" className="w-full pt-2.5">
										<div className="flex flex-col gap-4 rounded-lg bg-muted/40">
											<ShowDeployments
												id={composeId}
												type="compose"
												serverId={data?.serverId || ""}
												refreshToken={data?.refreshToken || ""}
											/>
										</div>
									</TabsContent>
								)}

								{permissions?.domain.read && (
									<TabsContent value="domains">
										<div className="flex flex-col gap-4 pt-2.5">
											<ShowDomains id={composeId} type="compose" />
										</div>
									</TabsContent>
								)}

								<TabsContent value="patches" className="w-full">
									<div className="flex flex-col gap-4 pt-2.5">
										<ShowPatches id={composeId} type="compose" />
									</div>
								</TabsContent>

								{permissions?.service.create && (
									<TabsContent value="advanced">
										<div className="flex flex-col gap-4 pt-2.5">
											<AddCommandCompose composeId={composeId} />
											<ShowVolumes id={composeId} type="compose" />
											<ShowImport composeId={composeId} />
											<AssignComposeNetworks composeId={composeId} />
											<IsolatedDeploymentTab composeId={composeId} />
											<FreshVolumes composeId={composeId} />
										</div>
									</TabsContent>
								)}
							</Tabs>
						)}
					</div>
				</div>
			</div>
		</div>
	);
};

export default Service;
Service.getLayout = (page: ReactElement) => {
	return <DashboardLayout>{page}</DashboardLayout>;
};

export async function getServerSideProps(
	ctx: GetServerSidePropsContext<{
		composeId: string;
		activeTab: TabState;
		environmentId: string;
	}>,
) {
	const { query, params, req, res } = ctx;

	const activeTab = query.tab;
	const { user, session } = await validateRequest(req);
	if (!user) {
		return {
			redirect: {
				permanent: false,
				destination: "/",
			},
		};
	}
	// Fetch data from external API
	const helpers = createServerSideHelpers({
		router: appRouter,
		ctx: {
			req: req as any,
			res: res as any,
			db: null as any,
			session: session as any,
			user: user as any,
		},
		transformer: superjson,
	});

	// Valid project, if not return to initial homepage....
	if (typeof params?.composeId === "string") {
		try {
			await helpers.compose.one.fetch({
				composeId: params?.composeId,
			});
			await helpers.settings.isCloud.prefetch();
			return {
				props: {
					trpcState: helpers.dehydrate(),
					composeId: params?.composeId,
					activeTab: (activeTab || "general") as TabState,
					environmentId: params?.environmentId,
				},
			};
		} catch {
			return {
				redirect: {
					permanent: false,
					destination: "/dashboard/home",
				},
			};
		}
	}

	return {
		redirect: {
			permanent: false,
			destination: "/",
		},
	};
}
