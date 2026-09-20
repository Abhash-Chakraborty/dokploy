import { IS_CLOUD, validateRequest } from "@dokploy/server";
import { createServerSideHelpers } from "@trpc/react-query/server";
import { LockKeyhole } from "lucide-react";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import superjson from "superjson";
import { ScimSettings } from "@/components/abhash/auth/scim-settings";
import { SsoSettings } from "@/components/abhash/auth/sso-settings";
import { ForwardAuthSettings } from "@/components/abhash/forward-auth/forward-auth-settings";
import { LoginMethods } from "@/components/dashboard/settings/web-server/login-methods";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { PageContainer, PageHeader } from "@/components/shared/page-header";
import { appRouter } from "@/server/api/root";

const Page = () => (
	<PageContainer>
		<PageHeader
			title="Authentication"
			description="How people sign in: login methods, single sign-on and its group mappings."
			icon={<LockKeyhole className="size-5" />}
		/>
		<LoginMethods />
		<SsoSettings />
		<ScimSettings />
		<ForwardAuthSettings />
	</PageContainer>
);

export default Page;

Page.getLayout = (page: ReactElement) => (
	<DashboardLayout metaName="Authentication">{page}</DashboardLayout>
);

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
	const { req, res } = ctx;
	const { user, session } = await validateRequest(req);
	if (!user) {
		return { redirect: { permanent: false, destination: "/" } };
	}
	if (IS_CLOUD || (user.role !== "owner" && user.role !== "admin")) {
		return {
			redirect: {
				permanent: false,
				destination: "/dashboard/settings/profile",
			},
		};
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
	return { props: { trpcState: helpers.dehydrate() } };
}
