import { validateRequest } from "@dokploy/server/lib/auth";
import { createServerSideHelpers } from "@trpc/react-query/server";
import { HardDrive } from "lucide-react";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import superjson from "superjson";
import { UnifiedBackups } from "@/components/dashboard/backups/unified-backups";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { PageContainer, PageHeader } from "@/components/shared/page-header";
import { appRouter } from "@/server/api/root";

const Backups = () => {
	return (
		<PageContainer>
			<PageHeader
				title="Backups"
				description="All backups across your services in one place."
				icon={<HardDrive className="size-5" />}
			/>
			<UnifiedBackups />
		</PageContainer>
	);
};

export default Backups;

Backups.getLayout = (page: ReactElement) => {
	return <DashboardLayout metaName="Backups">{page}</DashboardLayout>;
};

export async function getServerSideProps(
	ctx: GetServerSidePropsContext<{ serviceId: string }>,
) {
	const { user, session } = await validateRequest(ctx.req);
	if (!user) {
		return {
			redirect: { permanent: false, destination: "/" },
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
		if (!userPermissions?.backup?.read) {
			return {
				redirect: { permanent: false, destination: "/" },
			};
		}
		return {
			props: {
				trpcState: helpers.dehydrate(),
			},
		};
	} catch {
		return { props: {} };
	}
}
