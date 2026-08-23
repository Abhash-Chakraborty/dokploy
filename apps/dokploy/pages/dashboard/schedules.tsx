import { validateRequest } from "@dokploy/server/lib/auth";
import { hasPermission } from "@dokploy/server/services/permission";
import { CalendarClock } from "lucide-react";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { ShowSchedules } from "@/components/dashboard/application/schedules/show-schedules";
import { ShowAllSchedules } from "@/components/dashboard/schedules/show-all-schedules";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { PageContainer, PageHeader } from "@/components/shared/page-header";
import { ServerFilter } from "@/components/shared/server-filter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

function SchedulesPage() {
	return (
		<PageContainer className="pb-10">
			<PageHeader
				title="Automation"
				description="Every scheduled job in this organization, across projects, servers and the Dokploy host."
				icon={<CalendarClock className="size-5" />}
			/>
			<Tabs defaultValue="all" className="w-full">
				<TabsList>
					<TabsTrigger value="all">All schedules</TabsTrigger>
					<TabsTrigger value="host">Host schedules</TabsTrigger>
				</TabsList>
				<TabsContent value="all" className="pt-4">
					<ShowAllSchedules />
				</TabsContent>
				<TabsContent value="host" className="pt-4">
					<ServerFilter>
						{(serverId) => (
							<div className="w-full">
								<ShowSchedules
									scheduleType={serverId ? "server" : "dokploy-server"}
									id={serverId ?? "dokploy-server"}
								/>
							</div>
						)}
					</ServerFilter>
				</TabsContent>
			</Tabs>
		</PageContainer>
	);
}
export default SchedulesPage;

SchedulesPage.getLayout = (page: ReactElement) => {
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

	// Gate on schedule.read so a custom role granted that permission is not
	// bounced by a bare owner/admin check. Host-level schedules stay restricted
	// inside the router, which re-checks owner/admin for those rows.
	const canView = await hasPermission(
		{
			user: { id: user.id },
			session: { activeOrganizationId: session?.activeOrganizationId || "" },
		},
		{ schedule: ["read"] },
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
