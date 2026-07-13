import { validateRequest } from "@dokploy/server/lib/auth";
import { createServerSideHelpers } from "@trpc/react-query/server";
import { PieChart } from "lucide-react";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import superjson from "superjson";
import { ShowSwarmContainers } from "@/components/dashboard/swarm/containers/show-swarm-containers";
import SwarmMonitorCard from "@/components/dashboard/swarm/monitoring-card";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { PageContainer, PageHeader } from "@/components/shared/page-header";
import { ServerFilter } from "@/components/shared/server-filter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { appRouter } from "@/server/api/root";

const Dashboard = () => {
	return (
		<ServerFilter>
			{(serverId) => (
				<PageContainer>
					<PageHeader
						title="Swarm"
						description="Monitor and manage your Docker Swarm cluster."
						icon={<PieChart className="size-5" />}
					/>
					<Tabs defaultValue="overview">
						<TabsList>
							<TabsTrigger value="overview">Overview</TabsTrigger>
							<TabsTrigger value="containers">Containers</TabsTrigger>
						</TabsList>
						<TabsContent value="overview" className="pt-4">
							<SwarmMonitorCard serverId={serverId} />
						</TabsContent>
						<TabsContent value="containers" className="pt-4">
							<ShowSwarmContainers serverId={serverId} />
						</TabsContent>
					</Tabs>
				</PageContainer>
			)}
		</ServerFilter>
	);
};

export default Dashboard;

Dashboard.getLayout = (page: ReactElement) => {
	return <DashboardLayout>{page}</DashboardLayout>;
};
export async function getServerSideProps(
	ctx: GetServerSidePropsContext<{ serviceId: string }>,
) {
	const { user, session } = await validateRequest(ctx.req);
	if (!user) {
		return {
			redirect: {
				permanent: false,
				destination: "/",
			},
		};
	}
	const { req, res } = ctx;

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
	try {
		await helpers.project.all.prefetch();

		const userPermissions = await helpers.user.getPermissions.fetch();

		if (!userPermissions?.docker.read) {
			return {
				redirect: {
					permanent: false,
					destination: "/",
				},
			};
		}
		return {
			props: {
				trpcState: helpers.dehydrate(),
			},
		};
	} catch {
		return {
			props: {},
		};
	}
}
