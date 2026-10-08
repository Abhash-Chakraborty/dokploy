import { IS_CLOUD, validateRequest } from "@dokploy/server";
import { createServerSideHelpers } from "@trpc/react-query/server";
import type { GetServerSidePropsContext } from "next";
import Link from "next/link";
import type { ReactElement } from "react";
import superjson from "superjson";
import { WebDomain } from "@/components/dashboard/settings/web-domain";
import { WebServer } from "@/components/dashboard/settings/web-server";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { appRouter } from "@/server/api/root";

const Page = () => {
	return (
		<div className="flex w-full flex-col gap-8">
			<WebServer />
			<WebDomain />
			<p className="text-[13px] text-muted-foreground">
				Backups of Dokploy itself are on the{" "}
				<Link
					href="/dashboard/backups#dokploy-backups"
					className="text-foreground underline underline-offset-4"
				>
					Backups
				</Link>{" "}
				page, next to every other backup. Host checks (Docker, Swarm, Traefik)
				are on{" "}
				<Link
					href="/dashboard/system-health"
					className="text-foreground underline underline-offset-4"
				>
					System health
				</Link>
				.
			</p>
		</div>
	);
};

export default Page;

Page.getLayout = (page: ReactElement) => {
	return <DashboardLayout metaName="Server">{page}</DashboardLayout>;
};
export async function getServerSideProps(
	ctx: GetServerSidePropsContext<{ serviceId: string }>,
) {
	const { req, res } = ctx;
	if (IS_CLOUD) {
		return {
			redirect: {
				permanent: false,
				destination: "/dashboard/home",
			},
		};
	}
	const { user, session } = await validateRequest(ctx.req);
	if (!user) {
		return {
			redirect: {
				permanent: false,
				destination: "/",
			},
		};
	}
	if (user.role === "member") {
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

	return {
		props: {
			trpcState: helpers.dehydrate(),
		},
	};
}
