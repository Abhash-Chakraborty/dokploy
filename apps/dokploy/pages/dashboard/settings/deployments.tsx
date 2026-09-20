import { IS_CLOUD, validateRequest } from "@dokploy/server";
import { createServerSideHelpers } from "@trpc/react-query/server";
import { Eye, Hammer } from "lucide-react";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import superjson from "superjson";
import { BuildsConcurrency } from "@/components/dashboard/settings/servers/actions/builds-concurrency";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { PageContainer, PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { appRouter } from "@/server/api/root";
import { api } from "@/utils/api";

const Page = () => {
	const { data: servers } = api.server.all.useQuery();

	return (
		<PageContainer>
			<PageHeader
				title="Builds"
				description="How many deployments may build at the same time on each server. Builds of the same service always run one after another."
				icon={<Hammer className="size-5" />}
				actions={
					<Tooltip delayDuration={200}>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								aria-label="What raising this costs"
							>
								<Eye className="size-4 text-muted-foreground transition-colors hover:text-foreground" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="left" className="max-w-80">
							Each concurrent build runs its own builder and image build, so
							raising this multiplies CPU, memory and disk use on the server.
							Set it to what the machine can actually handle: too high and
							builds exhaust memory and fail.
						</TooltipContent>
					</Tooltip>
				}
			/>
			<div className="flex flex-col gap-6">
				<div className="flex flex-col gap-2">
					<p className="text-sm font-medium text-muted-foreground">
						Dokploy Server
					</p>
					<BuildsConcurrency />
				</div>

				<div className="flex flex-col gap-2">
					<p className="text-sm font-medium text-muted-foreground">
						Remote Servers
					</p>
					{servers && servers.length > 0 ? (
						<div className="flex flex-col gap-3">
							{servers.map((server) => (
								<BuildsConcurrency
									key={server.serverId}
									serverId={server.serverId}
									label={server.name}
								/>
							))}
						</div>
					) : (
						<p className="text-sm text-muted-foreground rounded-lg border border-dashed p-4 text-center">
							No remote servers added yet.
						</p>
					)}
				</div>
			</div>
		</PageContainer>
	);
};

export default Page;

Page.getLayout = (page: ReactElement) => {
	return <DashboardLayout metaName="Builds">{page}</DashboardLayout>;
};

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
	const { req, res } = ctx;
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
	// Concurrent builds is a self-hosted feature only.
	if (IS_CLOUD) {
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
	await helpers.server.all.prefetch();

	return {
		props: {
			trpcState: helpers.dehydrate(),
			isCloud: IS_CLOUD,
		},
	};
}
