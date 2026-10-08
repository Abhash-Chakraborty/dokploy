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
import { ShowGeneralPostgres } from "@/components/dashboard/postgres/general/show-general-postgres";
import { UpdatePostgres } from "@/components/dashboard/postgres/update-postgres";
import { TransferService } from "@/components/dashboard/shared/transfer-service";
import { PostgresqlIcon } from "@/components/icons/data-tools-icons";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { AdvanceBreadcrumb } from "@/components/shared/advance-breadcrumb";
import { ServiceHeader } from "@/components/shared/service-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UseKeyboardNav } from "@/hooks/use-keyboard-nav";
import { appRouter } from "@/server/api/root";
import { api } from "@/utils/api";
import { useWhitelabeling } from "@/utils/hooks/use-whitelabeling";

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
const ShowExternalPostgresCredentials = dynamic(() =>
	import(
		"@/components/dashboard/postgres/general/show-external-postgres-credentials"
	).then((m) => m.ShowExternalPostgresCredentials),
);
const ShowInternalPostgresCredentials = dynamic(() =>
	import(
		"@/components/dashboard/postgres/general/show-internal-postgres-credentials"
	).then((m) => m.ShowInternalPostgresCredentials),
);
const ShowDatabaseAdvancedSettings = dynamic(() =>
	import("@/components/dashboard/shared/show-database-advanced-settings").then(
		(m) => m.ShowDatabaseAdvancedSettings,
	),
);

type TabState = "projects" | "monitoring" | "settings" | "backups" | "advanced";

const Postgresql = (
	props: InferGetServerSidePropsType<typeof getServerSideProps>,
) => {
	const [_toggleMonitoring, _setToggleMonitoring] = useState(false);
	const { postgresId, activeTab } = props;
	const router = useRouter();
	const { projectId, environmentId } = router.query;
	const [tab, setSab] = useState<TabState>(activeTab);
	const { data } = api.postgres.one.useQuery({ postgresId });
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
			<UseKeyboardNav forPage="postgres" />
			<AdvanceBreadcrumb />
			<Head>
				<title>
					Database: {data?.name} - {data?.environment?.project?.name} |{" "}
					{appName}
				</title>
			</Head>
			<div className="w-full">
				<div className="flex w-full flex-col">
					<ServiceHeader
						icon={<PostgresqlIcon />}
						name={data?.name}
						description={data?.description}
						appName={data?.appName}
						storedStatus={data?.applicationStatus}
						serverId={data?.serverId}
						server={data?.server}
						logsHref={`/dashboard/project/${projectId}/environment/${environmentId}/services/postgres/${postgresId}?tab=logs`}
						actions={
							<>
								{permissions?.service.create && (
									<UpdatePostgres postgresId={postgresId} />
								)}
								{permissions?.service.create && (
									<TransferService
										id={postgresId}
										type="postgres"
										serverId={data?.serverId}
									/>
								)}
								{permissions?.service.delete && (
									<DeleteService id={postgresId} type="postgres" />
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
									const newPath = `/dashboard/project/${projectId}/environment/${environmentId}/services/postgres/${postgresId}?tab=${e}`;

									router.push(newPath, undefined, {
										shallow: true,
									});
								}}
							>
								<div className="flex flex-row items-center justify-between w-full gap-4 overflow-x-auto">
									<TabsList>
										<TabsTrigger value="general">General</TabsTrigger>
										{permissions?.envVars.read && (
											<TabsTrigger value="environment">Environment</TabsTrigger>
										)}
										{permissions?.logs.read && (
											<TabsTrigger value="logs">Logs</TabsTrigger>
										)}
										{permissions?.monitoring.read &&
											((data?.serverId && isCloud) || !data?.server) && (
												<TabsTrigger value="monitoring">Monitoring</TabsTrigger>
											)}
										<TabsTrigger value="backups">Backups</TabsTrigger>
										{permissions?.service.create && (
											<TabsTrigger value="advanced">Advanced</TabsTrigger>
										)}
									</TabsList>
								</div>

								<TabsContent value="general">
									<div className="flex flex-col gap-4 pt-2.5">
										<ShowGeneralPostgres postgresId={postgresId} />
										<ShowInternalPostgresCredentials postgresId={postgresId} />
										<ShowExternalPostgresCredentials postgresId={postgresId} />
									</div>
								</TabsContent>
								{permissions?.envVars.read && (
									<TabsContent value="environment">
										<div className="flex flex-col gap-4 pt-2.5">
											<ShowEnvironment id={postgresId} type="postgres" />
										</div>
									</TabsContent>
								)}
								{permissions?.monitoring.read && (
									<TabsContent value="monitoring">
										<div className="pt-2.5">
											<div className="flex flex-col gap-4 rounded-lg p-6 bg-muted/40">
												{data?.serverId && isCloud ? (
													<ContainerPaidMonitoring
														appName={data?.appName || ""}
														baseUrl={`${
															data?.serverId
																? `http://${data?.server?.ipAddress}:${data?.server?.metricsConfig?.server?.port}`
																: "http://localhost:4500"
														}`}
														token={
															data?.server?.metricsConfig?.server?.token || ""
														}
													/>
												) : (
													<>
														<ContainerFreeMonitoring
															appName={data?.appName || ""}
														/>
													</>
												)}
											</div>
										</div>
									</TabsContent>
								)}
								{permissions?.logs.read && (
									<TabsContent value="logs">
										<div className="flex flex-col gap-4  pt-2.5">
											<ShowDockerLogs
												serverId={data?.serverId || ""}
												appName={data?.appName || ""}
												serviceId={data?.postgresId}
											/>
										</div>
									</TabsContent>
								)}
								<TabsContent value="backups">
									<div className="flex flex-col gap-4 pt-2.5">
										<ShowBackups
											id={postgresId}
											databaseType="postgres"
											backupType="database"
										/>
									</div>
								</TabsContent>
								{permissions?.service.create && (
									<TabsContent value="advanced">
										<div className="flex flex-col gap-4 pt-2.5">
											<ShowDatabaseAdvancedSettings
												id={postgresId}
												type="postgres"
											/>
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

export default Postgresql;
Postgresql.getLayout = (page: ReactElement) => {
	return <DashboardLayout>{page}</DashboardLayout>;
};

export async function getServerSideProps(
	ctx: GetServerSidePropsContext<{
		postgresId: string;
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

	if (typeof params?.postgresId === "string") {
		try {
			await helpers.postgres.one.fetch({
				postgresId: params?.postgresId,
			});
			await helpers.settings.isCloud.prefetch();

			return {
				props: {
					trpcState: helpers.dehydrate(),
					postgresId: params?.postgresId,
					activeTab: (activeTab || "general") as TabState,
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
