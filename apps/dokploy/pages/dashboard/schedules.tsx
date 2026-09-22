import { validateRequest } from "@dokploy/server/lib/auth";
import { hasPermission } from "@dokploy/server/services/permission";
import { CalendarClock } from "lucide-react";
import type { GetServerSidePropsContext } from "next";
import { useRouter } from "next/router";
import type { ReactElement } from "react";
import { HostCrontab } from "@/components/abhash/fleet/host-crontab";
import { ShowSchedules } from "@/components/dashboard/application/schedules/show-schedules";
import { ShowAllSchedules } from "@/components/dashboard/schedules/show-all-schedules";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { PageContainer, PageHeader } from "@/components/shared/page-header";
import { ServerFilter } from "@/components/shared/server-filter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const TABS = ["all", "host", "cron"] as const;
type Tab = (typeof TABS)[number];

function SchedulesPage() {
	const router = useRouter();
	const tab: Tab = TABS.includes(router.query.tab as Tab)
		? (router.query.tab as Tab)
		: "all";
	const setTab = (value: string) => {
		const { tab: _current, ...query } = router.query;
		router.replace(
			{
				pathname: router.pathname,
				query: value === "all" ? query : { ...query, tab: value },
			},
			undefined,
			{ shallow: true },
		);
	};

	return (
		<PageContainer className="pb-10">
			<PageHeader
				title="Automation"
				description="Every scheduled job in this organization, across projects, servers and the Dokploy host."
				icon={<CalendarClock className="size-5" />}
			/>
			<Tabs value={tab} onValueChange={setTab} className="w-full">
				<ServerFilter
					hidePicker={tab === "all"}
					leading={
						<TabsList variant="line">
							<TabsTrigger value="all">All schedules</TabsTrigger>
							<TabsTrigger value="host">Host schedules</TabsTrigger>
							<TabsTrigger value="cron">Server cron</TabsTrigger>
						</TabsList>
					}
				>
					{(serverId) => (
						<>
							<TabsContent value="all">
								<ShowAllSchedules />
							</TabsContent>
							<TabsContent value="host">
								<ShowSchedules
									scheduleType={serverId ? "server" : "dokploy-server"}
									id={serverId ?? "dokploy-server"}
								/>
							</TabsContent>
							<TabsContent value="cron">
								{serverId ? (
									<HostCrontab serverId={serverId} />
								) : (
									<div className="flex h-40 flex-col items-center justify-center gap-1 text-center text-sm text-muted-foreground">
										<span>Pick a remote server to see its crontabs.</span>
										<span className="text-xs">
											Dokploy runs in a container here, so it cannot reach this
											host's own crontab. Add the host as a remote server to
											manage it too.
										</span>
									</div>
								)}
							</TabsContent>
						</>
					)}
				</ServerFilter>
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
