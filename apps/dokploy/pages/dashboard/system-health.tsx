import { IS_CLOUD } from "@dokploy/server/constants";
import { validateRequest } from "@dokploy/server/lib/auth";
import { hasPermission } from "@dokploy/server/services/permission";
import { HeartPulse } from "lucide-react";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { ShowSystemHealth } from "@/components/dashboard/system-health/show-system-health";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { PageContainer, PageHeader } from "@/components/shared/page-header";

const SystemHealthPage = () => {
	return (
		<PageContainer className="pb-10">
			<PageHeader
				title="System Health"
				description="Docker, Traefik, Postgres, storage and fleet reachability in one place."
				icon={<HeartPulse className="size-5" />}
			/>
			<ShowSystemHealth />
		</PageContainer>
	);
};

export default SystemHealthPage;

SystemHealthPage.getLayout = (page: ReactElement) => {
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

	// The probes this page composes all run against a real host, so it is not
	// meaningful in cloud. Mirrors the sidebar gate.
	if (IS_CLOUD) {
		return {
			redirect: {
				permanent: false,
				destination: "/dashboard/home",
			},
		};
	}

	const canView = await hasPermission(
		{
			user: { id: user.id },
			session: { activeOrganizationId: session?.activeOrganizationId || "" },
		},
		{ docker: ["read"] },
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
