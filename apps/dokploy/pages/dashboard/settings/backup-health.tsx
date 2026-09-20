import { validateRequest } from "@dokploy/server";
import { createServerSideHelpers } from "@trpc/react-query/server";
import { HardDrive } from "lucide-react";
import type { GetServerSidePropsContext } from "next";
import { useRouter } from "next/router";
import type { ReactElement } from "react";
import superjson from "superjson";
import { BackupHealth } from "@/components/abhash/backups/backup-health";
import { UnifiedBackups } from "@/components/dashboard/backups/unified-backups";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { PageContainer, PageHeader } from "@/components/shared/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { appRouter } from "@/server/api/root";
import { api } from "@/utils/api";

const TABS = ["repositories", "services"] as const;
type Tab = (typeof TABS)[number];

const Page = () => {
	const router = useRouter();
	const { data: permissions } = api.user.getPermissions.useQuery();
	// The merged page replaced two nav entries that carried their own gates.
	const canSeeLegacy = !!permissions?.backup?.read;
	const raw = router.query.tab;
	const requested = Array.isArray(raw) ? raw[0] : raw;
	const wanted: Tab = TABS.includes(requested as Tab)
		? (requested as Tab)
		: "repositories";
	const tab: Tab =
		wanted === "services" && !canSeeLegacy ? "repositories" : wanted;

	return (
		<PageContainer>
			<PageHeader
				icon={<HardDrive className="size-5" />}
				title="Backups"
				description="Restic repositories with restore drills, and the older per-service jobs that write straight to S3."
			/>
			<Tabs
				value={tab}
				onValueChange={(next) => {
					// Keeps the tab shareable and survives a reload.
					void router.replace(
						{ pathname: router.pathname, query: { tab: next } },
						undefined,
						{ shallow: true },
					);
				}}
			>
				<TabsList>
					<TabsTrigger value="repositories">
						Repositories and drills
					</TabsTrigger>
					{canSeeLegacy && (
						<TabsTrigger value="services">Per-service (legacy)</TabsTrigger>
					)}
				</TabsList>
				<TabsContent value="repositories" className="mt-4">
					<BackupHealth embedded />
				</TabsContent>
				{canSeeLegacy && (
					<TabsContent value="services" className="mt-4">
						<UnifiedBackups />
					</TabsContent>
				)}
			</Tabs>
		</PageContainer>
	);
};

export default Page;

Page.getLayout = (page: ReactElement) => (
	<DashboardLayout metaName="Backups">{page}</DashboardLayout>
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
	await helpers.abhashBackups.overview.prefetch();
	return { props: { trpcState: helpers.dehydrate() } };
}
