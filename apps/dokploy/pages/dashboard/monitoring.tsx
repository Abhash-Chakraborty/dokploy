import { IS_CLOUD } from "@dokploy/server/constants";
import { validateRequest } from "@dokploy/server/lib/auth";
import { hasPermission } from "@dokploy/server/services/permission";
import { BarChartHorizontalBigIcon, Loader2 } from "lucide-react";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { ContainerFreeMonitoring } from "@/components/dashboard/monitoring/free/container/show-free-container-monitoring";
import { ShowPaidMonitoring } from "@/components/dashboard/monitoring/paid/servers/show-paid-monitoring";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { PageContainer, PageHeader } from "@/components/shared/page-header";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { api } from "@/utils/api";

const BASE_URL = "http://localhost:3001/metrics";

const DEFAULT_TOKEN = "metrics";

const Dashboard = () => {
	const [toggleMonitoring, _setToggleMonitoring] = useLocalStorage(
		"monitoring-enabled",
		false,
	);

	const { data: monitoring, isPending } = api.user.getMetricsToken.useQuery();
	return (
		<PageContainer className="pb-10">
			<PageHeader
				title="Monitoring"
				description="Live container and server metrics."
				icon={<BarChartHorizontalBigIcon className="size-5" />}
			/>
			{isPending ? (
				<div className="rounded-xl border bg-background flex px-4 min-h-[50vh] justify-center items-center gap-2 text-muted-foreground">
					Loading...
					<Loader2 className="h-4 w-4 animate-spin" />
				</div>
			) : toggleMonitoring ? (
				<div className="rounded-xl border bg-background">
					<ShowPaidMonitoring
						BASE_URL={
							process.env.NODE_ENV === "production"
								? `http://${monitoring?.serverIp}:${monitoring?.metricsConfig?.server?.port}/metrics`
								: BASE_URL
						}
						token={
							process.env.NODE_ENV === "production"
								? monitoring?.metricsConfig?.server?.token
								: DEFAULT_TOKEN
						}
					/>
				</div>
			) : (
				<div className="rounded-xl border bg-background p-6">
					<ContainerFreeMonitoring appName="dokploy" />
				</div>
			)}
		</PageContainer>
	);
};

export default Dashboard;

Dashboard.getLayout = (page: ReactElement) => {
	return <DashboardLayout>{page}</DashboardLayout>;
};
export async function getServerSideProps(
	ctx: GetServerSidePropsContext<{ serviceId: string }>,
) {
	if (IS_CLOUD) {
		return {
			redirect: {
				permanent: false,
				destination: "/dashboard/home",
			},
		};
	}
	const { user, session } = await validateRequest(ctx.req);
	if (!user) {
		return {
			redirect: {
				permanent: false,
				destination: "/",
			},
		};
	}

	const canView = await hasPermission(
		{
			user: { id: user.id },
			session: { activeOrganizationId: session?.activeOrganizationId || "" },
		},
		{ monitoring: ["read"] },
	);

	if (!canView) {
		return {
			redirect: {
				permanent: false,
				destination: "/dashboard/home",
			},
		};
	}

	return {
		props: {},
	};
}
