import { validateRequest } from "@dokploy/server";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { PlatformDefaultsForm } from "@/components/abhash/defaults/platform-defaults-form";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";

const Page = () => <PlatformDefaultsForm />;

export default Page;

Page.getLayout = (page: ReactElement) => (
	<DashboardLayout metaName="Defaults">{page}</DashboardLayout>
);

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
	const { user } = await validateRequest(ctx.req);
	if (!user || (user.role !== "owner" && user.role !== "admin")) {
		return { redirect: { permanent: false, destination: "/" } };
	}
	return { props: {} };
}
