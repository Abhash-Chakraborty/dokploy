import { validateRequest } from "@dokploy/server";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { ShowLogDrains } from "@/components/dashboard/settings/log-drains/show-log-drains";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";

const Page = () => (
	<div className="flex flex-col gap-4 w-full">
		<ShowLogDrains />
	</div>
);

export default Page;

Page.getLayout = (page: ReactElement) => (
	<DashboardLayout metaName="Log Drains">{page}</DashboardLayout>
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
