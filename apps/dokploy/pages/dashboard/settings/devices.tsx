import { validateRequest } from "@dokploy/server";
import { ShieldCheck } from "lucide-react";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { PasskeyManager } from "@/components/dashboard/settings/profile/passkey-manager";
import { ShowSessions } from "@/components/dashboard/settings/sessions/show-sessions";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { PageContainer, PageHeader } from "@/components/shared/page-header";

const DevicesPage = () => (
	<PageContainer>
		<PageHeader
			title="Security"
			description="Passkeys and the devices signed in to your account."
			icon={<ShieldCheck className="size-5" />}
		/>
		<PasskeyManager />
		<ShowSessions />
	</PageContainer>
);

export default DevicesPage;

DevicesPage.getLayout = (page: ReactElement) => (
	<DashboardLayout metaName="Security">{page}</DashboardLayout>
);

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
	const { user } = await validateRequest(ctx.req);
	if (!user) {
		return {
			redirect: { destination: "/", permanent: false },
		};
	}
	return { props: {} };
}
