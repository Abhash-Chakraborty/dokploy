import { validateRequest } from "@dokploy/server/lib/auth";
import { createServerSideHelpers } from "@trpc/react-query/server";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { useState } from "react";
import superjson from "superjson";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { TerminalView } from "@/components/shared/terminal-view";
import { appRouter } from "@/server/api/root";

const Terminals = () => {
	const [serverId, setServerId] = useState<string>("local");
	return (
		// Exactly the space under the top bar (3rem) and inside the page's
		// padding (0.5rem top; -mb-6 trims the 2.5rem bottom to 1rem), so only the
		// terminal scrolls.
		<div className="-mb-6 flex h-[calc(100dvh-4.5rem)] min-h-0 w-full flex-col gap-2 pt-2">
			<TerminalView
				serverId={serverId}
				onServerChange={setServerId}
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
				permanent: false,
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

		if (!userPermissions?.server.terminal) {
			return {
				redirect: {
					permanent: false,
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
