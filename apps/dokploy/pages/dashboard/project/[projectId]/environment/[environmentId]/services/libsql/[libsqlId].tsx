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
import { type ReactElement, useState } from "react";
import superjson from "superjson";
import { DeleteService } from "@/components/dashboard/compose/delete-service";
import { ShowGeneralLibsql } from "@/components/dashboard/libsql/general/show-general-libsql";
import { UpdateLibsql } from "@/components/dashboard/libsql/update-libsql";
import { TransferService } from "@/components/dashboard/shared/transfer-service";
import { LibsqlIcon } from "@/components/icons/data-tools-icons";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { AdvanceBreadcrumb } from "@/components/shared/advance-breadcrumb";
import { ServiceHeader } from "@/components/shared/service-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UseKeyboardNav } from "@/hooks/use-keyboard-nav";
import { appRouter } from "@/server/api/root";
import { api } from "@/utils/api";

// Tabs load on demand: only one is visible, and together they pull in
// the editor, terminal and chart libraries.
const ShowEnvironment = dynamic(() =>
	import(
		"@/components/dashboard/application/environment/show-environment"
	).then((m) => m.ShowEnvironment),
);
const ShowDockerLogs = dynamic(() =>
	import("@/components/dashboard/application/logs/show").then(
		(m) => m.ShowDockerLogs,
	),
);
const ShowBackups = dynamic(() =>
	import("@/components/dashboard/database/backups/show-backups").then(
		(m) => m.ShowBackups,
	),
);
const ShowExternalLibsqlCredentials = dynamic(() =>
	import(
		"@/components/dashboard/libsql/general/show-external-libsql-credentials"
	).then((m) => m.ShowExternalLibsqlCredentials),
);
const ShowInternalLibsqlCredentials = dynamic(() =>
	import(
		"@/components/dashboard/libsql/general/show-internal-libsql-credentials"
	).then((m) => m.ShowInternalLibsqlCredentials),
);
const ContainerFreeMonitoring = dynamic(() =>
	import(
		"@/components/dashboard/monitoring/free/container/show-free-container-monitoring"
	).then((m) => m.ContainerFreeMonitoring),
);
const ContainerPaidMonitoring = dynamic(() =>
	import(
		"@/components/dashboard/monitoring/paid/container/show-paid-container-monitoring"
	).then((m) => m.ContainerPaidMonitoring),
);
const ShowDatabaseAdvancedSettings = dynamic(() =>
	import("@/components/dashboard/shared/show-database-advanced-settings").then(
		(m) => m.ShowDatabaseAdvancedSettings,
	),
);

type TabState = "projects" | "monitoring" | "settings" | "backups" | "advanced";

