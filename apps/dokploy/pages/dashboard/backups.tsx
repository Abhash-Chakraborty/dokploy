import { validateRequest } from "@dokploy/server";
import { createServerSideHelpers } from "@trpc/react-query/server";
import type { GetServerSidePropsContext } from "next";
import { useRouter } from "next/router";
import type { ReactElement } from "react";
import superjson from "superjson";
import { BackupHealth } from "@/components/abhash/backups/backup-health";
import { BackupJobs } from "@/components/dashboard/backups/backup-jobs";
import { NewBackupMenu } from "@/components/dashboard/backups/new-backup-menu";
import { ShowBackups } from "@/components/dashboard/database/backups/show-backups";
import { ShowDestinations } from "@/components/dashboard/settings/destination/show-destinations";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import {
	PageContainer,
	PageHeader,
	SectionHeader,
} from "@/components/shared/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { appRouter } from "@/server/api/root";
import { api } from "@/utils/api";

const TABS = ["jobs", "storage", "snapshots"] as const;
type Tab = (typeof TABS)[number];

const Page = () => {
	const router = useRouter();
	const { data: user } = api.user.get.useQuery();
	const { data: jobs } = api.abhashBackups.jobs.useQuery();
	const raw = router.query.tab;
	const requested = Array.isArray(raw) ? raw[0] : raw;
	const tab: Tab = TABS.includes(requested as Tab)
		? (requested as Tab)
		: "jobs";

	const setTab = (next: string) =>
		void router.replace(
			{ pathname: router.pathname, query: { tab: next } },
			undefined,
			{ shallow: true },
		);

	const failing = jobs?.filter((job) => job.lastRun?.status === "error").length;
	const summary = jobs
		? jobs.length === 0
			? "Nothing is backed up yet."
			: `${jobs.length} ${jobs.length === 1 ? "job" : "jobs"}${failing ? ` · ${failing} failing` : " · all healthy"}`
		: "Everything that is backed up, in one place.";

	return (
		<PageContainer>
			<PageHeader
				title="Backups"
				description={summary}
				actions={
					<NewBackupMenu
						onDokploy={() => {
							setTab("jobs");
							requestAnimationFrame(() =>
								document
									.getElementById("dokploy-backups")
									?.scrollIntoView({ behavior: "smooth" }),
							);
						}}
					/>
				}
			/>
			<Tabs value={tab} onValueChange={setTab}>
				<TabsList>
					<TabsTrigger value="jobs">Jobs</TabsTrigger>
					<TabsTrigger value="storage">Storage</TabsTrigger>
					<TabsTrigger value="snapshots">Snapshots and drills</TabsTrigger>
				</TabsList>
				<TabsContent value="jobs" className="flex flex-col gap-12">
					<BackupJobs />
					<section id="dokploy-backups" className="flex flex-col gap-4">
						<SectionHeader
							title="Dokploy itself"
							description="The panel's own database and settings. Keep at least one schedule here so a broken host can be rebuilt."
						/>
						{user?.userId && (
							<ShowBackups
								id={user.userId}
								databaseType="web-server"
								backupType="database"
								hideHeading
							/>
						)}
					</section>
				</TabsContent>
				<TabsContent value="storage">
					<ShowDestinations embedded />
				</TabsContent>
				<TabsContent value="snapshots">
					<BackupHealth embedded />
				</TabsContent>
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
	await helpers.abhashBackups.jobs.prefetch();
	return { props: { trpcState: helpers.dehydrate() } };
}
