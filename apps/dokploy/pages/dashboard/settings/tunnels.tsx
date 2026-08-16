import { validateRequest } from "@dokploy/server";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { ShowCloudflareTunnels } from "@/components/dashboard/settings/tunnels/show-cloudflare-tunnels";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";

const Page = () => (
	<div className="flex flex-col gap-4 w-full">
		<ShowCloudflareTunnels />
	</div>
);

export default Page;

Page.getLayout = (page: ReactElement) => (
	<DashboardLayout metaName="Tunnels">{page}</DashboardLayout>
);

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
	const { user } = await validateRequest(ctx.req);
	if (!user) {
		return { redirect: { destination: "/", permanent: false } };
	}
	if (user.role !== "owner" && user.role !== "admin") {
		return {
			redirect: {
				destination: "/dashboard/settings/profile",
				permanent: false,
			},
		};
	}
	return { props: {} };
}
