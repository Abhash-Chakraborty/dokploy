import { validateRequest } from "@dokploy/server/lib/auth";
import { hasPermission } from "@dokploy/server/services/permission";
import { ChartLine } from "lucide-react";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { ShowAnalytics } from "@/components/dashboard/analytics/show-analytics";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { PageContainer, PageHeader } from "@/components/shared/page-header";

const AnalyticsPage = () => {
	return (
		<PageContainer className="pb-10">
			<PageHeader
				title="Analytics"
				description="Deployment trends and service composition across your projects."
				icon={<ChartLine className="size-5" />}
			/>
			<ShowAnalytics />
		</PageContainer>
	);
};

export default AnalyticsPage;

AnalyticsPage.getLayout = (page: ReactElement) => {
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

	const canView = await hasPermission(
		{
			user: { id: user.id },
			session: { activeOrganizationId: session?.activeOrganizationId || "" },
		},
		{ service: ["read"] },
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
