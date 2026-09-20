import { validateRequest } from "@dokploy/server";
import { createServerSideHelpers } from "@trpc/react-query/server";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import superjson from "superjson";
import { FirewallSettings } from "@/components/abhash/firewall/firewall-settings";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { appRouter } from "@/server/api/root";

const Page = () => (
	<div className="flex w-full flex-col gap-4">
		<FirewallSettings />
	</div>
);

export default Page;

Page.getLayout = (page: ReactElement) => (
	<DashboardLayout metaName="Firewall">{page}</DashboardLayout>
);

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
	const { req, res } = ctx;
	const { user, session } = await validateRequest(req);
	if (!user || user.role === "member") {
		return { redirect: { permanent: false, destination: "/" } };
	}
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
	await helpers.user.get.prefetch();
	await helpers.firewall.list.prefetch();
	return { props: { trpcState: helpers.dehydrate() } };
}
