import { validateRequest } from "@dokploy/server/lib/auth";
import { createServerSideHelpers } from "@trpc/react-query/server";
import { LayoutList } from "lucide-react";
import type { GetServerSidePropsContext } from "next";
import { useRouter } from "next/router";
import type { ReactElement } from "react";
import superjson from "superjson";
import { ShowOverviewBackups } from "@/components/dashboard/overview/show-overview-backups";
import { ShowOverviewDomains } from "@/components/dashboard/overview/show-overview-domains";
import { ShowOverviewServices } from "@/components/dashboard/overview/show-overview-services";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { PageContainer, PageHeader } from "@/components/shared/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { appRouter } from "@/server/api/root";
import { api } from "@/utils/api";

const DEFAULT_TAB = "services";

const Overview = () => {
	const router = useRouter();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const canSeeBackups =
		!!permissions?.backup.read && !!permissions?.volumeBackup.read;
	const canSeeDomains = !!permissions?.domain.read;

	const queryTab =
		typeof router.query.tab === "string" ? router.query.tab : DEFAULT_TAB;
	const activeTab =
		(queryTab === "backups" && !canSeeBackups) ||
		(queryTab === "domains" && !canSeeDomains)
			? DEFAULT_TAB
			: queryTab;

	const setTab = (value: string) => {
		const { tab: _current, subtab: _subtab, ...query } = router.query;
		router.replace(
			{
				pathname: router.pathname,
				query: value === DEFAULT_TAB ? query : { ...query, tab: value },
			},
			undefined,
			{ shallow: true },
		);
	};

	return (
		<PageContainer>
			<PageHeader
				title="Inventory"
				description="Every service, backup and domain you can reach, in one place."
				icon={<LayoutList className="size-5" />}
			/>
			<Tabs value={activeTab} onValueChange={setTab}>
				<TabsList>
					<TabsTrigger value="services">Services</TabsTrigger>
					{canSeeBackups && <TabsTrigger value="backups">Backups</TabsTrigger>}
					{canSeeDomains && <TabsTrigger value="domains">Domains</TabsTrigger>}
				</TabsList>
				<TabsContent value="services">
					<ShowOverviewServices />
				</TabsContent>
				{canSeeBackups && (
					<TabsContent value="backups">
						<ShowOverviewBackups />
					</TabsContent>
				)}
				{canSeeDomains && (
					<TabsContent value="domains">
						<ShowOverviewDomains />
					</TabsContent>
				)}
			</Tabs>
		</PageContainer>
	);
};

export default Overview;

Overview.getLayout = (page: ReactElement) => {
	return <DashboardLayout>{page}</DashboardLayout>;
};

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
	const { user, session } = await validateRequest(ctx.req);
	if (!user) {
		return {
			redirect: {
				permanent: false,
				destination: "/",
			},
		};
	}
	// Deployments moved to their own page; keep old links working.
	if (ctx.query.tab === "deployments") {
		return {
			redirect: {
				permanent: false,
				destination:
					ctx.query.subtab === "queue"
						? "/dashboard/deployments?tab=queue"
						: "/dashboard/deployments",
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
		const userPermissions = await helpers.user.getPermissions.fetch();

		if (!userPermissions?.service.read) {
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
