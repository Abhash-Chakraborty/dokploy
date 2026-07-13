import { validateRequest } from "@dokploy/server";
import { ShieldCheck } from "lucide-react";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { LoginHistory } from "@/components/dashboard/settings/profile/login-history";
import { PasskeyManager } from "@/components/dashboard/settings/profile/passkey-manager";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { PageHeader } from "@/components/shared/page-header";

const DevicesPage = () => (
	<div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-4">
		<PageHeader
			title="Security & Devices"
			description="Manage passkeys and active account sessions."
			icon={<ShieldCheck className="size-5" />}
		/>
		<PasskeyManager />
		<LoginHistory />
	</div>
);

export default DevicesPage;

DevicesPage.getLayout = (page: ReactElement) => (
	<DashboardLayout metaName="Security & Devices">{page}</DashboardLayout>
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