const Libsql = (
	props: InferGetServerSidePropsType<typeof getServerSideProps>,
) => {
	const [_toggleMonitoring, _setToggleMonitoring] = useState(false);

	const { libsqlId, activeTab } = props;
	const router = useRouter();
	const { projectId, environmentId } = router.query;
	const [tab, setSab] = useState<TabState>(activeTab);
	const { data } = api.libsql.one.useQuery({ libsqlId });
	const { data: auth } = api.user.get.useQuery();

	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { data: serverIp } = api.settings.getIp.useQuery();

	return (
		<div className="pb-10">
			<UseKeyboardNav forPage="libsql" />
			<AdvanceBreadcrumb />

			<div className="flex flex-col gap-4">
				<Head>
					<title>
						Database: {data?.name} - {data?.environment?.project?.name} |
						Dokploy
					</title>
				</Head>
				<div className="flex w-full flex-col">
					<ServiceHeader
						icon={<LibsqlIcon />}
						name={data?.name}
						description={data?.description}
						appName={data?.appName}
						storedStatus={data?.applicationStatus}
						serverId={data?.serverId}
						server={data?.server}
						logsHref={`/dashboard/project/${projectId}/environment/${environmentId}/services/libsql/${libsqlId}?tab=logs`}
						actions={
							<>
								<UpdateLibsql libsqlId={libsqlId} />
								{(auth?.role === "owner" || auth?.canCreateServices) && (
									<TransferService
										id={libsqlId}
										type="libsql"
										serverId={data?.serverId}
									/>
								)}
								{(auth?.role === "owner" || auth?.canDeleteServices) && (
									<DeleteService id={libsqlId} type="libsql" />
								)}
							</>
						}
					/>
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
									setSab(e as TabState);
									const newPath = `/dashboard/project/${projectId}/environment/${environmentId}/services/libsql/${libsqlId}?tab=${e}`;

									router.push(newPath, undefined, { shallow: true });
								}}
							>
								<div className="flex flex-row items-center justify-between w-full gap-4 overflow-x-auto">
									<TabsList>
										<TabsTrigger value="general">General</TabsTrigger>
										<TabsTrigger value="environment">Environment</TabsTrigger>
										<TabsTrigger value="logs">Logs</TabsTrigger>
										{((data?.serverId && isCloud) || !data?.server) && (
											<TabsTrigger value="monitoring">Monitoring</TabsTrigger>
										)}
										<TabsTrigger value="backups">Backups</TabsTrigger>
										<TabsTrigger value="advanced">Advanced</TabsTrigger>
									</TabsList>
								</div>

								<TabsContent value="general">
									<div className="flex flex-col gap-4 pt-2.5">
										<ShowGeneralLibsql libsqlId={libsqlId} />
										<ShowInternalLibsqlCredentials libsqlId={libsqlId} />
										<ShowExternalLibsqlCredentials libsqlId={libsqlId} />
									</div>
								</TabsContent>
								<TabsContent value="environment">
									<div className="flex flex-col gap-4 pt-2.5">
										<ShowEnvironment id={libsqlId} type="libsql" />
									</div>
								</TabsContent>
								<TabsContent value="monitoring">
									<div className="pt-2.5">
										<div className="flex flex-col gap-4 rounded-lg p-6 bg-muted/40">
											{data?.serverId && isCloud ? (
												<ContainerPaidMonitoring
													appName={data?.appName || ""}
													baseUrl={`${data?.serverId ? `http://${data?.server?.ipAddress}:${data?.server?.metricsConfig?.server?.port}` : "http://localhost:4500"}`}
													token={
														data?.server?.metricsConfig?.server?.token || ""
													}
												/>
											) : (
												<>
													{/* {monitoring?.enabledFeatures && (
															<div className="flex flex-row w-fit p-4 rounded-lg items-center gap-2 bg-muted/40">
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
															<ContainerPaidMonitoring
																appName={data?.appName || ""}
																baseUrl={`http://${monitoring?.serverIp}:${monitoring?.metricsConfig?.server?.port}`}
																token={
																	monitoring?.metricsConfig?.server?.token || ""
																}
															/>
														) : (
															<div> */}
													<ContainerFreeMonitoring
														appName={data?.appName || ""}
													/>
													{/* </div> */}
													{/* )} */}
												</>
											)}
										</div>
									</div>
								</TabsContent>
								<TabsContent value="logs">
									<div className="flex flex-col gap-4  pt-2.5">
										<ShowDockerLogs
											serverId={data?.serverId || ""}
											appName={data?.appName || ""}
											serviceId={data?.libsqlId}
										/>
									</div>
								</TabsContent>
								<TabsContent value="backups">
									<div className="flex flex-col gap-4 pt-2.5">
										<ShowBackups
											id={libsqlId}
											databaseType="libsql"
											backupType="database"
										/>
									</div>
								</TabsContent>
								<TabsContent value="advanced">
									<div className="flex flex-col gap-4 pt-2.5">
										<ShowDatabaseAdvancedSettings id={libsqlId} type="libsql" />
									</div>
								</TabsContent>
							</Tabs>
						)}
					</div>
				</div>
			</div>
		</div>
	);
};

export default Libsql;
Libsql.getLayout = (page: ReactElement) => {
	return <DashboardLayout>{page}</DashboardLayout>;
};

export async function getServerSideProps(
	ctx: GetServerSidePropsContext<{
		libsqlId: string;
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

	if (typeof params?.libsqlId === "string") {
		try {
			await helpers.libsql.one.fetch({
				libsqlId: params?.libsqlId,
			});
			await helpers.settings.isCloud.prefetch();
			return {
				props: {
					trpcState: helpers.dehydrate(),
					libsqlId: params?.libsqlId,
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
