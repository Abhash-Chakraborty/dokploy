import { validateRequest } from "@dokploy/server/lib/auth";
import { createServerSideHelpers } from "@trpc/react-query/server";
import { SquareTerminal } from "lucide-react";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { useState } from "react";
import superjson from "superjson";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { PageHeader } from "@/components/shared/page-header";
import {
	TerminalServerSelect,
	TerminalView,
} from "@/components/shared/terminal-view";
import { appRouter } from "@/server/api/root";

const Terminals = () => {
	const [serverId, setServerId] = useState<string>("local");
	return (
		// Cap to the viewport so the page itself never scrolls — only the
		// terminal canvas inside TerminalView scrolls.
		<div className="flex h-[calc(100dvh-5rem)] min-h-0 w-full flex-col gap-4">
			<PageHeader
				title="Terminals"
				description="Master console — switch between any connected server."
				icon={<SquareTerminal className="size-5" />}
				actions={
					<TerminalServerSelect
						value={serverId}
						onChange={setServerId}
						className="w-56"
					/>
				}
			/>
			<TerminalView
				serverId={serverId}
				onServerChange={setServerId}
				showSelector={false}
				fillHeight
			/>
		</div>
	);
};

export default Terminals;

Terminals.getLayout = (page: ReactElement) => {
	return <DashboardLayout metaName="Terminals">{page}</DashboardLayout>;
};

export async function getServerSideProps(
	ctx: GetServerSidePropsContext<{ serviceId: string }>,
) {
	const { user, session } = await validateRequest(ctx.req);
	if (!user) {
		return {
			redirect: {
				permanent: true,
				destination: "/",
			},
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

		if (!userPermissions?.docker.read) {
			return {
				redirect: {
					permanent: true,
					destination: "/",
				},
			};
		}
		return {
			props: {
				trpcState: helpers.dehydrate(),
			},
		};
	} catch {
		return {
			props: {},
		};
	}
}
